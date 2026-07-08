import type { RuntimeInbound } from "@shared/protocol";
import type { RuntimeContext } from "./context";

/** The single runtime protocol version, asserted at the handshake. */
export const PROTOCOL_VERSION = 1;

/** Lets a long-running handler stream chunks to the client before its result. */
export interface DeltaSink {
  delta(channel: string, data: unknown): void;
}

export type Handler = (
  ctx: RuntimeContext,
  inbound: RuntimeInbound,
  sink: DeltaSink,
) => Promise<unknown>;

const handlers = new Map<string, Handler>();

/** Registers a handler for `${kind}:${type}` (e.g. "query:ping"). */
export function register(key: string, handler: Handler): void {
  if (handlers.has(key)) throw new Error(`duplicate handler for ${key}`);
  handlers.set(key, handler);
}

/**
 * Validates the minimal shape of an inbound message before dispatch touches it. This
 * is a JSON-over-stdio boundary crossing two languages (TS type erased on this side,
 * Rust's serde_json::Value on the other) — compile-time typing provides no actual
 * protection here. A malformed message (protocol-version skew, a renderer bug) used
 * to reach `dispatch` with a missing/non-string `id`, producing a result envelope
 * whose `id` key `JSON.stringify` silently omits — the client could then never
 * correlate the response and just hung forever (report §1.4/§3.3).
 */
export function validateInbound(value: unknown): value is RuntimeInbound {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "command" || v.kind === "query") &&
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.type === "string" &&
    v.type.length > 0 &&
    (v.companyId === null || typeof v.companyId === "string")
  );
}

export async function dispatch(
  ctx: RuntimeContext,
  inbound: RuntimeInbound,
  sink: DeltaSink,
): Promise<unknown> {
  const key = `${inbound.kind}:${inbound.type}`;
  const handler = handlers.get(key);
  if (!handler) throw new Error(`no handler for ${key}`);
  return handler(ctx, inbound, sink);
}

// ---- Phase A handlers (domains register more as they are strangled in) ----

register("query:ping", async (ctx) => ({
  ok: true,
  protocolVersion: PROTOCOL_VERSION,
  schemaVersion: ctx.migration.schemaVersion,
  companies: await ctx.repos.countCompanies(),
}));
