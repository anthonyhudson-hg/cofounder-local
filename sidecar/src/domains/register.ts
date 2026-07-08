import type { CommandEnvelope } from "@shared/protocol";
import { register } from "../runtime/dispatch";
import {
  createCompany,
  listCompanies,
  updateCompany,
  cloneCompany,
  removeCompany,
  getActiveCompanyId,
  setActiveCompanyId,
} from "./companies/service";
import { resolveApproval } from "./approvals/service";
import { invokeTool, runToolApproved } from "../tools/registry";
import { registerMemoryTools } from "../tools/builtin/memory";
import { registerGithubConnector } from "../connectors/github";
import {
  listConversations,
  listMessages,
  renameConversation,
  sendMessage,
  listReactions,
  toggleReaction,
  listReplyCounts,
  listThread,
  listActiveConversationIds,
  createGroup,
  insertUserMessage,
  insertAssistantPlaceholder,
  insertChannelAssistantMessage,
  insertErrorMessage,
  finalizeMessage,
  setMessageError,
  getConversationSession,
  setConversationSession,
  addReaction,
  recentMessages,
  openThreadRoots,
  getAgentSession,
  upsertAgentSession,
  insertRelevanceCheck,
  consumeReactionNotices,
  createChannel,
} from "./conversations/service";
import { generateOnboarding, applyOnboarding, type SuggestedRole } from "./onboarding/service";
import type { Effort } from "../providers";
import {
  listEmployees,
  getEmployeeByConversation,
  updateEmployeeField,
  createEmployee,
  listResponsibilities,
  addResponsibility,
  updateResponsibility,
  removeResponsibility,
  listDepartments,
  createDepartment,
  listMembershipsForEmployee,
  toggleMembership,
  listChannelMembers,
} from "./employees/service";
import {
  getUserProfile,
  setUserFullName,
  getNotificationPreference,
  setNotificationPreference,
  baselineNotifications,
  drainNotifications,
} from "./settings/service";
import type { CommandEnvelope as CE } from "@shared/protocol";
import type { ToolContext } from "../tools/types";

/**
 * Registers all domain command/query handlers + built-in tools + connectors.
 * Imported for its side effects by the runtime entry point. Domains are added
 * here as they are strangled off the client onto the runtime (Phase C+).
 */

registerMemoryTools();
registerGithubConnector();

register("command:company.create", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<"company.create", { name: string }>;
  return createCompany(ctx, { name: cmd.payload.name }, { kind: "user" });
});

function requireCompany(inbound: { companyId: string | null }): string {
  if (!inbound.companyId) throw new Error("this operation requires a company scope");
  return inbound.companyId;
}

const VALID_EFFORTS: ReadonlySet<string> = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);

/**
 * Validates a wire-supplied effort string against the real Effort union instead of
 * an `as never` cast, which made any string from the wire — including a garbage or
 * protocol-version-mismatched value — silently type-check as valid and only surface
 * as a runtime error deep inside provider-specific effort-mapping code instead of a
 * clean validation error at the dispatch boundary (report §1.4).
 */
function validateEffort(effort: string | undefined): Effort | undefined {
  if (effort === undefined) return undefined;
  if (!VALID_EFFORTS.has(effort)) throw new Error(`invalid effort: ${effort}`);
  return effort as Effort;
}

register("query:companies.list", async (ctx) => listCompanies(ctx));

register("query:company.active", async (ctx) => ({ activeCompanyId: await getActiveCompanyId(ctx) }));

register("command:company.update", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<"company.update", { companyId: string; field: string; value: string | null }>;
  await updateCompany(ctx, cmd.payload.companyId, cmd.payload.field, cmd.payload.value);
  return { ok: true };
});

register("command:company.clone", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<"company.clone", { sourceId: string; name: string }>;
  return cloneCompany(ctx, cmd.payload.sourceId, cmd.payload.name);
});

register("command:company.remove", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<"company.remove", { companyId: string }>;
  return removeCompany(ctx, cmd.payload.companyId);
});

register("command:company.setActive", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<"company.setActive", { companyId: string }>;
  await setActiveCompanyId(ctx, cmd.payload.companyId);
  return { ok: true };
});

register("query:conversations.list", async (ctx, inbound) =>
  listConversations(ctx, requireCompany(inbound)),
);

register("query:messages.list", async (ctx, inbound) => {
  const q = inbound as CommandEnvelope<"messages.list", { conversationId: string }>;
  return listMessages(ctx, q.payload.conversationId);
});

register("query:employees.list", async (ctx, inbound) => listEmployees(ctx, requireCompany(inbound)));

register("command:conversation.rename", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<"conversation.rename", { conversationId: string; name: string }>;
  await renameConversation(ctx, requireCompany(inbound), cmd.payload.conversationId, cmd.payload.name);
  return { ok: true };
});

