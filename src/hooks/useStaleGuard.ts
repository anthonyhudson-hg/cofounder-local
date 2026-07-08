import { useCallback, useMemo, useRef } from "react";

/**
 * Guards against out-of-order async responses clobbering fresher state — e.g. switching
 * companies/conversations quickly enough that an older `reload()` call resolves after a
 * newer one it was superseded by (report §1.3). None of the list/detail hooks in this
 * app remount per id, so a plain `useEffect(() => { reload() }, [id])` has no built-in
 * protection against this; call `begin()` right before the async fetch and check
 * `isCurrent(token)` before committing its result.
 *
 * Usage:
 *   const { begin, isCurrent } = useStaleGuard();
 *   const reload = useCallback(async () => {
 *     const token = begin();
 *     const rows = await query(...);
 *     if (!isCurrent(token)) return; // a newer reload has since started
 *     setState(rows);
 *   }, [begin, isCurrent, ...]);
 */
export function useStaleGuard() {
  const gen = useRef(0);
  const begin = useCallback(() => ++gen.current, []);
  const isCurrent = useCallback((token: number) => token === gen.current, []);
  // Memoized so the returned object itself is referentially stable across renders —
  // callers may reasonably put it directly in a useCallback/useEffect dependency array.
  return useMemo(() => ({ begin, isCurrent }), [begin, isCurrent]);
}
