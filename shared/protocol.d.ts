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

/** Emitted once when the runtime has booted, migrated, and is ready. */
export interface ReadyEnvelope {
  kind: "ready";
  protocolVersion: number;
}

export type RuntimeOutbound =
  | ResultEnvelope
  | DeltaEnvelope
  | EventEnvelope
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
