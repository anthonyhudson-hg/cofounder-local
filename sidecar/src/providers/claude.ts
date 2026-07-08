import { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentProvider, RunTurnOptions, TurnResult, UsagePayload, ZERO_USAGE } from "./types";

/**
 * Claude Code / Claude Agent SDK provider. This is the original Chief of Staff
 * backend, lifted verbatim behind the AgentProvider interface — its streaming,
 * session, usage and cost semantics are unchanged.
 */
export class ClaudeProvider implements AgentProvider {
  async *runTurn(opts: RunTurnOptions): AsyncGenerator<string, TurnResult, void> {
    let sessionId: string | undefined;
    let usage: UsagePayload = { ...ZERO_USAGE };
    let totalCostUsd = 0;
    let success = false;
    // Tracks whether a "result" message was actually observed — previously, if the
    // stream ended without one (subprocess crash mid-stream), this silently returned
    // `success:false` with zero explanation, indistinguishable from the case where
    // `query()` throws outright (report §3.2).
    let resultObserved = false;

    const abortController = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => abortController.abort(), opts.timeoutMs) : null;

    try {
      for await (const message of query({
        prompt: opts.prompt,
        options: {
          model: opts.model,
          effort: opts.effort,
          systemPrompt: opts.systemPrompt,
          resume: opts.resumeSessionId ?? undefined,
          allowedTools: [],
          abortController,
        },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }

        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) yield block.text;
          }
        }

        if (message.type === "result") {
          resultObserved = true;
          success = message.subtype === "success";
          totalCostUsd = message.total_cost_usd ?? 0;
          const u = message.usage ?? {};
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          };
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!resultObserved) {
      if (abortController.signal.aborted) {
        throw new Error(`Claude turn timed out after ${opts.timeoutMs}ms`);
      }
      throw new Error("Claude turn ended without a result message — the subprocess may have crashed mid-stream");
    }

    return {
      sessionId: sessionId ?? opts.resumeSessionId ?? null,
      success,
      usage,
      totalCostUsd,
    };
  }
}
