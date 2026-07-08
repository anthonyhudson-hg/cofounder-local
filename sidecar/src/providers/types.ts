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
}

export interface TurnResult {
  /** Opaque handle to resume this conversation with the SAME provider next turn. */
  sessionId: string | null;
  success: boolean;
  usage: UsagePayload;
  totalCostUsd: number;
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
