import { Hash } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef } from "react";
import { MentionTarget } from "../lib/mentions";
import { Conversation, Message } from "../types";
import { Avatar } from "./Avatar";
import { MessageRow } from "./MessageRow";

export interface EmployeeInfo {
  name: string;
  avatar: string | null;
}

interface Props {
  conversation: Conversation;
  messages: Message[];
  employeesById: Record<string, EmployeeInfo>;
  dmAvatar?: string | null;
  reactions: Record<string, string[]>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  showDebug: boolean;
  mentionTargets: MentionTarget[];
  onMentionClick: (target: MentionTarget) => void;
  replyCounts: Record<string, number>;
  onOpenThread: (rootMessageId: string) => void;
  onReply: (message: Message) => void;
}

// Shared sentinel so messages with no reactions all pass the same referentially-stable
// empty array to MessageRow instead of a fresh `[]` literal every render (report §6.1).
const EMPTY_REACTIONS: string[] = [];

// A viewport is considered "at the bottom" within this many pixels of true bottom —
// close enough that arriving content should still auto-scroll.
const AUTO_SCROLL_THRESHOLD_PX = 80;

export function MessageList({
  conversation,
  messages,
  employeesById,
  dmAvatar,
  reactions,
  onToggleReaction,
  showDebug,
  mentionTargets,
  onMentionClick,
  replyCounts,
  onOpenThread,
  onReply,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  useEffect(() => {
    const el = containerRef.current;
    // Only auto-scroll if the viewport was already near the bottom before this update —
    // otherwise a user reading earlier history mid-stream gets yanked to the bottom on
    // every single token (report §5.2).
    if (el && !wasNearBottomRef.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  };

  if (messages.length === 0) {
    return (
      <div className="message-list message-list-empty">
        <div className="empty-state">
          {conversation.kind === "channel" ? (
            <>
              <div className="empty-state-icon">
                <Hash weight="bold" size={26} />
              </div>
              <h2>Welcome to #{conversation.name}</h2>
              <p>This is the very beginning of the #{conversation.name} channel.</p>
            </>
          ) : (
            <>
              <Avatar name={conversation.name} avatar={dmAvatar} bot className="empty-state-icon dm" />
              <h2>{conversation.name}</h2>
              <p>This is the very beginning of your direct message history with {conversation.name}.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="message-list" ref={containerRef} onScroll={handleScroll}>
      {messages.map((m) => {
        const authorInfo = m.author_employee_id ? employeesById[m.author_employee_id] : null;
        const displayName = m.role === "user" ? "You" : authorInfo?.name ?? conversation.name;
        const replyTarget = m.reply_to_message_id ? messagesById.get(m.reply_to_message_id) : null;
        const replyAuthorName = replyTarget
          ? replyTarget.role === "user"
            ? "You"
            : (replyTarget.author_employee_id && employeesById[replyTarget.author_employee_id]?.name) ??
              conversation.name
          : m.reply_to_message_id
            ? "a message"
            : undefined;
        const replySnippet = replyTarget ? replyTarget.content.slice(0, 80) : undefined;

        return (
          <MessageRow
            key={m.id}
            message={m}
            displayName={displayName}
            avatar={authorInfo?.avatar}
            reactions={reactions[m.id] ?? EMPTY_REACTIONS}
            onToggleReaction={onToggleReaction}
            showDebug={showDebug}
            mentionTargets={mentionTargets}
            onMentionClick={onMentionClick}
            replyCount={replyCounts[m.id]}
            onOpenThread={onOpenThread}
            onReply={onReply}
            replyAuthorName={replyAuthorName}
            replySnippet={replySnippet}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
