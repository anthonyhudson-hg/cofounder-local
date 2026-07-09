import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { Database } from "../../db/schema";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";
import { DEFAULT_CHAT_MODEL, detectProviders, preferredProvider } from "../../providers/availability";
import { modelProvider, type ModelProviderName } from "../../runtime/models";
import { nextPositionAfter } from "../../runtime/position";

export async function listEmployees(ctx: RuntimeContext, companyId: string) {
  return ctx.db.selectFrom("employees").where("company_id", "=", companyId).selectAll().execute();
}

export async function getEmployeeByConversation(ctx: RuntimeContext, conversationId: string) {
  return (
    (await ctx.db.selectFrom("employees").where("conversation_id", "=", conversationId).selectAll().executeTakeFirst()) ?? null
  );
}

const EMPLOYEE_FIELDS = new Set([
  "job_title",
  "department",
  "mission",
  "preamble",
  "additional_details",
  "default_model",
  "default_effort",
  "avatar",
  "manager_employee_id",
]);

export async function updateEmployeeField(
  ctx: RuntimeContext,
  conversationId: string,
  field: string,
  value: string | null,
): Promise<void> {
  if (!EMPLOYEE_FIELDS.has(field)) throw new Error(`invalid employee field: ${field}`);
  await mutate(ctx, async (trx, emit) => {
    const emp = await trx
      .selectFrom("employees")
      .where("conversation_id", "=", conversationId)
      .select(["id", "company_id"])
      .executeTakeFirst();
    if (!emp) throw new Error("employee not found");

    if (field === "manager_employee_id" && value) {
      if (value === emp.id) throw new Error("an employee cannot manage themselves");
      // Walk the full reporting subtree of `emp.id`. The frontend's own picker already
      // excludes it, but that guard only blocks a 1-hop cycle and nothing else in the
      // system enforces this — this is the only real backstop against a corrupted org
      // chart via any other write path (report §4.1).
      const rows = await trx
        .selectFrom("employees")
        .where("company_id", "=", emp.company_id)
        .select(["id", "manager_employee_id"])
        .execute();
      const byManager = new Map<string, string[]>();
      for (const r of rows) {
        if (!r.manager_employee_id) continue;
        const list = byManager.get(r.manager_employee_id);
        if (list) list.push(r.id);
        else byManager.set(r.manager_employee_id, [r.id]);
      }
      const queue = [...(byManager.get(emp.id) ?? [])];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (id === value) throw new Error("cannot set manager: would create a reporting cycle");
        queue.push(...(byManager.get(id) ?? []));
      }
    }

    await trx.updateTable("employees").set({ [field]: value } as never).where("id", "=", emp.id).execute();
    await emit({ companyId: emp.company_id, type: "employee.updated", subjectId: emp.id, actor: { kind: "user" }, payload: { field } });
  });
}

export interface CreateEmployeeInput {
  companyId: string;
  name: string;
  jobTitle?: string;
  department?: string;
  avatar?: string | null;
  // Full-persona fields — populated by the candidate flow (both Hire and onboarding).
  // All optional so a bare create (name/title/department only) still works unchanged.
  mission?: string;
  preamble?: string;
  additionalDetails?: string;
  // When omitted, insertFullEmployee falls back to the configured provider's
  // default model (see below) rather than the column's hardcoded Claude default.
  defaultModel?: string;
  defaultEffort?: string;
  responsibilities?: string[];
  // agent_profiles fields (the "Personality & autonomy" panel).
  personality?: string;
  communicationStyle?: string;
  expertise?: string[];
}

/**
 * The single place an employee row (its 1:1 DM conversation + the employee record
 * + its responsibilities) is written. Runs inside a caller-provided transaction and
 * does NOT emit — the caller owns the event. Shared by `createEmployee` (Hire) and
 * `applyOnboarding` so both paths populate an identical, fully-fleshed employee.
 */
