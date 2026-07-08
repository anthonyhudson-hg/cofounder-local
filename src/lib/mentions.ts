export interface MentionTarget {
  type: "employee" | "channel";
  conversationId: string;
  label: string;
}

/**
 * Mention targets are scoped to who/what is actually visible from a given
 * conversation: only employees who participate in it, and only channels that
 * are reachable from it. This keeps a DM's @mentions to its own participants
 * (no tagging someone from an unrelated DM) and a channel's @mentions to its
 * own members.
 */
export function scopedMentionTargets(params: {
  participantEmployees: { conversation_id: string; name: string }[];
  accessibleChannels: { id: string; name: string }[];
}): MentionTarget[] {
  return [
    ...params.participantEmployees.map((e) => ({
      type: "employee" as const,
      conversationId: e.conversation_id,
      label: e.name,
    })),
    ...params.accessibleChannels.map((c) => ({
      type: "channel" as const,
      conversationId: c.id,
      label: c.name,
    })),
  ];
}

export interface MentionMatch {
  type: "employee" | "channel";
  target: MentionTarget;
  start: number;
  end: number;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

export function findMentions(content: string, targets: MentionTarget[]): MentionMatch[] {
  const byPrefix = (type: "employee" | "channel", prefix: string) =>
    targets
      .filter((t) => t.type === type)
      .sort((a, b) => b.label.length - a.label.length)
      .map((t) => ({ t, needle: `${prefix}${t.label}` }));

  const candidates = [...byPrefix("employee", "@"), ...byPrefix("channel", "#")];
  const matches: MentionMatch[] = [];

  for (const { t, needle } of candidates) {
    let idx = 0;
    while ((idx = content.indexOf(needle, idx)) !== -1) {
      const endIdx = idx + needle.length;
      // Only the trailing boundary was checked before — a mention embedded directly
      // after a word character with no separating whitespace (e.g. "cc@Ben Dover")
      // still registered as a match. Require a boundary on both edges, matching how
      // @mentions work everywhere else (report §5.9).
      if (!isWordChar(content[idx - 1]) && !isWordChar(content[endIdx])) {
        matches.push({ type: t.type, target: t, start: idx, end: endIdx });
      }
      idx = endIdx;
    }
  }

  matches.sort((a, b) => a.start - b.start);
  const result: MentionMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      result.push(m);
      lastEnd = m.end;
    }
  }
  return result;
}
