import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import type { DeltaSink } from "../../runtime/dispatch";
import { mutate } from "../../runtime/unitOfWork";
import { buildIdentityBlock, composeSystemPrompt } from "../../runtime/promptBuilder";
import { formatReactionNoticesForPrompt } from "../../runtime/reactionFormatting";
import { findMentions, type MentionTarget } from "../../runtime/mentions";
import { modelProvider } from "../../runtime/models";
import { getProvider, drainTurn, TurnCancelledError, type AgentProvider, type Effort, type TurnChunk, type TurnResult } from "../../providers";
import { resolveManagerName, employeeDisplayName, listChannelMembers, listResponsibilities, getAgentProfile } from "../employees/service";
import { getUserProfile } from "../settings/service";
import { registerTurn, unregisterTurn } from "../../runtime/turnRegistry";

/**
 * A stored session id can go stale outside this app's control (the SDK's own
 * local session store cleared, state restored on a different machine, a
 * corrupted local cache). Once that happens, every future turn on this
 * conversation would resume with the same dead id and repeat the exact same
 * failure forever — no self-heal path existed before this. Detects Claude's
 * specific "resume target doesn't exist" error text so callers can retry once
 * with a fresh session instead of erroring on every message indefinitely.
 */
function isStaleSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no conversation found with session/i.test(message);
}

/**
 * Shared by both the DM and channel turn loops — registers the turn so
 * command:message.cancel can reach it, retries once fresh on a stale resume
 * session, and always unregisters when done. `attempt` owns everything
 * specific to the caller (building RunTurnOptions, draining the generator,
 * forwarding chunks to whatever delta channel makes sense for it) — DM and
 * channel turns stream to different delta shapes (a real message id exists
 * up front for a DM; a channel responder has no message row until it decides
 * to post, so it streams keyed by employeeId instead), which is genuinely
 * different, but the gate/retry/cancel machinery around that isn't and
 * shouldn't be reimplemented per caller.
 */
async function runTurnGated<T>(
  registryKey: string,
  resume: string | null,
  attempt: (resumeSessionId: string | null, abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abortController = new AbortController();
  registerTurn(registryKey, abortController);
  try {
    try {
      return await attempt(resume, abortController.signal);
    } catch (err) {
      if (resume && isStaleSessionError(err)) {
        return await attempt(null, abortController.signal);
      }
      throw err;
    }
  } finally {
    unregisterTurn(registryKey);
  }
}

/** Lists a company's conversations (scoped). */
export async function listConversations(ctx: RuntimeContext, companyId: string) {
  return ctx.db
    .selectFrom("conversations")
    .where("company_id", "=", companyId)
    .selectAll()
    .orderBy("kind")
    .orderBy("created_at")
    .execute();
}

/** Lists top-level messages for a conversation. */
export async function listMessages(ctx: RuntimeContext, conversationId: string) {
  return ctx.db
    .selectFrom("messages")
    .where("conversation_id", "=", conversationId)
    .where("thread_root_id", "is", null)
    .selectAll()
    .orderBy("created_at")
    .execute();
}

export async function renameConversation(
  ctx: RuntimeContext,
  companyId: string,
  conversationId: string,
  name: string,
): Promise<void> {
  await assertConversationInCompany(ctx, companyId, conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx.updateTable("conversations").set({ name }).where("id", "=", conversationId).execute();
    await emit({ companyId, type: "conversation.renamed", subjectId: conversationId, actor: { kind: "user" }, payload: { name } });
  });
}

async function assertConversationInCompany(ctx: RuntimeContext, companyId: string, conversationId: string) {
  const row = await ctx.db
    .selectFrom("conversations")
    .where("id", "=", conversationId)
    .where("company_id", "=", companyId)
    .select("id")
    .executeTakeFirst();
  if (!row) throw new Error(`conversation ${conversationId} not in company ${companyId}`);
}

export async function listReactions(ctx: RuntimeContext, conversationId: string) {
  return ctx.db
    .selectFrom("reactions as r")
    .innerJoin("messages as m", "m.id", "r.message_id")
    .where("m.conversation_id", "=", conversationId)
    .selectAll("r")
    .execute();
}

export async function toggleReaction(
  ctx: RuntimeContext,
  companyId: string,
  messageId: string,
  emoji: string,
  reactor = "user",
): Promise<void> {
  await mutate(ctx, async (trx, emit) => {
    const existing = await trx
      .selectFrom("reactions")
      .where("message_id", "=", messageId)
      .where("emoji", "=", emoji)
      .where("reactor", "=", reactor)
      .select("id")
      .executeTakeFirst();
    if (existing) {
      await trx.deleteFrom("reactions").where("id", "=", existing.id).execute();
    } else {
      await trx.insertInto("reactions").values({ id: randomUUID(), message_id: messageId, emoji, reactor }).execute();
    }
    await emit({ companyId, type: "reaction.toggled", subjectId: messageId, actor: { kind: "user" }, payload: { emoji } });
  });
}

export async function listReplyCounts(ctx: RuntimeContext, conversationId: string) {
  const rows = await ctx.db
    .selectFrom("messages")
    .where("conversation_id", "=", conversationId)
    .where("thread_root_id", "is not", null)
    .select(["thread_root_id"])
    .select((eb) => eb.fn.countAll<number>().as("cnt"))
    .groupBy("thread_root_id")
    .execute();
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.thread_root_id) counts[r.thread_root_id] = Number(r.cnt);
  return counts;
}

export async function listThread(ctx: RuntimeContext, conversationId: string, threadRootId: string) {
  return ctx.db
    .selectFrom("messages")
    .where("conversation_id", "=", conversationId)
    .where((eb) => eb.or([eb("id", "=", threadRootId), eb("thread_root_id", "=", threadRootId)]))
    .selectAll()
    .orderBy("created_at")
    .execute();
}

