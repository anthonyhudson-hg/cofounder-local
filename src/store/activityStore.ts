import { create } from "zustand";
import type { EventEnvelope } from "@shared/protocol";

/**
 * Client-side projection of the runtime event stream (refactor #7). A first,
 * self-contained consumer of the event spine that powers the live Activity /
 * audit view. Domain stores (conversations, employees, …) follow the same
 * pattern as each is strangled onto the runtime.
 */
interface ActivityState {
  events: EventEnvelope[];
  push: (event: EventEnvelope) => void;
  clear: () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  events: [],
  push: (event) => set((s) => ({ events: [event, ...s.events].slice(0, 250) })),
  clear: () => set({ events: [] }),
}));
