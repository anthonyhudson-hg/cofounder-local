import * as fsp from "node:fs/promises";
import type { RuntimeContext } from "../../runtime/context";
import { runGit } from "../../connectors/git";
import { resolveWithinRoot } from "../../connectors/workspace";
import { getProject } from "./service";

/** Single-letter git status shown per file (VS Code-ish): M modified, A added,
 *  D deleted, R renamed, ? untracked, "" clean. */
export type GitStatusLetter = "M" | "A" | "D" | "R" | "?";

export interface ProjectTree {
  /** Relative POSIX paths of tracked + untracked (gitignore-respected) files. */
  files: string[];
  /** path → status letter, for files with a working-tree change. */
  status: Record<string, GitStatusLetter>;
  /** Current branch of the linked repo's working tree. */
  branch: string;
}

async function requireProjectRoot(ctx: RuntimeContext, companyId: string, projectId: string): Promise<string> {
  const p = await getProject(ctx, projectId);
  if (!p || p.company_id !== companyId) throw new Error("project not found in this company");
  return p.root_path;
}

function unquote(p: string): string {
  // git quotes paths with special chars: "src/a b.ts"
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

function mapStatus(code: string): GitStatusLetter {
  if (code.includes("?")) return "?";
  if (code.includes("A")) return "A";
  if (code.includes("D")) return "D";
  if (code.includes("R")) return "R";
  return "M";
}

/** A live snapshot of the linked repo's working tree: its files + per-file git status. */
export async function getProjectTree(ctx: RuntimeContext, companyId: string, projectId: string): Promise<ProjectTree> {
  const root = await requireProjectRoot(ctx, companyId, projectId);
  const listed = await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).catch(() => "");
  const files = listed ? listed.split("\n").map((l) => unquote(l.trim())).filter(Boolean) : [];

  const statusRaw = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]).catch(() => "");
  const status: Record<string, GitStatusLetter> = {};
  for (const line of statusRaw.split("\n").filter(Boolean)) {
    const code = line.slice(0, 2);
    let p = line.slice(3);
    if (code.includes("R") && p.includes(" -> ")) p = p.split(" -> ")[1];
    status[unquote(p.trim())] = mapStatus(code);
  }

  const branch = (await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")) || "";
  return { files, status, branch };
}

const MAX_FILE_BYTES = 512 * 1024;

export interface ProjectFile {
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** Read a file from the linked repo for a read-only preview (path-confined, size-capped). */
export async function readProjectFile(ctx: RuntimeContext, companyId: string, projectId: string, relPath: string): Promise<ProjectFile> {
  const root = await requireProjectRoot(ctx, companyId, projectId);
  const abs = resolveWithinRoot(root, relPath, "the project");
  const stat = await fsp.stat(abs);
  if (stat.isDirectory()) throw new Error("that path is a directory");
  const buf = await fsp.readFile(abs);
  // Crude binary sniff: a NUL byte in the first chunk.
  if (buf.subarray(0, 8000).includes(0)) return { content: "", truncated: false, binary: true };
  const truncated = buf.length > MAX_FILE_BYTES;
  return { content: buf.subarray(0, MAX_FILE_BYTES).toString("utf8"), truncated, binary: false };
}
