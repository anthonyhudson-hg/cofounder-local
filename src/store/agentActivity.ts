import { create } from "zustand";

/**
 * Tracks which employees have a turn actively in flight RIGHT NOW (generating a
 * response / running a tool) — accurate "working" vs "idle". Set true the moment
 * a provider turn starts and false when it finishes/errors. Not persisted: this
 * is live runtime state.
 */
interface AgentActivityState {
  active: Set<string>;
  setActive: (employeeId: string, on: boolean) => void;
}

export const useAgentActivity = create<AgentActivityState>((set) => ({
  active: new Set(),
  setActive: (employeeId, on) =>
    set((s) => {
      if (on === s.active.has(employeeId)) return s;
      const next = new Set(s.active);
      if (on) next.add(employeeId);
      else next.delete(employeeId);
      return { active: next };
    }),
}));
