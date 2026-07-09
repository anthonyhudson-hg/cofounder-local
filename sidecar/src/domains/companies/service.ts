import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { Actor } from "@shared/protocol";
import type { Database } from "../../db/schema";
import type { RuntimeContext } from "../../runtime/context";
import { mutate, type Emit } from "../../runtime/unitOfWork";
import { getSetting, setSetting } from "../settings/kv";
import { DEFAULT_CHAT_MODEL, preferredProvider } from "../../providers/availability";
import { nextPositionAfter } from "../../runtime/position";

const COS_GREETING =
  "👋 I'm your Chief of Staff. I'm a blank slate right now — tell me how you'd like me to work, or just start handing me things to coordinate, track, and follow up on.";

/**
 * Seeds a new company with #general and a COMPLETELY BLANK Chief of Staff (no
 * persona/mission/preamble — the founder shapes it), and STARTS the conversation
 * with a greeting message so the DM is live and visible immediately.
 */
async function seedDefaults(
  trx: Transaction<Database>,
  emit: Emit,
  companyId: string,
): Promise<{ cosEmployeeId: string; cosConversationId: string; generalConversationId: string }> {
  const generalId = randomUUID();
  const cosConvId = randomUUID();
  const cosEmpId = randomUUID();
  const greetingId = randomUUID();

  await trx.insertInto("conversations").values({ id: generalId, company_id: companyId, kind: "channel", name: "general" }).execute();
  await trx.insertInto("conversations").values({ id: cosConvId, company_id: companyId, kind: "dm", name: "Chief of Staff" }).execute();
  await trx
    .insertInto("employees")
    .values({
      id: cosEmpId,
      company_id: companyId,
      conversation_id: cosConvId,
      job_title: "Chief of Staff",
      department: "Executive",
      // deliberately blank — mission/preamble/additional_details default to ''
      // Seed the model from whatever provider is configured so a Codex-only
      // install gets a working Chief of Staff, not a Claude default that fails
      // to send. If nothing is configured yet (very first boot before the user
      // sets a provider up), this defaults to Claude and is repaired later by
      // reconcileEmployeeModels once a provider becomes available.
      default_model: DEFAULT_CHAT_MODEL[preferredProvider()],
    })
    .execute();
  await trx.insertInto("departments").values({ id: randomUUID(), company_id: companyId, name: "Executive", position: 0 }).execute();
  await trx.insertInto("channel_memberships").values({ id: randomUUID(), conversation_id: generalId, employee_id: cosEmpId }).execute();

  // Start the conversation so the DM is live + shows in the sidebar right away.
  await trx
    .insertInto("messages")
    .values({ id: greetingId, conversation_id: cosConvId, role: "assistant", content: COS_GREETING, status: "complete", author_employee_id: cosEmpId })
    .execute();
  await emit({ companyId, type: "message.created", subjectId: greetingId, actor: { kind: "employee", employeeId: cosEmpId }, payload: { conversationId: cosConvId, role: "assistant" } });

  return { cosEmployeeId: cosEmpId, cosConversationId: cosConvId, generalConversationId: generalId };
}

async function nextPosition(ctx: RuntimeContext): Promise<number> {
  const row = await ctx.db
    .selectFrom("companies")
    .select(ctx.db.fn.max("position").as("maxpos"))
    .executeTakeFirst();
  return nextPositionAfter(row?.maxpos);
}

export interface CreateCompanyInput {
  name: string;
}

/** Creates a company, seeds its #general + Chief of Staff, emits company.created. */
export async function createCompany(
  ctx: RuntimeContext,
  input: CreateCompanyInput,
  actor: Actor,
): Promise<{ id: string; cosEmployeeId: string; cosConversationId: string; generalConversationId: string }> {
  const id = randomUUID();
  const position = await nextPosition(ctx);
  const name = input.name.trim() || "New Company";

  const seeded = await mutate(ctx, async (trx, emit: Emit) => {
    await trx.insertInto("companies").values({ id, name, position }).execute();
    const s = await seedDefaults(trx, emit, id);
    await emit({ companyId: id, type: "company.created", subjectId: id, actor, payload: { name } });
    return s;
  });

  return { id, cosEmployeeId: seeded.cosEmployeeId, cosConversationId: seeded.cosConversationId, generalConversationId: seeded.generalConversationId };
}

