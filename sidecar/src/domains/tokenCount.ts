import Anthropic from "@anthropic-ai/sdk";

/**
 * Ported from the legacy sidecar's handleCountTokens (full cutover — this used
 * to be a standalone `cos_count_tokens` Tauri command hitting the legacy
 * process). Exact counting is Anthropic-specific and requires
 * ANTHROPIC_API_KEY; Codex users and Claude users authenticated only via
 * Claude Code's local subscription/OAuth (the primary auth path, not an API
 * key) fall back to a length-based approximation — this figure is only a
 * system-prompt size indicator either way.
 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function countTokens(input: {
  provider?: string | null;
  model: string;
  systemPrompt: string;
}): Promise<{ tokens: number; exact: boolean }> {
  const text = input.systemPrompt ?? "";
  if (!text.trim()) return { tokens: 0, exact: true };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (input.provider === "codex" || !apiKey) {
    return { tokens: approxTokens(text), exact: false };
  }

  try {
    const client = new Anthropic({ apiKey });
    const result = await client.messages.countTokens({
      model: input.model,
      system: text,
      messages: [{ role: "user", content: " " }],
    });
    return { tokens: result.input_tokens, exact: true };
  } catch {
    return { tokens: approxTokens(text), exact: false };
  }
}
