import { useEffect } from "react";
import type { Actor, EventEnvelope } from "@shared/protocol";
import { onRuntimeEvent, query, startRuntimeBus } from "../lib/runtimeClient";
import { useActivityStore } from "../store/activityStore";
import { useStaleGuard } from "../hooks/useStaleGuard";

/**
 * Audit / activity feed: real history from the durable events table
 * (query:audit.list) seeded on mount/company-switch, then kept live via the
 * runtime event stream. Company-scoped on both sides — the live subscription
 * filters by companyId since the runtime bus broadcasts events for every
 * company in the process, not just the active one.
 */
// Mirrors sidecar/src/domains/audit/service.ts's AuditEventItem — no shared
// workspace package between runtime and client (see CLAUDE.md), so this is a
// deliberate, minimal duplication of the query:audit.list response shape.
type AuditEventItem = Omit<EventEnvelope, "kind" | "companyId">;

function actorLabel(actor: Actor): string {
  if (actor.kind === "user") return "You";
  if (actor.kind === "employee") return `Agent ${actor.employeeId.slice(0, 8)}`;
  return "System";
}

interface Props {
  companyId: string | null;
}

export function ActivityView({ companyId }: Props) {
  const events = useActivityStore((s) => s.events);
  const push = useActivityStore((s) => s.push);
  const seedHistory = useActivityStore((s) => s.seedHistory);
  const clear = useActivityStore((s) => s.clear);
  const { begin, isCurrent } = useStaleGuard();

  useEffect(() => {
    clear();
    if (!companyId) return;
    const token = begin();
    query<AuditEventItem[]>("audit.list", { limit: 100 }, companyId).then((rows) => {
      if (!isCurrent(token)) return;
      const asEvents: EventEnvelope[] = rows.map((r) => ({ kind: "event", companyId, ...r }));
      seedHistory(asEvents);
    });
  }, [companyId, clear, seedHistory, begin, isCurrent]);

  useEffect(() => {
    void startRuntimeBus();
    const off = onRuntimeEvent((e) => {
      if (e.companyId !== companyId) return;
      push(e);
    });
    return off;
  }, [push, companyId]);

  return (
    <div className="activity-view">
      <div className="activity-header">
        <h2>Activity</h2>
        <span className="activity-sub">Event history for this company, live-updating</span>
        {events.length > 0 && (
          <button className="settings-link-btn" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      {events.length === 0 ? (
        <div className="activity-empty">
          No activity yet. Runtime events (company, tool, memory, approval…) appear here as they happen.
        </div>
      ) : (
        <ul className="activity-list">
          {events.map((e) => (
            <li key={e.id} className="activity-item">
              <span className="activity-seq">#{e.seq}</span>
              <span className="activity-type">{e.type}</span>
              <span className="activity-actor">{actorLabel(e.actor)}</span>
              <span className="activity-time">{e.createdAt}</span>
              <code className="activity-payload">{JSON.stringify(e.payload)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
