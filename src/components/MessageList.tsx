import { Hash } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
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
  const endRef = useRef<HTMLDivElement>(null);
  const messagesById = new Map(messages.map((m) => [m.id, m]));

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

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
    <div className="message-list">
      {messages.map((m) => {
        const authorInfo = m.author_employee_id ? employeesById[m.author_employee_id] : null;
        const displayName = m.role === "user" ? "You" : authorInfo?.name ?? conversation.name;
        const replyTarget = m.reply_to_message_id ? messagesById.get(m.reply_to_message_id) : null;
        const replyPreview = replyTarget
          ? {
              authorName:
                replyTarget.role === "user"
                  ? "You"
                  : (replyTarget.author_employee_id && employeesById[replyTarget.author_employee_id]?.name) ??
                    conversation.name,
              snippet: replyTarget.content.slice(0, 80),
            }
          : m.reply_to_message_id
            ? { authorName: "a message", snippet: "" }
            : null;

        return (
          <MessageRow
            key={m.id}
            message={m}
            displayName={displayName}
            avatar={authorInfo?.avatar}
            reactions={reactions[m.id] ?? []}
            onToggleReaction={(emoji) => onToggleReaction(m.id, emoji)}
            showDebug={showDebug}
            mentionTargets={mentionTargets}
            onMentionClick={onMentionClick}
            replyCount={replyCounts[m.id]}
            onOpenThread={() => onOpenThread(m.id)}
            onReply={() => onReply(m)}
            replyPreview={replyPreview}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
