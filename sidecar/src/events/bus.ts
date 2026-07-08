import type { EventEnvelope } from "@shared/protocol";

export type EventListener = (event: EventEnvelope) => void;

/**
 * In-process event bus. Committed domain events are published here; the runtime
 * forwards them to the client (stdout) and any in-process consumers (outbox
 * processor, routines) subscribe too.
 */
export class EventBus {
  private listeners = new Set<EventListener>();

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
}
