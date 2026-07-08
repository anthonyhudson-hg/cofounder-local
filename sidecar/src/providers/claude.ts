import type { query } from "@anthropic-ai/claude-agent-sdk";
import { AgentProvider, RunTurnOptions, TurnResult, UsagePayload, ZERO_USAGE } from "./types";

/**
 * Claude Code / Claude Agent SDK provider. This is the original Chief of Staff
 * backend, lifted verbatim behind the AgentProvider interface — its streaming,
 * session, usage and cost semantics are unchanged.
 *
 * The SDK ships ESM-only ("type": "module", no CJS entry), so it's loaded via
 * a genuine dynamic import() (preserved past the CommonJS downlevel via
 * `new Function`, mirroring providers/codex.ts's identical guard) instead of
 * a static value import. A plain `import { query } from "..."` here used to
 * downlevel to a bare `require(...)`, which only "worked" because this dev
 * machine's Node has unflagged require(ESM) support (Node 22.12+/23+) — a
 * bundled build's exact Node version shouldn't be a silent precondition for
 * this provider to function at all.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;

let queryFnPromise: Promise<typeof query> | null = null;
function getQuery(): Promise<typeof query> {
  if (!queryFnPromise) {
    queryFnPromise = dynamicImport("@anthropic-ai/claude-agent-sdk").then((mod) => mod.query);
    // Mirrors codex.ts: don't cache a failed import forever — a transient FS
    // hiccup shouldn't require a full app restart to recover from.
    queryFnPromise.catch(() => {
      queryFnPromise = null;
    });
  }
  return queryFnPromise;
}

export class ClaudeProvider implements AgentProvider {
  async *runTurn(opts: RunTurnOptions): AsyncGenerator<string, TurnResult, void> {
    const query = await getQuery();
    let sessionId: string | undefined;
    let usage: UsagePayload = { ...ZERO_USAGE };
    let totalCostUsd = 0;
    let success = false;
    let errorMessage: string | undefined;
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
          if (!success) {
            const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
            errorMessage = errors.length ? `${message.subtype}: ${errors.join("; ")}` : message.subtype;
          }
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
      errorMessage,
    };
  }
}
