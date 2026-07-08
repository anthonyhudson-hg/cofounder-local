import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmployeeInfo } from "../components/MessageList";
import { command, query } from "../lib/runtimeClient";
import { registerRequestHandler, unregisterRequestHandler } from "../lib/sidecarBus";
import { buildIdentityBlock, composeSystemPrompt, resolveManagerName } from "../lib/promptBuilder";
import { consumeReactionNotices, formatReactionNotices } from "../lib/reactionNotices";
import { useAgentActivity } from "../store/agentActivity";
import { REACTOR_USER } from "../types";
import { DebugPayload, Effort, Employee, Message, Reaction, modelProvider } from "../types";

export interface ReplyTarget {
  messageId: string;
  threadRootId: string | null;
}

export function useConversation(
  conversationId: string,
  employee: Employee | null,
  employeeName: string,
  companyProfile: string,
  companySystemPrompt: string,
  userFullName: string,
  employeesById: Record<string, EmployeeInfo>,
  onActivity?: () => void,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<Message[]>([]);

  const applyPatch = useCallback((id: string, patch: Partial<Message>) => {
    messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setMessages(messagesRef.current);
  }, []);

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
  }, [reload]);

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      await command("reaction.toggle", { messageId, emoji, reactor: REACTOR_USER }, null);
      await reloadReactions();
    },
    [reloadReactions],
  );

  const send = useCallback(
    async (text: string, model: string, effort: Effort, replyTo?: ReplyTarget) => {
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

      if (!employee) return;

      const provider = modelProvider(model);
      const conv = await query<{ session_id: string | null; session_provider: string | null } | null>(
        "conversation.session", { conversationId }, null,
      );
      const storedProvider = conv?.session_provider ?? "claude";
      const resumeSessionId = storedProvider === provider ? conv?.session_id ?? null : null;
      const managerName = resolveManagerName(employee.manager_employee_id, employeesById, userFullName);
      const identityBlock = buildIdentityBlock(employeeName, employee, managerName);
      const responsibilityRows = await query<{ text: string }[]>("responsibilities.list", { employeeId: employee.id }, null);
      const responsibilities = responsibilityRows.map((r) => r.text);
      const baseSystemPrompt = composeSystemPrompt(companyProfile, companySystemPrompt, identityBlock, employee, responsibilities);
      const mentionScope = `This is a private 1:1 DM between you and ${userFullName || "the founder"}. There is nobody else here to @mention — do not @mention any other employee in this conversation.`;
      const systemPrompt = `${baseSystemPrompt}\n\n---\n\n${mentionScope}\n\n---\n\nIf the message you're replying to deserves a quick reaction in addition to (or instead of, if you have nothing to add) a full reply, end your response with a line like [[react:👍]] using one relevant emoji. Omit this entirely if no reaction is warranted.`;

      const reactionNotices = await consumeReactionNotices(employee.id, userFullName);
      const noticesBlock = formatReactionNotices(reactionNotices);
      const promptWithNotices = noticesBlock ? `${noticesBlock}\n\n${trimmed}` : trimmed;

      const debugPayload: DebugPayload = {
        model, effort, companySystemPrompt, companyProfile, identityBlock,
        mission: employee.mission, preamble: employee.preamble, responsibilities,
        additionalDetails: employee.additional_details, prompt: promptWithNotices,
        reactionNotices, resumeSessionId, sentAt: new Date().toISOString(),
      };
      const debugPayloadJson = JSON.stringify(debugPayload);

      const assistantMsgId = crypto.randomUUID();
      const assistantMsg: Message = {
        id: assistantMsgId, conversation_id: conversationId, role: "assistant", content: "",
        model, effort, input_tokens: null, output_tokens: null,
        cache_creation_input_tokens: null, cache_read_input_tokens: null, total_cost_usd: null,
        status: "streaming", error_message: null, debug_payload: debugPayloadJson,
        thread_root_id: userThreadRootId, reply_to_message_id: null,
        author_employee_id: employee.id, created_at: new Date().toISOString(),
      };
      if (!userThreadRootId) {
        messagesRef.current = [...messagesRef.current, assistantMsg];
        setMessages(messagesRef.current);
      }
      await command("message.insertAssistantPlaceholder", {
        id: assistantMsgId, conversationId, model, effort,
        debugPayload: debugPayloadJson, threadRootId: userThreadRootId, authorEmployeeId: employee.id,
      }, null);

      setSending(true);
      useAgentActivity.getState().setActive(employee.id, true);

      registerRequestHandler(assistantMsgId, async (event) => {
        if (event.type === "delta") {
          const current = messagesRef.current.find((m) => m.id === assistantMsgId);
          applyPatch(assistantMsgId, { content: (current?.content ?? "") + event.text });
          return;
        }
        if (event.type !== "done" && event.type !== "error") return;
        // Everything below must run inside try/finally: an uncaught throw from any of
        // these commands used to leave `sending` stuck true forever (report §1.2).
        try {
          if (event.type === "done") {
            const rawContent = messagesRef.current.find((m) => m.id === assistantMsgId)?.content ?? "";
            const reactMatch = rawContent.match(/\n*\[\[react:(\S+)\]\]\s*$/);
            const finalContent = reactMatch ? rawContent.slice(0, reactMatch.index).trimEnd() : rawContent;

            applyPatch(assistantMsgId, {
              content: finalContent, status: event.success ? "complete" : "error",
              error_message: event.success ? null : "The assistant did not complete this response.",
              input_tokens: event.usage.inputTokens, output_tokens: event.usage.outputTokens,
              cache_creation_input_tokens: event.usage.cacheCreationInputTokens,
              cache_read_input_tokens: event.usage.cacheReadInputTokens, total_cost_usd: event.totalCostUsd,
            });
            await command("message.finalize", {
              id: assistantMsgId, content: finalContent,
              usage: event.usage, totalCostUsd: event.totalCostUsd,
            }, null);
            if (reactMatch) {
              await command("reaction.add", { messageId: userMsgId, emoji: reactMatch[1], reactor: employee.id }, null);
              await reloadReactions();
            }
            if (event.sessionId) {
              await command("conversation.setSession", { conversationId, sessionId: event.sessionId, provider }, null);
            }
            if (userThreadRootId) await reload();
          } else {
            applyPatch(assistantMsgId, { status: "error", error_message: event.message });
            await command("message.setError", { id: assistantMsgId, message: event.message }, null);
          }
        } catch (err) {
          applyPatch(assistantMsgId, {
            status: "error",
            error_message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          useAgentActivity.getState().setActive(employee.id, false);
          unregisterRequestHandler(assistantMsgId);
          setSending(false);
        }
      });

      try {
        await invoke("cos_send", {
          id: assistantMsgId, conversationId, provider, model, effort,
          systemPrompt, prompt: promptWithNotices, resumeSessionId,
        });
      } catch (err) {
        applyPatch(assistantMsgId, { status: "error", error_message: err instanceof Error ? err.message : String(err) });
        useAgentActivity.getState().setActive(employee.id, false);
        unregisterRequestHandler(assistantMsgId);
        setSending(false);
      }
    },
    [conversationId, employee, employeeName, companyProfile, companySystemPrompt, userFullName, employeesById, onActivity, applyPatch, reload, reloadReactions],
  );

  return { messages, replyCounts, reactions, toggleReaction, send, sending, reload };
}
