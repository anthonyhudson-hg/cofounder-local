import { create } from "zustand";
import type { AgentStatus } from "@shared/protocol";
import type { LiveActivity } from "../lib/liveActivity";

/**
 * Live "what is this agent doing right now" status, broadcast by the runtime for
 * every in-flight turn (see sidecar runtime/agentStatus.ts). Keyed by
 * conversation → employee so a streaming assistant row can look up its own
 * status; the empty-string key holds a conversation-level status (e.g. the
 * channel relevance gate's "Checking who should respond"). Ephemeral: cleared
 * when the turn reports `done`, and pruned by TTL so a crashed turn can't leave
 * a permanent "working" indicator.
 */
const STATUS_TTL_MS = 90_000;

interface AgentStatusState {
  byConversation: Record<string, Record<string, AgentStatus>>;
  apply: (status: AgentStatus) => void;
}

export const useAgentStatusStore = create<AgentStatusState>((set) => ({
  byConversation: {},
  apply: (status) =>
    set((state) => {
      const key = status.employeeId ?? "";
      const conv = { ...(state.byConversation[status.conversationId] ?? {}) };
      if (status.done) {
        delete conv[key];
      } else {
        conv[key] = status;
      }
      // Drop anything past the TTL (a turn that died without emitting `done`).
      const cutoff = Date.now() - STATUS_TTL_MS;
      for (const [k, s] of Object.entries(conv)) {
        if (new Date(s.lastEventAt).getTime() < cutoff) delete conv[k];
      }
      const nextConv = { ...state.byConversation };
      if (Object.keys(conv).length === 0) delete nextConv[status.conversationId];
      else nextConv[status.conversationId] = conv;
      return { byConversation: nextConv };
    }),
}));

const EMPTY_STATUSES: Record<string, AgentStatus> = {};

/** All live statuses for a conversation, keyed by employeeId ("" = conversation-level). */
export function useConversationStatuses(conversationId: string | null): Record<string, AgentStatus> {
  return useAgentStatusStore((s) => (conversationId ? s.byConversation[conversationId] ?? EMPTY_STATUSES : EMPTY_STATUSES));
}

/** Adapt a wire AgentStatus to the render-layer LiveActivity shape. */
export function toLiveActivity(status: AgentStatus): LiveActivity {
  return {
    statusMessage: status.message,
    toolName: status.toolName,
    lastEventAt: new Date(status.lastEventAt).getTime(),
  };
}