export async function insertFullEmployee(
  trx: Transaction<Database>,
  input: CreateEmployeeInput,
): Promise<{ conversationId: string; employeeId: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("employee name required");
  const conversationId = randomUUID();
  const employeeId = randomUUID();

  await trx.insertInto("conversations").values({ id: conversationId, company_id: input.companyId, kind: "dm", name }).execute();
  await trx
    .insertInto("employees")
    .values({
      id: employeeId,
      company_id: input.companyId,
      conversation_id: conversationId,
      job_title: input.jobTitle ?? "",
      department: input.department ?? "",
      avatar: input.avatar ?? null,
      // Let the column defaults stand when a field is absent, rather than forcing "".
      ...(input.mission !== undefined ? { mission: input.mission } : {}),
      ...(input.preamble !== undefined ? { preamble: input.preamble } : {}),
      ...(input.additionalDetails !== undefined ? { additional_details: input.additionalDetails } : {}),
      // Default the model to whatever provider is actually configured rather than
      // the column's hardcoded Claude default, so employees created on a
      // Codex-only install are usable out of the box.
      default_model: DEFAULT_CHAT_MODEL[preferredProvider()],
    })
    .execute();

  const responsibilities = (input.responsibilities ?? []).map((r) => r.trim()).filter(Boolean);
  if (responsibilities.length) {
    await trx
      .insertInto("employee_responsibilities")
      .values(responsibilities.map((text, position) => ({ id: randomUUID(), employee_id: employeeId, text, position })))
      .execute();
  }

  // Seed the agent profile (personality / communication style / expertise) when the
  // candidate supplied it. autonomy_level is set explicitly to the same value a
  // never-configured employee behaves as (see DEFAULT_AGENT_PROFILE), so creating the
  // row here introduces no approval-friction change vs. the column's own 'suggest'.
  const expertise = (input.expertise ?? []).map((e) => e.trim()).filter(Boolean);
  const personality = (input.personality ?? "").trim();
  const communicationStyle = (input.communicationStyle ?? "").trim();
  if (personality || communicationStyle || expertise.length) {
    await trx
      .insertInto("agent_profiles")
      .values({
        employee_id: employeeId,
        personality,
        communication_style: communicationStyle,
        expertise: JSON.stringify(expertise),
        autonomy_level: "act-with-approval",
        updated_at: new Date().toISOString(),
      })
      .execute();
  }

  return { conversationId, employeeId };
}

export async function createEmployee(ctx: RuntimeContext, input: CreateEmployeeInput): Promise<{ conversationId: string; employeeId: string }> {
  return mutate(ctx, async (trx, emit) => {
    const ids = await insertFullEmployee(trx, input);
    await emit({ companyId: input.companyId, type: "employee.created", subjectId: ids.employeeId, actor: { kind: "user" }, payload: { conversationId: ids.conversationId } });
    return ids;
  });
}

/**
 * Repoint any employee whose model belongs to a provider that is NOT currently
 * configured onto the preferred available provider's default model. This exists
 * for one specific ordering: the very first company + Chief of Staff are seeded
 * at runtime boot, which can happen before the user has set up ANY provider (the
 * launch gate then makes them configure one). Without this, a user who sets up
 * only Codex at the gate would be left with a Chief of Staff still pointing at
 * Claude — usable everywhere except the one conversation that shipped by default.
 * Idempotent and cheap (a no-op once every employee already matches an available
 * provider), so it's safe to call on every launch after the gate clears.
 */
export async function reconcileEmployeeModels(ctx: RuntimeContext): Promise<{ updated: number }> {
  const detected = detectProviders();
  const available = new Set<ModelProviderName>(
    (Object.keys(detected) as ModelProviderName[]).filter((p) => detected[p]),
  );
  // Nothing configured — don't touch anything (the gate is blocking the app anyway).
  if (available.size === 0) return { updated: 0 };

  const target = DEFAULT_CHAT_MODEL[preferredProvider()];
  const employees = await ctx.db.selectFrom("employees").select(["id", "company_id", "default_model"]).execute();
  const stale = employees.filter((e) => !available.has(modelProvider(e.default_model)));
  if (stale.length === 0) return { updated: 0 };

  // Group by company so each mutation emits a company-scoped event, consistent
  // with every other write going through mutate().
  const byCompany = new Map<string, string[]>();
  for (const e of stale) {
    if (!e.company_id) continue;
    const ids = byCompany.get(e.company_id) ?? [];
    ids.push(e.id);
    byCompany.set(e.company_id, ids);
  }
  for (const [companyId, ids] of byCompany) {
    await mutate(ctx, async (trx, emit) => {
      await trx.updateTable("employees").set({ default_model: target }).where("id", "in", ids).execute();
      await emit({ companyId, type: "employee.models.reconciled", subjectId: companyId, actor: { kind: "system" }, payload: { count: ids.length, model: target } });
    });
  }
  return { updated: stale.length };
}

