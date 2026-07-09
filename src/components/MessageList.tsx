import { Hash, UsersThree } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef } from "react";
import type { LiveActivity } from "../lib/liveActivity";
import { MentionTarget } from "../lib/mentions";
import { focusMessageRow } from "../lib/scrollToMessage";
import { Conversation, Message, type Approval, type ApprovalDecision, type Question, type SubAnswer } from "../types";
import { Avatar } from "./Avatar";
import { AgentWorkingRow, MessageRow } from "./MessageRow";

/** A live agent status that has no message row of its own yet — rendered as a
 *  synthetic "working" row (a channel responder before it posts, the relevance
 *  gate, or a turn another window initiated). */
export interface PendingActivity {
  key: string;
  /** Absent for a conversation-level status (e.g. the relevance gate). */
  name?: string;
  avatar?: string | null;
  activity: LiveActivity;
}

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
  /** A message to scroll to + briefly highlight (jumped-to from global search). */
  focusMessageId?: string;
  /** The live activity for a streaming assistant message, if its author is
   *  working right now. A DM has at most one in-flight message; a channel can
   *  have several responders at once (keyed by employeeId), so the lookup is
   *  left to the caller rather than MessageList assuming DM's shape. */
  activityFor?: (message: Message) => LiveActivity | undefined;
  /** Working agents that don't have a message row yet — rendered as synthetic
   *  rows below the conversation (channel responders pre-post, relevance gate). */
  pendingActivities?: PendingActivity[];
  /** Structured questions the agents asked, keyed by anchor message id (DM: the
   *  asking assistant message; channel: the responder's ephemeral row id). */
  questions?: Record<string, Question[]>;
  onAnswerQuestion?: (questionId: string, answers: Record<string, SubAnswer>) => void;
  /** Gated tool approvals awaiting sign-off, keyed by the same anchor scheme. */
  approvals?: Record<string, Approval[]>;
  onResolveApproval?: (approvalId: string, decision: ApprovalDecision) => void;
  /** Label for the "Always in …" button on approval cards. */
  approvalScopeLabel?: string;
}

// Shared sentinel so messages with no reactions all pass the same referentially-stable
// empty array to MessageRow instead of a fresh `[]` literal every render (report §6.1).
const EMPTY_REACTIONS: string[] = [];
const EMPTY_QUESTIONS: Question[] = [];
const EMPTY_APPROVALS: Approval[] = [];

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
  focusMessageId,
  activityFor,
  pendingActivities,
  questions,
  onAnswerQuestion,
  approvals,
  onResolveApproval,
  approvalScopeLabel,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const focusedRef = useRef<string | null>(null);
  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  useEffect(() => {
    const el = containerRef.current;
    // Only auto-scroll if the viewport was already near the bottom before this update —
    // otherwise a user reading earlier history mid-stream gets yanked to the bottom on
    // every single token (report §5.2).
    if (el && !wasNearBottomRef.current) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pendingActivities]);

  // Defined AFTER the auto-scroll effect so, on the commit where we jump to a search
  // result, this runs last and wins. The ref guard flashes each target only once (the
  // effect re-runs as `messages` load in), and clears when the target changes so the
  // same message can be jumped to again later.
  useEffect(() => {
    if (!focusMessageId) {
      focusedRef.current = null;
      return;
    }
    if (focusedRef.current === focusMessageId) return;
    if (focusMessageRow(containerRef.current, focusMessageId)) focusedRef.current = focusMessageId;
  }, [focusMessageId, messages]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  };

  if (messages.length === 0 && !pendingActivities?.length) {
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
          ) : conversation.is_group ? (
            <>
              <div className="empty-state-icon">
                <UsersThree weight="fill" size={26} />
              </div>
              <h2>{conversation.name}</h2>
              <p>This is the very beginning of the {conversation.name} group.</p>
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
            activity={activityFor?.(m)}
            questions={questions?.[m.id] ?? EMPTY_QUESTIONS}
            onAnswerQuestion={onAnswerQuestion}
            approvals={approvals?.[m.id] ?? EMPTY_APPROVALS}
            onResolveApproval={onResolveApproval}
            approvalScopeLabel={approvalScopeLabel}
          />
        );
      })}
      {pendingActivities?.map((p) => (
        <AgentWorkingRow key={p.key} name={p.name} avatar={p.avatar} activity={p.activity} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
