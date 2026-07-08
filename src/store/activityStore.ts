import { create } from "zustand";
import type { EventEnvelope } from "@shared/protocol";

/**
 * Client-side projection of the runtime event stream (refactor #7). Started
 * as a live-only view (last 250 events since the app was opened); `seedHistory`
 * later added real history from the durable events table (query:audit.list) so
 * switching companies or reopening the app doesn't lose everything older than
 * the current session.
 */
interface ActivityState {
  events: EventEnvelope[];
  historyLoaded: boolean;
  push: (event: EventEnvelope) => void;
  seedHistory: (events: EventEnvelope[]) => void;
  clear: () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  events: [],
  historyLoaded: false,
  push: (event) =>
    set((s) => (s.events.some((e) => e.id === event.id) ? s : { events: [event, ...s.events].slice(0, 250) })),
  seedHistory: (events) =>
    set((s) => {
      if (s.historyLoaded) return s;
      const existingIds = new Set(s.events.map((e) => e.id));
      const merged = [...s.events, ...events.filter((e) => !existingIds.has(e.id))]
        .sort((a, b) => b.seq - a.seq)
        .slice(0, 250);
      return { events: merged, historyLoaded: true };
    }),
  clear: () => set({ events: [] }),
}));
