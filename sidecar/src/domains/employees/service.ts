import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";

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
}

export async function createEmployee(ctx: RuntimeContext, input: CreateEmployeeInput): Promise<{ conversationId: string; employeeId: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("employee name required");
  const conversationId = randomUUID();
  const employeeId = randomUUID();
  await mutate(ctx, async (trx, emit) => {
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
      })
      .execute();
    await emit({ companyId: input.companyId, type: "employee.created", subjectId: employeeId, actor: { kind: "user" }, payload: { conversationId } });
  });
  return { conversationId, employeeId };
}

// ---- responsibilities ----
export async function listResponsibilities(ctx: RuntimeContext, employeeId: string) {
  return ctx.db.selectFrom("employee_responsibilities").where("employee_id", "=", employeeId).selectAll().orderBy("position").orderBy("created_at").execute();
}

export async function addResponsibility(ctx: RuntimeContext, companyId: string, employeeId: string, text: string): Promise<void> {
  await mutate(ctx, async (trx, emit) => {
    const max = await trx.selectFrom("employee_responsibilities").where("employee_id", "=", employeeId).select(trx.fn.max("position").as("m")).executeTakeFirst();
    const position = (Number(max?.m ?? -1) || -1) + 1;
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
