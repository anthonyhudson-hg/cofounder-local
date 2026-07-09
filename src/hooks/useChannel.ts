import { useCallback, useEffect, useRef, useState } from "react";
import { command, commandStreaming, query } from "../lib/runtimeClient";
import { REACTOR_USER, Reaction } from "../types";
import { Employee, Message, type Question, type QuestionSpec, type SubAnswer } from "../types";
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

interface PendingSend {
  userMsgId: string;
  text: string;
  replyTo?: ReplyTarget;
}

const EPHEMERAL_PREFIX = "ephemeral-";

/** Groups channel question rows by their UI anchor. Channel questions have no
 *  asking_message_id (a responder has no message row until it posts), so they
 *  anchor to the responder's ephemeral row by employee. Cancelled ones drop out
 *  of the chat flow (still visible in the debug view). */
function groupChannelQuestions(rows: Question[]): Record<string, Question[]> {
  const grouped: Record<string, Question[]> = {};
  for (const q of rows) {
    if (q.status === "cancelled") continue;
    const key = q.asking_message_id ?? `${EPHEMERAL_PREFIX}${q.employee_id}`;
    (grouped[key] ??= []).push(q);
  }
  return grouped;
}

/**
 * The runtime now owns the entire channel turn loop — relevance-gating every
 * member, running each responder in parallel, and parsing each one's
 * control-block for whether/where to post and which reactions to add (full
 * cutover — this used to be an entirely client-orchestrated flow spanning
 * per-member `cos_check_relevance`/`cos_send_channel` legacy sidecar calls).
 *
 * Streams live now, same as a DM: a responder has no message row until it
 * decides to post (that depends on parsing its own control block, which only
 * exists once its turn finishes), so there's nothing to attach a real
 * message id's delta to while it's in flight — instead, each responding
 * member gets a synthetic "ephemeral-<employeeId>" placeholder message that
 * grows as its "channelText"/"channelTool" deltas arrive, and disappears the
 * moment its "channelDone" delta fires (reload() picks up whatever it
 * actually posted, if anything, keyed by the server's real id).
 *
 * Sends while one is already in flight queue rather than block, same as a
 * DM — there's no reason a channel composer should behave differently.
 */
