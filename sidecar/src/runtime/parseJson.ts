/**
 * Pulls a JSON payload out of a model's free-form reply — the model is asked for
 * raw JSON but often wraps it in a ```json fence or a sentence or two. Prefers a
 * fenced block, then falls back to the outermost `{...}` / `[...]` span.
 *
 * Shared by every "ask the model for structured output" caller (onboarding
 * suggestions, candidate generation) so the extraction rules stay identical.
 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];

  // Take whichever of the first `{` or `[` appears earliest, paired with its last
  // matching close, so both object and array top-level payloads are handled.
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const candidates = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (candidates.length === 0) return text;
  const start = Math.min(...candidates);
  const close = text[start] === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : text;
}
