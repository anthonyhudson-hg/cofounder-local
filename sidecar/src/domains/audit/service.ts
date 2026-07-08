import type { Actor } from "@shared/protocol";
import type { RuntimeContext } from "../../runtime/context";

/**
 * Read side of the durable event log (the same `events` table `runtime/
 * unitOfWork.ts`'s `mutate()` appends to atomically with every state
 * mutation). Previously this data only reached the client as a live delta
 * stream (`src/store/activityStore.ts`, capped at the last 250 events since
 * the app was opened) — nothing let a user page back through actual history.
 * This is a plain read query, not a new write path; `events` already had
 * everything needed.
 */
export interface AuditEventItem {
  seq: number;
  id: string;
  type: string;
  actor: Actor;
  subjectId: string | null;
  payload: unknown;
  causationId: string | null;
  correlationId: string | null;
  createdAt: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Most-recent-first, optionally paginated backwards via `beforeSeq` (an
 * exclusive cursor — pass the last-seen `seq` from the previous page to get
 * the next older page). `seq` is a monotonic per-row autoincrement, so it's a
 * stable cursor even under concurrent inserts, unlike paginating on
 * `created_at` (not guaranteed unique to the millisecond).
 */
export async function listEvents(
  ctx: RuntimeContext,
  companyId: string,
  options: { beforeSeq?: number; limit?: number } = {},
): Promise<AuditEventItem[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  let q = ctx.db.selectFrom("events").where("company_id", "=", companyId).selectAll();
  if (options.beforeSeq !== undefined) q = q.where("seq", "<", options.beforeSeq);
  const rows = await q.orderBy("seq", "desc").limit(limit).execute();
  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    type: r.type,
    actor: JSON.parse(r.actor) as Actor,
    subjectId: r.subject_id,
    payload: JSON.parse(r.payload) as unknown,
    causationId: r.causation_id,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
  }));
}
