import type { Transaction } from "kysely";
import type { EventEnvelope } from "@shared/protocol";
import type { Database } from "../db/schema";
import { insertEvent, type EventSpec } from "../events/append";
import type { RuntimeContext } from "./context";

export type Emit = (spec: EventSpec) => Promise<EventEnvelope>;

/**
 * Runs `fn` in a single transaction with an `emit` that appends events atomically
 * alongside the state mutation. After commit, all emitted events are published to
 * the bus (which forwards to the client + in-process consumers). This is the
 * canonical write path — every command goes through it so state and its event log
 * never diverge.
 */
export async function mutate<T>(
  ctx: RuntimeContext,
  fn: (trx: Transaction<Database>, emit: Emit) => Promise<T>,
): Promise<T> {
  const collected: EventEnvelope[] = [];

  const result = await ctx.db.transaction().execute(async (trx) => {
    const emit: Emit = async (spec) => {
      const env = await insertEvent(trx, spec);
      collected.push(env);
      return env;
    };
    return fn(trx, emit);
  });

  for (const env of collected) ctx.bus.publish(env);
  return result;
}