// ---- responsibilities ----
export async function listResponsibilities(ctx: RuntimeContext, employeeId: string) {
  return ctx.db.selectFrom("employee_responsibilities").where("employee_id", "=", employeeId).selectAll().orderBy("position").orderBy("created_at").execute();
}

export async function addResponsibility(ctx: RuntimeContext, companyId: string, employeeId: string, text: string): Promise<void> {
  await mutate(ctx, async (trx, emit) => {
    const max = await trx.selectFrom("employee_responsibilities").where("employee_id", "=", employeeId).select(trx.fn.max("position").as("m")).executeTakeFirst();
    const position = nextPositionAfter(max?.m);
    await trx.insertInto("employee_responsibilities").values({ id: randomUUID(), employee_id: employeeId, text, position }).execute();
    await emit({ companyId, type: "employee.responsibility.added", subjectId: employeeId, actor: { kind: "user" }, payload: {} });
  });
}

export async function updateResponsibility(ctx: RuntimeContext, id: string, text: string): Promise<void> {
  await ctx.db.updateTable("employee_responsibilities").set({ text }).where("id", "=", id).execute();
}

export async function removeResponsibility(ctx: RuntimeContext, id: string): Promise<void> {
  await ctx.db.deleteFrom("employee_responsibilities").where("id", "=", id).execute();
}

// ---- departments ----
export async function listDepartments(ctx: RuntimeContext, companyId: string) {
  return ctx.db.selectFrom("departments").where("company_id", "=", companyId).selectAll().orderBy("position").orderBy("name").execute();
}

export async function createDepartment(ctx: RuntimeContext, companyId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = await ctx.db.selectFrom("departments").where("company_id", "=", companyId).where("name", "=", trimmed).selectAll().executeTakeFirst();
  if (existing) return existing;
  const max = await ctx.db.selectFrom("departments").where("company_id", "=", companyId).select(ctx.db.fn.max("position").as("m")).executeTakeFirst();
  const position = (Number(max?.m ?? -1) || -1) + 1;
  const id = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("departments").values({ id, company_id: companyId, name: trimmed, position }).execute();
    await emit({ companyId, type: "department.created", subjectId: id, actor: { kind: "user" }, payload: { name: trimmed } });
  });
  return ctx.db.selectFrom("departments").where("id", "=", id).selectAll().executeTakeFirst();
}

// ---- channel memberships ----
export async function listMembershipsForEmployee(ctx: RuntimeContext, employeeId: string) {
  return (
    await ctx.db.selectFrom("channel_memberships").where("employee_id", "=", employeeId).where("effective_to", "is", null).select("conversation_id").execute()
  ).map((r) => r.conversation_id);
}

export async function toggleMembership(ctx: RuntimeContext, conversationId: string, employeeId: string): Promise<void> {
  await mutate(ctx, async (trx, emit) => {
    const conv = await trx.selectFrom("conversations").where("id", "=", conversationId).select("company_id").executeTakeFirst();
    const existing = await trx.selectFrom("channel_memberships").where("employee_id", "=", employeeId).where("conversation_id", "=", conversationId).where("effective_to", "is", null).select("id").executeTakeFirst();
    if (existing) {
      await trx.updateTable("channel_memberships").set({ effective_to: new Date().toISOString() }).where("id", "=", existing.id).execute();
    } else {
      await trx.insertInto("channel_memberships").values({ id: randomUUID(), conversation_id: conversationId, employee_id: employeeId }).execute();
    }
    await emit({ companyId: conv?.company_id ?? null, type: "membership.toggled", subjectId: conversationId, actor: { kind: "user" }, payload: { employeeId } });
  });
}

export async function listChannelMembers(ctx: RuntimeContext, conversationId: string) {
  return ctx.db
    .selectFrom("channel_memberships as cm")
    .innerJoin("employees as e", "e.id", "cm.employee_id")
    .where("cm.conversation_id", "=", conversationId)
    .where("cm.effective_to", "is", null)
    .selectAll("e")
    .execute();
}

/**
 * An employee's "name" isn't its own column — it's the name of the 1:1 DM
 * conversation created alongside it (see createEmployee above). Ported from the
 * client's `employeesById[id].name` lookup now that prompt composition
 * (identity blocks, manager resolution, @mention scoping) runs server-side.
 */
