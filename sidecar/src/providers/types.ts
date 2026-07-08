import type { ToolContext } from "../tools/types";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type ProviderName = "claude" | "codex";

export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const ZERO_USAGE: UsagePayload = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export interface RunTurnOptions {
  model: string;
  effort: Effort;
  systemPrompt: string;
  prompt: string;
  resumeSessionId?: string | null;
  /**
   * Optional: abort the turn if it hasn't produced a terminal result within this many
   * milliseconds. Neither provider previously had any timeout or cancellation
   * mechanism — a hung subprocess (network stall, SDK deadlock) blocked the request
   * indefinitely with no way for the sidecar or user to cancel it (report §3.6).
   * Unset by default; opt-in, so no existing caller's behavior changes.
   */
  timeoutMs?: number;
  /**
   * When present, exposes an in-process `memory.write` tool for this turn,
   * gated through the same capability/approval machinery as `tool.invoke`
   * (tools/registry.ts's `invokeTool`) — an agent with no standing grant gets
   * a clean "capability denied" tool result, same as the direct IPC path.
   * Claude-only: `@openai/codex-sdk` has no mechanism for the calling process
   * to register custom tools, so CodexProvider ignores this field entirely
   * (see providers/codex.ts). Deliberately scoped to memory.write only, not
   * the full tool registry — every other tool stays reachable only via
   * `command:tool.invoke`.
   */
  memoryWriteTool?: ToolContext;
}

export interface TurnResult {
  /** Opaque handle to resume this conversation with the SAME provider next turn. */
  sessionId: string | null;
  success: boolean;
  usage: UsagePayload;
  totalCostUsd: number;
  /**
   * Populated when `success` is false and the provider observed a specific reason
   * (e.g. Claude's `subtype`/`errors` on a non-success result — rate limit, max-turns,
   * refusal). Previously this was lost entirely: `sendMessage` set `status: "error"`
   * with no `error_message`, showing a DM error bubble with zero diagnostic content
   * (report §4.10).
   */
  errorMessage?: string;
}

/**
 * A backend that can run one agent turn. Implementations yield assistant text
 * chunks as they stream, and return terminal metadata (session id, usage, cost)
 * once the turn completes. Callers that want streaming emit each yielded chunk;
 * callers that want the full text accumulate the chunks.
 */
export interface AgentProvider {
  runTurn(opts: RunTurnOptions): AsyncGenerator<string, TurnResult, void>;
}

/** Drive a runTurn generator to completion, forwarding each text chunk. */
export async function drainTurn(
  gen: AsyncGenerator<string, TurnResult, void>,
  onText: (text: string) => void,
): Promise<TurnResult> {
  let step = await gen.next();
  while (!step.done) {
    onText(step.value);
    step = await gen.next();
  }
  return step.value;
}
