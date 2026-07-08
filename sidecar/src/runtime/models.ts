/**
 * Server-side fork of src/types.ts's MODELS[] id -> provider mapping. Needed
 * now that channel-send resolves each member's provider from their stored
 * `default_model` itself (no client in the loop computing it per-turn, unlike
 * the DM send path where the frontend still passes `provider` alongside the
 * user-chosen `model`). Must be kept in sync with src/types.ts MODELS[] by
 * hand — the two can't share a module across the browser/Node split without a
 * shared workspace package, same tradeoff already accepted for
 * runtime/promptBuilder.ts and runtime/mentions.ts (report §1.7).
 */

export type ModelProviderName = "claude" | "codex";

const MODEL_PROVIDERS: Record<string, ModelProviderName> = {
  "claude-sonnet-5": "claude",
  "claude-opus-4-8": "claude",
  "claude-haiku-4-5-20251001": "claude",
  "claude-fable-5": "claude",
  "gpt-5.5": "codex",
  "gpt-5.1-codex": "codex",
  "gpt-5-codex": "codex",
};

/** Which backend owns a model id. Defaults to Claude for unknown ids. */
export function modelProvider(modelId: string | null | undefined): ModelProviderName {
  if (!modelId) return "claude";
  return MODEL_PROVIDERS[modelId] ?? "claude";
}
