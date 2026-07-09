import { getProvider, drainTurn, type AgentProvider, type ProviderName } from "../../providers";
import { claudePresence, codexPresence } from "../../providers/availability";

/** Test seam: override presence detection and provider resolution so the ping
 *  paths can be exercised without spawning a real provider binary. */
export interface HealthDeps {
  claudePresence?: () => { available: boolean; via: string };
  codexPresence?: () => { available: boolean; via: string };
  getProvider?: (name: ProviderName) => AgentProvider;
}

/**
 * Preflight provider availability check. The app is unusable if NO agent
 * provider is authenticated — every employee's turn (and onboarding/candidate
 * generation) goes through whichever provider is configured — so we surface this
 * at launch and hard-gate the UI on it instead of letting the user onboard a
 * whole company and only discover the problem when their first message dies with
 * a raw "process exited with code 1" (which is exactly what an unauthenticated
 * provider produces).
 */

export interface ProviderStatus {
  provider: ProviderName;
  /** Human label for the setup screen. */
  label: string;
  available: boolean;
  /** How availability was detected, or the reason it's unavailable. */
  detail: string;
}

export interface ProviderHealth {
  anyAvailable: boolean;
  providers: ProviderStatus[];
}

// Presence detection (env vars + credential files) is the fast path here: a
// positive result short-circuits the costly live ping, and a negative result is
// confirmed by a ping before we ever block the user, so a credential stored
// somewhere we don't inspect can't wrongly lock them out. Shared with the
// provider-selection logic in providers/availability.ts.

// Model to ping per provider — the ping only needs a valid turn, not a real
// answer. Codex uses gpt-5.5 (the tier a plain ChatGPT-account login can run):
// pinging a plan-gated codex-native model would fail auth-independent and
// wrongly report Codex unavailable.
const PING_MODELS: Record<ProviderName, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-5.5",
};
// Kept comfortably under runtimeClient's 30s query timeout even with both pings
// racing in parallel.
const PING_TIMEOUT_MS = 12_000;

/**
 * Definitive check: run a trivial real turn. An unauthenticated provider fails
 * fast here (the vendored CLI exits non-zero), which is exactly what we want to
 * catch — and when it does fail we get the provider's own error message to show.
 */
async function ping(
  provider: ProviderName,
  resolveProvider: (name: ProviderName) => AgentProvider,
): Promise<{ ok: boolean; error: string }> {
  try {
    const result = await drainTurn(
      resolveProvider(provider).runTurn({
        model: PING_MODELS[provider],
        effort: "low",
        systemPrompt: "",
        prompt: "Reply with the single word: ok",
        timeoutMs: PING_TIMEOUT_MS,
      }),
      () => {},
    );
    if (result.success) return { ok: true, error: "" };
    return { ok: false, error: result.errorMessage ?? "the provider reported a failure" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function status(provider: ProviderName, available: boolean, detail: string): ProviderStatus {
  return { provider, label: provider === "claude" ? "Claude" : "OpenAI Codex", available, detail };
}

export async function checkProviderHealth(deps: HealthDeps = {}): Promise<ProviderHealth> {
  const resolveProvider = deps.getProvider ?? getProvider;
  const claude = (deps.claudePresence ?? claudePresence)();
  const codex = (deps.codexPresence ?? codexPresence)();

  // Fast path: if inspection already found a credential for either provider the
  // app is usable — don't spend a live turn (and don't spawn the other
  // provider's binary) just to fill in per-provider detail the gate won't show.
  if (claude.available || codex.available) {
    return {
      anyAvailable: true,
      providers: [
        status("claude", claude.available, claude.available ? `Detected via ${claude.via}.` : "Not configured on this machine."),
        status("codex", codex.available, codex.available ? `Detected via ${codex.via}.` : "Not configured on this machine."),
      ],
    };
  }

  // Nothing detected — confirm with real pings before blocking, so we neither
  // wrongly lock out a working install nor show the gate without the provider's
  // own diagnostic message.
  const [claudePing, codexPing] = await Promise.all([ping("claude", resolveProvider), ping("codex", resolveProvider)]);
  const providers = [
    status("claude", claudePing.ok, claudePing.ok ? "Reachable." : claudePing.error),
    status("codex", codexPing.ok, codexPing.ok ? "Reachable." : codexPing.error),
  ];
  return { anyAvailable: providers.some((p) => p.available), providers };
}
