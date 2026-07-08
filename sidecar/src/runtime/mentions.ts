/**
 * Server-side fork of src/lib/mentions.ts (intentional duplication, matching the
 * existing promptBuilder.ts fork — see report §1.7). Pure, dependency-free string
 * logic; kept identical so @mention detection behaves the same now that channel
 * orchestration runs in the runtime instead of the client.
 */

export interface MentionTarget {
  type: "employee" | "channel";
  conversationId: string;
  label: string;
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