// ---- reads ----
const p = <T>(inbound: unknown) => (inbound as CE<string, T>).payload;
register("query:employees.byConversation", async (ctx, inbound) =>
  getEmployeeByConversation(ctx, p<{ conversationId: string }>(inbound).conversationId),
);
register("query:reactions.list", async (ctx, inbound) =>
  listReactions(ctx, p<{ conversationId: string }>(inbound).conversationId),
);
register("query:messages.replyCounts", async (ctx, inbound) =>
  listReplyCounts(ctx, p<{ conversationId: string }>(inbound).conversationId),
);
register("query:messages.thread", async (ctx, inbound) => {
  const { conversationId, threadRootId } = p<{ conversationId: string; threadRootId: string }>(inbound);
  return listThread(ctx, conversationId, threadRootId);
});
register("query:conversations.activity", async (ctx, inbound) =>
  listActiveConversationIds(ctx, requireCompany(inbound)),
);
register("query:responsibilities.list", async (ctx, inbound) =>
  listResponsibilities(ctx, p<{ employeeId: string }>(inbound).employeeId),
);
register("query:departments.list", async (ctx, inbound) => listDepartments(ctx, requireCompany(inbound)));
register("query:memberships.forEmployee", async (ctx, inbound) =>
  listMembershipsForEmployee(ctx, p<{ employeeId: string }>(inbound).employeeId),
);
register("query:channel.members", async (ctx, inbound) =>
  listChannelMembers(ctx, p<{ conversationId: string }>(inbound).conversationId),
);
register("query:userProfile.get", async (ctx) => getUserProfile(ctx));
register("query:notifications.pref", async (ctx) => getNotificationPreference(ctx));

// ---- writes ----
register("command:reaction.toggle", async (ctx, inbound) => {
  const { messageId, emoji, reactor } = p<{ messageId: string; emoji: string; reactor?: string }>(inbound);
  await toggleReaction(ctx, requireCompany(inbound), messageId, emoji, reactor);
  return { ok: true };
});
register("command:employee.update", async (ctx, inbound) => {
  const { conversationId, field, value } = p<{ conversationId: string; field: string; value: string | null }>(inbound);
  await updateEmployeeField(ctx, conversationId, field, value);
  return { ok: true };
});
register("command:employee.create", async (ctx, inbound) => {
  const b = p<{ name: string; jobTitle?: string; department?: string; avatar?: string | null }>(inbound);
  return createEmployee(ctx, { companyId: requireCompany(inbound), ...b });
});
register("command:group.create", async (ctx, inbound) => {
  const { name, employeeIds } = p<{ name: string; employeeIds: string[] }>(inbound);
  return createGroup(ctx, requireCompany(inbound), name, employeeIds);
});
register("command:channel.create", async (ctx, inbound) => {
  const { name } = p<{ name: string }>(inbound);
  return createChannel(ctx, requireCompany(inbound), name);
});
register("command:onboarding.generate", async (ctx, inbound) => {
  return generateOnboarding(ctx, p(inbound));
});
register("command:onboarding.apply", async (ctx, inbound) => {
  return applyOnboarding(ctx, { companyId: requireCompany(inbound), ...p<{ companyName: string; profile: string; systemPrompt: string; roles: SuggestedRole[]; channels: string[] }>(inbound) });
});
register("command:responsibility.add", async (ctx, inbound) => {
  const { employeeId, text } = p<{ employeeId: string; text: string }>(inbound);
  await addResponsibility(ctx, requireCompany(inbound), employeeId, text);
  return { ok: true };
});
register("command:responsibility.update", async (ctx, inbound) => {
  const { id, text } = p<{ id: string; text: string }>(inbound);
  await updateResponsibility(ctx, id, text);
  return { ok: true };
});
register("command:responsibility.remove", async (ctx, inbound) => {
  await removeResponsibility(ctx, p<{ id: string }>(inbound).id);
  return { ok: true };
});
register("command:department.create", async (ctx, inbound) =>
  createDepartment(ctx, requireCompany(inbound), p<{ name: string }>(inbound).name),
);
register("command:membership.toggle", async (ctx, inbound) => {
  const { conversationId, employeeId } = p<{ conversationId: string; employeeId: string }>(inbound);
  await toggleMembership(ctx, conversationId, employeeId);
  return { ok: true };
});
register("command:userProfile.set", async (ctx, inbound) => {
  await setUserFullName(ctx, p<{ userFullName: string }>(inbound).userFullName);
  return { ok: true };
});
register("command:notifications.setPref", async (ctx, inbound) => {
  await setNotificationPreference(ctx, p<{ enabled: boolean }>(inbound).enabled);
  return { ok: true };
});
register("command:notifications.baseline", async (ctx) => {
  await baselineNotifications(ctx);
  return { ok: true };
});
register("command:notifications.drain", async (ctx) => ({ pending: await drainNotifications(ctx) }));