export async function employeeDisplayName(ctx: RuntimeContext, employeeId: string): Promise<string | null> {
  const row = await ctx.db
    .selectFrom("employees as e")
    .innerJoin("conversations as c", "c.id", "e.conversation_id")
    .where("e.id", "=", employeeId)
    .select("c.name")
    .executeTakeFirst();
  return row?.name ?? null;
}

/** Server-side fork of src/lib/promptBuilder.ts's resolveManagerName. */
export async function resolveManagerName(
  ctx: RuntimeContext,
  managerEmployeeId: string | null,
  userFullName: string,
): Promise<string> {
  if (!managerEmployeeId) return userFullName || "the founder";
  const name = await employeeDisplayName(ctx, managerEmployeeId);
  return name ?? (userFullName || "the founder");
}

// ---- agent profile (personality/communication style/expertise/autonomy) ----

export type AutonomyLevel = "suggest" | "act-with-approval" | "autonomous";
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["suggest", "act-with-approval", "autonomous"];

export interface AgentProfile {
  personality: string;
  communicationStyle: string;
  expertise: string[];
  autonomyLevel: AutonomyLevel;
}

// Deliberately NOT "suggest" (the DB column's own default once a row exists) —
// an employee with no agent_profiles row yet has never been configured, and
// should behave exactly like every employee did before this feature existed
// (today's capability-gate policy, no extra approval friction). The column
// default of "suggest" only takes effect once a row is actually created,
// which happens on first explicit write via the UI — not implicitly for
// every pre-existing employee the moment this ships (report-adjacent: a
// silent, unrequested behavior change for existing users would be its own
// bug). evaluateCapability() mirrors this same "no row = unconfigured, not
// suggest" reasoning independently.
const DEFAULT_AGENT_PROFILE: AgentProfile = {
  personality: "",
  communicationStyle: "",
  expertise: [],
  autonomyLevel: "act-with-approval",
};

/**
 * `agent_profiles` rows are created lazily on first write (same pattern as
 * `employee_responsibilities` — no row means "all defaults", not an error).
 */
export async function getAgentProfile(ctx: RuntimeContext, employeeId: string): Promise<AgentProfile> {
  const row = await ctx.db
    .selectFrom("agent_profiles")
    .where("employee_id", "=", employeeId)
    .selectAll()
    .executeTakeFirst();
  if (!row) return DEFAULT_AGENT_PROFILE;
  let expertise: string[] = [];
  try {
    const parsed = JSON.parse(row.expertise);
    if (Array.isArray(parsed)) expertise = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // Malformed JSON should never happen (only this module ever writes this column),
    // but a corrupted value degrading to "no expertise" is safer than throwing and
    // taking down prompt composition for every turn this employee ever takes.
  }
  return {
    personality: row.personality,
    communicationStyle: row.communication_style,
    expertise,
    autonomyLevel: row.autonomy_level,
  };
}

const AGENT_PROFILE_FIELDS = new Set(["personality", "communication_style", "expertise", "autonomy_level"]);

/**
 * `value` for "expertise" is a JSON-encoded string[] (matches the column's own
 * storage format — the wire contract mirrors the DB rather than introducing a
 * second encoding). `field`/`value` come straight off the wire, so both are
 * validated before touching a CHECK-constrained column (report §1.4-class fix).
 */
export async function updateAgentProfileField(
  ctx: RuntimeContext,
  employeeId: string,
  field: string,
  value: string,
): Promise<void> {
  if (!AGENT_PROFILE_FIELDS.has(field)) throw new Error(`invalid agent profile field: ${field}`);
  if (field === "autonomy_level" && !AUTONOMY_LEVELS.includes(value as AutonomyLevel)) {
    throw new Error(`invalid autonomy level: ${value}`);
  }
  if (field === "expertise") {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new Error("not an array");
    } catch {
      throw new Error("expertise must be a JSON-encoded string array");
    }
  }
  await mutate(ctx, async (trx, emit) => {
    const emp = await trx.selectFrom("employees").where("id", "=", employeeId).select(["company_id"]).executeTakeFirst();
    if (!emp) throw new Error("employee not found");
    await trx
      .insertInto("agent_profiles")
      .values({ employee_id: employeeId, [field]: value, updated_at: new Date().toISOString() } as never)
      .onConflict((oc) => oc.column("employee_id").doUpdateSet({ [field]: value, updated_at: new Date().toISOString() } as never))
      .execute();
    await emit({ companyId: emp.company_id, type: "agentProfile.updated", subjectId: employeeId, actor: { kind: "user" }, payload: { field } });
  });
}