export function useChannel(conversationId: string, companyId: string, onActivity?: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyCounts, setReplyCounts] = useState<Record<string, number>>({});
  const [reactions, setReactions] = useState<Record<string, string[]>>({});
  const [questions, setQuestions] = useState<Record<string, Question[]>>({});
  const [members, setMembers] = useState<Employee[]>([]);
  const [sending, setSending] = useState(false);
  // Tool name each responding member is currently calling, keyed by employeeId
  // (unlike a DM, several members can be mid-turn — and mid-tool-call — at once).
  const [activeTools, setActiveTools] = useState<Record<string, string>>({});
  const messagesRef = useRef<Message[]>([]);
  // Synchronous mirror of `sending` — see useConversation.ts's identical guard
  // for why this can't just read the React state inside send().
  const sendingRef = useRef(false);
  const queueRef = useRef<PendingSend[]>([]);
  // Separate stale guards per reload target — this hook is not remounted per
  // conversationId (confirmed via ChatPane's lack of a `key`), so a fast channel
  // switch can otherwise let an older conversation's slower response land after
  // the new one's and briefly show the wrong channel's data (report §1.3).
  const membersGuard = useStaleGuard();
  const reactionsGuard = useStaleGuard();
  const messagesGuard = useStaleGuard();

  const applyPatch = useCallback((id: string, patch: Partial<Message>) => {
    messagesRef.current = messagesRef.current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    setMessages(messagesRef.current);
  }, []);

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
    const questionRows = await query<Question[]>("questions.list", { conversationId }, null);
    if (!messagesGuard.isCurrent(token)) return;
    // Real rows just arrived — preserve any ephemeral placeholders still live
    // (a later, still-in-flight responder in the same batch) rather than
    // wiping them out from under an active stream.
    const ephemeral = messagesRef.current.filter((m) => m.id.startsWith(EPHEMERAL_PREFIX));
    messagesRef.current = [...rows, ...ephemeral];
    setMessages(messagesRef.current);
    setReplyCounts(replyCountRows);
    setQuestions(groupChannelQuestions(questionRows));
    await reloadReactions();
  }, [conversationId, reloadReactions, messagesGuard]);

  // Calling the memoized `reload` directly from inside the doubly-nested
  // onDelta callback below (itself nested inside runSend) made the React
  // Compiler unable to prove the hand-written memoization was preserved and
  // it silently skipped optimizing this whole hook (a real, verified
  // difference from useConversation.ts, which only ever calls reload() from
  // its top-level finally block, not from a nested sub-callback). Routing
  // through a ref sidesteps it — always current, opaque to that analysis.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

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

  const runSend = useCallback(
    async (item: PendingSend) => {
      const { text: trimmed, replyTo } = item;

      onActivity?.();
      sendingRef.current = true;
      setSending(true);

      try {
        await commandStreaming<SendChannelMessageResult>(
          "message.sendChannel",
          { conversationId, text: trimmed, replyTo: replyTo ? { messageId: replyTo.messageId, threadRootId: replyTo.threadRootId } : null },
          companyId,
          (channel, data) => {
            if (channel === "channelText") {
              const { employeeId, text: chunk, reset } = data as { employeeId: string; text: string; reset?: boolean };
              const ephemeralId = `${EPHEMERAL_PREFIX}${employeeId}`;
              const existing = messagesRef.current.find((m) => m.id === ephemeralId);
              if (reset) {
                // Stale-session retry discarding its partial text — clear the
                // ephemeral bubble so the retry doesn't append onto it.
                if (existing) applyPatch(ephemeralId, { content: "" });
                return;
              }
              if (existing) {
                applyPatch(ephemeralId, { content: existing.content + chunk });
              } else {
                const placeholder: Message = {
                  id: ephemeralId, conversation_id: conversationId, role: "assistant", content: chunk,
                  model: null, effort: null, input_tokens: null, output_tokens: null,
                  cache_creation_input_tokens: null, cache_read_input_tokens: null, total_cost_usd: null,
                  status: "streaming", error_message: null, debug_payload: null,
                  thread_root_id: null, reply_to_message_id: null,
                  author_employee_id: employeeId, created_at: new Date().toISOString(),
                };
                messagesRef.current = [...messagesRef.current, placeholder];
                setMessages(messagesRef.current);
              }
              return;
            }
            if (channel === "channelTool") {
              const { employeeId, name, phase } = data as { employeeId: string; name: string; phase: "start" | "end" };
              setActiveTools((prev) => {
                const updated = { ...prev };
                if (phase === "start") updated[employeeId] = name;
                else delete updated[employeeId];
                return updated;
              });
              return;
            }
            if (channel === "channelQuestion") {
              // A responder called question_ask and is blocked awaiting the
              // answer. Anchor the card to that responder's ephemeral row
              // (creating one if it hasn't streamed any text yet).
              const { employeeId, phase, questionId, spec } = data as {
                employeeId: string;
                phase: "ask" | "keepalive";
                questionId: string;
                spec: QuestionSpec;
              };
              if (phase === "keepalive") return; // idle timer already reset by touchPending
              const ephemeralId = `${EPHEMERAL_PREFIX}${employeeId}`;
              if (!messagesRef.current.some((m) => m.id === ephemeralId)) {
                const placeholder: Message = {
                  id: ephemeralId, conversation_id: conversationId, role: "assistant", content: "",
                  model: null, effort: null, input_tokens: null, output_tokens: null,
                  cache_creation_input_tokens: null, cache_read_input_tokens: null, total_cost_usd: null,
                  status: "streaming", error_message: null, debug_payload: null,
                  thread_root_id: null, reply_to_message_id: null,
                  author_employee_id: employeeId, created_at: new Date().toISOString(),
                };
                messagesRef.current = [...messagesRef.current, placeholder];
                setMessages(messagesRef.current);
              }
              setQuestions((prev) => {
                const list = prev[ephemeralId] ?? [];
                if (list.some((q) => q.id === questionId)) return prev;
                const q: Question = {
                  id: questionId, conversation_id: conversationId, asking_message_id: null,
                  employee_id: employeeId, spec, answers: null, status: "pending",
                  created_at: new Date().toISOString(), resolved_at: null,
                };
                return { ...prev, [ephemeralId]: [...list, q] };
              });
              return;
            }
            if (channel === "channelDone") {
              const { employeeId } = data as { employeeId: string };
              const ephemeralId = `${EPHEMERAL_PREFIX}${employeeId}`;
              messagesRef.current = messagesRef.current.filter((m) => m.id !== ephemeralId);
              setMessages(messagesRef.current);
              setActiveTools((prev) => {
                if (!(employeeId in prev)) return prev;
                const updated = { ...prev };
                delete updated[employeeId];
                return updated;
              });
              // This responder's real message (if it posted one) already exists
              // in the DB now — bring it in immediately rather than waiting for
              // every other (possibly slower) responder to finish too.
              void reloadRef.current();
            }
          },
        );
      } catch (err) {
        // Unlike a DM, there's no single assistant placeholder to mark
        // errored — a whole-batch failure this catastrophic (the command
        // itself rejecting, not a per-responder failure the backend already
        // handles and posts individually) has no natural per-message slot in
        // the channel UI. Swallowed rather than left as an unhandled
        // rejection now that send() is fire-and-forget (queueing needs it to
        // be); at minimum, surfaced to the console instead of silently lost.
        console.error("channel send failed:", err);
      } finally {
        // Belt-and-suspenders: clear any ephemeral placeholder that never got a
        // matching channelDone (e.g. the command itself rejected outright).
        messagesRef.current = messagesRef.current.filter((m) => !m.id.startsWith(EPHEMERAL_PREFIX));
        setMessages(messagesRef.current);
        setActiveTools({});
        // reload() can itself reject (timeout, backend error); that must never
        // suppress the sending-flag reset below or the composer gets stuck
        // read-only even though the turn already completed (see
        // useConversation.ts's identical guard for the same failure mode).
        try {
          await reload();
        } catch {
          // Swallowed — the next successful reload will catch the DB up.
        }

        const next = queueRef.current.shift();
        if (next) {
          // Hand off directly without flipping `sending` back to false in
          // between, so the composer doesn't flicker enabled/disabled across
          // two sends that were always meant to run back-to-back.
          void runSend(next);
        } else {
          sendingRef.current = false;
          setSending(false);
        }
      }
    },
    [conversationId, companyId, onActivity, applyPatch, reload],
  );

  const send = useCallback(
    (text: string, replyTo?: ReplyTarget) => {
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

      const item: PendingSend = { userMsgId, text: trimmed, replyTo };
      if (sendingRef.current) {
        queueRef.current.push(item);
        return;
      }
      void runSend(item);
    },
    [conversationId, members, runSend],
  );

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

  return { messages, replyCounts, reactions, questions, toggleReaction, members, send, sending, activeTools, answerQuestion, reload };
}
