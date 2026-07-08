import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Actor, EventEnvelope } from "@shared/protocol";
import type { Database } from "../db/schema";

export interface EventSpec {
  companyId: string | null;
  type: string;
  actor?: Actor;
  subjectId?: string | null;
  payload?: unknown;
  causationId?: string | null;
  correlationId?: string | null;
}

/**
 * Appends one event inside the caller's transaction (atomic with the state
 * mutation) and returns the fully-formed envelope. Publishing to the bus happens
 * AFTER commit — see runtime/unitOfWork.
 */
export async function insertEvent(
  trx: Transaction<Database> | Kysely<Database>,
  spec: EventSpec,
): Promise<EventEnvelope> {
  const id = randomUUID();
  const actor: Actor = spec.actor ?? { kind: "system" };
  const payload = spec.payload ?? {};

  const inserted = await trx
    .insertInto("events")
    .values({
      id,
      company_id: spec.companyId,
      type: spec.type,
      actor: JSON.stringify(actor),
      subject_id: spec.subjectId ?? null,
      payload: JSON.stringify(payload),
      causation_id: spec.causationId ?? null,
      correlation_id: spec.correlationId ?? null,
    })
    .returning(["seq", "created_at"])
    .executeTakeFirstOrThrow();

  return {
    kind: "event",
    id,
    seq: Number(inserted.seq),
    companyId: spec.companyId,
    type: spec.type,
    actor,
    subjectId: spec.subjectId ?? null,
    payload,
    causationId: spec.causationId ?? null,
    correlationId: spec.correlationId ?? null,
    createdAt: inserted.created_at,
  };
}