export async function listActiveConversationIds(ctx: RuntimeContext, companyId: string) {
  const rows = await ctx.db
    .selectFrom("messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .where("c.company_id", "=", companyId)
    .select("m.conversation_id")
    .distinct()
    .execute();
  return rows.map((r) => r.conversation_id);
}

export async function createChannel(ctx: RuntimeContext, companyId: string, name: string): Promise<{ conversationId: string }> {
  const clean = name.replace(/^#/, "").trim();
  if (!clean) throw new Error("channel name required");
  const conversationId = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("conversations").values({ id: conversationId, company_id: companyId, kind: "channel", name: clean }).execute();
    await emit({ companyId, type: "conversation.created", subjectId: conversationId, actor: { kind: "user" }, payload: { kind: "channel", name: clean } });
  });
  return { conversationId };
}

export async function createGroup(ctx: RuntimeContext, companyId: string, name: string, employeeIds: string[]): Promise<{ conversationId: string }> {
  if (employeeIds.length < 2) throw new Error("A group needs at least two other participants");
  const conversationId = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("conversations").values({ id: conversationId, company_id: companyId, kind: "dm", is_group: 1, name: name.trim() || "Group" }).execute();
    for (const employeeId of employeeIds) {
      await trx.insertInto("channel_memberships").values({ id: randomUUID(), conversation_id: conversationId, employee_id: employeeId }).execute();
    }
    await emit({ companyId, type: "conversation.created", subjectId: conversationId, actor: { kind: "user" }, payload: { kind: "group" } });
  });
  return { conversationId };
}

// ---- granular message/session ops (used by the client chat orchestration) ----

async function companyOf(ctx: RuntimeContext, conversationId: string): Promise<string | null> {
  const c = await ctx.db.selectFrom("conversations").where("id", "=", conversationId).select("company_id").executeTakeFirst();
  return c?.company_id ?? null;
}

async function companyOfMessage(ctx: RuntimeContext, messageId: string): Promise<string | null> {
  const row = await ctx.db.selectFrom("messages").where("id", "=", messageId).select("conversation_id").executeTakeFirst();
  return row ? companyOf(ctx, row.conversation_id) : null;
}

export async function insertUserMessage(
  ctx: RuntimeContext,
  m: { id: string; conversationId: string; content: string; threadRootId?: string | null; replyToMessageId?: string | null },
): Promise<void> {
  const companyId = await companyOf(ctx, m.conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("messages").values({
      id: m.id, conversation_id: m.conversationId, role: "user", content: m.content, status: "complete",
      thread_root_id: m.threadRootId ?? null, reply_to_message_id: m.replyToMessageId ?? null,
    }).execute();
    await emit({ companyId, type: "message.created", subjectId: m.id, actor: { kind: "user" }, payload: { conversationId: m.conversationId, role: "user" } });
  });
}

export async function insertAssistantPlaceholder(
  ctx: RuntimeContext,
  m: { id: string; conversationId: string; model: string; effort: string; debugPayload?: string | null; threadRootId?: string | null; authorEmployeeId: string },
): Promise<void> {
  // Was a raw ctx.db write with no emit — violated the "every command goes through
  // mutate() so state and its event log never diverge" invariant (runtime/unitOfWork.ts)
  // that this function's own sibling insertUserMessage already follows (report §1.5).
  const companyId = await companyOf(ctx, m.conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("messages").values({
      id: m.id, conversation_id: m.conversationId, role: "assistant", content: "", model: m.model, effort: m.effort,
      status: "streaming", debug_payload: m.debugPayload ?? null, thread_root_id: m.threadRootId ?? null, author_employee_id: m.authorEmployeeId,
    }).execute();
    await emit({ companyId, type: "message.created", subjectId: m.id, actor: { kind: "employee", employeeId: m.authorEmployeeId }, payload: { conversationId: m.conversationId, role: "assistant" } });
  });
}

export async function insertChannelAssistantMessage(
  ctx: RuntimeContext,
  m: { id: string; conversationId: string; content: string; model: string; effort: string; debugPayload?: string | null; threadRootId?: string | null; replyToMessageId?: string | null; authorEmployeeId: string; usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }; totalCostUsd: number },
): Promise<void> {
  const companyId = await companyOf(ctx, m.conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("messages").values({
      id: m.id, conversation_id: m.conversationId, role: "assistant", content: m.content, model: m.model, effort: m.effort,
      status: "complete", debug_payload: m.debugPayload ?? null, thread_root_id: m.threadRootId ?? null, reply_to_message_id: m.replyToMessageId ?? null,
      author_employee_id: m.authorEmployeeId, input_tokens: m.usage.inputTokens, output_tokens: m.usage.outputTokens,
      cache_creation_input_tokens: m.usage.cacheCreationInputTokens, cache_read_input_tokens: m.usage.cacheReadInputTokens, total_cost_usd: m.totalCostUsd,
    }).execute();
    await emit({ companyId, type: "message.completed", subjectId: m.id, actor: { kind: "employee", employeeId: m.authorEmployeeId }, payload: { conversationId: m.conversationId } });
  });
}

export async function insertErrorMessage(
  ctx: RuntimeContext,
  m: { id: string; conversationId: string; errorMessage: string; authorEmployeeId: string },
): Promise<void> {
  const companyId = await companyOf(ctx, m.conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("messages").values({
      id: m.id, conversation_id: m.conversationId, role: "assistant", content: "", status: "error", error_message: m.errorMessage, author_employee_id: m.authorEmployeeId,
    }).execute();
    await emit({ companyId, type: "message.created", subjectId: m.id, actor: { kind: "employee", employeeId: m.authorEmployeeId }, payload: { conversationId: m.conversationId, role: "assistant", status: "error" } });
  });
}

