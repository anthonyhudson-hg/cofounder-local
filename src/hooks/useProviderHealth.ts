import { useCallback, useEffect, useRef, useState } from "react";
import { query } from "../lib/runtimeClient";

export interface ProviderStatus {
  provider: "claude" | "codex";
  label: string;
  available: boolean;
  detail: string;
}

export interface ProviderHealth {
  anyAvailable: boolean;
  providers: ProviderStatus[];
}

interface UseProviderHealth {
  /** The last successful result, or null until one resolves. */
  health: ProviderHealth | null;
  loading: boolean;
  /**
   * Set when the health query itself failed (runtime not responding / timed
   * out). Distinct from `health` so the UI can show a retryable error instead
   * of silently proceeding — see below.
   */
  error: string | null;
  recheck: () => Promise<void>;
}

/**
 * Preflight: asks the runtime whether any agent provider is authenticated. The
 * app hard-gates on this (see App.tsx) so a user without Claude/Codex set up
 * gets clear setup instructions immediately instead of onboarding a whole
 * company and only hitting the wall on their first message.
 *
 * If the query itself fails (the runtime is still coming up, unresponsive, or
 * the call times out) we surface `error` rather than fabricating a healthy
 * result. The previous version collapsed every failure into
 * `{ anyAvailable: true }`, which meant a Re-check against a dead runtime
 * silently dropped the user into onboarding that then died on the first
 * message — exactly the failure this gate exists to prevent. The caller decides
 * what to do with `error` (App shows a retry surface).
 */
export function useProviderHealth(): UseProviderHealth {
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic id of the most recently STARTED request: only it may commit a
  // result. Stops a slow in-flight check from clobbering a newer Re-check
  // (latest-wins) and, together with mountedRef, from setting state after
  // unmount.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const recheck = useCallback(async () => {
    const id = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await query<ProviderHealth>("providers.health", {}, null);
      if (!mountedRef.current || id !== requestIdRef.current) return;
      setHealth(result);
    } catch (err) {
      if (!mountedRef.current || id !== requestIdRef.current) return;
      // Genuinely unknown — surface it as a retryable error, never as a fake
      // "all good" that would fail open into broken onboarding.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current && id === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  return { health, loading, error, recheck };
}
