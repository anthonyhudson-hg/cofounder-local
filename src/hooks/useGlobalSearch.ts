import { useEffect, useState } from "react";
import { query } from "../lib/runtimeClient";
import { EMPTY_SEARCH_RESULTS, GlobalSearchResults } from "../lib/search";

const DEBOUNCE_MS = 150;

/**
 * Debounced global search. Returns results for the current `q` (empty query =>
 * empty results, no round-trip). Stale in-flight responses are dropped so fast
 * typing never flashes an older query's results.
 */
export function useGlobalSearch(companyId: string | null, q: string) {
  const [results, setResults] = useState<GlobalSearchResults>(EMPTY_SEARCH_RESULTS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const trimmed = q.trim();
    if (!trimmed || !companyId) {
      setResults(EMPTY_SEARCH_RESULTS);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      query<GlobalSearchResults>("search.global", { q: trimmed }, companyId)
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults(EMPTY_SEARCH_RESULTS);
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [companyId, q]);

  return { results, loading };
}
