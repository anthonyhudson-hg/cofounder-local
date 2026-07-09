import { useEffect, useState } from "react";
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

function formatTime(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function ActivityRow({ event }: { event: EventEnvelope }) {
  const [expanded, setExpanded] = useState(false);
  const payload = JSON.stringify(event.payload);
  return (
    <li className="activity-item">
      <span className="activity-seq">#{event.seq}</span>
      <span className="activity-type">{event.type}</span>
      <span className="activity-actor">{actorLabel(event.actor)}</span>
      <span className="activity-time">{formatTime(event.createdAt)}</span>
      <code
        className={`activity-payload${expanded ? " expanded" : ""}`}
        title={expanded ? "Click to collapse" : "Click to expand"}
        onClick={() => setExpanded((v) => !v)}
      >
        {payload}
      </code>
    </li>
  );
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
    query<AuditEventItem[]>("audit.list", { limit: 100 }, companyId)
      .then((rows) => {
        if (!isCurrent(token)) return;
        const asEvents: EventEnvelope[] = rows.map((r) => ({ kind: "event", companyId, ...r }));
        seedHistory(asEvents);
      })
      .catch((err) => {
        console.error("Failed to load activity history:", err);
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
            <ActivityRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </div>
  );
}
