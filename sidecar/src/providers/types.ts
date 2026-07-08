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
 * A turn yields two kinds of chunk: incremental text (real token-level
 * streaming when the provider supports it, not one block at the end) and
 * tool-activity notices (a model calling e.g. memory_write). Both ride the
 * same generator so a caller only has to drain one stream, same as before —
 * `kind` just lets it tell them apart instead of assuming every chunk is text.
 */
export type TurnChunk = { kind: "text"; text: string } | { kind: "tool"; name: string; phase: "start" | "end" };

/**
 * A backend that can run one agent turn. Implementations yield chunks as they
 * happen and return terminal metadata (session id, usage, cost) once the turn
 * completes. Callers that want streaming emit each yielded chunk; callers
 * that want the full text accumulate the "text" chunks.
 */
export interface AgentProvider {
  runTurn(opts: RunTurnOptions): AsyncGenerator<TurnChunk, TurnResult, void>;
}

/** Drive a runTurn generator to completion, forwarding each yielded chunk. */
export async function drainTurn(
  gen: AsyncGenerator<TurnChunk, TurnResult, void>,
  onChunk: (chunk: TurnChunk) => void,
): Promise<TurnResult> {
  let step = await gen.next();
  while (!step.done) {
    onChunk(step.value);
    step = await gen.next();
  }
  return step.value;
}
