import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Git orchestration for project sandboxing. Each unit of work (a task) gets an
 * isolated `git worktree` + branch off the project repo, so agents never touch
 * the user's live working tree and parallel agents can't collide. Landing is via
 * a branch → PR (see connectors/github.ts); local-only repos degrade to
 * branch-only.
 */
export async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
  });
  return stdout.toString().trim();
}

/** Is `dir` inside a git working tree? */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await runGit(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** The repo's top-level directory (so a project registered at a subdir resolves to its root). */
export async function repoToplevel(dir: string): Promise<string> {
  return runGit(dir, ["rev-parse", "--show-toplevel"]);
}

/** Best-effort default branch + origin remote for a freshly-registered project. */
export async function repoInfo(dir: string): Promise<{ defaultBranch: string; remoteUrl: string | null }> {
  let defaultBranch = "main";
  try {
    // Prefer origin/HEAD's target; fall back to the current branch.
    const head = await runGit(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
    defaultBranch = head ? head.replace(/^origin\//, "") : await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // keep the fallback
  }
  let remoteUrl: string | null;
  try {
    remoteUrl = (await runGit(dir, ["remote", "get-url", "origin"])) || null;
  } catch {
    remoteUrl = null;
  }
  return { defaultBranch: defaultBranch || "main", remoteUrl };
}

/**
 * Create an isolated worktree + new branch off `baseBranch`. The worktree is a
 * throwaway checkout the agent edits in; the branch is what eventually PRs.
 */
export async function addWorktree(repoRoot: string, worktreePath: string, branch: string, baseBranch: string): Promise<void> {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseBranch]);
}

/** Remove a worktree (best-effort — prune on failure so a stale entry can't wedge future adds). */
export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    try {
      await runGit(repoRoot, ["worktree", "prune"]);
    } catch {
      // best-effort
    }
  }
}

/** True if the worktree has any staged/unstaged/untracked changes. */
export async function hasChanges(worktreePath: string): Promise<boolean> {
  const out = await runGit(worktreePath, ["status", "--porcelain"]);
  return out.length > 0;
}
