import { Hash, UsersThree } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentStatus } from "@shared/protocol";
import { useChannel } from "../hooks/useChannel";
import { useChannelMembership } from "../hooks/useChannelMembership";
import { useConversation } from "../hooks/useConversation";
import type { LiveActivity } from "../lib/liveActivity";
import { MentionTarget, scopedMentionTargets } from "../lib/mentions";
import { toLiveActivity, useConversationStatuses } from "../store/agentStatus";
import { Conversation, DEFAULT_MODEL_ID, Effort, Employee, Message } from "../types";
import { Avatar } from "./Avatar";
import { ChannelMembersModal } from "./ChannelMembersModal";
import { Composer } from "./Composer";
import { EmployeeInfo, MessageList, type PendingActivity } from "./MessageList";
import { ThreadPanel } from "./ThreadPanel";

/**
 * Split the live agent statuses for a conversation into (a) the activity for a
 * streaming assistant message already on screen (keyed to the row by author),
 * and (b) "pending" statuses that have no row yet — a channel responder before
 * it posts, the relevance gate (no employee), or a turn another window started —
 * rendered as synthetic working rows.
 */
function deriveActivityRows(
  messages: Message[],
  statuses: Record<string, AgentStatus>,
  employeesById: Record<string, EmployeeInfo>,
): { activityFor: (m: Message) => LiveActivity | undefined; pendingActivities: PendingActivity[] } {
  const streamingEmployees = new Set(
    messages
      .filter((m) => m.role === "assistant" && m.status === "streaming" && m.author_employee_id)
      .map((m) => m.author_employee_id as string),
  );
  const activityFor = (m: Message): LiveActivity | undefined => {
    // Only the CURRENTLY-streaming message shows the live status. Keying by author
    // alone attached the badge/"Working" block to that employee's *previous*
    // (already-complete) messages too, since they share an author_employee_id.
    if (m.role !== "assistant" || m.status !== "streaming" || !m.author_employee_id) return undefined;
    const s = statuses[m.author_employee_id];
    return s ? toLiveActivity(s) : undefined;
  };
  const pendingActivities: PendingActivity[] = [];
  for (const [key, s] of Object.entries(statuses)) {
    if (key && streamingEmployees.has(key)) continue; // already shown on its message row
    pendingActivities.push({
      key: key || "__conversation__",
      name: key ? employeesById[key]?.name ?? "Someone" : undefined,
      avatar: key ? employeesById[key]?.avatar ?? null : null,
      activity: toLiveActivity(s),
    });
  }
  return { activityFor, pendingActivities };
}

interface Props {
  conversation: Conversation;
  employee: Employee | null;
  employees: Employee[];
  channels: Conversation[];
  companyId: string;
  employeesById: Record<string, EmployeeInfo>;
  onNavigate: (conversationId: string) => void;
  onOpenSidebar: () => void;
  onActivity: () => void;
  /** A message jumped to from global search — scrolled to + highlighted, thread auto-opened. */
  focusTarget?: { messageId: string; threadRootId: string | null } | null;
  onFocusHandled?: () => void;
}

export function ChatPane(props: Props) {
  if (props.conversation.kind === "channel" || !!props.conversation.is_group) {
    return <ChannelChatPane {...props} />;
  }
  return <DmChatPane {...props} />;
}

/**
 * Drives jump-to-message from global search: opens the thread if the target is a
 * reply, then hands the message id to whichever list (main pane or thread) owns it.
 * Must be called AFTER the pane's own conversation-change reset effect so it wins the
 * openThreadId race on a cross-conversation jump.
 */
function useJumpToMessage(
  conversationId: string,
  focusTarget: Props["focusTarget"],
  onFocusHandled: (() => void) | undefined,
  setOpenThreadId: (id: string | null) => void,
) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const [inThread, setInThread] = useState(false);

  // Clear a stale focus when the conversation changes (runs before the target effect below).
  useEffect(() => {
    setFocusId(null);
    setInThread(false);
  }, [conversationId]);

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.threadRootId) {
      setOpenThreadId(focusTarget.threadRootId);
      setInThread(true);
    } else {
      setInThread(false);
    }
    setFocusId(focusTarget.messageId);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  return {
    mainFocusId: inThread ? undefined : focusId ?? undefined,
    threadFocusId: inThread ? focusId ?? undefined : undefined,
  };
}

