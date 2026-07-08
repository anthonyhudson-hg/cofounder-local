import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool } from "../tools/registry";
import { getSecret } from "../secrets/vault";
import { resolveWithinWorkspace } from "./workspace";
import type { Tool, ToolContext } from "../tools/types";

/**
 * GitHub connector (refactor: connectors). A connector is a credential + a set
 * of connector-scoped tools. This one exposes git operations; the commit_push
 * tool is `external-write`, so the capability gate forces a human approval unless
 * the agent holds a matching grant. The PAT is pulled from the company-scoped
 * vault at call time and never logged.
 *
 * (Connectors are modelled to be hostable as MCP servers per the chosen hybrid;
 * this git-backed implementation is directly verifiable without a live network.)
 */

interface CommitPushInput {
  cwd: string;
  message: string;
  push?: boolean;
  remote?: string;
  branch?: string;
}

const execFileAsync = promisify(execFile);

// Async + bounded: `execFileSync` used to block the entire single-threaded sidecar
// process on any git call (network hangs on push included) — one stuck request froze
// every other employee's in-flight work too (report §2.2).
const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (e.killed || e.code === "ETIMEDOUT") {
      throw new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`);
    }
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

function validateCommitPushInput(input: unknown): void {
  if (!input || typeof input !== "object") throw new Error("github.commit_push: input must be an object");
  const { cwd, message, push, remote, branch } = input as Partial<CommitPushInput>;
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("github.commit_push: 'cwd' must be a non-empty string");
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("github.commit_push: 'message' must be a non-empty string");
  }
  if (push !== undefined && typeof push !== "boolean") throw new Error("github.commit_push: 'push' must be a boolean");
  if (remote !== undefined && typeof remote !== "string") throw new Error("github.commit_push: 'remote' must be a string");
  if (branch !== undefined && typeof branch !== "string") throw new Error("github.commit_push: 'branch' must be a string");
}

const commitPush: Tool<CommitPushInput, { committed: boolean; sha: string | null; pushed: boolean }> = {
  name: "github.commit_push",
  scope: "connector:github",
  effect: "external-write",
  description: "Stage all changes, commit, and (optionally) push to a GitHub remote.",
  validateInput: validateCommitPushInput,

  // Gives the human approving this action a real file list instead of the raw JSON
  // args (report §2.2) — `cwd` here is still the caller's raw, unscoped input (approval
  // happens before `run`'s workspace-resolution runs), but staying within the company
  // workspace is enforced in `run` regardless of what's shown here.
  async describeForApproval(tc, input) {
    try {
      const cwd = resolveWithinWorkspace(tc.companyId, input.cwd);
      const status = await git(cwd, ["status", "--porcelain"]);
      const filesChanged = status ? status.split("\n").filter(Boolean) : [];
      return { filesChanged, fileCount: filesChanged.length };
    } catch (err) {
      return { filesChangedError: err instanceof Error ? err.message : String(err) };
    }
  },

  async run(tc: ToolContext, input: CommitPushInput) {
    // `cwd` was previously trusted verbatim — any directory on disk that happened to be
    // a git repo. `git add -A` then staged *everything* in that tree, and a `push:true`
    // call shipped it off using the company's stored PAT: a real, unattended
    // exfiltration path. Confine every commit/push to this company's own sandboxed
    // workspace directory instead (report §2.2).
    const cwd = resolveWithinWorkspace(tc.companyId, input.cwd);

    const status = await git(cwd, ["status", "--porcelain"]);
    if (!status) {
      // Nothing to commit — a very plausible case if this tool is invoked twice or
      // after a no-op turn. Previously this threw a raw git-stderr exception instead
      // of a clean, expected outcome (report §2.2).
      const sha = await git(cwd, ["rev-parse", "HEAD"]).catch(() => null);
      return { committed: false, sha, pushed: false };
    }

    await git(cwd, ["add", "-A"]);
    // No longer forces --no-gpg-sign: that silently overrode any repo/user signing
    // policy with no opt-out (report §2.2). Commits now sign or not per the repo's own
    // git config, same as running `git commit` by hand would.
    await git(cwd, ["commit", "-m", input.message]);
    const sha = await git(cwd, ["rev-parse", "HEAD"]);

    let pushed = false;
    if (input.push) {
      const pat = await getSecret(tc.ctx, tc.companyId, "github_pat");
      if (!pat) throw new Error("no github_pat secret configured for this company");
      const remote = input.remote ?? "origin";
      const branch = input.branch ?? (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
      try {
        // The PAT is passed via an env var read by the credential helper at runtime —
        // never embedded in the helper string itself, so it never appears in this
        // process's argv (visible via Task Manager/`tasklist`/`wmic process` to any
        // other process on the machine), only in this one child process's environment
        // block (report §2.2).
        await git(
          cwd,
          ["-c", `credential.helper=!f() { echo "password=$COFOUNDER_GIT_PAT"; }; f`, "push", remote, branch],
          { COFOUNDER_GIT_PAT: pat },
        );
        pushed = true;
      } catch (err) {
        // The commit already succeeded locally — don't lose that fact in a thrown
        // exception with no state attached. A naive retry after a "nothing to commit"
        // read would otherwise dead-end confusingly (report §2.2).
        throw new Error(
          `commit succeeded (${sha}) but push to ${remote}/${branch} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { committed: true, sha, pushed };
  },
};

export function registerGithubConnector(): void {
  registerTool(commitPush);
}
