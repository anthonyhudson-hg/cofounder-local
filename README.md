# Cofounder

A local-first desktop app that gives a solo founder (or small team) a company of AI
"employees." It looks and feels like Slack — a `#general` channel, a `Chief of Staff`
DM, hireable teammates with their own roles, models, and personalities — but every
member is an autonomous agent backed by a pluggable provider (Claude or OpenAI Codex).

Everything runs on your machine: there is no server, no account, and no data leaves
the device except the calls each agent makes to its own provider (using your existing
Claude Code / ChatGPT login or API key).

## Stack

- **UI** — React 19 + TypeScript + Vite, packaged with **Tauri 2** (Rust shell).
- **Runtime** — a single Node.js sidecar process, spawned by the Rust backend, that
  owns SQLite outright (`better-sqlite3` + Kysely) and runs the entire turn loop for
  both DMs and channels. Frontend and runtime talk over a typed Command/Query/Event/
  Delta protocol (newline-delimited JSON over stdio).
- **Providers** — `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`, each
  vendoring its own platform binary (no system CLI install required).
- **Storage** — SQLite in the app config directory; secrets in the OS keychain with an
  encrypted-file fallback.

## Getting started (development)

Prerequisites: Node.js 20+, Rust (stable), and the Tauri prerequisites for your OS.

```bash
npm install
npm --prefix sidecar install
npm run tauri dev      # launches the app; Rust spawns the sidecar automatically
```

To use the agents you must be authenticated with at least one provider — `claude login`
(or `ANTHROPIC_API_KEY`) and/or `codex login` (or `OPENAI_API_KEY`). The app hard-gates
its UI behind a provider-health check and tells you what's missing on first launch.

Common scripts:

```bash
npm run build          # typecheck + build the frontend
npm test               # run the frontend + runtime test suites (vitest)
npm run lint           # eslint
npm --prefix sidecar run build && npm --prefix sidecar test   # runtime only
```

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — the architecture of record: runtime protocol, domain
  layout, the turn loop, the multi-provider seam, packaging, and known tech debt. Read
  this first before changing anything non-trivial.
- **[RELEASING.md](./RELEASING.md)** — how to cut a Windows release (version bump,
  build, sign, publish the auto-update artifacts).

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/` | React frontend (components, hooks, lib, stores) |
| `sidecar/src/` | Node runtime: domains, providers, db, tools, secrets, connectors |
| `src-tauri/` | Rust/Tauri shell, capabilities, bundle config |
| `shared/protocol.d.ts` | The Command/Query/Event/Delta wire contract |
| `scripts/` | Build tooling (portable-Node fetch, installer assets) |
| `persona_examples/` | Reference persona writing samples (design reference; not loaded at runtime) |
