import { useCallback, useEffect, useRef, useState } from "react";
import { EmployeeInfo } from "../components/MessageList";
import { command, query } from "../lib/runtimeClient";
import { buildIdentityBlock, composeSystemPrompt, resolveManagerName } from "../lib/promptBuilder";
import { consumeReactionNotices, formatReactionNotices } from "../lib/reactionNotices";
import { SidecarEvent } from "../lib/sidecarBus";
import { invokeAndWait } from "../lib/sidecarRequest";
import { findMentions } from "../lib/mentions";
import { useAgentActivity } from "../store/agentActivity";
import { ChannelDebugMeta, DebugPayload, Employee, Message, REACTOR_USER, Reaction, modelProvider } from "../types";
import { ReplyTarget } from "./useConversation";

type RelevanceResultEvent = Extract<SidecarEvent, { type: "relevance_result" }>;
type ChannelResultEvent = Extract<SidecarEvent, { type: "channel_result" }>;

// Relevance checks are a quick classification call and should fail fast; a full
// channel turn may include tool use and deserves more headroom before we give up.
const RELEVANCE_TIMEOUT_MS = 30_000;
const CHANNEL_SEND_TIMEOUT_MS = 120_000;

export function useChannel(
  conversationId: string,
  conversationName: string,
  companyProfile: string,
  companySystemPrompt: string,
  userFullName: string,
  employeesById: Record<string, EmployeeInfo>,
  onActivity?: () => void,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [members, setMembers] = useState<Employee[]>([]);
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<Message[]>([]);

  const reloadMembers = useCallback(async () => {
    setMembers(await query<Employee[]>("channel.members", { conversationId }, null));
  }, [conversationId]);

  const reloadReactions = useCallback(async () => {
    const rows = await query<Reaction[]>("reactions.list", { conversationId }, null);
    const grouped: Record<string, string[]> = {};
    for (const r of rows) (grouped[r.message_id] ??= []).push(r.emoji);
    setReactions(grouped);
  }, [conversationId]);

  const reload = useCallback(async () => {
    const rows = await query<Message[]>("messages.list", { conversationId }, null);
    messagesRef.current = rows;
    setMessages(rows);
    setReplyCounts(await query<Record<string, number>>("messages.replyCounts", { conversationId }, null));
    await reloadReactions();
  }, [conversationId, reloadReactions]);

  useEffect(() => {
    reload();
    reloadMembers();
  }, [reload, reloadMembers]);

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      await command("reaction.toggle", { messageId, emoji, reactor: REACTOR_USER }, null);
      await reloadReactions();
    },
    [reloadReactions],
  );

  // Split out so the outer `send` can guarantee `setSending(false)` via try/finally
  // regardless of where in this body a throw happens (report §1.2).
  const sendToMembers = useCallback(
    async (trimmed: string, userMsgId: string) => {
      const openThreadRows = await query<{ id: string; content: string }[]>("messages.openThreads", { conversationId, limit: 10 }, null);
      const openThreads = openThreadRows.map((r) => ({ id: r.id, preview: r.content.slice(0, 60) }));

      const recentRows = await query<Message[]>("messages.recent", { conversationId, limit: 15 }, null);
      const reactionTargets = recentRows.map((r) => ({
        id: r.id,
        author: r.author_employee_id ? employeesById[r.author_employee_id]?.name ?? "Someone" : userFullName,
        preview: r.content.slice(0, 60),
      }));

      // A directly @mentioned member ALWAYS responds (bypassing the relevance
      // gate); when there are explicit mentions, non-mentioned members stay out.
      // With no mentions, fall back to the relevance gate for everyone.
      const memberTargets = members
        .map((m) => ({ type: "employee" as const, conversationId: m.conversation_id, label: employeesById[m.id]?.name ?? "" }))
        .filter((t) => t.label);
      const mentionedConvIds = new Set(findMentions(trimmed, memberTargets).map((x) => x.target.conversationId));
      const hasMentions = mentionedConvIds.size > 0;

      const relevanceResults = await Promise.all(
        members.map(async (member) => {
          if (hasMentions) {
            return mentionedConvIds.has(member.conversation_id)
              ? { member, respond: true, reason: "Directly @mentioned." }
              : { member, respond: false, reason: "Not mentioned in a directed message." };
          }
          const managerName = resolveManagerName(member.manager_employee_id, employeesById, userFullName);
          const identityBlock = buildIdentityBlock(employeesById[member.id]?.name ?? "Employee", member, managerName);
          const responsibilityRows = await query<{ text: string }[]>("responsibilities.list", { employeeId: member.id }, null);
          const employeeContext = `${identityBlock}\nMission: ${member.mission}\nResponsibilities: ${responsibilityRows.map((r) => r.text).join("; ") || "(none listed)"}`;
          const id = crypto.randomUUID();
          try {
            const event = await invokeAndWait<RelevanceResultEvent>(
              "cos_check_relevance",
              { id, employeeContext, channelName: conversationName, triggerMessage: trimmed },
              id,
              RELEVANCE_TIMEOUT_MS,
            );
            return { member, respond: event.respond, reason: event.reason };
          } catch (err) {
            return { member, respond: false, reason: `Relevance check failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }),
      );

      await Promise.all(
        relevanceResults.map(({ member, respond, reason }) =>
          command("relevanceCheck.insert", { messageId: userMsgId, employeeId: member.id, decision: respond ? "respond" : "skip", reason }, null),
        ),
      );

      const relevanceMeta: ChannelDebugMeta["relevanceChecks"] = relevanceResults.map((r) => ({
        employeeName: employeesById[r.member.id]?.name ?? "Employee",
        decision: r.respond ? "respond" : "skip",
        reason: r.reason,
      }));

      const responders = relevanceResults.filter((r) => r.respond).map((r) => r.member);

      await Promise.all(
        responders.map(async (member) => {
          const provider = modelProvider(member.default_model);
          const session = await query<{ session_id: string | null; session_provider: string | null } | null>(
            "agentSession.get", { conversationId, employeeId: member.id }, null,
          );
          const storedProvider = session?.session_provider ?? "claude";
          const resumeSessionId = storedProvider === provider ? session?.session_id ?? null : null;

          const managerName = resolveManagerName(member.manager_employee_id, employeesById, userFullName);
          const identityBlock = buildIdentityBlock(employeesById[member.id]?.name ?? "Employee", member, managerName);
          const responsibilityRows = await query<{ text: string }[]>("responsibilities.list", { employeeId: member.id }, null);
          const responsibilities = responsibilityRows.map((r) => r.text);
          const baseSystemPrompt = composeSystemPrompt(companyProfile, companySystemPrompt, identityBlock, member, responsibilities);
          const otherMemberNames = members
            .filter((m) => m.id !== member.id)
            .map((m) => employeesById[m.id]?.name)
            .filter((n): n is string => !!n);
          const mentionScope = otherMemberNames.length
            ? `You may only @mention people who are members of this channel: ${otherMemberNames.join(", ")}. Do not @mention anyone else — they aren't part of this conversation and won't see it.`
            : `There is nobody else in this channel to @mention right now.`;
          const systemPrompt = `${baseSystemPrompt}\n\n---\n\n${mentionScope}`;

          const reactionNotices = await consumeReactionNotices(member.id, userFullName);
          const noticesBlock = formatReactionNotices(reactionNotices);
          const promptWithNotices = noticesBlock ? `${noticesBlock}\n\n${trimmed}` : trimmed;

          const id = crypto.randomUUID();
          useAgentActivity.getState().setActive(member.id, true);
          try {
            const result = await invokeAndWait<ChannelResultEvent>(
              "cos_send_channel",
              { id, provider, model: member.default_model, effort: member.default_effort, systemPrompt, prompt: promptWithNotices, resumeSessionId, openThreads, reactionTargets },
              id,
              CHANNEL_SEND_TIMEOUT_MS,
            );

            if (result.sessionId) {
              await command("agentSession.upsert", { conversationId, employeeId: member.id, sessionId: result.sessionId, provider }, null);
            }

            for (const r of result.reactions) {
              await command("reaction.add", { messageId: r.messageId, emoji: r.emoji, reactor: member.id }, null);
            }

            if (result.respondsWithText && result.text.trim()) {
              const threadRootId =
                result.threadRootId ??
                (result.replyToMessageId
                  ? openThreadRows.find((t) => t.id === result.replyToMessageId)?.id ?? result.replyToMessageId
                  : null);

              const channelMeta: ChannelDebugMeta = {
                relevanceChecks: relevanceMeta,
                replyToMessageId: result.replyToMessageId,
                threadRootId,
                reactionsApplied: result.reactions,
              };
              const debugPayload: DebugPayload = {
                model: member.default_model, effort: member.default_effort,
                companySystemPrompt, companyProfile, identityBlock,
                mission: member.mission, preamble: member.preamble, responsibilities,
                additionalDetails: member.additional_details, prompt: promptWithNotices,
                reactionNotices, resumeSessionId, sentAt: new Date().toISOString(), channel: channelMeta,
              };

              await command("message.insertChannelAssistant", {
                id: crypto.randomUUID(), conversationId, content: result.text.trim(),
                model: member.default_model, effort: member.default_effort, debugPayload: JSON.stringify(debugPayload),
                threadRootId, replyToMessageId: result.replyToMessageId, authorEmployeeId: member.id,
                usage: result.usage, totalCostUsd: result.totalCostUsd,
              }, null);
            }
          } catch (err) {
            // Covers both the send itself failing and any post-processing step above
            // (session upsert, reactions, message insert) throwing — without this the
            // whole Promise.all rejects and `sending` gets stuck true forever (report §1.2).
            await command("message.insertError", {
              id: crypto.randomUUID(), conversationId,
              errorMessage: err instanceof Error ? err.message : String(err), authorEmployeeId: member.id,
            }, null).catch(() => {});
          } finally {
            useAgentActivity.getState().setActive(member.id, false);
          }
        }),
      );

      await reload();
    },
    [conversationId, conversationName, members, employeesById, companyProfile, companySystemPrompt, userFullName, reload],
  );

  const send = useCallback(
    async (text: string, replyTo?: ReplyTarget) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const userMsgId = crypto.randomUUID();
      const userThreadRootId = replyTo ? replyTo.threadRootId ?? replyTo.messageId : null;
      const userMsg: Message = {
        id: userMsgId, conversation_id: conversationId, role: "user", content: trimmed,
        model: null, effort: null, input_tokens: null, output_tokens: null,
        cache_creation_input_tokens: null, cache_read_input_tokens: null, total_cost_usd: null,
        status: "complete", error_message: null, debug_payload: null,
        thread_root_id: userThreadRootId, reply_to_message_id: replyTo?.messageId ?? null,
        author_employee_id: null, created_at: new Date().toISOString(),
      };
      if (!userThreadRootId) {
        messagesRef.current = [...messagesRef.current, userMsg];
        setMessages(messagesRef.current);
      }
      await command("message.insertUser", {
        id: userMsgId, conversationId, content: trimmed,
        threadRootId: userThreadRootId, replyToMessageId: replyTo?.messageId ?? null,
      }, null);
      onActivity?.();

      if (members.length === 0) return;
      setSending(true);
      try {
        await sendToMembers(trimmed, userMsgId);
      } finally {
        setSending(false);
      }
    },
    [conversationId, members, onActivity, sendToMembers],
  );

  return { messages, replyCounts, reactions, toggleReaction, members, send, sending, reload };
}