export async function finalizeMessage(
  ctx: RuntimeContext,
  m: { id: string; content: string; usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }; totalCostUsd: number },
): Promise<void> {
  const row = await ctx.db.selectFrom("messages").where("id", "=", m.id).select("conversation_id").executeTakeFirst();
  const companyId = row ? await companyOf(ctx, row.conversation_id) : null;
  await mutate(ctx, async (trx, emit) => {
    await trx.updateTable("messages").set({
      content: m.content, status: "complete", input_tokens: m.usage.inputTokens, output_tokens: m.usage.outputTokens,
      cache_creation_input_tokens: m.usage.cacheCreationInputTokens, cache_read_input_tokens: m.usage.cacheReadInputTokens, total_cost_usd: m.totalCostUsd,
    }).where("id", "=", m.id).execute();
    await emit({ companyId, type: "message.completed", subjectId: m.id, actor: { kind: "system" }, payload: {} });
  });
}

export async function setMessageError(ctx: RuntimeContext, id: string, message: string): Promise<void> {
  const companyId = await companyOfMessage(ctx, id);
  await mutate(ctx, async (trx, emit) => {
    await trx.updateTable("messages").set({ status: "error", error_message: message }).where("id", "=", id).execute();
    await emit({ companyId, type: "message.errored", subjectId: id, actor: { kind: "system" }, payload: {} });
  });
}

export async function getConversationSession(ctx: RuntimeContext, conversationId: string) {
  return (
    (await ctx.db.selectFrom("conversations").where("id", "=", conversationId).select(["session_id", "session_provider"]).executeTakeFirst()) ?? null
  );
}

export async function setConversationSession(ctx: RuntimeContext, conversationId: string, sessionId: string, provider: string): Promise<void> {
  const companyId = await companyOf(ctx, conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx.updateTable("conversations").set({ session_id: sessionId, session_provider: provider }).where("id", "=", conversationId).execute();
    await emit({ companyId, type: "conversation.sessionSet", subjectId: conversationId, actor: { kind: "system" }, payload: { provider } });
  });
}

export async function addReaction(ctx: RuntimeContext, messageId: string, emoji: string, reactor: string): Promise<void> {
  const companyId = await companyOfMessage(ctx, messageId);
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("reactions").values({ id: randomUUID(), message_id: messageId, emoji, reactor }).onConflict((oc) => oc.doNothing()).execute();
    await emit({ companyId, type: "reaction.added", subjectId: messageId, actor: { kind: "employee", employeeId: reactor }, payload: { emoji } });
  });
}

export async function recentMessages(ctx: RuntimeContext, conversationId: string, limit: number) {
  return ctx.db.selectFrom("messages").where("conversation_id", "=", conversationId).selectAll().orderBy("created_at", "desc").limit(limit).execute();
}

export async function openThreadRoots(ctx: RuntimeContext, conversationId: string, limit: number) {
  return ctx.db.selectFrom("messages").where("conversation_id", "=", conversationId).where("thread_root_id", "is", null).select(["id", "content"]).orderBy("created_at", "desc").limit(limit).execute();
}

export async function getAgentSession(ctx: RuntimeContext, conversationId: string, employeeId: string) {
  return (
    (await ctx.db.selectFrom("agent_sessions").where("conversation_id", "=", conversationId).where("employee_id", "=", employeeId).select(["session_id", "session_provider"]).executeTakeFirst()) ?? null
  );
}

export async function upsertAgentSession(ctx: RuntimeContext, conversationId: string, employeeId: string, sessionId: string, provider: string): Promise<void> {
  const companyId = await companyOf(ctx, conversationId);
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("agent_sessions")
      .values({ id: randomUUID(), conversation_id: conversationId, employee_id: employeeId, session_id: sessionId, session_provider: provider, updated_at: new Date().toISOString() })
      .onConflict((oc) => oc.columns(["conversation_id", "employee_id"]).doUpdateSet({ session_id: sessionId, session_provider: provider, updated_at: new Date().toISOString() }))
      .execute();
    await emit({ companyId, type: "agentSession.upserted", subjectId: conversationId, actor: { kind: "employee", employeeId }, payload: { provider } });
  });
}

export async function insertRelevanceCheck(ctx: RuntimeContext, messageId: string, employeeId: string, decision: "respond" | "skip", reason: string): Promise<void> {
  const companyId = await companyOfMessage(ctx, messageId);
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("relevance_checks").values({ id: randomUUID(), message_id: messageId, employee_id: employeeId, decision, reason }).execute();
    await emit({ companyId, type: "relevanceCheck.inserted", subjectId: messageId, actor: { kind: "employee", employeeId }, payload: { decision } });
  });
}

/**
 * Returns unseen reactions on an employee's messages and marks them notified.
 * Client formats them (emoji intent copy stays on the client). Ports the DB half
 * of lib/reactionNotices.consumeReactionNotices.
 */
export async function consumeReactionNotices(
  ctx: RuntimeContext,
  employeeId: string,
  userFullName: string,
): Promise<{ emoji: string; fromName: string; messageContent: string }[]> {
  const rows = await ctx.db
    .selectFrom("reactions as r")
    .innerJoin("messages as m", "m.id", "r.message_id")
    .leftJoin("employees as re", "re.id", "r.reactor")
    .leftJoin("conversations as rc", "rc.id", "re.conversation_id")
    .where("m.author_employee_id", "=", employeeId)
    .where("r.notified_at", "is", null)
    .select((eb) => [
      "r.id as id",
      "r.emoji as emoji",
      "m.content as messageContent",
      eb.case().when("r.reactor", "=", "user").then(userFullName).else(eb.ref("rc.name")).end().as("fromName"),
    ])
    .orderBy("r.created_at")
    .execute();
  if (rows.length === 0) return [];
  await ctx.db.updateTable("reactions").set({ notified_at: new Date().toISOString() }).where("id", "in", rows.map((r) => r.id)).execute();
  return rows.map((r) => ({ emoji: r.emoji, fromName: r.fromName ?? "Someone", messageContent: r.messageContent }));
}

