import type { RuntimeContext } from "../../runtime/context";
import { runGit } from "../../connectors/git";
import { getSecret } from "../../secrets/vault";
import { getProject, type ProjectRow } from "./service";

/**
 * Repo metadata for the project view: commits + branches read from the local
 * repo, PRs + issues pulled from the GitHub API (for projects with a remote).
 */

export interface CommitRow {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}
export interface BranchRow {
  name: string;
  current: boolean;
}
export interface PullRow {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  updatedAt: string;
  draft: boolean;
}
export interface IssueRow {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  updatedAt: string;
}

export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function requireProject(ctx: RuntimeContext, companyId: string, projectId: string): Promise<ProjectRow> {
  const p = await getProject(ctx, projectId);
  if (!p || p.company_id !== companyId) throw new Error("project not found in this company");
  return p;
}

const NUL = "\x00";

export async function getProjectCommits(ctx: RuntimeContext, companyId: string, projectId: string, limit = 40): Promise<CommitRow[]> {
  const p = await requireProject(ctx, companyId, projectId);
  const out = await runGit(p.root_path, ["log", `-n${Math.min(Math.max(limit, 1), 200)}`, "--date=short", `--pretty=format:%H${NUL}%h${NUL}%an${NUL}%ad${NUL}%s`]).catch(() => "");
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, author, date, ...rest] = line.split(NUL);
      return { sha, shortSha, author, date, subject: rest.join(NUL) };
    });
}

export async function getProjectBranches(ctx: RuntimeContext, companyId: string, projectId: string): Promise<BranchRow[]> {
  const p = await requireProject(ctx, companyId, projectId);
  const out = await runGit(p.root_path, ["branch", "--sort=-committerdate", "--format=%(HEAD)%00%(refname:short)"]).catch(() => "");
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [head, name] = line.split(NUL);
      return { name, current: head.trim() === "*" };
    });
}

async function github<T>(ctx: RuntimeContext, project: ProjectRow, companyId: string, apiPath: string): Promise<T> {
  if (!project.remote_url) throw new Error("this project has no GitHub remote (local-only)");
  const or = parseOwnerRepo(project.remote_url);
  if (!or) throw new Error("could not parse a GitHub owner/repo from the remote");
  const pat = await getSecret(ctx, companyId, "github_pat");
  if (!pat) throw new Error("no github_pat secret is configured for this company");
  const res = await fetch(`https://api.github.com/repos/${or.owner}/${or.repo}${apiPath}`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "cofounder" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface GhUser {
  login?: string;
}
interface GhPull {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user?: GhUser;
  updated_at: string;
  draft?: boolean;
}
interface GhIssue extends GhPull {
  pull_request?: unknown;
}

export async function getProjectPulls(ctx: RuntimeContext, companyId: string, projectId: string): Promise<PullRow[]> {
  const p = await requireProject(ctx, companyId, projectId);
  const rows = await github<GhPull[]>(ctx, p, companyId, "/pulls?state=all&per_page=30&sort=updated&direction=desc");
  return rows.map((r) => ({ number: r.number, title: r.title, state: r.state, url: r.html_url, author: r.user?.login ?? "", updatedAt: r.updated_at, draft: !!r.draft }));
}

export async function getProjectIssues(ctx: RuntimeContext, companyId: string, projectId: string): Promise<IssueRow[]> {
  const p = await requireProject(ctx, companyId, projectId);
  const rows = await github<GhIssue[]>(ctx, p, companyId, "/issues?state=all&per_page=30&sort=updated&direction=desc");
  // The issues endpoint returns PRs too — drop anything with a pull_request field.
  return rows
    .filter((r) => !r.pull_request)
    .map((r) => ({ number: r.number, title: r.title, state: r.state, url: r.html_url, author: r.user?.login ?? "", updatedAt: r.updated_at }));
}
