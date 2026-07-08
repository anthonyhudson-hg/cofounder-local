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
