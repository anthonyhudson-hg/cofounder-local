import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { tool as ToolFn } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext } from "../tools/types";
import { AGENT_TOOLS_MCP_SERVER_NAME } from "./claudeMemoryTool";
import { TurnCancelledError } from "./types";
import { askQuestion, cancelQuestion } from "../domains/questions/service";
import { registerQuestion, unregisterQuestion } from "../domains/questions/registry";
import {
  formatAnswerForModel,
  normalizeSpec,
  MAX_SELECT_OPTIONS,
  MAX_SUBQUESTIONS,
  type AnswerPayload,
  type RawQuestionSpec,
} from "../domains/questions/spec";

export const ASK_QUESTION_MCP_TOOL_NAME = "question_ask";
export const ASK_QUESTION_ALLOWED_TOOL = `mcp__${AGENT_TOOLS_MCP_SERVER_NAME}__${ASK_QUESTION_MCP_TOOL_NAME}`;

/** Well under the client's STREAM_IDLE_TIMEOUT_MS (120s in runtimeClient.ts):
 *  each keepalive is a sink.delta on the initiating request id, which resets the
 *  client's idle timer (only deltas do — status broadcasts don't), so the still-
 *  open message.send/sendChannel stream survives a human taking minutes to answer. */
const KEEPALIVE_MS = 30_000;

const optionSchema = z.object({
  label: z.string().min(1).describe("Short chip label for this option."),
  description: z.string().optional().describe("One-line helper shown under the label."),
  preview: z.string().optional().describe("Optional longer preview shown when the option is focused."),
});

const inputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    options: z.array(optionSchema).min(1).max(MAX_SELECT_OPTIONS),
    multiSelect: z.boolean().default(false).describe("Allow selecting more than one option."),
    allowOther: z.boolean().default(true).describe("Show an always-available free-text 'Other' escape hatch."),
  }),
  z.object({
    kind: z.literal("text"),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional().describe("Render a multi-line textarea instead of a single-line input."),
  }),
  z.object({
    kind: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    unit: z.string().optional().describe("Unit label shown next to the value, e.g. 'hrs'."),
    slider: z.boolean().optional().describe("Render a slider instead of a numeric input (requires min & max)."),
  }),
  z.object({ kind: z.literal("date"), min: z.string().optional(), max: z.string().optional() }),
  z.object({
    kind: z.literal("file"),
    accept: z.string().optional().describe("Comma-separated accept filter, e.g. 'image/*,.pdf'."),
    multiple: z.boolean().optional(),
    imageOnly: z.boolean().optional(),
  }),
]);

/** The tool's zod raw-shape (the SDK's `tool()` takes an object of zod schemas). */
export const zodQuestionSchema = {
  title: z.string().optional().describe("Optional heading for the whole question card."),
  questions: z
    .array(
      z.object({
        header: z.string().min(1).describe("A short tag/label for this sub-question, e.g. 'Deployment target'."),
        question: z.string().min(1).describe("The actual question to ask."),
        input: inputSchema,
        required: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(MAX_SUBQUESTIONS)
    .describe(`Between 1 and ${MAX_SUBQUESTIONS} related sub-questions, answered together on one card.`),
};

/**
 * The in-process MCP tool that pauses the agent mid-turn to ask the user a
 * structured question, blocks until they answer, and returns the answer so the
 * model continues the SAME turn. This is the faithful analog of Anthropic's own
 * AskUserQuestion tool. Mirrors claudeMessageSendTool.ts's shape (`toolFn`
 * passed in, not imported — see claudeMemoryTool.ts's doc comment) but, unlike
 * the other tools, does NOT route through invokeTool: asking a human is
 * `effect: "none"` (never gated/approved) and the handler must block on the
 * SDK's own await, which the gate path can't do.
 *
 * Claude-only: Codex can't register host tools, so Codex agents never get this
 * and fall back to asking in prose (see the system-prompt guidance).
 */
export function buildAskQuestionToolDef(toolFn: typeof ToolFn, tc: ToolContext) {
  return toolFn(
    ASK_QUESTION_MCP_TOOL_NAME,
    "Pause and ask the user up to 4 structured questions (single/multi-select, free text, number, date, or file upload), then BLOCK until they answer and return their answers so you can continue. Use this liberally whenever you're genuinely blocked on a decision only the user can make — a choice between real alternatives, a missing parameter, a preference you shouldn't guess. Do NOT use it for things you can reasonably decide yourself.",
    zodQuestionSchema,
    async (rawArgs): Promise<CallToolResult> => {
      // 1. No live user in this context (a background message.send cascade) —
      // degrade instead of blocking forever.
      if (!tc.interactive || !tc.sink || !tc.conversationId) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "There is no interactive user present here, so you can't ask a question in this context. Proceed with your best judgment, or state the decision you'd need the user to make.",
            },
          ],
        };
      }
      // 2. Already cancelled before we even start.
      if (tc.abortSignal?.aborted) {
        return { isError: true, content: [{ type: "text", text: "The user cancelled before the question could be asked." }] };
      }

      const spec = normalizeSpec(rawArgs as RawQuestionSpec);
      const questionId = await askQuestion(tc, spec);

      const isDm = !!tc.askingMessageId;
      const channel = isDm ? "question" : "channelQuestion";
      const base = isDm ? { messageId: tc.askingMessageId } : { employeeId: tc.employeeId };
      const render = (phase: "ask" | "keepalive") =>
        tc.sink!.delta(channel, { ...base, phase, questionId, conversationId: tc.conversationId, spec });

      render("ask"); // draw the card immediately (and reset the idle timer)

      let keepalive: ReturnType<typeof setInterval> | null = null;
      let onAbort: (() => void) | null = null;
      try {
        const answer = await new Promise<AnswerPayload>((resolve, reject) => {
          registerQuestion(questionId, { resolve, reject });
          keepalive = setInterval(() => render("keepalive"), KEEPALIVE_MS);
          onAbort = () => reject(new TurnCancelledError());
          if (tc.abortSignal) {
            if (tc.abortSignal.aborted) onAbort();
            else tc.abortSignal.addEventListener("abort", onAbort);
          }
        });
        return { content: [{ type: "text", text: formatAnswerForModel(spec, answer) }] };
      } catch {
        // Abort (user Stop / stale-session retry): mark the row cancelled so the
        // card locks and the debug view reflects it.
        await cancelQuestion(tc.ctx, questionId).catch(() => {});
        return {
          isError: true,
          content: [{ type: "text", text: "The user cancelled without answering. Do not assume an answer — stop and wait for them." }],
        };
      } finally {
        if (keepalive) clearInterval(keepalive);
        if (onAbort && tc.abortSignal) tc.abortSignal.removeEventListener("abort", onAbort);
        unregisterQuestion(questionId);
      }
    },
  );
}
