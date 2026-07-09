import { useCallback, useEffect, useRef, useState } from "react";
import { command, commandStreaming, query } from "../lib/runtimeClient";
import { useAgentActivity } from "../store/agentActivity";
import { REACTOR_USER } from "../types";
import { Effort, Employee, Message, Reaction, modelProvider, type Approval, type ApprovalDecision, type Question, type QuestionSpec, type SubAnswer } from "../types";
import { useStaleGuard } from "./useStaleGuard";

/** Groups question rows by their UI anchor (DM: the asking assistant message id;
 *  cancelled ones are dropped from the chat flow — they stay in the debug view). */
function groupQuestions(rows: Question[]): Record<string, Question[]> {
  const grouped: Record<string, Question[]> = {};
  for (const q of rows) {
    if (q.status === "cancelled") continue;
    const key = q.asking_message_id;
    if (!key) continue;
    (grouped[key] ??= []).push(q);
  }
  return grouped;
}

/** Groups pending approvals by the asking assistant message id. */
function groupApprovals(rows: Approval[]): Record<string, Approval[]> {
  const grouped: Record<string, Approval[]> = {};
  for (const a of rows) {
    if (!a.askingMessageId) continue;
    (grouped[a.askingMessageId] ??= []).push(a);
  }
  return grouped;
}

export interface ReplyTarget {
  messageId: string;
  threadRootId: string | null;
}

/** A tool call the streaming assistant message is currently making, or just finished. */
export interface ActiveTool {
  messageId: string;
  name: string;
}

interface SendMessageResult {
  userMessageId: string;
  assistantMessageId: string;
  sessionId: string | null;
  success: boolean;
  errorMessage?: string;
  reaction: { messageId: string; emoji: string } | null;
}

interface PendingSend {
  userMsgId: string;
  assistantMsgId: string;
  text: string;
  model: string;
  effort: Effort;
  replyTo?: ReplyTarget;
}