function ChannelChatPane({
  conversation,
  employees,
  channels,
  companyId,
  employeesById,
  onNavigate,
  onOpenSidebar,
  onActivity,
  focusTarget,
  onFocusHandled,
}: Props) {
  const isGroup = !!conversation.is_group;
  const { messages, replyCounts, reactions, toggleReaction, members, send, sending } = useChannel(
    conversation.id,
    companyId,
    onActivity,
  );
  const statuses = useConversationStatuses(conversation.id);
  const { activityFor, pendingActivities } = useMemo(
    () => deriveActivityRows(messages, statuses, employeesById),
    [messages, statuses, employeesById],
  );

  const [showDebug, setShowDebug] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);

  // Memoized: this was recomputed to a brand-new array/object graph every render
  // regardless of whether members/channels actually changed, which flowed down into
  // MessageList/MessageRow/MarkdownContent and defeated memoization there (report §5.2).
  const mentionTargets = useMemo(
    () =>
      scopedMentionTargets({
        participantEmployees: members.map((m) => ({
          conversation_id: m.conversation_id,
          name: employeesById[m.id]?.name ?? "Employee",
        })),
        accessibleChannels: channels.filter((c) => c.id !== conversation.id),
      }),
    [members, employeesById, channels, conversation.id],
  );

  useEffect(() => {
    setOpenThreadId(null);
    setReplyingTo(null);
  }, [conversation.id]);

  const { mainFocusId, threadFocusId } = useJumpToMessage(conversation.id, focusTarget, onFocusHandled, setOpenThreadId);

  const replyPreview = replyingTo
    ? {
        authorName:
          replyingTo.role === "user"
            ? "You"
            : (replyingTo.author_employee_id && employeesById[replyingTo.author_employee_id]?.name) ??
              conversation.name,
        snippet: replyingTo.content.slice(0, 80),
      }
    : null;

  const handleMentionClick = useCallback((target: MentionTarget) => onNavigate(target.conversationId), [onNavigate]);

  return (
    <div className="chat-pane-row">
      <div className="chat-pane">
        <header className="chat-header">
          <button className="hamburger" onClick={onOpenSidebar} aria-label="Open sidebar">
            <span />
            <span />
            <span />
          </button>
          <div className="chat-header-icon">
            {isGroup ? <UsersThree weight="fill" /> : <Hash weight="bold" />}
          </div>
          <div className="chat-header-title">{conversation.name}</div>
          <button className="channel-member-count-btn" onClick={() => setMembersOpen(true)}>
            <UsersThree weight="fill" /> {members.length} {members.length === 1 ? "member" : "members"}
          </button>
          <button
            className={`debug-toggle-btn ${showDebug ? "active" : ""}`}
            onClick={() => setShowDebug((v) => !v)}
          >
            Debug
          </button>
        </header>

        <MessageList
          conversation={conversation}
          messages={messages}
          employeesById={employeesById}
          reactions={reactions}
          onToggleReaction={toggleReaction}
          showDebug={showDebug}
          mentionTargets={mentionTargets}
          onMentionClick={handleMentionClick}
          replyCounts={replyCounts}
          onOpenThread={setOpenThreadId}
          onReply={setReplyingTo}
          focusMessageId={mainFocusId}
          activityFor={activityFor}
          pendingActivities={pendingActivities}
        />

        <Composer
          placeholder={isGroup ? `Message ${conversation.name}` : `Message #${conversation.name}`}
          onSend={(text) => {
            send(text, replyingTo ? { messageId: replyingTo.id, threadRootId: replyingTo.thread_root_id } : undefined);
            setReplyingTo(null);
          }}
          mentionTargets={mentionTargets}
          replyPreview={replyPreview}
          onCancelReply={() => setReplyingTo(null)}
        />
      </div>

      {openThreadId && (
        <ThreadPanel
          conversation={conversation}
          threadRootId={openThreadId}
          employeesById={employeesById}
          reactions={reactions}
          onToggleReaction={toggleReaction}
          showDebug={showDebug}
          mentionTargets={mentionTargets}
          onMentionClick={handleMentionClick}
          onSend={(text, _m, _e, replyTo) => send(text, replyTo)}
          sending={sending}
          onClose={() => setOpenThreadId(null)}
          focusMessageId={threadFocusId}
        />
      )}

      {membersOpen && (
        <ChannelMembersModal
          conversationId={conversation.id}
          channelName={conversation.name}
          employees={employees}
          employeesById={employeesById}
          onClose={() => setMembersOpen(false)}
        />
      )}
    </div>
  );
}

