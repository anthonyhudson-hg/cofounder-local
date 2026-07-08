/**
 * Server-side fork of src/lib/emoji.ts's REACTION_INTENTS/describeReactionIntent
 * plus src/lib/reactionNotices.ts's formatReactionNotices (intentional
 * duplication, matching the existing promptBuilder.ts fork — see report §1.7).
 * Turns the raw DB rows from conversations/service.ts's consumeReactionNotices
 * into the same prompt-injected block the client used to build.
 */

const REACTION_INTENTS: Record<string, string> = {
  "👍": "approval / agreement — you're good to proceed",
  "👎": "disagreement / concern — reconsider this",
  "✅": "done / confirmed — this is handled",
  "👀": "noted / watching this — more may be coming, no action needed yet",
  "🎉": "celebration — nice work",
  "🔥": "strong approval — this is great",
  "❤️": "appreciated / thank you",
  "😂": "found this funny",
  "⚠️": "flagging a concern — treat as a caution",
  "🚧": "work in progress — not ready yet",
  "❌": "rejected / incorrect — do not proceed as-is",
  "🙏": "thank you / please",
  "🤔": "uncertain / questioning — may need clarification",
  "🚀": "let's ship it / go ahead",
};

export function describeReactionIntent(emoji: string): string {
  return REACTION_INTENTS[emoji] ?? "no specific agreed meaning — read from context";
}

export interface FormattedReactionNotice {
  emoji: string;
  fromName: string;
  onMessagePreview: string;
  intent: string;
}

export interface RawReactionNotice {
  emoji: string;
  fromName: string;
  messageContent: string;
}

/** Mirrors client formatReactionNotices()'s 120-char preview truncation + wording. */
export function formatReactionNoticesForPrompt(
  raw: RawReactionNotice[],
): { notices: FormattedReactionNotice[]; block: string } {
  const notices = raw.map((n) => ({
    emoji: n.emoji,
    fromName: n.fromName,
    onMessagePreview: n.messageContent.slice(0, 120),
    intent: describeReactionIntent(n.emoji),
  }));
  if (notices.length === 0) return { notices, block: "" };
  const lines = notices.map(
    (n) => `- ${n.fromName} reacted ${n.emoji} (${n.intent}) to your message: "${n.onMessagePreview}"`,
  );
  return { notices, block: `[Reactions since your last turn]\n${lines.join("\n")}` };
}
