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
 * The single capability gate (refactor #4). Rules:
 *   - No grant for the tool's scope            -> deny (agent can't touch it at all)
 *   - Requested effect <= standing grant       -> allow
 *   - Requested effect >  standing grant        -> approval (a human may authorize
 *                                                 the higher action case-by-case)
 * `autonomy_level` on the agent profile can auto-approve within policy: an
 * 'autonomous' agent's above-grant actions still surface an approval unless the
 * grant already covers them — deliberately conservative for external-write.
 *
 * `autonomy_level: "suggest"` is the one direction this gate actively narrows
 * rather than widens: even a within-grant action beyond a harmless read gets
 * downgraded to "approval". This is a real backstop, not just prompt guidance
 * (see runtime/promptBuilder.ts's AUTONOMY_GUIDANCE) — the system prompt only
 * shapes what the model *chooses* to do; this is what actually stops it.
 * "act-with-approval" and "autonomous" both currently resolve identically to
 * the base grant-only policy above — loosening the gate for "autonomous"
 * beyond what the grant already allows is the "deliberately conservative"
 * case the original docstring already flagged, and isn't done here.
 */
export async function evaluateCapability(
  ctx: RuntimeContext,
  employeeId: string,
  scope: string,
  effect: Effect,
): Promise<CapabilityDecision> {
  const grant = await ctx.db
    .selectFrom("capability_grants")
    .where("employee_id", "=", employeeId)
    .where("scope", "=", scope)
    .select(["max_effect"])
    .executeTakeFirst();

  if (!grant) return "deny";
  if (effectRank(effect) > effectRank(grant.max_effect as Effect)) return "approval";

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