function DmChatPane({
  conversation,
  employee,
  channels,
  companyId,
  employeesById,
  onNavigate,
  onOpenSidebar,
  onActivity,
  focusTarget,
  onFocusHandled,
}: Props) {
  const { messages, replyCounts, reactions, toggleReaction, send, cancel, sending } = useConversation(
    conversation.id,
    companyId,
    employee,
    onActivity,
  );
  const { memberOf: employeeChannelIds } = useChannelMembership(employee?.id ?? "");
  const statuses = useConversationStatuses(conversation.id);
  const { activityFor, pendingActivities } = useMemo(
    () => deriveActivityRows(messages, statuses, employeesById),
    [messages, statuses, employeesById],
  );

  const mentionTargets = useMemo(
    () =>
      scopedMentionTargets({
        participantEmployees: employee ? [{ conversation_id: employee.conversation_id, name: conversation.name }] : [],
        accessibleChannels: channels.filter((c) => employeeChannelIds.has(c.id)),
      }),
    [employee, conversation.name, channels, employeeChannelIds],
  );

  const [model, setModel] = useState(employee?.default_model ?? DEFAULT_MODEL_ID);
  const [effort, setEffort] = useState<Effort>(employee?.default_effort ?? "medium");
  const [showDebug, setShowDebug] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (employee) {
      setModel(employee.default_model);
      setEffort(employee.default_effort);
    }
    setOpenThreadId(null);
    setReplyingTo(null);
  }, [employee?.conversation_id, conversation.id]);

  const { mainFocusId, threadFocusId } = useJumpToMessage(conversation.id, focusTarget, onFocusHandled, setOpenThreadId);

  const replyPreview = replyingTo
    ? {
        authorName: replyingTo.role === "user" ? "You" : conversation.name,
        snippet: replyingTo.content.slice(0, 80),
      }
    : null;

  const handleMentionClick = useCallback((target: MentionTarget) => onNavigate(target.conversationId), [onNavigate]);

  return (
    <div className="chat-pane-row">
      <div className="chat-pane">
        <header className="chat-header">
          <button className="hamburger" onClick={onOpenSidebar} aria-label="Open sidebar">
            <span />
            <span />
            <span />
          </button>
          <Avatar name={conversation.name} avatar={employee?.avatar} bot className="chat-header-avatar" />
          <div className="chat-header-title">{conversation.name}</div>
          {employee && (
            <button
              className={`debug-toggle-btn ${showDebug ? "active" : ""}`}
              onClick={() => setShowDebug((v) => !v)}
            >
              Debug
            </button>
          )}
        </header>

        <MessageList
          conversation={conversation}
          messages={messages}
          employeesById={employeesById}
          dmAvatar={employee?.avatar}
          reactions={reactions}
          onToggleReaction={toggleReaction}
          showDebug={showDebug}
          mentionTargets={mentionTargets}
          onMentionClick={handleMentionClick}
          replyCounts={replyCounts}
          onOpenThread={setOpenThreadId}
          onReply={setReplyingTo}
          focusMessageId={mainFocusId}
          activityFor={activityFor}
          pendingActivities={pendingActivities}
        />

        <Composer
          placeholder={`Message ${conversation.name}`}
          onSend={(text) => {
            send(
              text,
              model,
              effort,
              replyingTo ? { messageId: replyingTo.id, threadRootId: replyingTo.thread_root_id } : undefined,
            );
            setReplyingTo(null);
          }}
          showModelEffort={!!employee}
          model={model}
          effort={effort}
          onModelChange={setModel}
          onEffortChange={setEffort}
          mentionTargets={mentionTargets}
          replyPreview={replyPreview}
          onCancelReply={() => setReplyingTo(null)}
          sending={sending}
          onCancel={cancel}
        />
      </div>

      {openThreadId && (
        <ThreadPanel
          conversation={conversation}
          threadRootId={openThreadId}
          employeesById={employeesById}
          reactions={reactions}
          onToggleReaction={toggleReaction}
          showDebug={showDebug}
          mentionTargets={mentionTargets}
          onMentionClick={handleMentionClick}
          onSend={(text, m, e, replyTo) => send(text, m, e, replyTo)}
          sending={sending}
          onCancel={cancel}
          showModelEffort={!!employee}
          model={model}
          effort={effort}
          onModelChange={setModel}
          onEffortChange={setEffort}
          onClose={() => setOpenThreadId(null)}
          focusMessageId={threadFocusId}
        />
      )}
    </div>
  );
}
