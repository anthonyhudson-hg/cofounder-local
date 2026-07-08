# Cofounder — Full Repository Code Review

Scope: every source file in the repo (sidecar TS, frontend TS/TSX, Rust, build/config). Reviewed by area, cross-checked, and deduplicated below. This is a single-user local desktop app (Tauri + React + Node sidecar + SQLite), so multi-tenancy/GDPR/PCI/k8s-shaped checks are skipped as N/A — but "single-user" does not mean "no security surface": this app runs autonomous AI agents that can invoke tools (including `git push` with a stored PAT), renders AI-generated markdown, and shells out to a Node subprocess. Treat it accordingly.

Severity key: **CRITICAL** (data loss / total feature death) · **HIGH** (real, reproducible bug with user-visible harm) · **MEDIUM** (real bug, narrower blast radius) · **LOW** (correctness/quality issue, small impact) · **NIT** (polish).

---

## Part 0 — If you fix nothing else, fix these

1. [x] **DONE** — **Every sidecar/runtime IPC call can hang forever, with zero timeout, anywhere in the stack.** (§1.1)
2. [x] **DONE** — **The vault's fallback master key gets written to the OS temp directory.** Wipe temp, lose every secret permanently. (§2.1)
3. **The GitHub tool lets an agent point `git add -A && git push` at any directory on disk and exfiltrate it with a stored PAT**, and the human approval prompt shows raw JSON, not a diff. (§2.2)
4. [x] **DONE** — **CSP is fully disabled** (`"csp": null`) in an app that renders LLM-generated (and thus prompt-injectable) markdown. (§2.3)
5. [x] **DONE** — **Manager-cycle validation is cosmetic.** The frontend blocks direct-report cycles only; the backend validates nothing. A 2+ hop cycle (A→C→B→A) is fully achievable and makes employees vanish from the org chart with no error. (§4.1)
6. **The sidecar/runtime child processes have no crash detection, no restart, and can be orphaned on app exit.** One crash = silently dead AI chat for the rest of the session, surfaced only as a raw broken-pipe error. (§4.2)
7. **Codex's "no tools" sandboxing claim is false**, and `CodexProvider.runTurn` unconditionally reports `success: true` even when nothing observably succeeded. (§4.3, §4.4)
8. [x] **DONE** — **`MessageList` re-renders every message row on every streamed token.** No memoization anywhere in the hot path. (§6.1)
9. [x] **DONE** — **Six-plus UI actions (create/clone/delete company, create channel/group, hire, onboarding generate/finish) swallow errors silently** — `try { } finally { setBusy(false) }` with no `catch`, anywhere. (§1.2)

---

## Part 1 — Systemic / Cross-Cutting Issues

These patterns repeat across many files. Fix the pattern once instead of patching each call site.

### 1.1 — No timeout anywhere in the sidecar/runtime request-response layer — CRITICAL — ✅ DONE

**Fix applied:** `sidecarBus.ts`'s `registerRequestHandler` now arms a per-id idle timer (default 90s) that resets on every event delivered for that id (including `delta`), and synthesizes a `{type:"error"}` event + auto-unregisters on expiry instead of hanging forever; `sidecarRequest.ts`'s `invokeAndWait` takes an explicit `timeoutMs` (30s for relevance checks, 120s for a full channel turn). `runtimeClient.ts`'s `send()`/`command()`/`query()` got the equivalent treatment (30s default, 120s idle-reset for `commandStreaming`), plus per-listener try/catch isolation in the event dispatch loop. `useChannel.ts` and `useConversation.ts` were also fixed for the related §1.2 issue (see below) since a timeout without error handling just turns a hang into an unhandled rejection.

**Where:** `src/lib/runtimeClient.ts` (`pending` map, lines ~90-98), `src/lib/sidecarBus.ts` (`registerRequestHandler`, lines ~43-49), `src/lib/sidecarRequest.ts` (`invokeAndWait`, lines 4-19), and downstream every caller: `useChannel.ts` (relevance-check `Promise.all`, lines 100-118 and the send flow, 134-214), `useConversation.ts` (streaming send, 174-183), `useTokenCount.ts` (11-33), `src-tauri/src/sidecar.rs` (`write_request`/`send_to_runtime` have no read-side timeout either).

**Failure scenario:** the sidecar or runtime process hangs, crashes without flushing a final message, or simply never emits a matching response id (a real risk given `sidecar/src/runtime/index.ts` can drop the `id` field entirely on a malformed inbound message — see §3.3). The awaiting promise on the frontend never resolves or rejects. `sending`/loading flags get stuck `true` forever. The most concrete instance: `useChannel.send()`'s relevance-check `Promise.all` (one `cos_check_relevance` call per channel member) hangs the *entire send flow* for that channel if even one member's relevance check never returns — with no error, no way to retry short of restarting the app.

**Fix:** add a per-request timeout (30-60s) at the lowest common layer — `runtimeClient.ts`'s `send()` and `sidecarRequest.ts`'s `invokeAndWait()` — that rejects with a clear "no response from sidecar" error. Every caller already either has or should have a `catch` (see §1.2) to turn that into a visible error state instead of an infinite spinner.

### 1.2 — Systemic missing error handling on fire-and-forget async UI actions — HIGH — ✅ DONE

**Fix applied:** added a shared `useAsyncAction` hook (`src/hooks/useAsyncAction.ts`) that captures a thrown/rejected error into state instead of a bare `try/finally`, plus a `.form-error` CSS class to render it. Applied to every call site listed: `Sidebar.tsx` (create channel), `CompanySwitcher.tsx` (create/clone), `AppSettingsModal.tsx` (photo upload, delete), `EmployeeSettingsPanel.tsx` (photo upload, via the new shared `usePhotoUpload` hook), `GroupModal.tsx` (create), `HireModal.tsx` (fetch candidates — now with a Retry button — and hire), `OnboardingWizard.tsx` (generate/finish/skip). `useChannel.ts`/`useConversation.ts` got the equivalent treatment as part of §1.1 since their failure modes were the same root cause. `App.tsx`'s own handlers (`handleSwitchCompany` etc.) were left to propagate — that's correct, since the catch now lives at each actual call site closest to the UI feedback surface.

**Where (non-exhaustive, same bug repeated ~10+ times):**
- `src/App.tsx`: `handleSwitchCompany`, `handleCloneCompany`, `handleDeleteCompany`, `handleCreateChannel`, and inline `onCreated`/`onCreate`/`onRename` modal callbacks (lines 85-107, 267-314)
- `AppSettingsModal.tsx`: photo upload (47-58), delete company (162-163)
- `EmployeeSettingsPanel.tsx`: photo upload (181-192, byte-for-byte duplicate of the above)
- `CompanySwitcher.tsx`: create/clone (50-63, 65-75)
- `GroupModal.tsx`: create (37-48)
- `HireModal.tsx`: fetch candidates (52-65, no retry path either), hire (67-81)
- `OnboardingWizard.tsx`: generate (54-70), finish (72-91) — see §5.1 for the resulting dead-end screen
- `useChannel.ts`: `agentSession.upsert`/`reaction.add`/`message.insertChannelAssistant` calls inside `send()` (134-214) — an uncaught throw here leaves `sending: true` forever
- `useConversation.ts`: same shape inside the streaming "done" handler (137-172)

**Failure scenario:** any IPC/DB failure (lock contention, disk full, sidecar hiccup) resets the busy flag via `finally` but shows the user *nothing*. The button goes back to normal, the modal doesn't close, there's no error text — the user has no way to distinguish "it worked" from "it silently failed" and will likely retry into the same failure.

