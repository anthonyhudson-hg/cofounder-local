/**
 * Live "what is this agent doing right now" status for an in-flight assistant
 * turn — the real-time equivalent of Paperclip's run runtime-status line
 * ("Working… / Using X · N ago"). Derived client-side from the turn's streamed
 * deltas (see useConversation/useChannel): the turn start, each tool start/end,
 * and each text chunk update it, and it clears when the turn settles.
 */
export interface LiveActivity {
  /** Subtitle status, e.g. "Thinking", "Receiving agent output". */
  statusMessage: string;
  /** Friendly name of the tool currently running, if any (takes over the subtitle). */
  toolName: string | null;
  /** ms timestamp of the last streamed event — drives the ticking "N ago" line. */
  lastEventAt: number;
}

/**
 * Humanized elapsed duration ("1 second", "2 minutes", "1 hour 5 minutes"),
 * or null for non-positive/invalid input. Ported from Paperclip's
 * formatDurationWords so the "· N ago" line reads the same way.
 */
export function formatDurationWords(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The subtitle text for a live activity: "Using X · 3 seconds ago". */
export function activityStatusText(activity: LiveActivity, nowMs: number): string {
  const primary = activity.toolName ? `Using ${activity.toolName}` : activity.statusMessage;
  const elapsed = formatDurationWords(nowMs - activity.lastEventAt);
  const ageMs = nowMs - activity.lastEventAt;
  const activityText = elapsed ? (ageMs >= 15_000 ? `no output for ${elapsed} — still running` : `${elapsed} ago`) : "";
  return [primary, activityText].filter(Boolean).join(" · ");
}