export interface SendMessageInput {
  companyId: string;
  conversationId: string;
  text: string;
  model?: string;
  effort?: Effort;
  provider?: string | null;
  /** Replying inside an existing thread, mirroring the client's ReplyTarget. */
  replyTo?: { messageId: string; threadRootId: string | null } | null;
  /** The originating command's id, for correlating tool.invoked/etc. events emitted mid-turn back to this send. */
  correlationId?: string | null;
}

export interface SendMessageResult {
  userMessageId: string;
  assistantMessageId: string;
  sessionId: string | null;
  success: boolean;
  errorMessage?: string;
  /** Set when the model closed its reply with a `[[react:emoji]]` suffix. */
  reaction: { messageId: string; emoji: string } | null;
}

/**
 * The DM turn loop, relocated from the client's useConversation.send into the
 * runtime (refactor #2/#7). Full parity with that client flow (full cutover):
 * reply-threading, manager-name resolution, mention-scope + reaction-suffix
 * prompt injection, reaction-notices consumption, `[[react:emoji]]` parsing,
 * and a full debug payload. Persists the user message, composes the system
 * prompt from company + employee, drives the provider (streaming text deltas to
 * the client via `sink`), then persists the assistant message and resumes the
 * provider session. Emits message.created (x2) + message.completed.
 *
 * A failure driving the provider (thrown error, not just a graceful
 * `result.success: false`) is caught here and persisted as a normal error
 * message instead of rejecting the whole command — the legacy client-side flow
 * only left the message errored in local state with nothing in the DB, so a
 * reload used to silently drop back to "streaming" forever (a real gap this
 * closes, not just a port).
 *
 * `providerOverride` is for tests; production resolves via getProvider().
 */
