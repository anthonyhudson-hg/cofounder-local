import { z, type ZodRawShape } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { tool as ToolFn } from "@anthropic-ai/claude-agent-sdk";
import { AGENT_TOOLS_MCP_SERVER_NAME } from "./claudeMemoryTool";
import { runGatedToolInteractive } from "./interactiveApproval";
import type { ToolContext } from "../tools/types";

/**
 * MCP tool definitions for the project-sandboxing filesystem/shell/git tools.
 * Each routes through runGatedToolInteractive (the capability gate + inline
 * approval): an over-its-tier action (edit/delete/shell/PR without a high-enough
 * grant) surfaces an approval card in the chat and BLOCKS until the user
 * decides, then runs inline on allow — exactly like memory.write / message.send.
 */

/** MCP surfaces tools as `mcp__<server>__<name>`; underscore names, dotted registry names. */
function fsAllowed(mcpName: string): string {
  return `mcp__${AGENT_TOOLS_MCP_SERVER_NAME}__${mcpName}`;
}

interface FsToolDef {
  mcpName: string;
  registryName: string;
  description: string;
  shape: ZodRawShape;
}

const DEFS: FsToolDef[] = [
  { mcpName: "project_list", registryName: "project.list", description: "List the projects (codebases) you're scoped to work in.", shape: {} },
  {
    mcpName: "task_open",
    registryName: "task.open",
    description:
      "Open a unit of work on one of your projects: creates a task with its own isolated git worktree + branch and returns the taskId to pass to every file/shell op. Call this once before editing a project. If you have more than one project and it's unclear which to use, ask the user first.",
    shape: {
      projectId: z.string().describe("The id of the project to work in (from project_list)."),
      title: z.string().describe("A short title for this unit of work — becomes the branch/PR name."),
    },
  },
  { mcpName: "fs_read", registryName: "fs.read", description: "Read a text file in a task's worktree.", shape: { taskId: z.string(), path: z.string().describe("Path relative to the project root.") } },
  { mcpName: "fs_list", registryName: "fs.list", description: "List directory entries in a task's worktree.", shape: { taskId: z.string(), path: z.string().optional().describe("Relative dir; defaults to the root.") } },
  { mcpName: "fs_search", registryName: "fs.search", description: "Search file contents in a task's worktree (grep).", shape: { taskId: z.string(), query: z.string() } },
  { mcpName: "fs_create", registryName: "fs.create", description: "Create a NEW file (fails if it exists — use fs_edit to change an existing file).", shape: { taskId: z.string(), path: z.string(), content: z.string() } },
  { mcpName: "fs_edit", registryName: "fs.edit", description: "Overwrite an existing file's contents. May require the user's approval.", shape: { taskId: z.string(), path: z.string(), content: z.string() } },
  { mcpName: "fs_delete", registryName: "fs.delete", description: "Delete a file or directory. May require the user's approval.", shape: { taskId: z.string(), path: z.string() } },
  { mcpName: "fs_move", registryName: "fs.move", description: "Move/rename a file. May require the user's approval.", shape: { taskId: z.string(), from: z.string(), to: z.string() } },
  { mcpName: "shell_run", registryName: "shell.run", description: "Run a shell command in a task's worktree (build/test/lint). May require the user's approval.", shape: { taskId: z.string(), command: z.string() } },
  { mcpName: "git_open_pr", registryName: "git.open_pr", description: "Commit the task's changes and open a pull request (or push the branch for local-only repos). May require the user's approval.", shape: { taskId: z.string(), title: z.string(), body: z.string().optional() } },
];

export const FILESYSTEM_ALLOWED_TOOLS = DEFS.map((d) => fsAllowed(d.mcpName));

export function buildFilesystemToolDefs(toolFn: typeof ToolFn, tc: ToolContext) {
  return DEFS.map((def) =>
    toolFn(def.mcpName, def.description, def.shape, async (args): Promise<CallToolResult> => {
      try {
        return await runGatedToolInteractive(tc, def.registryName, args ?? {}, (output) => ({
          content: [{ type: "text", text: JSON.stringify(output) }],
        }));
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `${def.registryName} failed: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }),
  );
}
