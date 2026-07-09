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
import { resolveApproval, listApprovals } from "./approvals/service";
import { resolveApprovalWaiter, type ApprovalDecision } from "./approvals/registry";
import { listEvents } from "./audit/service";
import { invokeTool, runToolApproved, listScopes, getTool } from "../tools/registry";
import { listGrants, grantCapability, grantConversationCapability, revokeCapability } from "../tools/capability";
import type { Effect } from "../tools/types";
import { registerMemoryTools } from "../tools/builtin/memory";
import { registerMessagingTools } from "../tools/builtin/messaging";
import { registerFilesystemTools } from "../tools/builtin/filesystem";
import { registerQuestionTools, answerQuestion, listQuestions } from "./questions/service";
import type { SubAnswer } from "./questions/spec";
import { registerGithubConnector } from "../connectors/github";
import { cancelTurn } from "../runtime/turnRegistry";
import {
  listConversations,
  listMessages,
  renameConversation,
  sendMessage,
  sendChannelMessage,
  listReactions,
  toggleReaction,
  listReplyCounts,
  listThread,
  listActiveConversationIds,
  createGroup,
  createChannel,
} from "./conversations/service";
import { countTokens } from "./tokenCount";
import { generateOnboarding, applyOnboarding, type HiredCandidateRole } from "./onboarding/service";
import { generateCandidates } from "./employees/candidates";
import { globalSearch } from "./search/service";
import { checkProviderHealth } from "./health/service";
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
  getAgentProfile,
  updateAgentProfileField,
  reconcileEmployeeModels,
} from "./employees/service";
import {
  getUserProfile,
  setUserFullName,
  getNotificationPreference,
  setNotificationPreference,
  baselineNotifications,
  drainNotifications,
} from "./settings/service";
import {
  createProject,
  listProjects,
  removeProject,
  setEmployeeProjects,
  listEmployeeProjectIds,
} from "./projects/service";
import { createTask, listTasks, setTaskStatus, type TaskStatus } from "./tasks/service";
import { getProjectTree, readProjectFile } from "./projects/files";
import { getProjectCommits, getProjectBranches, getProjectPulls, getProjectIssues } from "./projects/repo";
import type { CommandEnvelope as CE } from "@shared/protocol";
import type { ToolContext } from "../tools/types";

/**
 * Registers all domain command/query handlers + built-in tools + connectors.
 * Imported for its side effects by the runtime entry point. Domains are added
 * here as they are strangled off the client onto the runtime (Phase C+).
 */

registerMemoryTools();
registerMessagingTools();
registerQuestionTools();
registerFilesystemTools();
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

const VALID_EFFECTS: ReadonlySet<string> = new Set<Effect>(["none", "read", "write-internal", "external-read", "external-write"]);

/** Same rationale as validateEffort — a garbage wire value would otherwise only
 *  surface as a raw SQLite CHECK-constraint error deep inside grantCapability. */
