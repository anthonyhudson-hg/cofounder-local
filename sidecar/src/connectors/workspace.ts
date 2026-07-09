import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDbPath } from "../db/index";

/**
 * Root directory under which all connector file-write operations for a given company
 * are confined. Previously connector tool input (e.g. github.commit_push's `cwd`) was
 * trusted verbatim with no scoping at all — any directory on disk that happened to be
 * a git repo — letting `git add -A && git push` stage and exfiltrate arbitrary local
 * files with a stored PAT (report §2.2). Resolved server-side, never trusted from tool
 * input, and auto-created on first use.
 */
export function companyWorkspaceRoot(companyId: string): string {
  const root = path.join(path.dirname(resolveDbPath()), "workspaces", companyId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Resolves `requested` against `root` and throws if it would escape it — absolute
 * paths outside the root, `..` traversal, etc. `requested` may be relative
 * (interpreted relative to `root`) or absolute (must itself land inside `root`).
 * This is the core path-confinement used for both the company workspace and a
 * project's worktree.
 */
export function resolveWithinRoot(root: string, requested: string, label = root): string {
  const candidate = path.resolve(root, requested);
  const rel = path.relative(root, candidate);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`path "${requested}" escapes ${label}`);
  }
  return candidate;
}

export function resolveWithinWorkspace(companyId: string, requested: string): string {
  return resolveWithinRoot(companyWorkspaceRoot(companyId), requested, "the company workspace");
}

/** Where a task's isolated git worktree is checked out (under the company workspace). */
export function taskWorktreePath(companyId: string, taskId: string): string {
  return path.join(companyWorkspaceRoot(companyId), "worktrees", taskId);
}
