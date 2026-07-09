import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { tool as ToolFn } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext } from "../tools/types";
import { runGatedToolInteractive } from "./interactiveApproval";
import { MEMORY_KINDS } from "../tools/builtin/memory";

/** Shared by every in-process agent tool (memory.write, message.send, ...) — one MCP server, several tools. */
export const AGENT_TOOLS_MCP_SERVER_NAME = "cofounder";
export const MEMORY_WRITE_MCP_TOOL_NAME = "memory_write";
/** MCP tool names surface to the model as `mcp__<serverName>__<toolName>`. */
export const MEMORY_WRITE_ALLOWED_TOOL = `mcp__${AGENT_TOOLS_MCP_SERVER_NAME}__${MEMORY_WRITE_MCP_TOOL_NAME}`;

/**
 * Builds the in-process MCP tool definition for `memory.write`, routed
 * through the real capability gate (tools/registry.ts's `invokeTool`) rather
 * than bypassing it — an agent with no standing grant on `tool:memory` still
 * gets denied here exactly as it would via `command:tool.invoke`.
 *
 * `toolFn` is the SDK's own `tool()` helper, passed in rather than imported
 * statically — `@anthropic-ai/claude-agent-sdk` is ESM-only and claude.ts
 * already owns the dynamic-import guard needed to load it safely; this file
 * only needs `tool()`'s *type* (erased at compile time), never its runtime
 * value directly.
 *
 * MCP has no "pending, ask a human" result — only success/error content — so
 * an `{status: "approval"}` decision is surfaced as an error-flagged result
 * whose text tells the model the write is queued, not that it failed outright.
 */
export function buildMemoryWriteToolDef(toolFn: typeof ToolFn, tc: ToolContext) {
  return toolFn(
    MEMORY_WRITE_MCP_TOOL_NAME,
    "Persist a durable memory entry (key/value) scoped to you as this agent, so you can recall it in a later conversation. Use this for facts, preferences, or context worth remembering — not for anything that only matters within this single turn.",
    {
      key: z.string().min(1).describe("A short, stable identifier for this memory, e.g. 'user-timezone'."),
      value: z.string().min(1).describe("The content to remember."),
      kind: z
        .enum(MEMORY_KINDS)
        .optional()
        .describe(`Defaults to 'long'. One of: ${MEMORY_KINDS.join(", ")}.`),
    },
    async (args): Promise<CallToolResult> => {
      try {
        return await runGatedToolInteractive(tc, "memory.write", args, () => ({ content: [{ type: "text", text: "Saved." }] }));
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Could not save this memory: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
