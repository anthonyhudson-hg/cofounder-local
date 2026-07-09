import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../runtime/context";
import { mutate } from "../runtime/unitOfWork";
import { effectRank, type Effect } from "./types";

/** Mirrors conversations/service.ts's assertConversationInCompany — guards
 *  against granting/revoking/listing capabilities for another company's
 *  employee via a client-driven IPC call (report-class leakage risk). */
async function assertEmployeeInCompany(ctx: RuntimeContext, companyId: string, employeeId: string): Promise<void> {
  const row = await ctx.db
    .selectFrom("employees")
    .where("id", "=", employeeId)
    .where("company_id", "=", companyId)
    .select("id")
    .executeTakeFirst();
  if (!row) throw new Error(`employee ${employeeId} not in company ${companyId}`);
}

export type CapabilityDecision = "allow" | "approval" | "deny";

/**
 * The single capability gate (refactor #4). Rules (Claude Code-style: no access
 * means ASK, not hard-block):
 *   - No grant, effect <= read (or none)       -> allow (reads/lookups flow free)
 *   - No grant, effect >  read                  -> approval (a human authorizes
 *                                                 the consequential action inline;
 *                                                 "Allow always" then grants it)
 *   - Requested effect <= standing grant        -> allow
 *   - Requested effect >  standing grant        -> approval
 * A grant can be global (capability_grants) OR scoped to this conversation
 * (conversation_capability_grants — the "Always in this channel" button); the
 * higher of the two applies.
 *
 * `autonomy_level: "suggest"` still narrows within-grant, effect>read actions to
 * "approval" — a real backstop beyond the prompt's AUTONOMY_GUIDANCE.
 */
export async function evaluateCapability(
  ctx: RuntimeContext,
  employeeId: string,
  scope: string,
  effect: Effect,
  conversationId?: string | null,
): Promise<CapabilityDecision> {
  const global = await ctx.db
    .selectFrom("capability_grants")
    .where("employee_id", "=", employeeId)
    .where("scope", "=", scope)
    .select(["max_effect"])
    .executeTakeFirst();

  let maxGrant: Effect | null = global ? (global.max_effect as Effect) : null;

  if (conversationId) {
    const convGrant = await ctx.db
      .selectFrom("conversation_capability_grants")
      .where("employee_id", "=", employeeId)
      .where("conversation_id", "=", conversationId)
      .where("scope", "=", scope)
      .select(["max_effect"])
      .executeTakeFirst();
    if (convGrant) {
      const ce = convGrant.max_effect as Effect;
      if (maxGrant === null || effectRank(ce) > effectRank(maxGrant)) maxGrant = ce;
    }
  }

  // No grant anywhere: harmless reads flow; anything consequential asks.
  if (maxGrant === null) {
    return effectRank(effect) > effectRank("read") ? "approval" : "allow";
  }

  if (effectRank(effect) > effectRank(maxGrant)) return "approval";

  if (effectRank(effect) > effectRank("read")) {
    const profile = await ctx.db
      .selectFrom("agent_profiles")
      .where("employee_id", "=", employeeId)
      .select(["autonomy_level"])
      .executeTakeFirst();
    if (profile?.autonomy_level === "suggest") return "approval";
  }

  return "allow";
}

export interface CapabilityGrantItem {
  scope: string;
  maxEffect: Effect;
}

/** Lists an employee's standing grants (company-scoped). */
export async function listGrants(ctx: RuntimeContext, companyId: string, employeeId: string): Promise<CapabilityGrantItem[]> {
  await assertEmployeeInCompany(ctx, companyId, employeeId);
  const rows = await ctx.db
    .selectFrom("capability_grants")
    .where("employee_id", "=", employeeId)
    .where("company_id", "=", companyId)
    .select(["scope", "max_effect"])
    .execute();
  return rows.map((r) => ({ scope: r.scope, maxEffect: r.max_effect as Effect }));
}

/**
 * Grants (or updates) an employee's capability up to `maxEffect`. Also used
 * directly by tests/seed data, hence the plain positional signature. Routed
 * through `mutate()` and emits `capability.granted` — capability_grants had
 * no audit trail at all before this (every other mutation in this codebase
 * goes through mutate(); this table was the one silent exception).
 */
export async function grantCapability(
  ctx: RuntimeContext,
  companyId: string,
  employeeId: string,
  scope: string,
  maxEffect: Effect,
): Promise<void> {
  await assertEmployeeInCompany(ctx, companyId, employeeId);
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("capability_grants")
      .values({ id: randomUUID(), company_id: companyId, employee_id: employeeId, scope, max_effect: maxEffect })
      .onConflict((oc) => oc.columns(["employee_id", "scope"]).doUpdateSet({ max_effect: maxEffect }))
      .execute();
    await emit({
      companyId,
      type: "capability.granted",
      subjectId: employeeId,
      actor: { kind: "user" },
      payload: { scope, maxEffect },
    });
  });
}

/**
 * Grants an employee a capability scoped to ONE conversation — the "Always in
 * this channel" approval decision. Separate table from the global grants so a
 * per-chat allowance never widens the employee's standing permissions; the gate
 * takes the higher of the two (see evaluateCapability). Emits capability.granted
 * with the conversationId so it's auditable and distinguishable from a global grant.
 */
export async function grantConversationCapability(
  ctx: RuntimeContext,
  companyId: string,
  employeeId: string,
  conversationId: string,
  scope: string,
  maxEffect: Effect,
): Promise<void> {
  await assertEmployeeInCompany(ctx, companyId, employeeId);
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("conversation_capability_grants")
      .values({ id: randomUUID(), company_id: companyId, employee_id: employeeId, conversation_id: conversationId, scope, max_effect: maxEffect })
      .onConflict((oc) => oc.columns(["employee_id", "conversation_id", "scope"]).doUpdateSet({ max_effect: maxEffect }))
      .execute();
    await emit({
      companyId,
      type: "capability.granted",
      subjectId: employeeId,
      actor: { kind: "user" },
      payload: { scope, maxEffect, conversationId },
    });
  });
}

/**
 * Revokes an employee's grant for a scope entirely (hard delete, not a
 * status flip) — capability_grants has no soft-delete column and
 * evaluateCapability's lookup already treats "no row" as the deny state,
 * so a delete preserves that invariant with zero changes to the gate.
 * History lives in the emitted `capability.revoked` event, not the row.
 */
export async function revokeCapability(ctx: RuntimeContext, companyId: string, employeeId: string, scope: string): Promise<void> {
  await assertEmployeeInCompany(ctx, companyId, employeeId);
  await mutate(ctx, async (trx, emit) => {
    await trx
      .deleteFrom("capability_grants")
      .where("employee_id", "=", employeeId)
      .where("company_id", "=", companyId)
      .where("scope", "=", scope)
      .execute();
    await emit({
      companyId,
      type: "capability.revoked",
      subjectId: employeeId,
      actor: { kind: "user" },
      payload: { scope },
    });
  });
}
