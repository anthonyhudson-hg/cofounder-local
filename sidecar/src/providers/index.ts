import { AgentProvider } from "./types";
import { ClaudeProvider } from "./claude";
import { CodexProvider } from "./codex";

const claude = new ClaudeProvider();
let codex: CodexProvider | null = null;

/**
 * Resolve the backend for a request. Defaults to Claude when the provider is
 * absent or unrecognized, so any caller that omits it behaves exactly as before.
 */
export function getProvider(name: string | null | undefined): AgentProvider {
  if (name === "codex") {
    return (codex ??= new CodexProvider());
  }
  return claude;
}

export * from "./types";
