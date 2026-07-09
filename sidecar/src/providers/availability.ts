import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderName } from "./types";

/**
 * Which agent providers are configured on this machine, and — given that — which
 * one internal/default work should use. This is the single source of truth for
 * "the app should run on whatever is available" so no flow silently hardcodes
 * Claude (the seeded Chief of Staff, onboarding/candidate generation, and the
 * channel relevance gate all route through here).
 *
 * Detection is a cheap, offline inspection of env vars + the CLIs' credential
 * files. It's deliberately the same signal `health/service.ts` uses for its
 * fast path; the health check additionally confirms a *negative* with a live
 * ping before blocking the user, but for picking a default a positive signal is
 * all we need.
 */

export interface Presence {
  available: boolean;
  /** Human phrase describing the signal we found (empty when none). */
  via: string;
}

export function claudePresence(): Presence {
  if (process.env.ANTHROPIC_API_KEY) return { available: true, via: "ANTHROPIC_API_KEY environment variable" };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { available: true, via: "CLAUDE_CODE_OAUTH_TOKEN environment variable" };
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { available: true, via: "ANTHROPIC_AUTH_TOKEN environment variable" };
  if (fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json"))) {
    return { available: true, via: "Claude Code login" };
  }
  return { available: false, via: "" };
}

export function codexPresence(): Presence {
  if (process.env.OPENAI_API_KEY) return { available: true, via: "OPENAI_API_KEY environment variable" };
  if (fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"))) {
    return { available: true, via: "Codex login" };
  }
  return { available: false, via: "" };
}

export function detectProviders(): Record<ProviderName, boolean> {
  return { claude: claudePresence().available, codex: codexPresence().available };
}

/**
 * The provider to use for default/internal work when the caller hasn't chosen
 * one. Prefers Claude when both are configured — it's the richer integration
 * (in-process tools, and a cheaper dedicated model for the relevance gate) — and
 * falls back to Claude when neither is detected (nothing will run in that state
 * anyway; the launch gate blocks it, and the provider seam defaults to Claude
 * everywhere else too).
 */
export function preferredProvider(): ProviderName {
  const detected = detectProviders();
  if (detected.claude) return "claude";
  if (detected.codex) return "codex";
  return "claude";
}

/** Default chat model a newly-created employee is seeded with, per provider. */
export const DEFAULT_CHAT_MODEL: Record<ProviderName, string> = {
  claude: "claude-sonnet-5",
  // gpt-5.5 is the broadly-available tier (ChatGPT-account logins); the
  // codex-native variants need a Codex/Business plan. Default to the one most
  // users can actually run.
  codex: "gpt-5.5",
};

/** Model for internal persona/suggestion generation (onboarding, candidates). */
export const UTILITY_MODEL: Record<ProviderName, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.5",
};

/** Cheap model for the per-member channel relevance decision. */
export const RELEVANCE_MODEL: Record<ProviderName, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-5.5",
};
