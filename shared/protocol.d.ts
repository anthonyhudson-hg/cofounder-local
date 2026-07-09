/**
 * Wire contract between the React client and the Node runtime.
 *
 * The client sends COMMANDS (mutations) and QUERIES (reads) to the runtime and
 * receives RESULTS (per-request replies) and EVENTS (broadcast domain facts).
 * Everything is newline-delimited JSON over the Tauri IPC bridge:
 *
 *   client  --invoke("send_to_runtime", RuntimeInbound)-->  Rust --stdin-->  runtime
 *   runtime --stdout--> Rust --emit("runtime://event", RuntimeOutbound)--> client
 *
 * This module is TYPE-ONLY (a .d.ts) so it can be imported by both the ESM
 * client and the CommonJS sidecar without coupling their build systems.
 */

/** Who caused a change. `system` = runtime/automation; else a user or employee id. */
export type Actor =
  | { kind: "user" }
  | { kind: "employee"; employeeId: string }
  | { kind: "system" };

/* ------------------------------------------------------------------ */
/* Inbound: client -> runtime                                          */
/* ------------------------------------------------------------------ */

export interface CommandEnvelope<TType extends string = string, TPayload = unknown> {
  kind: "command";
  /** Correlation id echoed back on the matching Result. */
  id: string;
  type: TType;
  /** Active company scope; the runtime validates ownership before acting. */
  companyId: string | null;
  payload: TPayload;
}

export interface QueryEnvelope<TType extends string = string, TPayload = unknown> {
  kind: "query";
  id: string;
  type: TType;
  companyId: string | null;
  payload: TPayload;
}

export type RuntimeInbound = CommandEnvelope | QueryEnvelope;

/* ------------------------------------------------------------------ */
/* Outbound: runtime -> client                                         */
/* ------------------------------------------------------------------ */

/** Per-request reply, matched to a Command/Query by `id`. */
export type ResultEnvelope<TData = unknown> =
  | { kind: "result"; id: string; ok: true; data: TData }
  | { kind: "result"; id: string; ok: false; error: { message: string; code?: string } };

/** Streaming chunk for long-running commands (e.g. token deltas). */
export interface DeltaEnvelope {
  kind: "delta";
  /** The command id this delta belongs to. */
  id: string;
  channel: string;
  data: unknown;
}

/** Append-only domain fact, broadcast to all subscribers. Mirrors the DB row. */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  kind: "event";
  id: string;
  /** Monotonic per-company sequence for ordered replay. */
  seq: number;
  companyId: string | null;
  type: TType;
  actor: Actor;
  /** Primary entity the event is about (conversation id, employee id, …). */
  subjectId: string | null;
  payload: TPayload;
  causationId: string | null;
  correlationId: string | null;
  createdAt: string;
}

/**
 * Ephemeral "what is this agent doing right now" status for an in-flight turn.
 * Broadcast to every window (unlike a Delta, which only reaches the initiating
 * client) and NOT persisted (unlike an Event) — it's live UI state, authored by
 * the runtime as the turn progresses through its steps (thinking, calling a
 * tool, relevance-gating, awaiting approval, writing). Keyed to a row by
 * (conversationId, employeeId): the streaming assistant message an employee is
 * producing. Cleared by a message with `done: true`.
 */
export interface AgentStatus {
  conversationId: string;
  /** The employee doing the work; null for a conversation-level status. */
  employeeId: string | null;
  /** The server-side assistant message id, when one exists yet. */
  messageId: string | null;
  /** Machine phase: thinking | tool | relevance | writing | approval | cascade. */
  phase: string;
  /** Human status line, e.g. "Thinking", "Receiving agent output". */
  message: string;
  /** Friendly tool name when phase === "tool" (takes over the status line). */
  toolName: string | null;
  /** A short preview of the latest assistant output, if any. */
  snippet: string | null;
  /** ISO timestamp of the last activity — drives the ticking "N ago" line. */
  lastEventAt: string;
  /** True → this turn finished; clear the status. */
  done: boolean;
}

export interface StatusEnvelope {
  kind: "status";
  status: AgentStatus;
}

/** Emitted once when the runtime has booted, migrated, and is ready. */
export interface ReadyEnvelope {
  kind: "ready";
  protocolVersion: number;
}

export type RuntimeOutbound =
  | ResultEnvelope
  | DeltaEnvelope
  | EventEnvelope
  | StatusEnvelope
  | ReadyEnvelope;

/* ------------------------------------------------------------------ */
/* Phase A handshake (grows as domains are strangled in)               */
/* ------------------------------------------------------------------ */

export type PingQuery = QueryEnvelope<"ping", Record<string, never>>;
export interface PingResult {
  ok: true;
  protocolVersion: number;
  schemaVersion: number;
  companies: number;
}