/**
 * First-boot seeding (replaces the old Rust migration v2/v10 seed). Ensures the
 * runtime-owned DB has at least one company + an active-company setting, so the
 * runtime is self-sufficient once tauri-plugin-sql is removed.
 */
export async function ensureBootstrap(ctx: RuntimeContext): Promise<void> {
  const count = await ctx.repos.countCompanies();
  if (count === 0) {
    const { id } = await createCompany(ctx, { name: "My Company" }, { kind: "system" });
    await setActiveCompanyId(ctx, id);
    return;
  }
  const active = await getActiveCompanyId(ctx);
  if (!active) {
    const first = await ctx.db.selectFrom("companies").select("id").orderBy("position").orderBy("created_at").executeTakeFirst();
    if (first) await setActiveCompanyId(ctx, first.id);
  }
}

export async function listCompanies(ctx: RuntimeContext) {
  return ctx.db.selectFrom("companies").selectAll().orderBy("position").orderBy("created_at").execute();
}

const COMPANY_FIELDS = new Set(["name", "profile", "system_prompt", "avatar", "color"]);

export async function updateCompany(
  ctx: RuntimeContext,
  companyId: string,
  field: string,
  value: string | null,
): Promise<void> {
  if (!COMPANY_FIELDS.has(field)) throw new Error(`invalid company field: ${field}`);
  await mutate(ctx, async (trx, emit) => {
    // A stale/unknown companyId previously no-op'd silently instead of surfacing an
    // error (report §4.11).
    const result = await trx.updateTable("companies").set({ [field]: value } as never).where("id", "=", companyId).executeTakeFirst();
    if (!result.numUpdatedRows) throw new Error(`company ${companyId} not found`);
    await emit({ companyId, type: "company.updated", subjectId: companyId, actor: { kind: "user" }, payload: { field } });
  });
}

export async function getActiveCompanyId(ctx: RuntimeContext): Promise<string | null> {
  return getSetting(ctx, "active_company_id");
}

export async function setActiveCompanyId(ctx: RuntimeContext, companyId: string): Promise<void> {
  await setSetting(ctx, "active_company_id", companyId);
}

/** Clone a company (structure only, no history/sessions) — ports useCompanies.clone. */
export async function cloneCompany(ctx: RuntimeContext, sourceId: string, newName: string): Promise<{ id: string }> {
  const source = await ctx.db.selectFrom("companies").where("id", "=", sourceId).selectAll().executeTakeFirst();
  if (!source) throw new Error("source company not found");
  const newId = randomUUID();
  const position = await nextPosition(ctx);

  await mutate(ctx, async (trx, emit) => {
    await trx.insertInto("companies").values({
      id: newId, name: newName.trim() || `${source.name} (copy)`, profile: source.profile,
      system_prompt: source.system_prompt, avatar: source.avatar, color: source.color, position,
    }).execute();

    const convs = await trx.selectFrom("conversations").where("company_id", "=", sourceId).selectAll().execute();
    const emps = await trx.selectFrom("employees").where("company_id", "=", sourceId).selectAll().execute();
    const depts = await trx.selectFrom("departments").where("company_id", "=", sourceId).selectAll().execute();
    const convMap = new Map(convs.map((c) => [c.id, randomUUID()]));
    const empMap = new Map(emps.map((e) => [e.id, randomUUID()]));

    for (const c of convs)
      await trx.insertInto("conversations").values({ id: convMap.get(c.id)!, company_id: newId, kind: c.kind, name: c.name, is_group: c.is_group }).execute();
    for (const d of depts)
      await trx.insertInto("departments").values({ id: randomUUID(), company_id: newId, name: d.name, position: d.position }).execute();
    for (const e of emps)
      await trx.insertInto("employees").values({
        id: empMap.get(e.id)!, company_id: newId, conversation_id: convMap.get(e.conversation_id)!,
        job_title: e.job_title, department: e.department, mission: e.mission, preamble: e.preamble,
        additional_details: e.additional_details, default_model: e.default_model, default_effort: e.default_effort, avatar: e.avatar,
      }).execute();
    for (const e of emps) {
      const resps = await trx.selectFrom("employee_responsibilities").where("employee_id", "=", e.id).selectAll().orderBy("position").execute();
      for (const r of resps)
        await trx.insertInto("employee_responsibilities").values({ id: randomUUID(), employee_id: empMap.get(e.id)!, text: r.text, position: r.position }).execute();
    }
    for (const e of emps) {
      if (!e.manager_employee_id) continue;
      const mgr = empMap.get(e.manager_employee_id);
      if (mgr) await trx.updateTable("employees").set({ manager_employee_id: mgr }).where("id", "=", empMap.get(e.id)!).execute();
    }
    for (const c of convs) {
      const mems = await trx.selectFrom("channel_memberships").where("conversation_id", "=", c.id).where("effective_to", "is", null).selectAll().execute();
      for (const m of mems) {
        const emp = empMap.get(m.employee_id);
        if (emp) await trx.insertInto("channel_memberships").values({ id: randomUUID(), conversation_id: convMap.get(c.id)!, employee_id: emp }).execute();
      }
    }
    await emit({ companyId: newId, type: "company.created", subjectId: newId, actor: { kind: "user" }, payload: { name: newName, clonedFrom: sourceId } });
  });
  return { id: newId };
}