function validateEffect(effect: string): Effect {
  if (!VALID_EFFECTS.has(effect)) throw new Error(`invalid capability effect: ${effect}`);
  return effect as Effect;
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
register("query:search.global", async (ctx, inbound) => {
  const { q, limit } = p<{ q: string; limit?: number }>(inbound);
  return globalSearch(ctx, requireCompany(inbound), q, limit);
});
register("query:providers.health", async () => checkProviderHealth());
register("command:providers.reconcile", async (ctx) => reconcileEmployeeModels(ctx));

// ---- projects & tasks (sandboxing) ----
register("query:projects.list", async (ctx, inbound) => listProjects(ctx, requireCompany(inbound)));
register("command:project.create", async (ctx, inbound) => {
  const { name, rootPath } = p<{ name: string; rootPath: string }>(inbound);
  return createProject(ctx, requireCompany(inbound), { name, rootPath });
});
register("command:project.remove", async (ctx, inbound) => {
  const { projectId } = p<{ projectId: string }>(inbound);
  await removeProject(ctx, requireCompany(inbound), projectId);
  return { ok: true };
});
register("query:project.tree", async (ctx, inbound) =>
  getProjectTree(ctx, requireCompany(inbound), p<{ projectId: string }>(inbound).projectId),
);
register("query:project.file", async (ctx, inbound) => {
  const { projectId, path } = p<{ projectId: string; path: string }>(inbound);
  return readProjectFile(ctx, requireCompany(inbound), projectId, path);
});
register("query:project.commits", async (ctx, inbound) =>
  getProjectCommits(ctx, requireCompany(inbound), p<{ projectId: string }>(inbound).projectId),
);
register("query:project.branches", async (ctx, inbound) =>
  getProjectBranches(ctx, requireCompany(inbound), p<{ projectId: string }>(inbound).projectId),
);
register("query:project.pulls", async (ctx, inbound) =>
  getProjectPulls(ctx, requireCompany(inbound), p<{ projectId: string }>(inbound).projectId),
);
register("query:project.issues", async (ctx, inbound) =>
  getProjectIssues(ctx, requireCompany(inbound), p<{ projectId: string }>(inbound).projectId),
);
register("query:employee.projects", async (ctx, inbound) =>
  listEmployeeProjectIds(ctx, p<{ employeeId: string }>(inbound).employeeId),
);
register("command:employee.setProjects", async (ctx, inbound) => {
  const { employeeId, projectIds } = p<{ employeeId: string; projectIds: string[] }>(inbound);
  if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== "string")) {
    throw new Error("employee.setProjects: projectIds must be an array of ids");
  }
  await setEmployeeProjects(ctx, requireCompany(inbound), employeeId, projectIds);
  return { ok: true };
});
register("query:tasks.list", async (ctx, inbound) => {
  const { projectId, employeeId, status } = p<{ projectId?: string; employeeId?: string; status?: TaskStatus }>(inbound);
  return listTasks(ctx, requireCompany(inbound), { projectId, employeeId, status });
});
register("command:task.create", async (ctx, inbound) => {
  const { projectId, employeeId, title } = p<{ projectId: string; employeeId?: string | null; title: string }>(inbound);
  return createTask(ctx, { companyId: requireCompany(inbound), projectId, employeeId: employeeId ?? null, title });
});
register("command:task.setStatus", async (ctx, inbound) => {
  const { taskId, status, prUrl } = p<{ taskId: string; status: TaskStatus; prUrl?: string | null }>(inbound);
  await setTaskStatus(ctx, taskId, status, { prUrl });
  return { ok: true };
});
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
register("query:agentProfile.get", async (ctx, inbound) =>
  getAgentProfile(ctx, p<{ employeeId: string }>(inbound).employeeId),
);
register("command:agentProfile.update", async (ctx, inbound) => {
  const { employeeId, field, value } = p<{ employeeId: string; field: string; value: string }>(inbound);
  await updateAgentProfileField(ctx, employeeId, field, value);
  return { ok: true };
});
register("query:capability.scopes", async () => listScopes());
register("query:capability.list", async (ctx, inbound) => {
  const { employeeId } = p<{ employeeId: string }>(inbound);
  return listGrants(ctx, requireCompany(inbound), employeeId);
});
register("command:capability.grant", async (ctx, inbound) => {
  const { employeeId, scope, maxEffect } = p<{ employeeId: string; scope: string; maxEffect: string }>(inbound);
  await grantCapability(ctx, requireCompany(inbound), employeeId, scope, validateEffect(maxEffect));
  return { ok: true };
});
register("command:capability.revoke", async (ctx, inbound) => {
  const { employeeId, scope } = p<{ employeeId: string; scope: string }>(inbound);
  await revokeCapability(ctx, requireCompany(inbound), employeeId, scope);
  return { ok: true };
});
register("command:employee.create", async (ctx, inbound) => {
  const b = p<{
    name: string;
    jobTitle?: string;
    department?: string;
    avatar?: string | null;
    mission?: string;
    preamble?: string;
    additionalDetails?: string;
    defaultModel?: string;
    defaultEffort?: string;
    responsibilities?: string[];
    personality?: string;
    communicationStyle?: string;
    expertise?: string[];
  }>(inbound);
  return createEmployee(ctx, { companyId: requireCompany(inbound), ...b });
});
register("command:group.create", async (ctx, inbound) => {
  const { name, employeeIds } = p<{ name: string; employeeIds: string[] }>(inbound);
  // The wire type is unchecked at the dispatch boundary — guard the array shape
  // and ids before they reach the insert rather than trusting the cast.
  if (!Array.isArray(employeeIds) || employeeIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("group.create: employeeIds must be a non-empty array of ids");
  }
  return createGroup(ctx, requireCompany(inbound), name, employeeIds);
});
register("command:channel.create", async (ctx, inbound) => {
  const { name } = p<{ name: string }>(inbound);
  return createChannel(ctx, requireCompany(inbound), name);
});
register("command:onboarding.generate", async (ctx, inbound) => {
  return generateOnboarding(ctx, p(inbound));
});
register("command:candidates.generate", async (ctx, inbound) => {
  return generateCandidates(ctx, { companyId: requireCompany(inbound), ...p<{ jobTitle: string; department: string; count?: number }>(inbound) });
});
register("command:onboarding.apply", async (ctx, inbound) => {
  return applyOnboarding(ctx, { companyId: requireCompany(inbound), ...p<{ companyName: string; profile: string; systemPrompt: string; roles: HiredCandidateRole[]; channels: string[] }>(inbound) });
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

// NOTE: the granular "chat ops" handlers (message.insertUser/insertAssistantPlaceholder/
// insertChannelAssistant/insertError/finalize/setError, conversation.session/setSession,
// agentSession.get/upsert, reaction.add, relevanceCheck.insert, reactionNotices.consume,
// messages.recent/openThreads) were removed in the full server-side turn-loop cutover.
// They were leftovers from the client-orchestrated design: the client would drive a turn
// by calling these one at a time. The whole turn loop now lives server-side in
// sendMessage/sendChannelMessage, so nothing calls them — and exposing them was an active
// hazard (command:message.insertChannelAssistant let any client insert an assistant
// message with an arbitrary author_employee_id into any conversation, forging a message
// from any employee while bypassing the turn loop and its capability gates). The
// underlying functions that are still used internally by the turn loop remain in
// conversations/service.ts; only their IPC exposure is gone.

interface SendMessagePayload {
  conversationId: string;
  text: string;
  model?: string;
  effort?: string;
  provider?: string | null;
  replyTo?: { messageId: string; threadRootId: string | null } | null;
}

register("command:message.send", async (ctx, inbound, sink) => {
  const payload = p<SendMessagePayload>(inbound);
  return sendMessage(
    ctx,
    {
      companyId: requireCompany(inbound),
      conversationId: payload.conversationId,
      text: payload.text,
      model: payload.model,
      effort: validateEffort(payload.effort),
      provider: payload.provider ?? null,
      replyTo: payload.replyTo ?? null,
      correlationId: inbound.id,
    },
    sink,
  );
});

register("command:message.cancel", async (_ctx, inbound) => {
  const { messageId } = p<{ messageId: string }>(inbound);
  // No-op (not an error) if the turn already finished — a client can race a
  // Stop click against the turn's own completion, and both outcomes look the
  // same to the user (the message stops streaming).
  return { cancelled: cancelTurn(messageId) };
});

register("command:message.sendChannel", async (ctx, inbound, sink) => {
  const payload = p<{ conversationId: string; text: string; replyTo?: { messageId: string; threadRootId: string | null } | null }>(inbound);
  return sendChannelMessage(
    ctx,
    {
      companyId: requireCompany(inbound),
      conversationId: payload.conversationId,
      text: payload.text,
      replyTo: payload.replyTo ?? null,
      correlationId: inbound.id,
    },
    sink,
  );
});

register("query:tokenCount.count", async (_ctx, inbound) => {
  const { provider, model, systemPrompt } = p<{ provider?: string | null; model: string; systemPrompt: string }>(inbound);
  return countTokens({ provider, model, systemPrompt });
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

const VALID_APPROVAL_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>(["denied", "once", "always", "always-here"]);

register("command:approval.resolve", async (ctx, inbound) => {
  const { approvalId, decision } = p<{ approvalId: string; decision: ApprovalDecision }>(inbound);
  if (!VALID_APPROVAL_DECISIONS.has(decision)) throw new Error(`invalid approval decision: ${decision}`);
  const approved = decision !== "denied";
  const resolved = await resolveApproval(ctx, approvalId, approved ? "approved" : "denied", "user");

  // Apply the standing grant BEFORE unblocking, so the run sees it and future
  // same-scope actions skip the prompt. "always" = global; "always-here" = this
  // conversation only. Grant at the tool's own effect tier.
  if ((decision === "always" || decision === "always-here") && resolved.employeeId) {
    const tool = getTool(resolved.action);
    if (tool) {
      if (decision === "always") {
        await grantCapability(ctx, resolved.companyId, resolved.employeeId, tool.scope, tool.effect);
      } else if (resolved.conversationId) {
        await grantConversationCapability(ctx, resolved.companyId, resolved.employeeId, resolved.conversationId, tool.scope, tool.effect);
      }
    }
  }

  // If a turn is blocked mid-flight on this approval, unblock it — its handler
  // runs the tool inline with the live context.
  const wasLive = resolveApprovalWaiter(approvalId, decision);
  if (wasLive) return { executed: true, live: true };

  // No live waiter (background/orphaned turn): fall back to the re-run path.
  if (!approved || !resolved.employeeId) return { executed: false };
  const tc: ToolContext = { ctx, companyId: resolved.companyId, employeeId: resolved.employeeId, correlationId: inbound.id };
  const output = await runToolApproved(tc, resolved.action, resolved.detail);
  return { executed: true, output };
});

register("query:approvals.list", async (ctx, inbound) => {
  const { status, conversationId } = p<{ status?: "pending" | "approved" | "denied" | "expired" | null; conversationId?: string | null }>(inbound);
  return listApprovals(ctx, requireCompany(inbound), status === undefined ? "pending" : status, conversationId ?? null);
});

register("query:audit.list", async (ctx, inbound) => {
  const { beforeSeq, limit } = p<{ beforeSeq?: number; limit?: number }>(inbound);
  return listEvents(ctx, requireCompany(inbound), { beforeSeq, limit });
});

// ---- ask-user-question tool round-trip ----
register("command:question.answer", async (ctx, inbound) => {
  const { questionId, answers } = p<{ questionId: string; answers: Record<string, SubAnswer> }>(inbound);
  if (!questionId || typeof questionId !== "string") throw new Error("question.answer requires a questionId");
  if (!answers || typeof answers !== "object") throw new Error("question.answer requires an answers object");
  return answerQuestion(ctx, requireCompany(inbound), questionId, answers);
});

register("query:questions.list", async (ctx, inbound) => {
  const { conversationId, status } = p<{ conversationId: string; status?: "pending" | "answered" | "cancelled" | null }>(inbound);
  return listQuestions(ctx, conversationId, status === undefined ? null : status);
});