// ---- granular chat ops (client keeps orchestration; DB lives on the runtime) ----
register("query:conversation.session", async (ctx, inbound) => getConversationSession(ctx, p<{ conversationId: string }>(inbound).conversationId));
register("query:messages.recent", async (ctx, inbound) => {
  const { conversationId, limit } = p<{ conversationId: string; limit: number }>(inbound);
  return recentMessages(ctx, conversationId, limit);
});
register("query:messages.openThreads", async (ctx, inbound) => {
  const { conversationId, limit } = p<{ conversationId: string; limit: number }>(inbound);
  return openThreadRoots(ctx, conversationId, limit);
});
register("query:agentSession.get", async (ctx, inbound) => {
  const { conversationId, employeeId } = p<{ conversationId: string; employeeId: string }>(inbound);
  return getAgentSession(ctx, conversationId, employeeId);
});
register("command:message.insertUser", async (ctx, inbound) => {
  await insertUserMessage(ctx, p(inbound));
  return { ok: true };
});
register("command:message.insertAssistantPlaceholder", async (ctx, inbound) => {
  await insertAssistantPlaceholder(ctx, p(inbound));
  return { ok: true };
});
register("command:message.insertChannelAssistant", async (ctx, inbound) => {
  await insertChannelAssistantMessage(ctx, p(inbound));
  return { ok: true };
});
register("command:message.insertError", async (ctx, inbound) => {
  await insertErrorMessage(ctx, p(inbound));
  return { ok: true };
});
register("command:message.finalize", async (ctx, inbound) => {
  await finalizeMessage(ctx, p(inbound));
  return { ok: true };
});
register("command:message.setError", async (ctx, inbound) => {
  const { id, message } = p<{ id: string; message: string }>(inbound);
  await setMessageError(ctx, id, message);
  return { ok: true };
});
register("command:conversation.setSession", async (ctx, inbound) => {
  const { conversationId, sessionId, provider } = p<{ conversationId: string; sessionId: string; provider: string }>(inbound);
  await setConversationSession(ctx, conversationId, sessionId, provider);
  return { ok: true };
});
register("command:reaction.add", async (ctx, inbound) => {
  const { messageId, emoji, reactor } = p<{ messageId: string; emoji: string; reactor: string }>(inbound);
  await addReaction(ctx, messageId, emoji, reactor);
  return { ok: true };
});
register("command:agentSession.upsert", async (ctx, inbound) => {
  const { conversationId, employeeId, sessionId, provider } = p<{ conversationId: string; employeeId: string; sessionId: string; provider: string }>(inbound);
  await upsertAgentSession(ctx, conversationId, employeeId, sessionId, provider);
  return { ok: true };
});
register("command:relevanceCheck.insert", async (ctx, inbound) => {
  const { messageId, employeeId, decision, reason } = p<{ messageId: string; employeeId: string; decision: "respond" | "skip"; reason: string }>(inbound);
  await insertRelevanceCheck(ctx, messageId, employeeId, decision, reason);
  return { ok: true };
});
register("command:reactionNotices.consume", async (ctx, inbound) => {
  const { employeeId, userFullName } = p<{ employeeId: string; userFullName: string }>(inbound);
  return { notices: await consumeReactionNotices(ctx, employeeId, userFullName) };
});

register("command:message.send", async (ctx, inbound, sink) => {
  const cmd = inbound as CommandEnvelope<
    "message.send",
    { conversationId: string; text: string; model?: string; effort?: string; provider?: string | null }
  >;
  return sendMessage(
    ctx,
    {
      companyId: requireCompany(inbound),
      conversationId: cmd.payload.conversationId,
      text: cmd.payload.text,
      model: cmd.payload.model,
      effort: validateEffort(cmd.payload.effort),
      provider: cmd.payload.provider ?? null,
    },
    sink,
  );
});

register("command:tool.invoke", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<
    "tool.invoke",
    { employeeId: string; tool: string; input: unknown; correlationId?: string | null }
  >;
  if (!cmd.companyId) throw new Error("tool.invoke requires a company scope");
  const tc: ToolContext = {
    ctx,
    companyId: cmd.companyId,
    employeeId: cmd.payload.employeeId,
    correlationId: cmd.payload.correlationId ?? cmd.id,
  };
  return invokeTool(tc, cmd.payload.tool, cmd.payload.input);
});

register("command:approval.resolve", async (ctx, inbound) => {
  const cmd = inbound as CommandEnvelope<
    "approval.resolve",
    { approvalId: string; decision: "approved" | "denied" }
  >;
  // The type above is compile-time only; validate the actual wire value before it
  // reaches a `status` column SQLite won't itself constrain to these two values
  // (report §4.11).
  if (cmd.payload.decision !== "approved" && cmd.payload.decision !== "denied") {
    throw new Error(`invalid approval decision: ${cmd.payload.decision}`);
  }
  const resolved = await resolveApproval(ctx, cmd.payload.approvalId, cmd.payload.decision, "user");
  if (cmd.payload.decision !== "approved" || !resolved.employeeId) {
    return { executed: false };
  }
  // Re-run the gated action now that a human approved it.
  const tc: ToolContext = {
    ctx,
    companyId: resolved.companyId,
    employeeId: resolved.employeeId,
    correlationId: cmd.id,
  };
  const output = await runToolApproved(tc, resolved.action, resolved.detail);
  return { executed: true, output };
});