/** Delete a company and all dependents (dependency order) — ports useCompanies.remove. */
export async function removeCompany(ctx: RuntimeContext, companyId: string): Promise<{ fallbackId: string }> {
  const others = await ctx.db.selectFrom("companies").where("id", "!=", companyId).select("id").orderBy("position").orderBy("created_at").execute();
  if (others.length === 0) throw new Error("Cannot delete the last remaining company");
  const fallbackId = others[0].id;

  await mutate(ctx, async (trx, emit) => {
    const convIds = (await trx.selectFrom("conversations").where("company_id", "=", companyId).select("id").execute()).map((r) => r.id);
    const empIds = (await trx.selectFrom("employees").where("company_id", "=", companyId).select("id").execute()).map((r) => r.id);
    const msgIds = convIds.length ? (await trx.selectFrom("messages").where("conversation_id", "in", convIds).select("id").execute()).map((r) => r.id) : [];
    if (msgIds.length) {
      await trx.deleteFrom("reactions").where("message_id", "in", msgIds).execute();
      await trx.deleteFrom("relevance_checks").where("message_id", "in", msgIds).execute();
    }
    if (convIds.length) {
      await trx.deleteFrom("agent_sessions").where("conversation_id", "in", convIds).execute();
      await trx.deleteFrom("channel_memberships").where("conversation_id", "in", convIds).execute();
      await trx.deleteFrom("messages").where("conversation_id", "in", convIds).execute();
    }
    // Previously stopped here — secrets (including a deleted company's GitHub PAT,
    // which then sat encrypted-at-rest indefinitely with nothing left to ever
    // reference or clean it up), capability grants, and per-employee agent
    // profiles/memory were never purged, becoming permanently orphaned rows
    // referencing a company/employees that no longer exist (report §4.5).
    await trx.deleteFrom("secrets").where("company_id", "=", companyId).execute();
    await trx.deleteFrom("capability_grants").where("company_id", "=", companyId).execute();
    await trx.deleteFrom("agent_memory").where("company_id", "=", companyId).execute();
    if (empIds.length) {
      await trx.deleteFrom("agent_profiles").where("employee_id", "in", empIds).execute();
      await trx.deleteFrom("employee_responsibilities").where("employee_id", "in", empIds).execute();
    }
    await trx.deleteFrom("employees").where("company_id", "=", companyId).execute();
    await trx.deleteFrom("conversations").where("company_id", "=", companyId).execute();
    await trx.deleteFrom("departments").where("company_id", "=", companyId).execute();
    await trx.deleteFrom("companies").where("id", "=", companyId).execute();

    // Update active_company_id to the fallback INSIDE this same transaction whenever
    // the company being removed is currently active, instead of depending on the
    // frontend making a second, separate IPC call that might never land (app crash
    // between the two calls would otherwise leave active_company_id pointing at a
    // dead row forever, since nothing that reads it checks existence) (report §4.11).
    // Uses `trx` directly (not the shared getSetting/setSetting helpers, which read
    // via ctx.db) so this stays atomic with the rest of the delete.
    const activeRow = await trx.selectFrom("settings").where("key", "=", "active_company_id").select("value").executeTakeFirst();
    if (activeRow?.value === companyId) {
      await trx
        .insertInto("settings")
        .values({ key: "active_company_id", value: fallbackId })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: fallbackId }))
        .execute();
    }

    await emit({ companyId, type: "company.deleted", subjectId: companyId, actor: { kind: "user" }, payload: {} });
  });
  return { fallbackId };
}
