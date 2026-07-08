import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { tool as ToolFn } from "@anthropic-ai/claude-agent-sdk";
import { invokeTool } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { AGENT_TOOLS_MCP_SERVER_NAME } from "./claudeMemoryTool";

export const MESSAGE_SEND_MCP_TOOL_NAME = "message_send";
export const MESSAGE_SEND_ALLOWED_TOOL = `mcp__${AGENT_TOOLS_MCP_SERVER_NAME}__${MESSAGE_SEND_MCP_TOOL_NAME}`;

/**
 * Builds the in-process MCP tool definition for `message.send` — lets an
 * agent proactively post into a channel/group it's a member of, not just
 * reply where it was addressed (see tools/builtin/messaging.ts for the
 * actual gate/persist/cascade logic this just forwards into). Mirrors
 * claudeMemoryTool.ts's shape exactly — see its doc comment for why `toolFn`
 * is passed in rather than imported statically, and why an
 * `{status: "approval"}` decision is surfaced as an error-flagged result.
 */
export function buildMessageSendToolDef(toolFn: typeof ToolFn, tc: ToolContext) {
  return toolFn(
    MESSAGE_SEND_MCP_TOOL_NAME,
    "Post a message as yourself into a channel or group conversation you're a member of — NOT a 1:1 DM. Use this to proactively reach out (e.g. 'post in #general that...') rather than only replying where you were directly addressed. Other members will see it and may respond, same as any other message in that conversation.",
    {
      conversationName: z.string().min(1).describe("The channel or group's name, e.g. 'general' (with or without a leading #). Must be a conversation you're already a member of."),
      text: z.string().min(1).describe("The message to post."),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await invokeTool(tc, "message.send", args);
        if (result.status === "approval") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `This post requires a human's approval and has been queued (approval id ${result.approvalId}). It has NOT been posted yet — tell the user it's pending review rather than assuming it went out.`,
              },
            ],
          };
        }
        const output = result.output as { conversationName: string };
        return { content: [{ type: "text", text: `Posted to #${output.conversationName}.` }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Could not post that message: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
