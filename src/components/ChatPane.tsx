import { Hash, UsersThree } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChannel } from "../hooks/useChannel";
import { useChannelMembership } from "../hooks/useChannelMembership";
import { useConversation } from "../hooks/useConversation";
import { MentionTarget, scopedMentionTargets } from "../lib/mentions";
import { Conversation, DEFAULT_MODEL_ID, Effort, Employee, Message } from "../types";
import { Avatar } from "./Avatar";
import { ChannelMembersModal } from "./ChannelMembersModal";
import { Composer } from "./Composer";
import { EmployeeInfo, MessageList } from "./MessageList";
import { ThreadPanel } from "./ThreadPanel";

interface Props {
  conversation: Conversation;
  employee: Employee | null;
  employees: Employee[];
  channels: Conversation[];
  companyProfile: string;
  companySystemPrompt: string;
  userFullName: string;
  employeesById: Record<string, EmployeeInfo>;
  onNavigate: (conversationId: string) => void;
  onOpenSidebar: () => void;
  onActivity: () => void;
}

export function ChatPane(props: Props) {
  if (props.conversation.kind === "channel" || !!props.conversation.is_group) {
    return <ChannelChatPane {...props} />;
  }
  return <DmChatPane {...props} />;
}

function ChannelChatPane({
  conversation,
  employees,
  channels,
  companyProfile,
  companySystemPrompt,
  userFullName,
  employeesById,
  onNavigate,
  onOpenSidebar,
  onActivity,
}: Props) {
  const isGroup = !!conversation.is_group;
  const { messages, replyCounts, reactions, toggleReaction, members, send, sending } = useChannel(
    conversation.id,
    conversation.name,
    companyProfile,
    companySystemPrompt,
    userFullName,
    employeesById,
    onActivity,
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
        />

        <Composer
          placeholder={isGroup ? `Message ${conversation.name}` : `Message #${conversation.name}`}
          disabled={sending}
          onSend={(text) => {
            send(text, replyingTo ? { messageId: replyingTo.id, threadRootId: replyingTo.thread_root_id } : undefined);
            setReplyingTo(null);
          }}
          model=""
          effort="medium"
          onModelChange={() => {}}
          onEffortChange={() => {}}
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
          showModelEffort={false}
          model=""
          effort="medium"
          onModelChange={() => {}}
          onEffortChange={() => {}}
          onClose={() => setOpenThreadId(null)}
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
  companyProfile,
  companySystemPrompt,
  userFullName,
  employeesById,
  onNavigate,
  onOpenSidebar,
  onActivity,
}: Props) {
  const { messages, replyCounts, reactions, toggleReaction, send, sending } = useConversation(
    conversation.id,
    employee,
    conversation.name,
    companyProfile,
    companySystemPrompt,
    userFullName,
    employeesById,
    onActivity,
  );
  const { memberOf: employeeChannelIds } = useChannelMembership(employee?.id ?? "");

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
        />

        <Composer
          placeholder={`Message ${conversation.name}`}
          disabled={!!employee && sending}
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
          showModelEffort={!!employee}
          model={model}
          effort={effort}
          onModelChange={setModel}
          onEffortChange={setEffort}
          onClose={() => setOpenThreadId(null)}
        />
      )}
    </div>
  );
}
