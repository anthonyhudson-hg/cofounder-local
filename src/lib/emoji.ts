export interface EmojiCategory {
  label: string;
  emojis: string[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    label: "Smileys",
    emojis: ["😀", "😄", "😂", "🙂", "😉", "😍", "🤔", "😅", "😬", "😮", "🥲", "😴", "🙃", "🤯", "😎"],
  },
  {
    label: "Gestures",
    emojis: ["👍", "👎", "👏", "🙌", "🙏", "🤝", "👌", "✌️", "🤞", "💪", "🫡", "👋"],
  },
  {
    label: "Hearts",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "💯"],
  },
  {
    label: "Status",
    emojis: ["✅", "❌", "⚠️", "🚧", "🔥", "⭐", "🎉", "🚀", "⏳", "🔁", "📌", "🔒"],
  },
  {
    label: "Faces & attention",
    emojis: ["👀", "🤨", "😱", "🥳", "😭", "🫠", "🧐", "🙄"],
  },
];

export const QUICK_REACTIONS = ["👍", "🎉", "❤️", "😂", "👀"];

export const REACTION_INTENTS: Record<string, string> = {
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
