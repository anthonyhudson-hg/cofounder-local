import { useCallback, useEffect, useRef, useState } from "react";
import { command, commandStreaming, query } from "../lib/runtimeClient";
import { useAgentActivity } from "../store/agentActivity";
import { REACTOR_USER } from "../types";
import { Effort, Employee, Message, Reaction, modelProvider } from "../types";
import { useStaleGuard } from "./useStaleGuard";

export interface ReplyTarget {
  messageId: string;
  threadRootId: string | null;
}

interface SendMessageResult {
  userMessageId: string;
  assistantMessageId: string;
  sessionId: string | null;
  success: boolean;
  errorMessage?: string;
  reaction: { messageId: string; emoji: string } | null;
}

/**
 * The runtime now owns the entire DM turn loop (full cutover — this used to be
 * a client-orchestrated flow spanning several separate `cos_*` legacy sidecar
 * calls plus client-side prompt composition). This hook is now just a thin
 * optimistic-UI layer over the single `message.send` command.
 */
export function useConversation(
  conversationId: string,
  companyId: string,
  employee: Employee | null,
  onActivity?: () => void,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<Message[]>([]);
  // This hook is not remounted per conversationId (no `key` on ChatPane), so a fast DM
  // switch can otherwise let an older conversation's slower response land after the new
  // one's and briefly show the wrong conversation's data (report §1.3).
  const reactionsGuard = useStaleGuard();
  const messagesGuard = useStaleGuard();

  const applyPatch = useCallback((id: string, patch: Partial<Message>) => {
    messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setMessages(messagesRef.current);
  }, []);

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
  }, [reload]);

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
    async (text: string, model: string, effort: Effort, replyTo?: ReplyTarget) => {
      const trimmed = text.trim();
      if (!trimmed || !employee) return;

      // These ids are local placeholders for optimistic rendering only — the
      // server generates its own ids when it persists the real rows, so
      // `reload()` below always replaces this optimistic state with the
      // authoritative DB rows once the turn settles (real ids matter: reactions
      // and thread-replies are keyed by id).
      const userMsgId = crypto.randomUUID();
      const assistantMsgId = crypto.randomUUID();
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
        const assistantMsg: Message = {
          id: assistantMsgId, conversation_id: conversationId, role: "assistant", content: "",
          model, effort, input_tokens: null, output_tokens: null,
          cache_creation_input_tokens: null, cache_read_input_tokens: null, total_cost_usd: null,
          status: "streaming", error_message: null, debug_payload: null,
          thread_root_id: userThreadRootId, reply_to_message_id: null,
          author_employee_id: employee.id, created_at: new Date().toISOString(),
        };
        messagesRef.current = [...messagesRef.current, userMsg, assistantMsg];
        setMessages(messagesRef.current);
      }
      onActivity?.();

      setSending(true);
      useAgentActivity.getState().setActive(employee.id, true);

      try {
        const result = await commandStreaming<SendMessageResult>(
          "message.send",
          {
            conversationId, text: trimmed, model, effort,
            provider: modelProvider(model),
            replyTo: replyTo ? { messageId: replyTo.messageId, threadRootId: replyTo.threadRootId } : null,
          },
          companyId,
          (channel, data) => {
            if (channel === "meta") {
              // Fires once, right after the server persists the placeholder — well
              // before the first text chunk — so "Debug" on an in-flight message
              // shows real data immediately instead of nothing until it completes.
              const { debugPayload } = data as { messageId: string; debugPayload: string };
              applyPatch(assistantMsgId, { debug_payload: debugPayload });
              return;
            }
            if (channel !== "text") return;
            const { text: chunk } = data as { messageId: string; text: string };
            const current = messagesRef.current.find((m) => m.id === assistantMsgId);
            applyPatch(assistantMsgId, { content: (current?.content ?? "") + chunk });
          },
        );

        if (!result.success) {
          applyPatch(assistantMsgId, {
            status: "error",
            error_message: result.errorMessage ?? "The assistant did not complete this response.",
          });
        }
        if (result.reaction) await reloadReactions();
      } catch (err) {
        applyPatch(assistantMsgId, { status: "error", error_message: err instanceof Error ? err.message : String(err) });
      } finally {
        // Always reconcile with the DB — the client's optimistic ids never match
        // what the server actually persisted, so reactions/thread-replies keyed
        // by id would silently break without this (same class of bug as the
        // §1.2 stuck-sending fix, now for id drift instead of a stuck flag).
        // reload() itself can reject (timeout, backend error) — it must never
        // suppress the sending-flag reset below, or the composer gets stuck
        // read-only until the app restarts even though the turn itself succeeded.
        try {
          await reload();
        } catch {
          // Swallowed — the next successful reload (another send, or a manual
          // one) will catch the DB up; a stuck composer is worse than a stale one.
        }
        useAgentActivity.getState().setActive(employee.id, false);
        setSending(false);
      }
    },
    [conversationId, companyId, employee, onActivity, applyPatch, reload, reloadReactions],
  );

  return { messages, replyCounts, reactions, toggleReaction, send, sending, reload };
}