export async function sendMessage(
  ctx: RuntimeContext,
  input: SendMessageInput,
  sink: DeltaSink,
  providerOverride?: AgentProvider,
): Promise<SendMessageResult> {
  await assertConversationInCompany(ctx, input.companyId, input.conversationId);

  const conv = await ctx.db
    .selectFrom("conversations")
    .where("id", "=", input.conversationId)
    .select(["session_id", "session_provider", "name"])
    .executeTakeFirstOrThrow();

  const employee = await ctx.db
    .selectFrom("employees")
    .where("conversation_id", "=", input.conversationId)
    .where("company_id", "=", input.companyId)
    .selectAll()
    .executeTakeFirst();
  if (!employee) throw new Error("no employee bound to this conversation");

  const company = await ctx.db
    .selectFrom("companies")
    .where("id", "=", input.companyId)
    .select(["profile", "system_prompt"])
    .executeTakeFirstOrThrow();

  const responsibilities = (
    await ctx.db
      .selectFrom("employee_responsibilities")
      .where("employee_id", "=", employee.id)
      .select("text")
      .orderBy("position")
      .orderBy("created_at")
      .execute()
  ).map((r) => r.text);

  const { userFullName } = await getUserProfile(ctx);

  const model = input.model ?? employee.default_model;
  const effort = (input.effort ?? employee.default_effort) as Effort;
  const providerName = input.provider ?? "claude";
  const resume = conv.session_provider === providerName ? conv.session_id : null;

  // 1. persist the user message (optionally inside an existing thread)
  const userMessageId = randomUUID();
  const userThreadRootId = input.replyTo ? input.replyTo.threadRootId ?? input.replyTo.messageId : null;
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("messages")
      .values({
        id: userMessageId,
        conversation_id: input.conversationId,
        role: "user",
        content: input.text,
        status: "complete",
        thread_root_id: userThreadRootId,
        reply_to_message_id: input.replyTo?.messageId ?? null,
      })
      .execute();
    await emit({ companyId: input.companyId, type: "message.created", subjectId: userMessageId, actor: { kind: "user" }, payload: { role: "user", conversationId: input.conversationId } });
  });

  // 2. compose system prompt (identity + DM-scoped mention/reaction guidance)
  const managerName = await resolveManagerName(ctx, employee.manager_employee_id, userFullName);
  const identity = buildIdentityBlock(conv.name, employee, managerName);
  const agentProfile = await getAgentProfile(ctx, employee.id);
  const baseSystemPrompt = composeSystemPrompt(company.profile, company.system_prompt, identity, employee, responsibilities, agentProfile);
  const mentionScope = `This is a private 1:1 DM between you and ${userFullName || "the founder"}. There is nobody else here to @mention — do not @mention any other employee in this conversation.`;
  const systemPrompt = `${baseSystemPrompt}\n\n---\n\n${mentionScope}\n\n---\n\nIf the message you're replying to deserves a quick reaction in addition to (or instead of, if you have nothing to add) a full reply, end your response with a line like [[react:👍]] using one relevant emoji. Omit this entirely if no reaction is warranted.`;

  // 3. consume reaction notices since this employee's last turn
  const rawNotices = await consumeReactionNotices(ctx, employee.id, userFullName);
  const { notices, block: noticesBlock } = formatReactionNoticesForPrompt(rawNotices);
  const promptWithNotices = noticesBlock ? `${noticesBlock}\n\n${input.text}` : input.text;

  const debugPayload = JSON.stringify({
    model,
    effort,
    companySystemPrompt: company.system_prompt,
    companyProfile: company.profile,
    identityBlock: identity,
    mission: employee.mission,
    preamble: employee.preamble,
    responsibilities,
    additionalDetails: employee.additional_details,
    agentProfile,
    prompt: promptWithNotices,
    reactionNotices: notices,
    resumeSessionId: resume,
    sentAt: new Date().toISOString(),
  });

  // 4. insert streaming assistant placeholder
  const assistantMessageId = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("messages")
      .values({
        id: assistantMessageId,
        conversation_id: input.conversationId,
        role: "assistant",
        content: "",
        model,
        effort,
        status: "streaming",
        debug_payload: debugPayload,
        thread_root_id: userThreadRootId,
        author_employee_id: employee.id,
      })
      .execute();
    await emit({ companyId: input.companyId, type: "message.created", subjectId: assistantMessageId, actor: { kind: "employee", employeeId: employee.id }, payload: { role: "assistant", conversationId: input.conversationId } });
  });

  // The debug payload is already fully computed and persisted at this point, but
  // the client's optimistic placeholder was built before this command resolved and
  // has no debug_payload yet — without this delta, "Debug" on an in-flight message
  // showed nothing until the whole turn finished and the client's post-send
  // reload() ran. Sent as its own "meta" channel (distinct from "text") so the
  // client can patch it in immediately, well before the first text chunk arrives.
  sink.delta("meta", { messageId: assistantMessageId, debugPayload });

  // 5. run the provider, streaming text deltas; a thrown error here is caught
  // and persisted as a normal error message rather than failing the command.
  let success: boolean;
  let errorMessage: string | undefined;
  let sessionId: string | null = resume;
  let reaction: { messageId: string; emoji: string } | null = null;
  let full = "";

  try {
    const provider = providerOverride ?? getProvider(providerName);

    const onChunk = (chunk: TurnChunk) => {
      if (chunk.kind === "text") {
        full += chunk.text;
        sink.delta("text", { messageId: assistantMessageId, text: chunk.text });
      } else {
        sink.delta("tool", { messageId: assistantMessageId, name: chunk.name, phase: chunk.phase });
      }
    };

    const result = await runTurnGated(assistantMessageId, resume, (resumeSessionId, abortSignal) => {
      full = "";
      return drainTurn(
        provider.runTurn({
          model,
          effort,
          systemPrompt,
          prompt: promptWithNotices,
          resumeSessionId,
          agentTools: { ctx, companyId: input.companyId, employeeId: employee.id, correlationId: input.correlationId ?? null },
          abortSignal,
        }),
        onChunk,
      );
    });

    const reactMatch = full.match(/\n*\[\[react:(\S+)\]\]\s*$/);
    const finalContent = reactMatch ? full.slice(0, reactMatch.index).trimEnd() : full;

    success = result.success;
    errorMessage = result.success ? undefined : (result.errorMessage ?? "The assistant did not complete this response.");
    sessionId = result.sessionId ?? resume;

    await mutate(ctx, async (trx, emit) => {
      await trx
        .updateTable("messages")
        .set({
          content: finalContent,
          status: result.success ? "complete" : "error",
          // Previously left null on failure — the DM error bubble showed zero
          // diagnostic content even though the provider had a specific reason
          // (report §4.10).
          error_message: errorMessage ?? null,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
          cache_read_input_tokens: result.usage.cacheReadInputTokens,
          total_cost_usd: result.totalCostUsd,
        })
        .where("id", "=", assistantMessageId)
        .execute();
      if (result.sessionId) {
        await trx
          .updateTable("conversations")
          .set({ session_id: result.sessionId, session_provider: providerName })
          .where("id", "=", input.conversationId)
          .execute();
      }
      await emit({ companyId: input.companyId, type: "message.completed", subjectId: assistantMessageId, actor: { kind: "employee", employeeId: employee.id }, payload: { conversationId: input.conversationId, ok: result.success, usage: result.usage } });
    });

    // Mirrors the legacy/client behavior: the reaction is applied whenever the
    // model emitted the suffix, even if the turn otherwise ended ungracefully.
    if (reactMatch) {
      await addReaction(ctx, userMessageId, reactMatch[1], employee.id);
      reaction = { messageId: userMessageId, emoji: reactMatch[1] };
    }
  } catch (err) {
    if (err instanceof TurnCancelledError) {
      // A user-initiated stop isn't a failure — keep whatever text already
      // streamed and mark it complete, matching how stopping a response works
      // in Claude's own web UI (the partial reply stays, it isn't an error).
      success = true;
      errorMessage = undefined;
      await mutate(ctx, async (trx, emit) => {
        await trx
          .updateTable("messages")
          .set({ content: full, status: "complete", error_message: null })
          .where("id", "=", assistantMessageId)
          .execute();
        await emit({
          companyId: input.companyId,
          type: "message.completed",
          subjectId: assistantMessageId,
          actor: { kind: "user" },
          payload: { conversationId: input.conversationId, ok: true, cancelled: true },
        });
      });
    } else {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
      await mutate(ctx, async (trx, emit) => {
        await trx.updateTable("messages").set({ status: "error", error_message: errorMessage }).where("id", "=", assistantMessageId).execute();
        await emit({ companyId: input.companyId, type: "message.errored", subjectId: assistantMessageId, actor: { kind: "system" }, payload: {} });
      });
    }
  }

  return { userMessageId, assistantMessageId, sessionId, success, errorMessage, reaction };
}

// ---- channel-send orchestration (full cutover: no client-side equivalent existed
// to port from — this replicates useChannel.ts's sendToMembers() plus the legacy
// sidecar's handleCheckRelevance/handleSendChannel entirely server-side) ----

// Relevance gatekeeping is always a cheap, internal Claude call regardless of which
// provider the employee actually chats with — ported from the legacy sidecar.
const RELEVANCE_CHECK_MODEL = "claude-haiku-4-5-20251001";

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : text;
}

interface ChannelControl {
  respondsWithText: boolean;
  replyToMessageId: string | null;
  threadRootId: string | null;
  reactions: { messageId: string; emoji: string }[];
}