**Fix:** this is exactly the shape of a shared hook. Write one `useAsyncAction()` (or a thin wrapper around `command()`/`query()`) that captures thrown errors into a returned `{ error, run, busy }` triple, and migrate every one of the above call sites to it. Stop patching this file-by-file.

### 1.3 — Async "reload" race conditions (stale response overwrites fresh state) — HIGH — ✅ DONE

**Fix applied:** added a shared `useStaleGuard` hook (`src/hooks/useStaleGuard.ts`) — `begin()`/`isCurrent(token)` around a generation counter — and applied it to every reload function listed: `useConversations`, `useEmployees`, `useDepartments`, `useEmployee`, `useActiveCompany`, `useCompanies`, and `useChannel`/`useConversation` (separate guards per reload target — messages, members, reactions — so an unrelated concurrent fetch can't spuriously invalidate a different one). An out-of-order response now gets silently discarded instead of committing stale state over fresher state.

**Where:** `useConversations.ts` (9-23), `useEmployees.ts`, `useDepartments.ts`, `useEmployee.ts`, `useActiveCompany.ts`, `useCompanies.ts`, `useChannel.ts` (41-52), `useConversation.ts` (44-54) — essentially every list/detail hook that reloads on an id/company change.

**Failure scenario:** none of these hooks are remounted per-conversation/per-company (confirmed: `ChatPane` renders without a `key`, and `useConversations`/`useEmployees`/etc. mount once at `App.tsx`'s top level). A `reload()` closure captures the id at creation time and unconditionally calls `setState(rows)` when its promise resolves — with no guard comparing "is this response still for the currently-selected id." Click company A, then B before A's `conversations.list` resolves, and A's slower response can land after B's, transiently showing company A's channel list while `companyId` state already says B. This is a real, easily user-triggered bug in a Slack-style UI meant for rapid switching, not a theoretical race. `React.StrictMode`'s double-invoked effects make it easy to hit in dev, too.

**Fix:** every reload closure needs to check staleness before committing state — either an incrementing generation counter compared at commit time, or an `AbortController` per request, keyed on the id that triggered the fetch.

### 1.4 — No runtime validation at any IPC/command dispatch boundary — MEDIUM
**Where:** `sidecar/src/domains/register.ts` (every one of ~40 handlers does `inbound as CommandEnvelope<...>` or uses the `p<T>()` helper — both are compile-time-only casts), `sidecar/src/runtime/dispatch.ts` (26-34, blindly interpolates `${inbound.kind}:${inbound.type}`), `sidecar/src/tools/registry.ts`/`types.ts` (tool `input: unknown` never schema-checked before `tool.run()`), `src-tauri/src/sidecar.rs`'s `send_to_runtime` (459-472, forwards arbitrary `serde_json::Value` with zero shape check).

**Failure scenario:** two concrete, already-confirmed instances of this exact gap causing real bugs:
- `register.ts:191` — `roles: never[]` as a payload type for a field that's actually iterated and dereferenced (`role.jobTitle`, `role.department`, `role.mission` in `onboarding/service.ts`). Compiles fine because `never` is assignable to anything; the cast has zero real type-checking value.
- `register.ts:305` — `effort: cmd.payload.effort as never` on the `message.send` handler. A garbage/version-skewed value from the wire silently type-checks as valid and only fails deep inside provider-specific effort-mapping code instead of at the dispatch boundary.
- `runtime/index.ts:41-64` — a malformed inbound message with a missing/non-string `id` produces an outbound envelope where `JSON.stringify` *omits* the `id` key entirely (since it's `undefined`), so the client can never correlate the response and just hangs — compounding §1.1.

**Fix:** add one thin runtime validator at the single choke point each side already has (`dispatch()` on the runtime side, the `p<T>()` helper on the register.ts side) rather than trusting `as` casts. Don't need a full schema library — even a shape/property-existence guard turns a 3-layers-deep opaque crash into a clean "bad request" at the boundary.

### 1.5 — Event-sourcing is bypassed by about half the write paths — MEDIUM
**Where:** `sidecar/src/domains/conversations/service.ts`: `insertAssistantPlaceholder` (166-174), `insertErrorMessage` (192-199), `setMessageError` (216-218), `setConversationSession` (226-228), `addReaction` (230-232), `upsertAgentSession` (248-254), `insertRelevanceCheck` (256-258) — all write via raw `ctx.db.insertInto/updateTable(...)` instead of `mutate(ctx, ...)`.

**Failure scenario:** `runtime/unitOfWork.ts` documents an explicit invariant — "every command goes through it so state and its event log never diverge" — that these seven functions violate. `toggleReaction` emits `reaction.toggled`; `addReaction` (used by the granular chat-ops path) does not. `insertUserMessage` emits `message.created`; `insertAssistantPlaceholder` (the streaming-start step in the *same flow*) does not. Any current or future consumer that generically subscribes to the event bus — audit trail, cross-window sync, notification pipeline — silently misses these transitions.

**Fix:** route these through `mutate()`/`emit()` like their siblings, or explicitly document why they're exempt and enforce that boundary in review.

### 1.6 — No keyboard dismissal or focus trapping on any modal/popover — MEDIUM
**Where:** `AppSettingsModal`, `ChannelMembersModal`, `GroupModal`, `HireModal`, `SearchModal`, `CompanySwitcher`, `EmojiPicker`, `Sidebar`'s mobile drawer — none close on `Escape`, none trap focus while open. Click-outside works everywhere it should; `Escape` works nowhere.

**Fix:** one shared `useModalDismiss()` hook (Escape handler + optional focus trap), applied to all of the above instead of nothing everywhere.

### 1.7 — Duplicated logic that will drift — LOW/MEDIUM
- **Photo upload**: `AppSettingsModal.tsx:47-58` and `EmployeeSettingsPanel.tsx:181-192` are byte-for-byte the same function, including the same missing-catch bug (§1.2). Extract a shared `usePhotoUpload()` hook.
- **`promptBuilder.ts`**: `sidecar/src/runtime/promptBuilder.ts` is an intentional byte-for-byte fork of `src/lib/promptBuilder.ts` (per its own comment, "ported verbatim" as part of a strangler migration) with no shared source and no test asserting they stay in sync. The next edit to either copy without mirroring it will silently make the legacy and new code paths build different system prompts for the same employee.
- **`getSetting`/`setSetting`**: `companies/service.ts` (`getActiveCompanyId`/`setActiveCompanyId`) and `settings/service.ts` implement the identical get/set-setting SQL pattern twice.
- **Modal boilerplate**: `GroupModal`, `SearchModal`, and `ChannelMembersModal` all reimplement the same avatar+name+meta picker row markup near-verbatim (`search-modal-*` classes reused wholesale) — candidate for one shared `PersonPicker` component.
- **Per-row membership queries**: `ChannelMembersModal.tsx`'s `MemberRow` calls `useChannelMembership(employee.id)` per row (13-14, 51) — N employees means N independent DB round-trips on modal open, and every checkbox toggle is scoped to one employee instead of the whole list. Lift into one query in the parent.

---

## Part 2 — Security

### 2.1 — Vault master-key fallback lands in `os.tmpdir()` — HIGH — ✅ DONE

**Fix applied:** `keyFilePath()` now defaults to `path.dirname(resolveDbPath())` (the real, stable app-config dir) instead of `os.tmpdir()`. First-use key creation (both the keychain and file paths) is now serialized across processes via an O_EXCL lock file with stale-lock takeover, closing the TOCTOU race. A caught keychain failure now logs why before falling back to the file store. `vault.ts`'s `getSecret` catches AES-GCM decrypt failures and rethrows a typed `SecretCorruptedError` instead of letting the raw crypto error propagate. `getMasterKey()` is now cached in-process instead of re-hitting the OS keychain on every seal/open call. All 7 sidecar tests (including the vault-exercising leakage-invariant and github-connector proof-of-life tests) still pass.

**File:** `sidecar/src/secrets/keychain.ts:9-13, 36-39`

The docstring claims the fallback is "a 0600 key file beside the DB." The actual code: `keyFilePath()` resolves to `process.env.COFOUNDER_KEY_DIR || os.tmpdir()`. Grep confirms `COFOUNDER_KEY_DIR` is never set anywhere — `src-tauri/src/sidecar.rs` only sets `COFOUNDER_DB_PATH`. So whenever the OS keychain path fails (missing/failed native `@napi-rs/keyring` binding, locked credential store, headless environment) the master key gets silently written to a directory the OS is explicitly allowed to wipe (Disk Cleanup, temp-file cleaners, container restarts). If that file goes, every row in `secrets` (GitHub PAT, provider API keys) becomes permanently undecryptable — AES-GCM auth-tag check fails on every future `open()`.

**Fix:** default `keyFilePath()` to `path.dirname(resolveDbPath())` — the real, stable, already-passed-in app-config directory — not `os.tmpdir()`.

Related, same file:
- **MEDIUM — TOCTOU race on first-use key creation** (lines 20-29, 43-46): check-then-act with no locking; two sidecar processes racing on a fresh profile can clobber each other's generated key, permanently orphaning anything sealed with the loser's key.
- **LOW — silent fallback with no logging** (16-34): the whole keychain path is `try { } catch { return fileFallback() }` with zero diagnostic output. A genuine keychain failure downgrades secret storage invisibly.
- **`vault.ts` MEDIUM — no handling for decryption failure** (22-31, 59-69): `open()`'s `setAuthTag`/`.final()` throws propagate raw out of `getSecret()` with no typed error, instead of a clean "secret unavailable/corrupted" the caller could use to prompt re-entry.
- **`vault.ts` LOW — perf**: `getMasterKey()` re-fetches from the OS keychain on every single seal/open call (14, 23) instead of caching the resolved key after first read.

### 2.2 — GitHub connector: unrestricted `cwd`, unscoped `git add -A`, PAT push — HIGH
**File:** `sidecar/src/connectors/github.ts`

Three compounding problems:
1. **No workspace scoping** (17-18, 35, 46): `CommitPushInput.cwd` is taken verbatim from unvalidated tool input (see §1.4 — no schema check on tool inputs anywhere). There is no workspace-root concept anywhere in this codebase. Any employee holding a standing `connector:github` grant at `external-write` (which `evaluateCapability` will `allow` with **zero human approval** — `tools/capability.ts`) can call `github.commit_push` against *any* directory on disk that happens to be a git repo.
2. **`git add -A`** then stages the entire tree at that path, not just agent-authored changes.
3. **Push uses the company's stored PAT** to whatever remote that repo has configured. Point `cwd` at an unrelated repo and this tool will happily ship arbitrary local file contents off the machine.

Even when a human approval *is* required (no standing grant), `requestApproval`'s `detail: input` shows the raw JSON args (`cwd`, `message`, `push`, `remote`, `branch`) — no diff, no file list. The human is approving blind.

**Fix:** resolve `cwd` server-side against a per-company workspace root, never trust the caller's path. Compute and include `git diff --stat` in the approval detail so a human approval is actually informed by what's being staged.

Related, same file:
- **MEDIUM — synchronous `execFileSync` with no timeout** (26, 35-37, 44, 46): blocks the entire single-threaded Node sidecar process. A hung `git push` (bad creds, dead network) freezes every other employee's in-flight chat, not just this tool call. Switch to async `execFile`/`spawn` with an explicit timeout.
- **MEDIUM — PAT passed via argv** (line 46): embedded into a `credential.helper` shell one-liner as a command-line argument, visible to any other process on the machine with sufficient privilege (Task Manager command-line column, `wmic process get commandline`). Use `GIT_ASKPASS` + an env var instead.
- **MEDIUM — hardcoded `--no-gpg-sign`** (36): silently overrides repo/user signing policy with no opt-out.
- **MEDIUM — no "nothing to commit" / partial-failure handling** (35-48): a no-op commit throws a raw git-stderr exception; a local-commit-then-failed-push leaves the caller with no signal that a commit already happened, so a naive retry fails again with a confusing "nothing to commit."

### 2.3 — CSP fully disabled — HIGH — ✅ DONE

**Fix applied:** `tauri.conf.json`'s `security.csp` is now `default-src 'self'; img-src 'self' data: https://randomuser.me; style-src 'self' 'unsafe-inline'; connect-src 'self' https://randomuser.me; font-src 'self'` — scoped to exactly what the app actually loads (bundled assets, avatar data URLs, candidate photos and the `fetch()` call to randomuser.me during hiring).

**File:** `src-tauri/tauri.conf.json:27` — `"csp": null`

This app renders LLM-generated markdown (react-markdown + remark-gfm) from agents that can themselves be prompt-injected via tool output. There is currently no raw-HTML rendering path (see §2.4 — good), but zero CSP means zero defense-in-depth if that ever changes (a future `rehype-raw` addition, a markdown-injection edge case). Combined with `send_to_runtime`'s unvalidated passthrough to the DB-owning process (§1.4) and full IPC bridge access (`cos_send`, `opener:default`, `notification:default`), any future XSS has an unobstructed path to real damage.

**Fix:** set an explicit policy, e.g. `"csp": "default-src 'self'; img-src 'self' data: https://randomuser.me; style-src 'self' 'unsafe-inline'; connect-src 'self' https://randomuser.me"`.

### 2.4 — Mention injection breaks out of markdown link syntax, reaching an unrestricted `openUrl` sink — MEDIUM-HIGH
**Files:** `src/components/MarkdownContent.tsx:8-22` (injection point), `52-62` (sink), `src/components/Sidebar.tsx:103` (root cause / entry point)

Good news first: no `dangerouslySetInnerHTML`, no `rehype-raw` — literal `<script>`-in-message injection is not exploitable here.

The actual bug: `injectMentionLinks` splices `` `[${raw}](${MENTION_SCHEME}:${type}:${encodeURIComponent(id)})` `` into markdown source, where `raw` is the literal matched mention text taken verbatim from message content — **not escaped for markdown control characters** (`]`, `(`, `)`, backslash). Channel names are user-supplied and `Sidebar.tsx:103` only lowercases and hyphenates whitespace — it does not strip `[`, `]`, `(`, `)`. A channel literally named `foo](javascript-or-file-scheme)[bar` would, once mentioned anywhere, break out of the intended `[text](cofounder-mention:...)` link and inject an attacker-chosen href into a real clickable link.

That link then hits `MarkdownContent.tsx:52-62`: `openUrl(href)` (Tauri's opener plugin, shells out to the OS URL handler) is called on **any non-mention link with no scheme allowlist**. `[click here](file:///C:/Users/.../secrets.txt)` or a locally-registered custom URI scheme opens via the OS handler on a single click with zero warning that the link isn't a normal `https://` URL.

Today this is mostly "self-XSS via naming your own channel" in a single-user app — but it becomes a real cross-boundary risk the moment any AI employee is allowed to name channels/DMs autonomously (the app already has the create-channel/create-group flows an agent could plausibly be given access to), turning indirect prompt injection into a live link-injection chain.

**Fix:** (a) escape markdown control characters in `raw` before interpolating, or better, do mention substitution as a remark/AST transform instead of pre-parse string surgery; (b) restrict channel/employee names to a safe charset at creation time (`Sidebar.tsx`); (c) allowlist `openUrl` to `http:`/`https:`/`mailto:` schemes only.

### 2.5 — Codex's "no tools" sandboxing claim doesn't hold — HIGH
**File:** `sidecar/src/providers/codex.ts:82-91`

The comment states Codex agents run "purely for chat (no tools)" via `sandboxMode: "read-only"` + `approvalPolicy: "never"`. Checked against `@openai/codex-sdk`'s actual `ThreadOptions` type: there is no option to disable the model's built-in exec/file/patch tools — `sandboxMode`/`approvalPolicy` only constrain what those tools may *do* (read-only fs, no interactive approval), unlike `ClaudeProvider`'s `allowedTools: []` (claude.ts:23), which genuinely removes tool access. A Codex turn can still autonomously invoke shell/read tools, scoped read-only to the **shared, system-wide `os.tmpdir()`** — not an isolated per-turn directory — so a read-only `ls`/`cat` could enumerate/read whatever other applications leave in the OS temp dir.

**Fix:** confirm whether a newer SDK exposes a genuine tool-disable flag; at minimum use a fresh per-turn `fs.mkdtempSync()` directory instead of the shared temp root, and correct the comment to say "sandboxed and unattended," not "no tools."

### 2.6 — No input schema validation for tool calls, the codebase's own stated "security boundary" — MEDIUM
**File:** `sidecar/src/tools/registry.ts`, `types.ts`, `capability.ts`

`capability.ts`'s own docstring frames this subsystem as "the single capability gate" for what an autonomous agent may do. But nothing validates tool `input: unknown` against any schema before `tool.run()` executes — `domains/register.ts`'s `command:tool.invoke` forwards `payload.input` straight through. Currently client-controlled only, but the framing (`autonomy_level`, standing grants) implies eventual LLM-tool-call-driven invocation, at which point malformed input from a model hitting an unvalidated Kysely insert (e.g. `memory.write`) becomes a real, exploitable gap rather than a hypothetical one.

**Fix:** validate tool input against a per-tool schema inside `invokeTool`, before `evaluateCapability`/`tool.run` execute.

---

## Part 3 — Sidecar Runtime, Providers, Dispatch — Correctness & Reliability

### 3.1 — `CodexProvider.runTurn` reports `success: true` unconditionally — HIGH
**File:** `sidecar/src/providers/codex.ts:141`

Unlike `ClaudeProvider` (derives `success` from an explicit `subtype === "success"` signal), Codex's success is never actually confirmed — it defaults `true` unless an exception was thrown or a `turn.failed`/`error` event set `failure`. If the SDK's event generator completes cleanly without ever emitting a terminal event (version skew between `@openai/codex-sdk` and the installed CLI, a stream-ending edge case the SDK doesn't surface as an error), the caller gets `success: true` with zero usage and whatever partial text happened to stream — indistinguishable from a real successful empty turn.

**Fix:** track a boolean set *only* inside the `turn.completed` branch (mirror `ClaudeProvider`'s approach) and default to `false`/throw if it was never observed.

### 3.2 — `ClaudeProvider`: silently-truncated stream reports `success:false` with no explanation — MEDIUM
**File:** `sidecar/src/providers/claude.ts:10-55`

If `query()`'s generator completes without ever yielding a `type:"result"` message (subprocess crash mid-stream), `runTurn` returns `success:false` with no thrown error — the caller emits a normal `done` event with `success:false` instead of taking the `error` path, giving the user zero explanation of what happened, unlike the case where `query()` throws outright.

**Fix:** track whether a `result` message was actually observed; throw explicitly if the stream ends without one.

### 3.3 — Malformed inbound runtime message drops its `id`, hanging the client forever — MEDIUM (compounds §1.1)
**Files:** `sidecar/src/runtime/index.ts:41-64`, `sidecar/src/runtime/dispatch.ts:26-34`

`RuntimeInbound` is compile-time-only; nothing validates the parsed JSON's shape. If `inbound.id` is missing or non-string, `dispatch` throws `"no handler for undefined:undefined"`, and the catch block constructs `{kind:"result", id: undefined, ...}` — but `JSON.stringify` **omits keys with `undefined` values**, so the client receives a result envelope with *no `id` field at all* and can never correlate it back to its pending request. Unlike the JSON.parse-failure path (which correctly hardcodes `id: "unknown"`), this path just hangs the caller.

**Fix:** coerce `id` to a safe fallback before constructing any outbound envelope; add the shape validation from §1.4/§2.6 at this same choke point.

### 3.4 — `tool.run()` failures leave a permanently dangling, unresolved audit trail — MEDIUM
**File:** `sidecar/src/tools/registry.ts:31-76`

`invokeTool` does three independent, non-atomic `mutate()` transactions: emit `tool.invoked` → `tool.run()` → emit `tool.completed`, with **no try/catch around `tool.run()`**. If the tool throws, `tool.invoked` is already durably committed, there's no `tool.failed` event type, and `tool.completed` never fires — a permanent "invoked but never resolved" gap in the event log, indistinguishable from "still running." Same gap in `runToolApproved` (79-94): a failed approved action leaves the approval record `"approved"` forever with no execution-status signal.

**Fix:** wrap `tool.run()` in try/catch, add and emit a `tool.failed` event on failure.

Related, same file: **LOW — denied tool attempts leave no audit trace at all** (36-38, throws immediately with no event emitted — the most security-relevant case is the one that's invisible in the log).

### 3.5 — `index.ts` (legacy CoS sidecar): malformed control block leaks raw JSON into the posted channel message — HIGH
**File:** `sidecar/src/index.ts`, `parseChannelControl`, 189-213

When a `` ```control ``` `` fence is detected but its JSON fails to parse (e.g. model emits a trailing-comma or missing-comma typo), the catch branch returns the **entire raw response, fence markers and broken JSON included**, because the fallback's `respondsWithText` is `true`. This garbage gets posted verbatim as the employee's visible channel message.

**Fix:** slice out the matched fence region regardless of parse success — `fullText.slice(0, match.index) + fullText.slice(match.index + match[0].length)` — instead of falling back to the untrimmed full text.

Related, same file:
- **MEDIUM — hardcoded model id** (`"claude-haiku-4-5-20251001"`, line 146) for relevance checks, bypassing the shared `MODELS[]` registry. When this dated snapshot is retired, relevance checks fail silently (swallowed into `respond:false`) and channel employees quietly stop responding with zero visible signal.
- **LOW — no per-conversation request serialization** (285-308): every inbound line is dispatched fire-and-forget with no queue keyed by conversation id.

### 3.6 — No timeout/cancellation anywhere in the provider contract — MEDIUM
**File:** `sidecar/src/providers/types.ts:41-56`

`RunTurnOptions`/`drainTurn` have no timeout or `AbortSignal`. Neither provider implements one — Codex's SDK does support `TurnOptions.signal` but it's never wired through. A hung subprocess (network stall, SDK deadlock) blocks that request indefinitely with no way for the sidecar or user to cancel short of killing the whole process.

**Fix:** add an optional timeout/`AbortSignal` to `RunTurnOptions`, wire into both providers.

### 3.7 — Test coverage gap: the two most fragile files have zero tests — HIGH
**File:** `sidecar/src/__tests__/runtime.test.ts`

Neither `ClaudeProvider` nor `CodexProvider` is exercised anywhere — the one chat-flow test injects a hand-rolled `fakeProvider` cast `as never` (bypassing the real interface entirely, so it can silently drift from it). This is exactly the code with the most fragile, nontrivial logic in the reviewed set (ESM/CJS dynamic-import interop, per-event-type usage/failure mapping) — and exactly where §3.1's real bug lives, undetected. The wire-protocol boundary (`dispatch.ts`/`runtime/index.ts`) is also never exercised; every test calls domain services directly, bypassing the malformed-JSON and dropped-`id` paths from §3.3 entirely.

**Fix:** add a mocked-SDK test suite driving `CodexProvider.runTurn` through `turn.completed`/`turn.failed`/`error`/no-terminal-event sequences, and at least one test that goes through `dispatch()` with a malformed payload.

### 3.8 — Minor items
- **`codex.ts` MEDIUM** (30-36): a failed dynamic import is cached forever with no retry — first-call failure (codex CLI not yet on PATH) permanently breaks Codex for the process's life; reset `clientPromise = null` in the catch.
- **`codex.ts` LOW** (108-131): loop doesn't `break` after a terminal failure event — wasted work, not incorrect.
- **`codex.ts` LOW** (133-135): original thrown error's `.code` (e.g. `ENOENT`) is discarded in favor of the event-derived message, making "CLI not installed" indistinguishable from "turn failed."
- **`providers/index.ts` LOW** (12-17): unrecognized provider strings (`"Codex"` with capital C, trailing whitespace) silently route to Claude with no log — a user could believe they're talking to Codex the whole time.
- **`memory.ts` LOW/MEDIUM** (60-70): `memory.read` has no limit/pagination — unbounded result set fed back into agent context and token cost.
- **`capability.ts` LOW**: inconsistent `crypto.randomUUID()` global vs. explicit `node:crypto` import used everywhere else; risks depending on WebCrypto global presence in the eventual bundled `.exe`.

---

## Part 4 — Sidecar Domains & Database

### 4.1 — Manager-cycle validation is cosmetic — HIGH — ✅ DONE

**Fix applied:** `EmployeeSettingsPanel.tsx` now computes the full descendant subtree of the employee being edited via BFS (`descendantIds`) and excludes all of it from the manager picker, not just direct reports. `sidecar/src/domains/employees/service.ts`'s `updateEmployeeField` enforces the same invariant server-side (walks the reporting subtree and throws before persisting a cycle-forming `manager_employee_id`), so the guard can no longer be bypassed by any other write path.

**Files:** `src/components/EmployeeSettingsPanel.tsx:141-145` (frontend filter, only real guard in the system), `sidecar/src/domains/employees/service.ts:27-44` (`updateEmployeeField`, zero validation), symptom visible in `src/components/OrgChartView.tsx:29-34`

```js
const managerOptions = employees.filter(
  (e) => e.id !== employee.id && e.manager_employee_id !== employee.id,
);
```
This only blocks an *immediate* cycle (excludes direct reports). It does not walk the transitive subtree. Example: A manages B, B manages C. Editing A and setting A's manager to C passes the filter (`C.manager_employee_id === B.id`, not `A.id`), producing the cycle A→C→B→A. The sidecar backend validates nothing on `manager_employee_id` either — this frontend filter is the *only* guard in the entire system, and it's trivially insufficient for chains ≥2 deep, and trivially bypassable by any other write path. Visible symptom: `OrgChartView.tsx`'s `toNode` cycle guard silently returns `null` for any employee already visited, so cyclic employees simply disappear from the org chart with zero error or warning.

**Fix:** walk the full descendant subtree of the employee being edited (BFS/DFS over `manager_employee_id`) and exclude all of it — and enforce this in the sidecar too, since the frontend guard is the only thing standing between a user and permanently broken org data.

### 4.2 — Sidecar/runtime process lifecycle: no crash recovery, possible orphans — HIGH
**File:** `src-tauri/src/sidecar.rs`

- **No explicit exit hook** (lines 213-220, 258-268, 404-412, 448-451; missing at `lib.rs:27`): both child processes rely solely on `kill_on_drop(true)` firing when the `Child` (moved into a detached async task) drops. No `tauri::RunEvent::Exit`/`ExitRequested` handler explicitly kills them. On shutdown paths that terminate the host process without running every task's destructor, the `node` sidecar/runtime can survive the window closing — orphaned processes holding the SQLite file open.
- **No crash detection or restart** (265-268, 448-451): the `child.wait()` task only logs the exit status; it never clears `state.stdin` back to `None`. If the sidecar crashes (unhandled exception, OOM), subsequent `write_request`/`send_to_runtime` calls still see `Some(ChildStdin)`, pass the "is running" check, and fail on `write_all` with a raw broken-pipe OS error — no auto-restart, so AI chat is silently dead for the rest of the session.
- **Startup failures are invisible** (`spawn`/`spawn_runtime`, 202-208, 392-398): resolution/spawn errors (e.g. `node` not on PATH) are only `eprintln!`'d to a console the packaged app's user will never see. The window opens looking fully functional; every send then fails with no indication of root cause.
- **No graceful shutdown handshake**: both children own live `better-sqlite3` connections, torn down purely by hard-kill, never a "please exit" message + grace period.

**Fix:** register an explicit exit handler that kills both children; clear `stdin` to `None` on crash and consider bounded auto-restart with backoff; emit a `startup-error` event the UI can render; add a shutdown handshake before falling back to kill.

Related, same file:
- **MEDIUM — maintainability**: ~130 lines of duplicated spawn/wire-stdout/wait-task logic between the sidecar and runtime process management (179-271 vs. 356-454) — any fix to the above has to be applied twice.
- **LOW — architecture**: `send_to_runtime` forwards unvalidated JSON straight to the privileged, DB-owning process (§1.4/§2.6) with zero shape/size check — pure pass-through, no defense-in-depth.

### 4.3 — Onboarding: new departments hardcode `position: 0` — MEDIUM
**File:** `sidecar/src/domains/onboarding/service.ts:150`

Every department created during onboarding gets `position: 0`, colliding with the "Executive" department already seeded at `position: 0` (`companies/service.ts:seedDefaults`). Suggest an Engineering and a Marketing role and you get three departments all sharing `position: 0` — the deterministic-ordering column this exists for is defeated. `employees/service.ts:createDepartment` already computes `MAX(position)+1` correctly elsewhere in the same codebase.

**Fix:** reuse that next-position logic instead of the literal `0`.

### 4.4 — Onboarding creates channels but never adds the new hires to them — MEDIUM
**File:** `sidecar/src/domains/onboarding/service.ts:139-159`

The suggestion step deliberately correlates channels with roles (Engineering role → suggest a "product" channel), but `applyOnboarding`'s role loop and channel loop are entirely disjoint — no `channel_memberships` row is ever inserted linking them. Result: an empty "product" channel and an Engineer who isn't in it.

**Fix:** after creating a role + its correlated channel, insert the membership row, mirroring what `seedDefaults` already does for the CoS + #general.

### 4.5 — `removeCompany` doesn't cascade-delete secrets, capability grants, agent profiles/memory — MEDIUM-HIGH
**File:** `sidecar/src/domains/companies/service.ts:187-212`

The delete cascades through `reactions` → `relevance_checks` → `agent_sessions` → `channel_memberships` → `messages` → `employee_responsibilities` → `employees` → `conversations` → `departments` → `companies`, but never touches `secrets` (company-scoped — **this includes the GitHub PAT from §2.2**), `capability_grants`, `agent_profiles`, or `agent_memory`. These become permanently orphaned rows referencing a company/employee that no longer exists. Most notably: a deleted company's vault-encrypted PAT is never purged and sits indefinitely with nothing left to ever reference or clean it up.

**Fix:** add the four missing tables to the same cascade transaction, scoped by `companyId`/`empIds`.

### 4.6 — No `ON DELETE` behavior on any foreign key in the schema — MEDIUM
**File:** `sidecar/src/db/migrations.ts` (entire `BASELINE_SQL`, 18-147, and later blocks)

Every FK (`employees.conversation_id`, `messages.conversation_id`, `channel_memberships.*`, `capability_grants.employee_id`, `agent_memory.employee_id`, etc.) is a bare `REFERENCES` with no `CASCADE`/`SET NULL`. Since `foreign_keys = ON` is enforced (`db/index.ts:27`), any parent-row delete hard-fails unless every dependent table is manually cleaned up first, in the correct order, by hand — which is exactly how §4.5 happened, and exactly how the next delete feature will independently rediscover the same trap.

**Fix:** add explicit `ON DELETE CASCADE`/`SET NULL` to the FKs meant to cascade; document the ones that intentionally don't.

### 4.7 — Migrator: baseline adoption is unverified — MEDIUM
**File:** `sidecar/src/db/migrator.ts:38-63`

When adopting a pre-existing (Rust-migrated) database, the only check is `tableExists(sqlite, "companies")`. If that one table exists, `0001_baseline` is marked applied **without ever running its SQL** and without checking that any other table/column/index in the hand-transcribed `BASELINE_SQL` actually matches the real legacy schema. Drift becomes silent and unrecoverable — no later migration will ever create a missing table/column; it only surfaces as a runtime "no such table/column" error.

**Fix:** on baseline adoption, diff `PRAGMA table_info` for every table in `BASELINE_SQL` against the live DB and fail loudly on mismatch instead of silently recording success.

Related, same file:
- **MEDIUM — concurrency**: two processes racing the first migration on a fresh DB (plausible given §4.2's lifecycle fragility, or simply running dev twice against the shared `os.tmpdir()/cofounder-dev.db` fallback in `db/index.ts:18`) — the loser's `CREATE TABLE companies` throws "table already exists" and crashes that process's startup instead of detecting "already applied." Catch and re-check instead of crashing, or take a file lock around the migration run.
- **LOW**: `schemaVersion` is just `MIGRATIONS.length`, not derived from actually-applied rows — meaningless if a migration is ever removed/reordered.

### 4.8 — Dead schema, redundant indexes — LOW
**File:** `sidecar/src/db/migrations.ts`

- `event_outbox` and `agent_profiles` tables exist in the schema (167-176, 225-232) but are never read or written anywhere in `sidecar/src` — scaffolding for features that never got wired up.
- `idx_reactions_message` (97) and `idx_capability_grants_employee` (206) are redundant with the leading column of an existing `UNIQUE` constraint on the same table — pure write overhead, zero query benefit. Drop them.
- `channel_memberships` has no DB-level constraint (e.g. a partial `UNIQUE ... WHERE effective_to IS NULL`) preventing two concurrently-active membership rows for the same pair — the invariant is only as safe as `employees/service.ts:toggleMembership` staying correct forever.

### 4.9 — `data/repositories.ts` — the advertised safety boundary isn't actually used — MEDIUM
**File:** `sidecar/src/data/repositories.ts:4-13, 42-49`

The docstring claims this is "the structural company-scoping boundary... cross-company leakage is impossible by construction," and that all reads/writes go through `repos.forCompany(companyId)`. In reality, `forCompany(companyId).listConversations()` is called **only from the test suite**. The actually-used `listConversations` (wired to the UI via `domains/register.ts`) is a completely separate implementation in `conversations/service.ts` that talks to `ctx.db` directly, selects different columns, and orders differently. Every other domain service follows the same direct-`ctx.db` pattern. Two divergent implementations of the same query now exist and will drift further; the advertised safety guarantee isn't enforced for the vast majority of company-scoped queries.

**Fix:** either finish the migration (route real domain services through `repos.forCompany`) or delete the unused proof-of-concept and correct the comment.

### 4.10 — Conversation error status has no error message — MEDIUM
**File:** `sidecar/src/domains/conversations/service.ts:391-404`

When `result.success` is `false` (rate limit, max-turns, refusal from the SDK), the code sets `status: "error"` but never populates `error_message`, even though the column exists and `insertErrorMessage`/`setMessageError` in the same file both use it correctly. `TurnResult` (`providers/types.ts`) doesn't even carry an error string to preserve. The DM error path shows zero diagnostic content while the channel-orchestration path shows something.

**Fix:** have `TurnResult` carry an optional `errorMessage` (from `message.subtype`/`message.result` on failure) and thread it into the `error_message` column here.

### 4.11 — Minor domain-service issues
- **`companies/service.ts` LOW-MEDIUM** (122-133, 187-212): deleting the active company doesn't itself update `active_company_id` — it relies on the frontend making a *second*, separate IPC call after `removeCompany` returns. If the app dies between the two calls, `settings.active_company_id` points at a dead row forever, and nothing that reads it checks existence. Fix: update the fallback id inside the same transaction as the delete.
- **`companies/service.ts` LOW**: `updateCompany` discards the update result — a stale/unknown `companyId` silently no-ops instead of erroring. Same pattern in `onboarding/service.ts:applyOnboarding` (133-137).
- **`employees/service.ts` LOW** (54-73): `createEmployee` doesn't trim/require `input.name`, unlike `createChannel`/`createGroup` elsewhere in the same file — a whitespace-only name silently creates a blank-labeled employee.
- **`approvals/service.ts` LOW** (40-52): `resolveApproval`'s `decision` param is only compile-time-restricted to `"approved"|"denied"`; the one caller does an unchecked `as` cast on IPC input (§1.4), so a malformed payload could reach the `status` column with an arbitrary string SQLite won't reject.

---

## Part 5 — Frontend: Correctness, UX, Accessibility

### 5.1 — Onboarding wizard: failed generation renders a completely blank, dead-end screen — HIGH — ✅ DONE

**Fix applied:** `generate`/`finish`/`skip` now run through `useAsyncAction`; the review step has an explicit `generateError` branch with a message + Back/Retry buttons instead of rendering `null`. `skip` is now busy-guarded (button shows "Skipping…" and disables) and trims the company name before persisting.

**File:** `src/components/OnboardingWizard.tsx:168-214, 54-70`

`generate()` has no try/catch at all (54-70) — failures are unhandled promise rejections. On failure, `suggestion` stays `null` and `generating` becomes `false`. The review step's render logic is `generating ? <spinner> : suggestion ? (<>...Back/Finish...</>) : null` — the `null` branch renders **nothing**, including no Back button (Back only exists inside the `suggestion &&` branch). The user lands on a completely blank screen with no error, no retry, and no way to navigate back — the only escape is restarting the app, during first-run onboarding.

**Fix:** add an explicit `generateError` state and render an error message with Back/Retry when generation fails; wrap `generate()`/`finish()` in try/catch.

Related, same file:
- **MEDIUM — correctness/race**: `skip()` (93-98) has no busy-guard, unlike `generate`/`finish` — rapid double-click fires two concurrent `company.update` + `onboarding.apply` pairs with no ordering guarantee.
- **LOW**: company name isn't trimmed before persisting (94) — a whitespace-only name is truthy and gets saved verbatim.

### 5.2 — `MessageList`: full re-render cascade on every streamed token — HIGH (performance) — ✅ DONE

**Fix applied:** `MessageRow` is now `React.memo`-wrapped. To make that actually effective: `MessageList` passes the raw, stable, row-id-taking callbacks (`onToggleReaction`, `onOpenThread`, `onReply`) straight through instead of pre-binding a fresh per-row closure every render; the `{authorName, snippet}` reply-preview object was split into two primitive props (`replyAuthorName`/`replySnippet`) so recomputing them fresh each render still compares equal under shallow prop comparison; messages with no reactions now share one frozen `EMPTY_REACTIONS` sentinel instead of a fresh `?? []` literal; `messagesById` is `useMemo`'d; and `ChatPane.tsx`'s `mentionTargets`/`handleMentionClick` (previously rebuilt every render, defeating all of the above) are now `useMemo`/`useCallback`'d. `ThreadPanel.tsx`, which also renders `MessageRow`, still had the old per-row-closure wrapping pattern — fixed to match the new contract (this was actually a latent correctness bug post-refactor: TS's parameter-count contravariance let a stale single-arg wrapper type-check against the new two-arg signature, which would have silently dropped the real emoji argument at runtime). Auto-scroll now only fires if the viewport was already near the bottom (report §5.2's paired finding). Reaction badges also now show a count instead of dropping it via `Set` dedup (report §5.9), and `formatTime` was fixed to handle negative UTC offsets correctly (report §5.5).

**File:** `src/components/MessageList.tsx:43, 75-109`

`messages` gets a new array reference on every streamed token (confirmed in `useConversation.ts`). Neither `MessageList` nor `MessageRow` is wrapped in `React.memo`, and `messagesById`/`replyPreview`/`authorInfo` are recomputed from scratch every render regardless of which row actually changed. Practical effect: **every message row in the entire conversation re-renders on every single streamed token** — visible jank at exactly the most latency-sensitive moment, in an app meant for daily heavy use.

**Fix:** `React.memo` on `MessageRow`; `useMemo` on `messagesById` keyed on `messages`; memoize per-message reply-preview computation instead of recomputing for the whole list every render.

Related, same file:
- **MEDIUM — UX**: auto-scroll (45-47) fires unconditionally on every `messages` change including every streamed chunk, with no check for whether the user has scrolled up — reading history during an active generation is impossible, the view gets yanked to the bottom on the next token.
- **MEDIUM — architecture**: `mentionTargets`/`scopedMentionTargets(...)` (called inline in `ChatPane.tsx`'s render body) is a brand-new object every render, which flows down and defeats the `useMemo` in `Composer.tsx:103` that depends on it — that memo effectively never caches. Wrap the call site in `useMemo`.
- **LOW**: no virtualization — fine at MVP scale, will degrade over months of accumulated history.

### 5.3 — `ThreadPanel`: no live streaming, looks frozen during generation — HIGH (UX) — ⚠️ PARTIAL

**Fix applied:** auto-scroll-to-newest-reply added, `Escape`-to-close wired, close button given an `aria-label`, and the now-mandatory `onToggleReaction`/reaction-empty-sentinel contract from §5.2's `MessageRow` refactor applied here too (this file had drifted onto the old, now-broken per-row-closure pattern). **Not done:** the core finding — deriving thread messages from the same live streaming source as the main pane instead of a separate reload-on-idle hook — is a genuine architectural change (`useThread` would need to share state with `useConversation`/`useChannel` rather than polling independently) and is left as a follow-up; noted here rather than silently left off the list.

**File:** `src/components/ThreadPanel.tsx:49-54`

`useThread` is an entirely separate, poll-on-`sending`-flip data source from the streaming `messages` state driving the main pane. Unlike `MessageList` (shows a live streaming cursor via `m.status === "streaming"`), the thread panel shows nothing while a reply generates, then the complete message pops in all at once when `sending` flips back to `false` — a jarring, inconsistent experience relative to the main pane, and will read as broken/frozen during long generations. Compounded by `sending` being conversation-wide, not thread-scoped: sending *any* unrelated top-level message also triggers an unnecessary full reload of this thread.

**Fix:** derive thread messages from the same live stream, filtered by `thread_root_id`, instead of a separate reload-based hook.

### 5.4 — `Composer`: mention autocomplete breaks on multi-word names, no keyboard path to accept — MEDIUM
**File:** `src/components/Composer.tsx:154, 132-143, 234-243`

`textBefore.match(/(^|\s)([@#])(\w*)$/)` — `\w*` cannot include spaces, so autocomplete for any multi-word name (e.g. "Alex Chen") breaks the instant a space is typed after the first token; users can only ever mention someone by their first name segment. Separately, there is no keyboard selection at all for the dropdown — no arrow-key navigation, Enter is deliberately passed through to insert a newline instead of picking the highlighted (nonexistent) suggestion. A keyboard-only user can never complete a mention via keyboard.

**Fix:** allow the term match to include internal spaces up to the next mention boundary; add a highlighted-index state with Arrow/Enter/Tab wiring.

Related, same file:
- **MEDIUM — UX**: switching conversations destroys the TipTap editor (`useEditor(..., [placeholder])` recreates on every placeholder change, which changes per-conversation) — any unsent draft is lost on channel/DM switch, unlike Slack/Discord's per-channel draft persistence.
- **MEDIUM — a11y**: mention dropdown has no `role="listbox"`/`aria-expanded`/`aria-activedescendant`; toolbar toggle buttons have no `aria-pressed`.

### 5.5 — `MessageRow`: timestamp parsing mishandles negative UTC offsets — MEDIUM — ✅ DONE

**Fix applied:** replaced the `iso.includes("Z") || iso.includes("+")` substring check with a proper trailing-offset regex (`/(?:Z|[+-]\d{2}:?\d{2})$/`), fixed alongside §5.2 while the file was open.

**File:** `src/components/MessageRow.tsx:32-36`

```js
const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
```
Doesn't check for a negative offset (`...-05:00`) — such a string has neither `Z` nor `+`, so `"Z"` gets appended, producing an invalid `...-05:00Z` string. `Number.isNaN` catches it and returns `""` — the timestamp silently vanishes from the UI.

**Fix:** use a real trailing-offset regex (`[+-]\d{2}:?\d{2}$|Z$`), or normalize timestamps to one format at the source.

### 5.6 — Systemic missing `onError` fallback on avatar `<img>` tags — LOW (consistency bug)
**Files:** `src/components/Avatar.tsx:11`, `src/components/CompanySwitcher.tsx:16`

`Emoji.tsx` already establishes the correct pattern (`onError={() => setFailed(true)}` falling back to a native glyph) elsewhere in the same directory — `Avatar` and the company glyph don't follow it. A corrupted/truncated avatar data URL (e.g. from an interrupted upload — see the unhandled-rejection bug in §1.2) renders a permanent broken-image icon instead of the initials fallback the code already has a path for.

### 5.7 — Accessibility gaps (grouped, lower severity individually)
- **`HomeView.tsx:26-34`** — notification toggle (`role="switch"`) has no accessible name (`aria-label`/`aria-labelledby`); screen readers announce only "switch, not checked."
- **`CompanySwitcher.tsx:79-141`** — trigger has no `aria-haspopup`/`aria-expanded`; dropdown has no `role="menu"`/`role="menuitem"`.
- **`IconRail.tsx:16-39`** — no `aria-current` on the active nav item; selection is communicated purely visually.
- **`Sidebar.tsx`** — mobile drawer scrim is a non-focusable `div` with only `onClick`, no `Escape` path (see §1.6); gear/settings icon buttons rely on `title` only, no `aria-label`.
- **`MessageRow.tsx:118-166`** — hover-only reveal for reaction/reply/menu controls; if implemented via `:hover`-only CSS (not also `:focus-within`), these are entirely unreachable by keyboard. Verify and fix the CSS.
- General pattern across `TitleBar.tsx`, `ThreadPanel.tsx`, `Sidebar.tsx`: icon-only close/action buttons with `title` but no `aria-label`.

### 5.8 — Inconsistent auto-save vs. explicit-save models within the same modal — MEDIUM
**Files:** `AppSettingsModal.tsx` (88, 108, 175 vs. 63/67/138-143), `EmployeeSettingsPanel.tsx` (299, 356 vs. 205-207, 128-134, 455)

Avatar/color/manager/channel-membership changes apply immediately on click; name/profile/system-prompt/preamble sit behind an explicit "Save changes" button gated by `isDirty`. The dirty-check and "Unsaved changes" indicator therefore lie by omission — a user can have genuinely unsaved prose edits sitting next to already-persisted manager/channel changes with no way to tell which is which. Worse, clicking the modal's `X` or the outside scrim while `isDirty` is true discards the unsaved half with **zero confirmation** — real risk for the `preamble`/`additional_details` fields a user might spend minutes writing.

**Fix:** pick one persistence model per modal; at minimum, intercept close with a confirm when `isDirty`.

### 5.9 — Minor frontend correctness/UX items
- **`EmployeeSettingsPanel.tsx:43-45`** — a responsibility row's local-draft reset effect depends only on `[responsibility.id]`, not `.text`; if the canonical text changes upstream while the id is unchanged, the local draft silently diverges.
- **`EmployeeSettingsPanel.tsx:52`** — no trim/non-empty guard on responsibility text before persisting on blur; a user can save an empty responsibility.
- **`HireModal.tsx:134-153`** — new-department input fires creation on both blur and Enter; clicking "Next" directly (no Enter) can race the async create, leaving the Next button confusingly disabled.
- **`SearchModal.tsx:41-47`** — no Enter-to-select on the search input, unlike typical quick-switcher UX.
- **`useResizableWidth.ts:12-30`** — drag `mousemove`/`mouseup` listeners are only removed on a genuine `mouseup`; if the component unmounts mid-drag, they leak and keep firing `setWidth` on an unmounted component.
- **`randomUser.ts:13-38`** — `fetchPhotos` trusts `data.results.length === count`; a short response from the API silently produces `photoUrl: undefined` for excess candidates despite the type claiming `string`, surfacing as a confusing downstream fetch error instead of a clear "photo service returned incomplete data."
- **`avatar.ts:41`**, **`randomUser.ts:15`** — no timeout/`AbortSignal` on `fetch`/`tauriFetch` calls to `randomuser.me`; a hung request blocks candidate/avatar generation indefinitely (same root pattern as §1.1, just external instead of IPC).
- **`shared/protocol.d.ts:25-41`** — `CommandEnvelope`/`QueryEnvelope` default their generics to plain `string`/`unknown`; there's no `CommandMap`/`QueryMap` mapping command name → payload → response type. Every one of the ~20+ call sites across the hooks layer is trusting an unchecked generic parameter rather than an inferred contract — the client-side mirror of §1.4.

---

## Part 6 — Architecture, DRY, Maintainability

- **God component**: `EmployeeSettingsPanel.tsx` (65-459) does role/model/channels/behavior/prompt-preview/avatar-upload/department-creation in one 460-line function. `ResponsibilityRow` is already split out — the "Role"/"Model"/"Channels"/"Behavior" sections are natural candidates to follow that precedent.
- **Inline payload types drift from real shapes**: `domains/register.ts` mixes `cmd.payload.field` and a shorter `p<T>()` helper across ~40 handlers with no consistent convention — pure noise, and directly enabled the `roles: never[]` bug in §1.4.
- **`sidecar/tsconfig.json`**: no ESLint config exists for the sidecar at all (confirmed no `sidecar/eslint.config.*`, and root `eslint.config.js:10` explicitly excludes it) — the code that spawns subprocesses, holds API keys, and owns the SQLite DB has zero static-analysis coverage (no unused-var, no floating-promise, no unsafe-any checks).
- **`@types/node` version skew**: root `package.json` pins `^26.1.1`, `sidecar/package.json` pins `^22.0.0` — the sidecar is the one that actually runs on Node and should track the real target runtime; root only needs it for Vite tooling.

---

## Part 7 — Rust / Build / Production Readiness

(See §4.2 for the process-lifecycle findings — the highest-severity Rust issues live there.)

- **`Cargo.toml`** version pins are major-version-only (`tauri = "2"`), but `Cargo.lock` is committed, so builds are actually reproducible in practice — not a real issue, noted for completeness.
- **`capabilities/default.json`** is correctly minimal: `http:default` scoped to `https://randomuser.me/*` only, no `fs`/`shell` permissions granted. Called out as a positive, not a finding.
- Already-known, accepted tech debt (not re-flagged as new): sidecar not yet bundled as a standalone `.exe`/Tauri `externalBin`; `total_cost_usd` is a client-side estimate, not real billing. Both are documented in `CLAUDE.md` and out of scope here — but note that §4.2's lifecycle fixes should land *before* the bundling work, since a bundled sidecar with the same crash-recovery gaps just moves the same bug to more users.

---

## Part 8 — Test Coverage

- **Zero component tests exist** for any of the ~27 files under `src/components/`. Highest-value gaps given what this review found: `OrgChartView.tsx`'s cycle handling and `EmployeeSettingsPanel.tsx`'s manager-cycle filter (§4.1 — exactly where a real bug was found), and `MessageList`'s memoization behavior (§5.2).
- **`sidecar/src/__tests__/runtime.test.ts`**: substantive where it exists (cross-company leakage invariant, monotonic event sequencing, capability grant transitions, and a genuine end-to-end git-commit-through-approval-and-vault test are all real, meaningful assertions — noted positively) but has zero coverage of `ClaudeProvider`/`CodexProvider` (§3.7) and zero coverage of the `dispatch()`/wire-protocol boundary (§3.3).
- **`src/lib/*.test.ts`**: generally good, non-tautological (`emoji.test.ts` verifies every UI emoji has a bundled asset on disk; `sillyNames.test.ts` verifies actual shuffle unbiasedness and non-mutation). Gaps: `mentions.ts`'s asymmetric word-boundary check (checks trailing edge only, not leading) is untested; `reactionNotices.ts`'s `consumeReactionNotices` (the function that actually talks to the runtime) has no test at all, only its pure formatting half does.

---

## Summary by severity

| Severity | Count (deduplicated findings) |
|---|---|
| CRITICAL/HIGH | 19 |
| MEDIUM | 31 |
| LOW/NIT | 28 |

The codebase is functional and the domain modeling (event sourcing, capability grants, effective-dated channel membership) is more thoughtful than most side projects at this stage — but it has the classic MVP shape: every happy path works, and almost nothing that can fail has a failure path. The single highest-leverage fix is §1.1 (timeouts) — it's the root cause behind a large fraction of the "hangs forever" bugs scattered through the hooks layer, and it's a few hours of work in two files (`runtimeClient.ts`, `sidecarRequest.ts`) to fix everywhere at once. The single scariest fix is §2.2 (GitHub connector) — it's a real, unattended exfiltration path gated by a UI dialog nobody will read closely, in an app that hands autonomous agents credentials.
