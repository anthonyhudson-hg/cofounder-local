import { useEffect } from "react";
import type { Actor } from "@shared/protocol";
import { onRuntimeEvent, startRuntimeBus } from "../lib/runtimeClient";
import { useActivityStore } from "../store/activityStore";

/**
 * Live audit / activity feed rendered from the runtime event stream. Fully
 * self-contained: it starts the runtime bus and subscribes on mount, so it
 * needs no wiring in App. This is the first end-to-end proof of the client↔
 * runtime path in the running UI (runtime → Rust → client → store → view).
 */
function actorLabel(actor: Actor): string {
  if (actor.kind === "user") return "You";
  if (actor.kind === "employee") return `Agent ${actor.employeeId.slice(0, 8)}`;
  return "System";
}

export function ActivityView() {
  const events = useActivityStore((s) => s.events);
  const push = useActivityStore((s) => s.push);
  const clear = useActivityStore((s) => s.clear);

  useEffect(() => {
    void startRuntimeBus();
    const off = onRuntimeEvent((e) => push(e));
    return off;
  }, [push]);

  return (
    <div className="activity-view">
      <div className="activity-header">
        <h2>Activity</h2>
        <span className="activity-sub">Live event stream from the agent runtime</span>
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
