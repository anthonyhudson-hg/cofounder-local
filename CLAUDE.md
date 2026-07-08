# Cofounder

Desktop app: React + TypeScript + Tauri (Rust) + SQLite (`tauri-plugin-sql`). Slack-style UI with a `#general` channel and a `Chief of Staff` DM backed by a pluggable **agent provider** (Claude or Codex), run from a Node.js sidecar spawned automatically by the Rust backend. All config (system prompt, default model/effort) lives in the `settings` SQLite table, not in files.

## Multi-provider architecture

Each employee's `default_model` picks both the model and, via the model registry, the **provider** (`src/types.ts` `MODELS[].provider` + `modelProvider()`). The provider string flows end-to-end: frontend → Rust `cos_*` commands (`provider: Option<String>`, defaults to Claude when absent) → sidecar. The Rust layer is a provider-agnostic transport; only the sidecar binds to a backend.

- **Sidecar provider seam:** `sidecar/src/providers/` — `AgentProvider.runTurn()` yields text chunks and returns `{sessionId, success, usage, totalCostUsd}`. `ClaudeProvider` wraps `@anthropic-ai/claude-agent-sdk`'s `query()` (behavior unchanged from the original single-provider code); `CodexProvider` wraps `@openai/codex-sdk`. `getProvider(name)` defaults to Claude. Handlers in `sidecar/src/index.ts` are provider-agnostic (they call `drainTurn`).
- **Codex specifics:** the SDK is ESM-only, so it's loaded via a `new Function`-guarded dynamic `import()` to survive the CommonJS downlevel. Codex has no system-prompt channel, so the persona is folded into each turn's input. Effort maps onto Codex's ladder (`max`→`high`). Codex reports no cost (`totalCostUsd: 0`); token counts are exact. Runs `sandboxMode: "read-only"`, `approvalPolicy: "never"` in `os.tmpdir()` since these agents are chat-only (no tools). Requires the **`codex` CLI installed and on PATH**, authed via `codex login` (ChatGPT) or `OPENAI_API_KEY` — the same local-subscription shape as Claude Code.
- **Sessions are provider-owned.** `conversations.session_id`/`agent_sessions.session_id` are opaque handles that only resume with the provider that minted them. Both tables carry a `session_provider` column (migration 13); the frontend drops `resumeSessionId` when the selected provider differs from the stored one, starting a fresh thread instead. `check_relevance` is always a cheap internal Claude call regardless of the employee's chat provider.

## Tech debt

- **Sidecar is not yet a bundled single-exe sidecar.** The Rust backend (`src-tauri/src/sidecar.rs`) currently spawns the Chief of Staff sidecar via a plain `node sidecar/dist/index.js` call, resolved relative to the source tree at dev time. This works for local dev but has two consequences for shipping a standalone `.exe` to another machine:
  1. It requires a system-installed `node` on the target machine.
  2. `sidecar/dist` + its `node_modules` (`@anthropic-ai/claude-agent-sdk` and, for the Codex provider, `@openai/codex-sdk`) aren't yet wired up as bundled Tauri resources, so `resolve_sidecar_script()`'s `resource_dir()` lookup will fail in a release build. The Codex path additionally needs the `codex` CLI present on the target machine (the SDK shells out to it and does not bundle a binary).

  **Fix path when ready to ship**: compile `sidecar/src/index.ts` into a real standalone binary (e.g. via `@yao-pkg/pkg`, already confirmed to work in this environment) and register it as a proper Tauri `externalBin` sidecar in `tauri.conf.json`, replacing the `Command::new("node")` call in `sidecar.rs`. Until then, this only blocks producing a distributable build for other machines — it does not block local development or use.

- **`total_cost_usd` is a client-side estimate, not real billing.** The Claude Agent SDK computes it from a bundled local price table regardless of auth method (API key vs. Claude subscription/OAuth), and that table may not yet have accurate pricing for newest models. Treat the "~$X est." figure shown per-message as directional only, not authoritative — token counts (input/output/cache) are the reliable numbers.
