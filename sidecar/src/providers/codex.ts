import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Codex as CodexClient,
  ThreadEvent,
  ModelReasoningEffort,
  ThreadOptions,
} from "@openai/codex-sdk";
import { AgentProvider, Effort, RunTurnOptions, TurnResult, UsagePayload, ZERO_USAGE } from "./types";

/*
 * OpenAI Codex provider. Structural analog to the Claude Agent SDK: the
 * `@openai/codex-sdk` package spawns the local `codex` CLI and exchanges JSONL
 * events over stdio, authenticated by the user's local ChatGPT login
 * (`codex login`) or `OPENAI_API_KEY` — the same "use my local subscription"
 * shape as Claude Code. The `codex` CLI must be installed and on PATH.
 *
 * The SDK ships as ESM-only ("type": "module"), so it is loaded via a genuine
 * dynamic import() (preserved past the CommonJS downlevel via `new Function`).
 * Types are imported type-only, which erases at compile time and costs nothing
 * at runtime.
 */

// Preserve a real dynamic `import()` regardless of the CommonJS output target,
// so this ESM-only package still loads. tsc would otherwise rewrite a literal
// import() into require(), which throws on an ESM package.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<typeof import("@openai/codex-sdk")>;

let clientPromise: Promise<CodexClient> | null = null;
function getClient(): Promise<CodexClient> {
  if (!clientPromise) {
    clientPromise = dynamicImport("@openai/codex-sdk").then((mod) => new mod.Codex());
    // A failed import (codex CLI not yet on PATH, transient FS hiccup) used to be
    // cached forever — every subsequent request would re-throw the same stale
    // rejection for the rest of the process's life, requiring a full app restart to
    // recover. Clear the cache on failure so the next call retries (report §3.8).
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

// Codex often wraps upstream API errors as a JSON string
// (e.g. '{"error":{"message":"..."}}'); pull out the human-readable message.
function cleanFailure(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    /* not JSON — fall through */
  }
  return raw;
}

// Map our effort ladder onto Codex's. "max" has no Codex equivalent, so clamp
// it to the highest Codex tier.
function mapEffort(effort: Effort): ModelReasoningEffort {
  switch (effort) {
    case "low":
      return "low";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "high";
    case "medium":
    default:
      return "medium";
  }
}

export class CodexProvider implements AgentProvider {
  async *runTurn(opts: RunTurnOptions): AsyncGenerator<string, TurnResult, void> {
    const codex = await getClient();

    // Codex has no dedicated system-prompt channel like the Claude Agent SDK,
    // so the persona is folded into each turn's input. Codex keeps thread
    // history across resumes, but re-stating the persona every turn mirrors
    // Claude's per-query systemPrompt semantics and keeps persona adherence
    // robust — including on resumed threads.
    const input = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
      : opts.prompt;

    // opts.memoryWriteTool (see providers/types.ts) is deliberately unused here:
    // `@openai/codex-sdk`'s ThreadOptions has no mechanism for the calling
    // process to register a custom tool, so Codex-provider turns never get the
    // in-process memory.write tool ClaudeProvider wires in — the tool is
    // Claude-only until/unless the SDK adds an equivalent surface.
    //
    // NOTE: this does NOT actually disable Codex's tools — `@openai/codex-sdk`'s
    // `ThreadOptions` has no option to disable the model's built-in exec/file/patch
    // tools; `sandboxMode`/`approvalPolicy` only constrain what those tools may DO
    // (read-only fs, no interactive approval), unlike `ClaudeProvider`'s
    // `allowedTools: []`, which genuinely removes tool access. So: sandboxed and
    // unattended, not "no tools" — a Codex turn can still autonomously invoke
    // read-only shell/file tools (report §2.5).
    //
    // Each turn gets its own freshly-created temp directory instead of the shared,
    // system-wide `os.tmpdir()` root, so a read-only `ls`/`cat` invoked by the model
    // can't enumerate/read whatever other applications leave in the OS temp dir.
    const turnDir = fs.mkdtempSync(path.join(os.tmpdir(), "cofounder-codex-"));
    try {
      const threadOptions: ThreadOptions = {
        workingDirectory: turnDir,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        model: opts.model,
        modelReasoningEffort: mapEffort(opts.effort),
      };

      const thread = opts.resumeSessionId
        ? codex.resumeThread(opts.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);

      const abortController = new AbortController();
      const timer = opts.timeoutMs ? setTimeout(() => abortController.abort(), opts.timeoutMs) : null;

      let sessionId: string | null = opts.resumeSessionId ?? null;
      let usage: UsagePayload = { ...ZERO_USAGE };
      let failure: string | null = null;
      // Only set true inside the turn.completed case below — previously `success` was
      // unconditionally `true` unless an exception was thrown or a terminal event set
      // `failure`. If the event stream ended quietly with neither (SDK/CLI version
      // skew, a stream-ending edge case the SDK doesn't surface as an error), the
      // caller got `success:true` with zero usage — indistinguishable from a real,
      // empty, successful turn (report §3.1 / Part 0 #7).
      let completed = false;

      // The SDK surfaces a failed turn via turn.failed/error events and then
      // throws from the event stream when the underlying `codex` process exits
      // non-zero. Capture the (cleaner) event message so we can rethrow it in a
      // readable form; a bare throw from the stream carries only raw CLI stderr.
      try {
        const { events } = await thread.runStreamed(input, { signal: abortController.signal });
        for await (const event of events as AsyncGenerator<ThreadEvent>) {
          switch (event.type) {
            case "thread.started":
              sessionId = event.thread_id;
              break;
            case "item.completed":
              if (event.item.type === "agent_message" && event.item.text) {
                yield event.item.text;
              }
              break;
            case "turn.completed":
              completed = true;
              usage = {
                inputTokens: event.usage.input_tokens ?? 0,
                outputTokens: event.usage.output_tokens ?? 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: event.usage.cached_input_tokens ?? 0,
              };
              break;
            case "turn.failed":
              failure = cleanFailure(event.error.message);
              break;
            case "error":
              failure = cleanFailure(event.message);
              break;
          }
          // Stop consuming once a terminal outcome is known instead of processing
          // further (likely irrelevant) events (report §3.8).
          if (failure || completed) break;
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          throw new Error(`Codex turn timed out after ${opts.timeoutMs}ms`, { cause: err });
        }
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
        const message = failure ?? (err instanceof Error ? err.message : String(err));
        throw new Error(code ? `${message} (${code})` : message, { cause: err });
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (failure) throw new Error(failure);
      if (!completed) {
        throw new Error("Codex turn ended without a completion or failure event — the CLI may have exited unexpectedly");
      }

      return {
        sessionId: thread.id ?? sessionId,
        success: true,
        // The Codex SDK does not report a cost estimate; token counts are the
        // reliable figures (consistent with how Claude cost is treated).
        usage,
        totalCostUsd: 0,
      };
    } finally {
      fs.rm(turnDir, { recursive: true, force: true }, () => {});
    }
  }
}
