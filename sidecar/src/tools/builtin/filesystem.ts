import { exec, execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { registerTool } from "../registry";
import { resolveWithinRoot } from "../../connectors/workspace";
import { runGit, hasChanges } from "../../connectors/git";
import { getSecret } from "../../secrets/vault";
import { getProject, listEmployeeProjectIds, type ProjectRow } from "../../domains/projects/service";
import { getTask, createTask, startTask, setTaskStatus, type TaskRow } from "../../domains/tasks/service";
import type { Tool, ToolContext } from "../types";

/**
 * Filesystem / shell / git tools scoped to a project's isolated git worktree.
 * Everything shares the capability scope `tool:filesystem`; the effect tier per
 * tool + the employee's standing grant gives the tiered governance for free
 * (read/create autonomous with a write-internal grant; edit/delete/shell/PR
 * escalate to a human approval). Paths are confined to the task's worktree via
 * resolveWithinRoot, and every op verifies the employee is scoped to the task's
 * project — an agent can never touch a repo it wasn't granted, or escape the
 * worktree, or mutate the user's live working tree (all edits happen on an
 * isolated branch → PR).
 */

const SCOPE = "tool:filesystem";
const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 12_000;
const SHELL_TIMEOUT_MS = 120_000;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface Resolved {
  task: TaskRow;
  project: ProjectRow;
  worktree: string;
}

/** Resolve a task to its worktree, enforcing company + project-scope + worktree existence. */
async function resolveTask(tc: ToolContext, taskId: unknown): Promise<Resolved> {
  if (typeof taskId !== "string" || !taskId) throw new Error("a valid taskId is required (open a task first with task_open)");
  const task = await getTask(tc.ctx, taskId);
  if (!task || task.company_id !== tc.companyId) throw new Error("task not found in this company");
  const allowed = await listEmployeeProjectIds(tc.ctx, tc.employeeId);
  if (!allowed.includes(task.project_id)) throw new Error("you are not scoped to this task's project");
  const project = await getProject(tc.ctx, task.project_id);
  if (!project) throw new Error("the task's project no longer exists");
  if (!task.worktree_path || !fs.existsSync(task.worktree_path)) {
    throw new Error("this task has no active worktree — it may have been cleaned up; open a new task");
  }
  return { task, project, worktree: task.worktree_path };
}

function str(o: unknown, k: string): string {
  const v = (o as Record<string, unknown> | null)?.[k];
  if (typeof v !== "string" || !v) throw new Error(`'${k}' must be a non-empty string`);
  return v;
}
function optStr(o: unknown, k: string): string | undefined {
  const v = (o as Record<string, unknown> | null)?.[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`'${k}' must be a string`);
  return v;
}
function clip(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more chars truncated)`;
}

// ---- project / task ----

const projectList: Tool = {
  name: "project.list",
  scope: SCOPE,
  effect: "read",
  description: "List the projects (codebases) you are scoped to work in.",
  async run(tc) {
    const ids = await listEmployeeProjectIds(tc.ctx, tc.employeeId);
    const projects = await Promise.all(ids.map((id) => getProject(tc.ctx, id)));
    return {
      projects: projects.filter((p): p is ProjectRow => !!p).map((p) => ({
        id: p.id,
        name: p.name,
        defaultBranch: p.default_branch,
        remote: !!p.remote_url,
      })),
    };
  },
};

const taskOpen: Tool = {
  name: "task.open",
  scope: SCOPE,
  effect: "write-internal",
  description:
    "Open a unit of work on one of your projects. Creates a task with its own isolated git worktree + branch off the default branch, and returns the taskId you pass to every file/shell op. Do this once before editing a project.",
  validateInput(input) {
    str(input, "projectId");
    str(input, "title");
  },
  async run(tc, input) {
    const projectId = str(input, "projectId");
    const title = str(input, "title");
    const allowed = await listEmployeeProjectIds(tc.ctx, tc.employeeId);
    if (!allowed.includes(projectId)) throw new Error("you are not scoped to that project");
    const task = await createTask(tc.ctx, { companyId: tc.companyId, projectId, employeeId: tc.employeeId, title });
    const { branchName } = await startTask(tc.ctx, task.id);
    return { taskId: task.id, branch: branchName, note: "Worktree ready. Use this taskId for fs_read/fs_list/fs_create/etc." };
  },
};

// ---- read ----

const fsRead: Tool = {
  name: "fs.read",
  scope: SCOPE,
  effect: "read",
  description: "Read a text file from a task's worktree (relative path).",
  validateInput(input) {
    str(input, "taskId");
    str(input, "path");
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const abs = resolveWithinRoot(worktree, str(input, "path"), "the project worktree");
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) throw new Error("that path is a directory — use fs_list");
    if (stat.size > MAX_READ_BYTES) throw new Error(`file too large to read (${stat.size} bytes; cap ${MAX_READ_BYTES})`);
    return { content: await fsp.readFile(abs, "utf8") };
  },
};

const fsList: Tool = {
  name: "fs.list",
  scope: SCOPE,
  effect: "read",
  description: "List directory entries in a task's worktree (relative path; defaults to the root).",
  validateInput(input) {
    str(input, "taskId");
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const rel = optStr(input, "path") ?? ".";
    const abs = resolveWithinRoot(worktree, rel, "the project worktree");
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    return {
      entries: entries
        .filter((e) => e.name !== ".git")
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
    };
  },
};

const fsSearch: Tool = {
  name: "fs.search",
  scope: SCOPE,
  effect: "read",
  description: "Search file contents in a task's worktree (like grep). Returns matching lines with file:line.",
  validateInput(input) {
    str(input, "taskId");
    str(input, "query");
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const query = str(input, "query");
    try {
      const out = await runGit(worktree, ["grep", "-n", "-I", "--no-color", "--untracked", "-e", query]);
      return { matches: clip(out) || "(no matches)" };
    } catch {
      // git grep exits non-zero when there are no matches.
      return { matches: "(no matches)" };
    }
  },
};

// ---- write (create is autonomous with a write-internal grant) ----

const fsCreate: Tool = {
  name: "fs.create",
  scope: SCOPE,
  effect: "write-internal",
  description: "Create a NEW file in a task's worktree. Fails if the file already exists (use fs_edit to change an existing file).",
  validateInput(input) {
    str(input, "taskId");
    str(input, "path");
    if (typeof (input as Record<string, unknown>).content !== "string") throw new Error("'content' must be a string");
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const abs = resolveWithinRoot(worktree, str(input, "path"), "the project worktree");
    if (fs.existsSync(abs)) throw new Error("file already exists — use fs_edit to modify it (that requires approval)");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, (input as { content: string }).content, "utf8");
    return { created: true };
  },
};

// ---- gated: edit / delete / move / shell / PR (external-write → approval unless granted) ----

async function previewDiff(worktree: string, relPath: string): Promise<Record<string, unknown>> {
  try {
    const diff = await runGit(worktree, ["diff", "--no-color", "--", relPath]).catch(() => "");
    return { path: relPath, diffPreview: clip(diff, 4000) || "(new content — no diff yet)" };
  } catch {
    return { path: relPath };
  }
}

const fsEdit: Tool = {
  name: "fs.edit",
  scope: SCOPE,
  effect: "external-write",
  description: "Overwrite an EXISTING file's contents in a task's worktree. Requires approval unless granted.",
  validateInput(input) {
    str(input, "taskId");
    str(input, "path");
    if (typeof (input as Record<string, unknown>).content !== "string") throw new Error("'content' must be a string");
  },
  async describeForApproval(tc, input) {
    try {
      const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
      return previewDiff(worktree, str(input, "path"));
    } catch (err) {
      return { previewError: err instanceof Error ? err.message : String(err) };
    }
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const abs = resolveWithinRoot(worktree, str(input, "path"), "the project worktree");
    if (!fs.existsSync(abs)) throw new Error("file does not exist — use fs_create");
    await fsp.writeFile(abs, (input as { content: string }).content, "utf8");
    return { edited: true };
  },
};

const fsDelete: Tool = {
  name: "fs.delete",
  scope: SCOPE,
  effect: "external-write",
  description: "Delete a file or directory in a task's worktree. Requires approval unless granted.",
  validateInput(input) {
    str(input, "taskId");
    str(input, "path");
  },
  async describeForApproval(tc, input) {
    return { path: optStr(input, "path") ?? "" };
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const abs = resolveWithinRoot(worktree, str(input, "path"), "the project worktree");
    await fsp.rm(abs, { recursive: true, force: true });
    return { deleted: true };
  },
};

const fsMove: Tool = {
  name: "fs.move",
  scope: SCOPE,
  effect: "external-write",
  description: "Move/rename a file within a task's worktree. Requires approval unless granted.",
  validateInput(input) {
    str(input, "taskId");
    str(input, "from");
    str(input, "to");
  },
  async describeForApproval(tc, input) {
    return { from: optStr(input, "from") ?? "", to: optStr(input, "to") ?? "" };
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const from = resolveWithinRoot(worktree, str(input, "from"), "the project worktree");
    const to = resolveWithinRoot(worktree, str(input, "to"), "the project worktree");
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return { moved: true };
  },
};

const shellRun: Tool = {
  name: "shell.run",
  scope: SCOPE,
  effect: "external-write",
  description:
    "Run a shell command in a task's worktree (build/test/lint/etc.). Runs sandboxed to the worktree. Requires approval unless granted.",
  validateInput(input) {
    str(input, "taskId");
    str(input, "command");
  },
  async describeForApproval(tc, input) {
    return { command: optStr(input, "command") ?? "" };
  },
  async run(tc, input) {
    const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const command = str(input, "command");
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: worktree,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return { exitCode: 0, output: clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; message?: string };
      if (e.killed) throw new Error(`command timed out after ${SHELL_TIMEOUT_MS}ms`, { cause: err });
      return { exitCode: e.code ?? 1, output: clip(`${e.stdout ?? ""}${e.stderr ? `\n[stderr]\n${e.stderr}` : ""}` || e.message || "command failed") };
    }
  },
};

// ---- git: commit + push + PR (land the work) ----

function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

const gitOpenPr: Tool = {
  name: "git.open_pr",
  scope: SCOPE,
  effect: "external-write",
  description:
    "Commit all changes on the task's branch and open a pull request (or push the branch, for local-only repos). Requires approval unless granted.",
  validateInput(input) {
    str(input, "taskId");
    str(input, "title");
  },
  async describeForApproval(tc, input) {
    try {
      const { worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
      const status = await runGit(worktree, ["status", "--porcelain"]).catch(() => "");
      const files = status ? status.split("\n").filter(Boolean) : [];
      return { title: optStr(input, "title") ?? "", filesChanged: files, fileCount: files.length };
    } catch (err) {
      return { previewError: err instanceof Error ? err.message : String(err) };
    }
  },
  async run(tc, input) {
    const { task, project, worktree } = await resolveTask(tc, (input as { taskId: string }).taskId);
    const title = str(input, "title");
    const body = optStr(input, "body") ?? "";
    const branch = task.branch_name!;

    if (await hasChanges(worktree)) {
      await runGit(worktree, ["add", "-A"]);
      await runGit(worktree, ["commit", "-m", title]);
    }

    // Local-only project: no remote to push/PR to — leave the branch for the human.
    if (!project.remote_url) {
      await setTaskStatus(tc.ctx, task.id, "in_review");
      return { pushed: false, prUrl: null, branch, note: "Local-only repo: committed to the branch. Push/PR it yourself." };
    }

    const pat = await getSecret(tc.ctx, tc.companyId, "github_pat");
    if (!pat) throw new Error("no github_pat secret configured for this company — needed to push/open a PR");

    await runGit(
      worktree,
      ["-c", `credential.helper=!f() { echo "password=$COFOUNDER_GIT_PAT"; }; f`, "push", "-u", "origin", branch],
      { COFOUNDER_GIT_PAT: pat },
    );

    const or = parseOwnerRepo(project.remote_url);
    if (!or) {
      await setTaskStatus(tc.ctx, task.id, "in_review");
      return { pushed: true, prUrl: null, branch, note: "Branch pushed. Couldn't parse a GitHub owner/repo from the remote to open a PR." };
    }

    const res = await fetch(`https://api.github.com/repos/${or.owner}/${or.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "cofounder",
      },
      body: JSON.stringify({ title, head: branch, base: task.base_branch || project.default_branch, body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await setTaskStatus(tc.ctx, task.id, "in_review");
      throw new Error(`branch pushed, but opening the PR failed (${res.status}): ${clip(text, 300)}`);
    }
    const pr = (await res.json()) as { html_url?: string };
    const prUrl = pr.html_url ?? null;
    await setTaskStatus(tc.ctx, task.id, "in_review", { prUrl });
    return { pushed: true, prUrl, branch };
  },
};

export function registerFilesystemTools(): void {
  registerTool(projectList);
  registerTool(taskOpen);
  registerTool(fsRead);
  registerTool(fsList);
  registerTool(fsSearch);
  registerTool(fsCreate);
  registerTool(fsEdit);
  registerTool(fsDelete);
  registerTool(fsMove);
  registerTool(shellRun);
  registerTool(gitOpenPr);
}

/** Tool names surfaced to the model (MCP), for the allowedTools list + prompt guidance. */
export const FILESYSTEM_TOOL_NAMES = [
  "project.list",
  "task.open",
  "fs.read",
  "fs.list",
  "fs.search",
  "fs.create",
  "fs.edit",
  "fs.delete",
  "fs.move",
  "shell.run",
  "git.open_pr",
] as const;
