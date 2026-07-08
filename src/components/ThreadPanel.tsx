import { X } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useThread } from "../hooks/useThread";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { ReplyTarget } from "../hooks/useConversation";
import { MentionTarget } from "../lib/mentions";
import { Conversation, Effort } from "../types";
import { Composer } from "./Composer";
import { EmployeeInfo } from "./MessageList";
import { MessageRow } from "./MessageRow";

interface Props {
  conversation: Conversation;
  threadRootId: string;
  employeesById: Record<string, EmployeeInfo>;
  reactions: Record<string, string[]>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  showDebug: boolean;
  mentionTargets: MentionTarget[];
  onMentionClick: (target: MentionTarget) => void;
  onSend: (text: string, model: string, effort: Effort, replyTo: ReplyTarget) => void;
  sending: boolean;
  onCancel?: () => void;
  showModelEffort: boolean;
  model: string;
  effort: Effort;
  onModelChange: (m: string) => void;
  onEffortChange: (e: Effort) => void;
  onClose: () => void;
}

const EMPTY_REACTIONS: string[] = [];

export function ThreadPanel({
  conversation,
  threadRootId,
  employeesById,
  reactions,
  onToggleReaction,
  showDebug,
  mentionTargets,
  onMentionClick,
  onSend,
  sending,
  onCancel,
  showModelEffort,
  model,
  effort,
  onModelChange,
  onEffortChange,
  onClose,
}: Props) {
  const { messages, reload } = useThread(conversation.id, threadRootId);
  const { width, onMouseDown } = useResizableWidth(360, 280, 560, "left");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sending) reload();
  }, [sending, reload]);

  // No live streaming cursor here (unlike the main pane) — reload() only fires once
  // `sending` flips back false, so a reply appears all at once rather than streaming
  // in. Fixing that requires deriving thread messages from the same live stream driving
  // the main pane instead of a separate poll-on-idle hook (report §5.3) — tracked as a
  // larger follow-up; this pass fixes the auto-scroll-on-new-reply gap noted alongside it.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  useEscapeToClose(true, onClose);

  return (
    <aside className="thread-panel" style={{ width }}>
      <div className="resize-handle resize-handle-left" onMouseDown={onMouseDown} />
      <div className="settings-panel-header">
        <h3>Thread</h3>
        <button className="modal-close" aria-label="Close thread" onClick={onClose}>
          <X />
        </button>
      </div>
      <div className="thread-panel-body">
        {messages.map((m) => {
          const authorInfo = m.author_employee_id ? employeesById[m.author_employee_id] : null;
          const displayName = m.role === "user" ? "You" : authorInfo?.name ?? conversation.name;
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
            />
          );
        })}
        <div ref={endRef} />
      </div>
      <Composer
        placeholder="Reply in thread…"
        onSend={(text) => onSend(text, model, effort, { messageId: threadRootId, threadRootId })}
        showModelEffort={showModelEffort}
        model={model}
        effort={effort}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        sending={sending}
        onCancel={onCancel}
      />
    </aside>
  );
}
