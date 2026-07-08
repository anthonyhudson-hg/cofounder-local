import { execFileSync } from "node:child_process";
import { registerTool } from "../tools/registry";
import { getSecret } from "../secrets/vault";
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const commitPush: Tool<CommitPushInput, { committed: boolean; sha: string; pushed: boolean }> = {
  name: "github.commit_push",
  scope: "connector:github",
  effect: "external-write",
  description: "Stage all changes, commit, and (optionally) push to a GitHub remote.",
  async run(tc: ToolContext, input: CommitPushInput) {
    git(input.cwd, ["add", "-A"]);
    git(input.cwd, ["commit", "-m", input.message, "--no-gpg-sign"]);
    const sha = git(input.cwd, ["rev-parse", "HEAD"]);

    let pushed = false;
    if (input.push) {
      const pat = await getSecret(tc.ctx, tc.companyId, "github_pat");
      if (!pat) throw new Error("no github_pat secret configured for this company");
      const remote = input.remote ?? "origin";
      const branch = input.branch ?? git(input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      // The PAT is passed via an ephemeral credential helper; never written to disk/logs.
      git(input.cwd, ["-c", `credential.helper=!f() { echo "password=${pat}"; }; f`, "push", remote, branch]);
      pushed = true;
    }
    return { committed: true, sha, pushed };
  },
};

export function registerGithubConnector(): void {
  registerTool(commitPush);
}
