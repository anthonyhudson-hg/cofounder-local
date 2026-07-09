import type { AgentStatus, EventEnvelope } from "@shared/protocol";

export type EventListener = (event: EventEnvelope) => void;
export type StatusListener = (status: AgentStatus) => void;

/**
 * In-process event bus. Committed domain events are published here; the runtime
 * forwards them to the client (stdout) and any in-process consumers (outbox
 * processor, routines) subscribe too.
 *
 * It also carries an EPHEMERAL status stream (`publishStatus`/`subscribeStatus`)
 * for live "what is this agent doing right now" updates. Unlike events, statuses
 * are never persisted and carry no sequence — they're transient UI state the
 * runtime authors as a turn progresses.
 */
export class EventBus {
  private listeners = new Set<EventListener>();
  private statusListeners = new Set<StatusListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: EventEnvelope): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        process.stderr.write(`[events] listener error: ${String(err)}\n`);
      }
    }
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  publishStatus(status: AgentStatus): void {
    for (const l of this.statusListeners) {
      try {
        l(status);
      } catch (err) {
        process.stderr.write(`[events] status listener error: ${String(err)}\n`);
      }
    }
  }
}
