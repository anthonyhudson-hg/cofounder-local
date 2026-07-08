import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import type { DeltaSink } from "../../runtime/dispatch";
import { mutate } from "../../runtime/unitOfWork";
import { buildIdentityBlock, composeSystemPrompt } from "../../runtime/promptBuilder";
import { getProvider, drainTurn, type AgentProvider, type Effort } from "../../providers";

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
}

/**
 * The DM turn loop, relocated from the client's useConversation.send into the
 * runtime (refactor #2/#7). Persists the user message, composes the system
 * prompt from company + employee, drives the provider (streaming text deltas to
 * the client via `sink`), then persists the assistant message and resumes the
 * provider session. Emits message.created (x2) + message.completed.
 *
 * `providerOverride` is for tests; production resolves via getProvider().
 */
export async function sendMessage(
  ctx: RuntimeContext,
  input: SendMessageInput,
  sink: DeltaSink,
  providerOverride?: AgentProvider,
): Promise<{ userMessageId: string; assistantMessageId: string; sessionId: string | null }> {
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

  const userFullName =
    (await ctx.db.selectFrom("settings").where("key", "=", "user_full_name").select("value").executeTakeFirst())
      ?.value ?? "";

  const model = input.model ?? employee.default_model;
  const effort = (input.effort ?? employee.default_effort) as Effort;
  const providerName = input.provider ?? "claude";

  // 1. persist the user message
  const userMessageId = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("messages")
      .values({ id: userMessageId, conversation_id: input.conversationId, role: "user", content: input.text, status: "complete" })
      .execute();
    await emit({ companyId: input.companyId, type: "message.created", subjectId: userMessageId, actor: { kind: "user" }, payload: { role: "user", conversationId: input.conversationId } });
  });

  // 2. compose system prompt
  const identity = buildIdentityBlock(conv.name, employee, userFullName || "the founder");
  const systemPrompt = composeSystemPrompt(company.profile, company.system_prompt, identity, employee, responsibilities);

  // 3. insert streaming assistant placeholder
  const assistantMessageId = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("messages")
      .values({ id: assistantMessageId, conversation_id: input.conversationId, role: "assistant", content: "", model, effort, status: "streaming", author_employee_id: employee.id })
      .execute();
    await emit({ companyId: input.companyId, type: "message.created", subjectId: assistantMessageId, actor: { kind: "employee", employeeId: employee.id }, payload: { role: "assistant", conversationId: input.conversationId } });
  });

  // 4. run the provider, streaming text deltas
  const resume = conv.session_provider === providerName ? conv.session_id : null;
  const provider = providerOverride ?? getProvider(providerName);
  let full = "";
  const result = await drainTurn(
    provider.runTurn({ model, effort, systemPrompt, prompt: input.text, resumeSessionId: resume }),
    (chunk) => {
      full += chunk;
      sink.delta("text", { messageId: assistantMessageId, text: chunk });
    },
  );

  // 5. persist final assistant message + resume the session
  await mutate(ctx, async (trx, emit) => {
    await trx
      .updateTable("messages")
      .set({
        content: full,
        status: result.success ? "complete" : "error",
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

  return { userMessageId, assistantMessageId, sessionId: result.sessionId };
}
