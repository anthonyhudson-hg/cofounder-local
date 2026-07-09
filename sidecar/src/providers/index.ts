import { AgentProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { CodexProvider } from "./codex";

// Both providers are constructed lazily on first use (symmetric — neither is built
// until a request actually routes to it).
let claude: ClaudeProvider | null = null;
let codex: CodexProvider | null = null;

/**
 * Resolve the backend for a request. Defaults to Claude when the provider is
 * absent or unrecognized, so any caller that omits it behaves exactly as before.
 */
export function getProvider(name: string | null | undefined): AgentProvider {
  if (name === "codex") {
    return (codex ??= new CodexProvider());
  }
  if (name != null && name !== "claude") {
    // A typo'd/stale provider value (e.g. "Codex" with a capital C, trailing
    // whitespace) used to silently route to Claude with zero indication — a user
    // could believe they're talking to Codex the whole time while every response
    // actually comes from (and is billed/counted against) Claude (report §3.8).
    process.stderr.write(`[providers] unrecognized provider "${name}", falling back to claude\n`);
  }
  return (claude ??= new ClaudeProvider());
}

export * from "./types";
