import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { invokeTool, runToolApproved } from "../tools/registry";
import type { ToolContext } from "../tools/types";
import { registerApproval, unregisterApproval } from "../domains/approvals/registry";
import { cancelApproval } from "../domains/approvals/service";
import { TurnCancelledError } from "./types";

/** Same 30s keepalive as question_ask — a sink.delta on the initiating request
 *  resets the client's 120s stream-idle timer while a human decides. */
const KEEPALIVE_MS = 30_000;

/**
 * Runs a gated tool with Claude Code–style INLINE approval. Calls the capability
 * gate (invokeTool); if it comes back "approval", renders an approval card into
 * the triggering chat and BLOCKS the turn until the user decides, then — on
 * allow — runs the tool inline (`runToolApproved`) and returns its result so the
 * model continues the same turn. Deny/cancel return a clean error result.
 *
 * The "Allow always" / "Always in this channel" grants are applied by
 * command:approval.resolve BEFORE it unblocks us, so by the time we run the tool
 * the grant already exists — this call just executes the one action.
 *
 * No live user (a background message.send cascade: `!interactive`/no sink) falls
 * back to the non-blocking "queued for approval" behavior, exactly as before.
 *
 * `formatOk` renders the tool's successful output as the model-facing result
 * text (each wrapper formats its own output, e.g. "Saved." vs a JSON blob).
 */
export async function runGatedToolInteractive(
  tc: ToolContext,
  name: string,
  args: unknown,
  formatOk: (output: unknown) => CallToolResult,
): Promise<CallToolResult> {
  const result = await invokeTool(tc, name, args ?? {});
  if (result.status === "ok") return formatOk(result.output);

  // status === "approval"
  const { approvalId, detail, scope } = result;

  // No interactive user here (background cascade) — keep the old queued behavior.
  if (!tc.interactive || !tc.sink || !tc.conversationId) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `This action requires the user's approval and has been queued (approval id ${approvalId}). It has NOT happened yet — tell the user it's pending review rather than assuming it succeeded.`,
        },
      ],
    };
  }
  if (tc.abortSignal?.aborted) {
    await cancelApproval(tc.ctx, approvalId).catch(() => {});
    return { isError: true, content: [{ type: "text", text: "The user cancelled before this action could be approved." }] };
  }

  const isDm = !!tc.askingMessageId;
  const channel = isDm ? "approval" : "channelApproval";
  const base = isDm ? { messageId: tc.askingMessageId } : { employeeId: tc.employeeId };
  const render = (phase: "ask" | "keepalive") =>
    tc.sink!.delta(channel, { ...base, phase, approvalId, action: name, detail, scope, conversationId: tc.conversationId });

  render("ask");

  let keepalive: ReturnType<typeof setInterval> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const decision = await new Promise<"denied" | "once" | "always" | "always-here">((resolve, reject) => {
      registerApproval(approvalId, { resolve, reject });
      keepalive = setInterval(() => render("keepalive"), KEEPALIVE_MS);
      onAbort = () => reject(new TurnCancelledError());
      if (tc.abortSignal) {
        if (tc.abortSignal.aborted) onAbort();
        else tc.abortSignal.addEventListener("abort", onAbort);
      }
    });

    if (decision === "denied") {
      return { isError: true, content: [{ type: "text", text: "The user denied this action. Do not attempt it again unless they ask — tell them it was declined." }] };
    }
    // Approved (once / always / always-here). Any grant was already applied by
    // approval.resolve; run the one action now with the live context.
    const output = await runToolApproved(tc, name, args ?? {});
    return formatOk(output);
  } catch (err) {
    await cancelApproval(tc.ctx, approvalId).catch(() => {});
    if (err instanceof TurnCancelledError) {
      return { isError: true, content: [{ type: "text", text: "The user cancelled before approving this action." }] };
    }
    return { isError: true, content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }] };
  } finally {
    if (keepalive) clearInterval(keepalive);
    if (onAbort && tc.abortSignal) tc.abortSignal.removeEventListener("abort", onAbort);
    unregisterApproval(approvalId);
  }
}
