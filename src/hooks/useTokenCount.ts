import { useEffect, useState } from "react";
import { query } from "../lib/runtimeClient";
import { modelProvider } from "../types";
import { useStaleGuard } from "./useStaleGuard";

/** Ported from the legacy `cos_count_tokens` sidecar call (full cutover) to the
 * runtime's `tokenCount.count` query. */
export function useTokenCount(text: string, model: string) {
  const [tokens, setTokens] = useState<number | null>(null);
  const [exact, setExact] = useState(true);
  const { begin, isCurrent } = useStaleGuard();

  useEffect(() => {
    const handle = setTimeout(async () => {
      const token = begin();
      try {
        const result = await query<{ tokens: number; exact: boolean }>(
          "tokenCount.count",
          { provider: modelProvider(model), model, systemPrompt: text },
          null,
        );
        if (!isCurrent(token)) return;
        setTokens(result.tokens);
        setExact(result.exact);
      } catch {
        // Timed out or the runtime rejected the request: don't leave the UI implying
        // a stale count is current — mark it approximate instead (report §5.9).
        if (isCurrent(token)) setExact(false);
      }
    }, 500);

    return () => clearTimeout(handle);
  }, [text, model, begin, isCurrent]);

  return { tokens, exact };
}
