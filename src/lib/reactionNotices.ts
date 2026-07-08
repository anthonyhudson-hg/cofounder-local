import { command } from "./runtimeClient";
import { describeReactionIntent } from "./emoji";
import { ReactionNotice } from "../types";

/**
 * Consumes unseen reactions on an employee's messages (marks them notified on
 * the runtime) and formats them for prompt injection. The DB half runs in the
 * runtime; emoji-intent copy stays here on the client.
 */
export async function consumeReactionNotices(
  employeeId: string,
  userFullName: string,
): Promise<ReactionNotice[]> {
  const { notices } = await command<{
    notices: { emoji: string; fromName: string; messageContent: string }[];
  }>("reactionNotices.consume", { employeeId, userFullName }, null);

  return notices.map((n) => ({
    emoji: n.emoji,
    fromName: n.fromName ?? "Someone",
    onMessagePreview: n.messageContent.slice(0, 120),
    intent: describeReactionIntent(n.emoji),
  }));
}

export function formatReactionNotices(notices: ReactionNotice[]): string {
  if (notices.length === 0) return "";
  const lines = notices.map(
    (n) => `- ${n.fromName} reacted ${n.emoji} (${n.intent}) to your message: "${n.onMessagePreview}"`,
  );
  return `[Reactions since your last turn]\n${lines.join("\n")}`;
}