function parseChannelControl(fullText: string): { control: ChannelControl; text: string } {
  const fallback: ChannelControl = { respondsWithText: true, replyToMessageId: null, threadRootId: null, reactions: [] };
  const match = fullText.match(/```control\s*([\s\S]*?)\s*```/);
  if (!match) return { control: fallback, text: fullText.trim() };

  // Strip the matched fence region regardless of whether the JSON inside it parses,
  // so a parse failure doesn't leak the literal control block into the posted
  // channel message (report §3.5, ported from the legacy sidecar's fix).
  const text = fullText.slice((match.index ?? 0) + match[0].length).trim();
  try {
    const parsed = JSON.parse(match[1]);
    const control: ChannelControl = {
      respondsWithText: parsed.respondsWithText ?? true,
      replyToMessageId: parsed.replyToMessageId ?? null,
      threadRootId: parsed.threadRootId ?? null,
      reactions: Array.isArray(parsed.reactions) ? parsed.reactions : [],
    };
    return { control, text };
  } catch {
    return { control: fallback, text };
  }
}

function buildChannelSystemPrompt(
  baseSystemPrompt: string,
  openThreads: { id: string; preview: string }[],
  reactionTargets: { id: string; author: string; preview: string }[],
): string {
  const threadsBlock = openThreads.length ? openThreads.map((t) => `- ${t.id}: ${t.preview}`).join("\n") : "(none open right now)";
  const targetsBlock = reactionTargets.length ? reactionTargets.map((t) => `- ${t.id} (${t.author}): ${t.preview}`).join("\n") : "(none)";

  return [
    baseSystemPrompt,
    [
      "You are responding in a multi-person channel, not a 1:1 DM. Reply with EXACTLY one fenced control block first, then your message text (if any) after it:",
      "```control",
      '{"respondsWithText": true, "replyToMessageId": null, "threadRootId": null, "reactions": []}',
      "```",
      "Your message text goes here if respondsWithText is true.",
      "",
      "Rules:",
      '- Set "respondsWithText" to false if you have nothing valuable to add and do not want to post a message (you can still react via "reactions" even when this is false).',
      '- "replyToMessageId": the id of a specific message you are directly replying to, or null.',
      '- "threadRootId": the id of an existing thread to reply within (see Open threads below), or null to post as a new top-level message.',
      '- "reactions": a list of {"messageId": "...", "emoji": "..."} for reactions to add to specific recent messages, independent of whether you post text.',
      "",
      "Open threads:",
      threadsBlock,
      "",
      "Recent messages you can reply to or react to:",
      targetsBlock,
    ].join("\n"),
  ].join("\n\n---\n\n");
}

