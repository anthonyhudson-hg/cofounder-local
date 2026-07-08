import { useCallback, useEffect, useRef, useState } from "react";
import { command, commandStreaming, query } from "../lib/runtimeClient";
import { REACTOR_USER, Reaction } from "../types";
import { Employee, Message } from "../types";
import { ReplyTarget } from "./useConversation";
import { useStaleGuard } from "./useStaleGuard";

interface ChannelResponderOutcome {
  employeeId: string;
  respond: boolean;
  posted: boolean;
  error?: string;
}

interface SendChannelMessageResult {
  userMessageId: string;
  responders: ChannelResponderOutcome[];
}

/**
 * The runtime now owns the entire channel turn loop — relevance-gating every
 * member, running each responder in parallel, and parsing each one's
 * control-block for whether/where to post and which reactions to add (full
 * cutover — this used to be an entirely client-orchestrated flow spanning
 * per-member `cos_check_relevance`/`cos_send_channel` legacy sidecar calls).
 * This hook is now just a thin optimistic-UI layer over the single
 * `message.sendChannel` command; the actual responses simply appear on the
 * `reload()` once the whole turn settles (no live streaming — channel replies
 * never streamed to the UI even before this cutover).
 */
export function useChannel(conversationId: string, companyId: string, onActivity?: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [members, setMembers] = useState<Employee[]>([]);
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<Message[]>([]);
  // Separate stale guards per reload target — this hook is not remounted per
  // conversationId (confirmed via ChatPane's lack of a `key`), so a fast channel
  // switch can otherwise let an older conversation's slower response land after
  // the new one's and briefly show the wrong channel's data (report §1.3).
  const membersGuard = useStaleGuard();
  const reactionsGuard = useStaleGuard();
  const messagesGuard = useStaleGuard();

  const reloadMembers = useCallback(async () => {
    const token = membersGuard.begin();
    const rows = await query<Employee[]>("channel.members", { conversationId }, null);
    if (!membersGuard.isCurrent(token)) return;
    setMembers(rows);
  }, [conversationId, membersGuard]);

  const reloadReactions = useCallback(async () => {
    const token = reactionsGuard.begin();
    const rows = await query<Reaction[]>("reactions.list", { conversationId }, null);
    if (!reactionsGuard.isCurrent(token)) return;
    const grouped: Record<string, string[]> = {};
    for (const r of rows) (grouped[r.message_id] ??= []).push(r.emoji);
    setReactions(grouped);
  }, [conversationId, reactionsGuard]);

  const reload = useCallback(async () => {
    const token = messagesGuard.begin();
    const rows = await query<Message[]>("messages.list", { conversationId }, null);
    const replyCountRows = await query<Record<string, number>>("messages.replyCounts", { conversationId }, null);
    if (!messagesGuard.isCurrent(token)) return;
    messagesRef.current = rows;
    setMessages(rows);
    setReplyCounts(replyCountRows);
    await reloadReactions();
  }, [conversationId, reloadReactions, messagesGuard]);

  useEffect(() => {
    reload();
    reloadMembers();
  }, [reload, reloadMembers]);

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      // Previously called with a null company scope, which register.ts's
      // reaction.toggle handler rejects via requireCompany() — every reaction
      // click threw "this operation requires a company scope" (a real,
      // pre-existing bug surfaced while wiring this hook up to the runtime).
      await command("reaction.toggle", { messageId, emoji, reactor: REACTOR_USER }, companyId);
      await reloadReactions();
    },
    [reloadReactions, companyId],
  );

  const send = useCallback(
    async (text: string, replyTo?: ReplyTarget) => {
      const trimmed = text.trim();
      if (!trimmed || members.length === 0) return;

      // A client-generated placeholder for optimistic rendering only — the
      // server assigns the real id; `reload()` below reconciles it.
      const userMsgId = crypto.randomUUID();
      const userThreadRootId = replyTo ? replyTo.threadRootId ?? replyTo.messageId : null;
      if (!userThreadRootId) {
        const userMsg: Message = {
          id: userMsgId, conversation_id: conversationId, role: "user", content: trimmed,
          model: null, effort: null, input_tokens: null, output_tokens: null,
          cache_creation_input_tokens: null, cache_read_input_tokens: null, total_cost_usd: null,
          status: "complete", error_message: null, debug_payload: null,
          thread_root_id: userThreadRootId, reply_to_message_id: replyTo?.messageId ?? null,
          author_employee_id: null, created_at: new Date().toISOString(),
        };
        messagesRef.current = [...messagesRef.current, userMsg];
        setMessages(messagesRef.current);
      }
      onActivity?.();

      setSending(true);
      try {
        await commandStreaming<SendChannelMessageResult>(
          "message.sendChannel",
          { conversationId, text: trimmed, replyTo: replyTo ? { messageId: replyTo.messageId, threadRootId: replyTo.threadRootId } : null },
          companyId,
          () => {},
        );
      } finally {
        // Channel replies (and any reactions responders added) only exist once
        // the whole turn settles — reload picks up everything in one shot.
        await reload();
        setSending(false);
      }
    },
    [conversationId, companyId, members, onActivity, reload],
  );

  return { messages, replyCounts, reactions, toggleReaction, members, send, sending, reload };
}