/**
 * The runtime now owns the entire DM turn loop (full cutover — this used to be
 * a client-orchestrated flow spanning several separate `cos_*` legacy sidecar
 * calls plus client-side prompt composition). This hook is now just a thin
 * optimistic-UI layer over the single `message.send` command.
 *
 * Sends while another turn is already in flight are queued rather than
 * blocked — matches Claude web: you can keep typing and hit send, and it
 * fires automatically the moment the current turn finishes, instead of the
 * composer locking up mid-response.
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
  const [questions, setQuestions] = useState<Record<string, Question[]>>({});
  const [approvals, setApprovals] = useState<Record<string, Approval[]>>({});
  const [sending, setSending] = useState(false);
  const [activeTool, setActiveTool] = useState<ActiveTool | null>(null);
  const messagesRef = useRef<Message[]>([]);
  // Synchronous mirror of `sending` — `send()` needs an immediately-consistent
  // in-flight check to decide run-now vs. queue, and React state updates
  // inside the same tick/closure can't be trusted not to be stale.
  const sendingRef = useRef(false);
  const queueRef = useRef<PendingSend[]>([]);
  // The assistant message id of whichever turn is currently in flight, so
  // cancel() knows what to tell the backend to abort (see runtime/turnRegistry.ts).
  const currentAssistantIdRef = useRef<string | null>(null);
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
    const questionRows = await query<Question[]>("questions.list", { conversationId }, null);
    const approvalRows = await query<Approval[]>("approvals.list", { status: "pending", conversationId }, companyId);
    if (!messagesGuard.isCurrent(token)) return;
    messagesRef.current = rows;
    setMessages(rows);
    setReplyCounts(replyCountRows);
    setQuestions(groupQuestions(questionRows));
    setApprovals(groupApprovals(approvalRows));
    await reloadReactions();
  }, [conversationId, companyId, reloadReactions, messagesGuard]);

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

  const runTurn = useCallback(
    async (item: PendingSend) => {
      if (!employee) return;
      const { assistantMsgId, text: trimmed, model, effort, replyTo } = item;

      onActivity?.();
      sendingRef.current = true;
      setSending(true);
      currentAssistantIdRef.current = assistantMsgId;
      useAgentActivity.getState().setActive(employee.id, true);
      // A queued item's placeholder started life as "pending" (nothing to show
      // yet); it's actually starting now.
      applyPatch(assistantMsgId, { status: "streaming" });

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
            if (channel === "tool") {
              // "start"/"end" mirror the model's own tool_use content block
              // lifecycle (see providers/claude.ts) — real activity, not a guess.
              const { name, phase } = data as { messageId: string; name: string; phase: "start" | "end" };
              setActiveTool(phase === "start" ? { messageId: assistantMsgId, name } : null);
              return;
            }
            if (channel === "question") {
              // The agent called question_ask and is now blocked awaiting the
              // answer. Render the card optimistically under the (optimistic-id)
              // assistant row; the post-turn reload() re-keys it to the server id.
              const { phase, questionId, spec } = data as { phase: "ask" | "keepalive"; questionId: string; spec: QuestionSpec };
              if (phase === "keepalive") return; // idle timer already reset by touchPending
              setQuestions((prev) => {
                const list = prev[assistantMsgId] ?? [];
                if (list.some((q) => q.id === questionId)) return prev;
                const q: Question = {
                  id: questionId, conversation_id: conversationId, asking_message_id: assistantMsgId,
                  employee_id: employee?.id ?? "", spec, answers: null, status: "pending",
                  created_at: new Date().toISOString(), resolved_at: null,
                };
                return { ...prev, [assistantMsgId]: [...list, q] };
              });
              return;
            }
            if (channel === "approval") {
              // A gated tool call is blocked awaiting sign-off. Render the card
              // optimistically under the (optimistic-id) assistant row; reload
              // re-keys to the server id after the turn.
              const { phase, approvalId, action, detail, scope } = data as {
                phase: "ask" | "keepalive"; approvalId: string; action: string; detail: unknown; scope: string | null;
              };
              if (phase === "keepalive") return;
              setApprovals((prev) => {
                const list = prev[assistantMsgId] ?? [];
                if (list.some((a) => a.id === approvalId)) return prev;
                const a: Approval = {
                  id: approvalId, employeeId: employee?.id ?? null, conversationId, askingMessageId: assistantMsgId,
                  action, detail, scope, status: "pending", requestedAt: new Date().toISOString(),
                };
                return { ...prev, [assistantMsgId]: [...list, a] };
              });
              return;
            }
            if (channel !== "text") return;
            const { text: chunk, reset } = data as { messageId: string; text: string; reset?: boolean };
            if (reset) {
              // A stale-session retry is discarding the partial text it already
              // streamed; clear the placeholder so the retry's text doesn't append
              // onto the abandoned attempt's.
              applyPatch(assistantMsgId, { content: "" });
              return;
            }
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
        currentAssistantIdRef.current = null;
        setActiveTool(null);

        const next = queueRef.current.shift();
        if (next) {
          // Hand off directly to the next queued turn without ever flipping
          // `sending` back to false in between — otherwise the composer would
          // flicker enabled/disabled between two turns that were always meant
          // to run back-to-back.
          void runTurn(next);
        } else {
          sendingRef.current = false;
          setSending(false);
        }
      }
    },
    [conversationId, companyId, employee, onActivity, applyPatch, reload, reloadReactions],
  );

  const send = useCallback(
    (text: string, model: string, effort: Effort, replyTo?: ReplyTarget) => {
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
      const queuing = sendingRef.current;

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
          // "pending" until this item actually starts running (may sit in the
          // queue for a while) — runTurn flips it to "streaming" itself.
          status: queuing ? "pending" : "streaming", error_message: null, debug_payload: null,
          thread_root_id: userThreadRootId, reply_to_message_id: null,
          author_employee_id: employee.id, created_at: new Date().toISOString(),
        };
        messagesRef.current = [...messagesRef.current, userMsg, assistantMsg];
        setMessages(messagesRef.current);
      }

      const item: PendingSend = { userMsgId, assistantMsgId, text: trimmed, model, effort, replyTo };
      if (queuing) {
        queueRef.current.push(item);
        return;
      }
      void runTurn(item);
    },
    [conversationId, employee, runTurn],
  );

  const cancel = useCallback(() => {
    const id = currentAssistantIdRef.current;
    if (!id) return;
    void command("message.cancel", { messageId: id }, companyId);
  }, [companyId]);

  /** Submit answers to a pending question. Optimistically locks the card, then
   *  resolves the blocked turn server-side (which continues streaming into the
   *  same assistant message). Marks it orphaned if no turn was still waiting. */
  const answerQuestion = useCallback(
    async (questionId: string, answers: Record<string, SubAnswer>) => {
      const patch = (fn: (q: Question) => Question) =>
        setQuestions((prev) => {
          const next: Record<string, Question[]> = {};
          for (const [k, list] of Object.entries(prev)) next[k] = list.map((q) => (q.id === questionId ? fn(q) : q));
          return next;
        });
      patch((q) => ({ ...q, status: "answered", answers: { answers, answeredAt: new Date().toISOString() } }));
      try {
        const res = await command<{ resolved: boolean }>("question.answer", { questionId, answers }, companyId);
        if (!res.resolved) patch((q) => ({ ...q, orphaned: true }));
      } catch (err) {
        console.error("question.answer failed:", err);
      }
    },
    [companyId],
  );

  /** Resolve a pending inline approval. Optimistically flips the card, then
   *  resolves it server-side (which unblocks the turn and runs the tool inline
   *  on allow). Marks orphaned if no turn was still waiting. */
  const resolveApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      const patch = (fn: (a: Approval) => Approval) =>
        setApprovals((prev) => {
          const next: Record<string, Approval[]> = {};
          for (const [k, list] of Object.entries(prev)) next[k] = list.map((a) => (a.id === approvalId ? fn(a) : a));
          return next;
        });
      patch((a) => ({ ...a, status: decision === "denied" ? "denied" : "approved" }));
      try {
        const res = await command<{ executed: boolean; live?: boolean }>("approval.resolve", { approvalId, decision }, companyId);
        if (decision !== "denied" && !res.live) patch((a) => ({ ...a, orphaned: true }));
      } catch (err) {
        console.error("approval.resolve failed:", err);
      }
    },
    [companyId],
  );

  return { messages, replyCounts, reactions, questions, approvals, toggleReaction, send, cancel, answerQuestion, resolveApproval, sending, activeTool, reload };
}