async function checkMemberRelevance(
  provider: AgentProvider,
  employeeContext: string,
  channelName: string,
  triggerMessage: string,
): Promise<{ respond: boolean; reason: string }> {
  const systemPrompt = [
    `You are deciding whether ONE employee should reply to a message in the #${channelName} channel.`,
    `Say YES (respond) if the message is relevant to this employee's role, asks for something they can help with, addresses them, or they can add genuine value. Say NO only if it is clearly outside their area or they would add nothing. For a plausibly-relevant employee, lean YES — in a channel, a helpful reply beats silence. (Direct @mentions are already handled and always reply.)`,
    `Employee:\n${employeeContext}`,
    `Respond with ONLY a JSON object, no other text: {"respond": true|false, "reason": "one short sentence"}`,
  ].join("\n\n");

  try {
    let raw = "";
    await drainTurn(
      provider.runTurn({ model: RELEVANCE_CHECK_MODEL, effort: "low", systemPrompt, prompt: triggerMessage }),
      (chunk) => {
        if (chunk.kind === "text") raw += chunk.text;
      },
    );
    try {
      const parsed = JSON.parse(extractJson(raw));
      return { respond: Boolean(parsed.respond), reason: String(parsed.reason ?? "") };
    } catch {
      return { respond: false, reason: `Could not parse relevance decision; defaulting to skip. Raw: ${raw.slice(0, 200)}` };
    }
  } catch (err) {
    return { respond: false, reason: `Relevance check errored, defaulting to skip: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface SendChannelMessageInput {
  companyId: string;
  conversationId: string;
  text: string;
  replyTo?: { messageId: string; threadRootId: string | null } | null;
  /** The originating command's id, for correlating tool.invoked/etc. events emitted mid-turn back to this send. */
  correlationId?: string | null;
}

export interface ChannelResponderOutcome {
  employeeId: string;
  respond: boolean;
  posted: boolean;
  error?: string;
}

export interface SendChannelMessageResult {
  userMessageId: string;
  responders: ChannelResponderOutcome[];
}

/**
 * Relevance-gates every member of a conversation against a trigger message
 * (an @mention always bypasses the gate), then runs each responder's turn in
 * parallel, parsing its control-block for whether to post text, which
 * thread/message to reply to, and which reactions to add.
 *
 * Factored out of sendChannelMessage so a channel message can originate from
 * either the user (sendChannelMessage) or an employee posting proactively
 * via the message.send tool (tools/builtin/messaging.ts) — both are "a new
 * message landed in this conversation, see who should respond" and were
 * never meant to be two different mechanisms. `excludeEmployeeId` is for the
 * latter case: an employee doesn't get relevance-gated against its own post.
 * `relevanceProviderOverride`/`responderProviderOverride` are for tests.
 *
 * `sink` streams live the same way a DM does. There's no message row yet
 * when a responder starts (whether it posts at all depends on parsing its
 * own control block once the turn finishes), so deltas are keyed by
 * `employeeId` rather than a message id: "channelText"/"channelTool" carry
 * live content the same shape as a DM's "text"/"tool" channels, and
 * "channelDone" tells the client that responder settled (whether or not it
 * actually posted) so its live-typing preview can be cleared immediately
 * instead of waiting for the whole batch. A tool-triggered post has no live
 * client to stream to — callers without one pass a no-op sink.
 */
export async function runChannelResponders(
  ctx: RuntimeContext,
  companyId: string,
  conversationId: string,
  triggerMessageId: string,
  triggerText: string,
  sink: DeltaSink,
  options: {
    excludeEmployeeId?: string;
    correlationId?: string | null;
    relevanceProviderOverride?: AgentProvider;
    responderProviderOverride?: AgentProvider;
  } = {},
): Promise<ChannelResponderOutcome[]> {
  const conv = await ctx.db.selectFrom("conversations").where("id", "=", conversationId).select(["name"]).executeTakeFirstOrThrow();
  const company = await ctx.db.selectFrom("companies").where("id", "=", companyId).select(["profile", "system_prompt"]).executeTakeFirstOrThrow();
  const { userFullName } = await getUserProfile(ctx);
  const allMembers = await listChannelMembers(ctx, conversationId);
  const members = options.excludeEmployeeId ? allMembers.filter((m) => m.id !== options.excludeEmployeeId) : allMembers;

  if (members.length === 0) return [];

  // 1. gather channel context: open threads, recent messages (for reactions),
  // and every member's display name (needed for identity blocks + @mentions).
  const openThreadRows = await openThreadRoots(ctx, conversationId, 10);
  const openThreads = openThreadRows.map((r) => ({ id: r.id, preview: r.content.slice(0, 60) }));

  const recentRows = await recentMessages(ctx, conversationId, 15);
  const authorNameCache = new Map<string, string>();
  const reactionTargets: { id: string; author: string; preview: string }[] = [];
  for (const r of recentRows) {
    let author = userFullName;
    if (r.author_employee_id) {
      const cached = authorNameCache.get(r.author_employee_id);
      author = cached ?? (await employeeDisplayName(ctx, r.author_employee_id)) ?? "Someone";
      authorNameCache.set(r.author_employee_id, author);
    }
    reactionTargets.push({ id: r.id, author, preview: r.content.slice(0, 60) });
  }

  const memberNames = new Map<string, string>();
  for (const m of allMembers) {
    memberNames.set(m.id, (await employeeDisplayName(ctx, m.id)) ?? "Employee");
  }

  // 2. relevance gate: an @mention always responds and bypasses the gate; with
  // no mentions, every member goes through the cheap Claude relevance check.
  const memberTargets: MentionTarget[] = members
    .map((m) => ({ type: "employee" as const, conversationId: m.conversation_id, label: memberNames.get(m.id) ?? "" }))
    .filter((t) => t.label);
  const mentionedConvIds = new Set(findMentions(triggerText, memberTargets).map((x) => x.target.conversationId));
  const hasMentions = mentionedConvIds.size > 0;
  const relevanceProvider = options.relevanceProviderOverride ?? getProvider("claude");

  const relevanceResults = await Promise.all(
    members.map(async (member) => {
      if (hasMentions) {
        return mentionedConvIds.has(member.conversation_id)
          ? { member, respond: true, reason: "Directly @mentioned." }
          : { member, respond: false, reason: "Not mentioned in a directed message." };
      }
      const managerName = await resolveManagerName(ctx, member.manager_employee_id, userFullName);
      const identityBlock = buildIdentityBlock(memberNames.get(member.id) ?? "Employee", member, managerName);
      const responsibilityRows = await listResponsibilities(ctx, member.id);
      const employeeContext = `${identityBlock}\nMission: ${member.mission}\nResponsibilities: ${responsibilityRows.map((r) => r.text).join("; ") || "(none listed)"}`;
      const { respond, reason } = await checkMemberRelevance(relevanceProvider, employeeContext, conv.name, triggerText);
      return { member, respond, reason };
    }),
  );

  await Promise.all(
    relevanceResults.map(({ member, respond, reason }) => insertRelevanceCheck(ctx, triggerMessageId, member.id, respond ? "respond" : "skip", reason)),
  );

  const relevanceMeta = relevanceResults.map((r) => ({
    employeeName: memberNames.get(r.member.id) ?? "Employee",
    decision: r.respond ? ("respond" as const) : ("skip" as const),
    reason: r.reason,
  }));

  const responders = relevanceResults.filter((r) => r.respond).map((r) => r.member);

  // 3. run every responder's turn in parallel.
  const outcomes = await Promise.all(
    responders.map(async (member): Promise<ChannelResponderOutcome> => {
      const providerName = modelProvider(member.default_model);
      const session = await getAgentSession(ctx, conversationId, member.id);
      const storedProvider = session?.session_provider ?? "claude";
      const resumeSessionId = storedProvider === providerName ? session?.session_id ?? null : null;

      const managerName = await resolveManagerName(ctx, member.manager_employee_id, userFullName);
      const displayName = memberNames.get(member.id) ?? "Employee";
      const identityBlock = buildIdentityBlock(displayName, member, managerName);
      const responsibilityRows = await listResponsibilities(ctx, member.id);
      const responsibilities = responsibilityRows.map((r) => r.text);
      const agentProfile = await getAgentProfile(ctx, member.id);
      const baseSystemPrompt = composeSystemPrompt(company.profile, company.system_prompt, identityBlock, member, responsibilities, agentProfile);
      const otherMemberNames = members
        .filter((m) => m.id !== member.id)
        .map((m) => memberNames.get(m.id))
        .filter((n): n is string => !!n);
      const mentionScope = otherMemberNames.length
        ? `You may only @mention people who are members of this channel: ${otherMemberNames.join(", ")}. Do not @mention anyone else — they aren't part of this conversation and won't see it.`
        : `There is nobody else in this channel to @mention right now.`;
      const systemPrompt = buildChannelSystemPrompt(`${baseSystemPrompt}\n\n---\n\n${mentionScope}`, openThreads, reactionTargets);

      const rawNotices = await consumeReactionNotices(ctx, member.id, userFullName);
      const { notices, block: noticesBlock } = formatReactionNoticesForPrompt(rawNotices);
      const promptWithNotices = noticesBlock ? `${noticesBlock}\n\n${triggerText}` : triggerText;

      try {
        const provider = options.responderProviderOverride ?? getProvider(providerName);
        let fullText = "";
        const onChunk = (chunk: TurnChunk) => {
          if (chunk.kind === "text") {
            fullText += chunk.text;
            sink.delta("channelText", { employeeId: member.id, text: chunk.text });
          } else {
            sink.delta("channelTool", { employeeId: member.id, name: chunk.name, phase: chunk.phase });
          }
        };

        const result = await runTurnGated(member.id, resumeSessionId, (resume, abortSignal) => {
          fullText = "";
          return drainTurn(
            provider.runTurn({
              model: member.default_model,
              effort: member.default_effort as Effort,
              systemPrompt,
              prompt: promptWithNotices,
              resumeSessionId: resume,
              agentTools: { ctx, companyId, employeeId: member.id, correlationId: options.correlationId ?? null },
              abortSignal,
            }),
            onChunk,
          );
        });

        const { control, text } = parseChannelControl(fullText);

        if (result.sessionId) {
          await upsertAgentSession(ctx, conversationId, member.id, result.sessionId, providerName);
        }
        for (const r of control.reactions) {
          await addReaction(ctx, r.messageId, r.emoji, member.id);
        }

        let posted = false;
        if (control.respondsWithText && text.trim()) {
          const threadRootId =
            control.threadRootId ??
            (control.replyToMessageId ? openThreadRows.find((t) => t.id === control.replyToMessageId)?.id ?? control.replyToMessageId : null);

          const debugPayload = JSON.stringify({
            model: member.default_model,
            effort: member.default_effort,
            companySystemPrompt: company.system_prompt,
            companyProfile: company.profile,
            identityBlock,
            mission: member.mission,
            preamble: member.preamble,
            responsibilities,
            additionalDetails: member.additional_details,
            agentProfile,
            prompt: promptWithNotices,
            reactionNotices: notices,
            resumeSessionId,
            sentAt: new Date().toISOString(),
            channel: { relevanceChecks: relevanceMeta, replyToMessageId: control.replyToMessageId, threadRootId, reactionsApplied: control.reactions },
          });

          await insertChannelAssistantMessage(ctx, {
            id: randomUUID(),
            conversationId,
            content: text.trim(),
            model: member.default_model,
            effort: member.default_effort,
            debugPayload,
            threadRootId,
            replyToMessageId: control.replyToMessageId,
            authorEmployeeId: member.id,
            usage: result.usage,
            totalCostUsd: result.totalCostUsd,
          });
          posted = true;
        }

        sink.delta("channelDone", { employeeId: member.id });
        return { employeeId: member.id, respond: true, posted };
      } catch (err) {
        sink.delta("channelDone", { employeeId: member.id });
        if (err instanceof TurnCancelledError) {
          // No client can trigger this for a channel responder yet (cancel is
          // DM-only today — see runtime/turnRegistry.ts), but runTurnGated is
          // shared, so handle it correctly rather than assuming it can't
          // happen: a stop isn't a failure, and there's no control block to
          // know where/whether to post, so just end this responder cleanly.
          return { employeeId: member.id, respond: true, posted: false };
        }
        // Covers both the turn itself failing and any post-processing step above
        // (session upsert, reactions, message insert) throwing — mirrors the
        // client's catch-and-post-error-message behavior (report §1.2).
        const message = err instanceof Error ? err.message : String(err);
        await insertErrorMessage(ctx, { id: randomUUID(), conversationId, errorMessage: message, authorEmployeeId: member.id }).catch(() => {});
        return { employeeId: member.id, respond: true, posted: false, error: message };
      }
    }),
  );

  const skipped: ChannelResponderOutcome[] = relevanceResults.filter((r) => !r.respond).map((r) => ({ employeeId: r.member.id, respond: false, posted: false }));

  return [...outcomes, ...skipped];
}

/**
 * The user-initiated entry point: persists the user's message, then runs
 * runChannelResponders against it. sendMessage's DM equivalent and this used
 * to duplicate the entire relevance/responder mechanism (see
 * runChannelResponders's doc comment) — this is now just "persist, then
 * delegate."
 */
export async function sendChannelMessage(
  ctx: RuntimeContext,
  input: SendChannelMessageInput,
  sink: DeltaSink,
  relevanceProviderOverride?: AgentProvider,
  responderProviderOverride?: AgentProvider,
): Promise<SendChannelMessageResult> {
  await assertConversationInCompany(ctx, input.companyId, input.conversationId);

  // persist the user message (optionally inside an existing thread)
  const userMessageId = randomUUID();
  const userThreadRootId = input.replyTo ? input.replyTo.threadRootId ?? input.replyTo.messageId : null;
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("messages")
      .values({
        id: userMessageId,
        conversation_id: input.conversationId,
        role: "user",
        content: input.text,
        status: "complete",
        thread_root_id: userThreadRootId,
        reply_to_message_id: input.replyTo?.messageId ?? null,
      })
      .execute();
    await emit({ companyId: input.companyId, type: "message.created", subjectId: userMessageId, actor: { kind: "user" }, payload: { role: "user", conversationId: input.conversationId } });
  });

  const responders = await runChannelResponders(ctx, input.companyId, input.conversationId, userMessageId, input.text, sink, {
    correlationId: input.correlationId,
    relevanceProviderOverride,
    responderProviderOverride,
  });

  return { userMessageId, responders };
}
