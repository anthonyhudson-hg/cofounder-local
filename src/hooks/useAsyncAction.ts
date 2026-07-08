import { useCallback, useState } from "react";

export interface AsyncActionState {
  busy: boolean;
  error: string | null;
}

/**
 * Wraps an async action (e.g. a modal's "Create"/"Delete" handler) so a thrown/rejected
 * failure is captured into `error` instead of being silently swallowed by a bare
 * `try { } finally { setBusy(false) }` — the single most repeated bug in the codebase
 * review (report §1.2): busy state cleared, no message, user has no idea it failed.
 *
 * Usage: const [run, { busy, error }, clearError] = useAsyncAction(handler);
 *        <button disabled={busy} onClick={() => run(arg)}>...</button>
 *        {error && <p className="form-error">{error}</p>}
 */
export function useAsyncAction<Args extends unknown[], R>(
  action: (...args: Args) => Promise<R>,
): [(...args: Args) => Promise<R | undefined>, AsyncActionState, () => void] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (...args: Args) => {
    setBusy(true);
    setError(null);
    try {
      return await action(...args);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [action]);

  const clearError = useCallback(() => setError(null), []);

  return [run, { busy, error }, clearError];
}
