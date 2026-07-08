import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../runtime/context";
import { effectRank, type Effect } from "./types";

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

/** Convenience for tests/seed: grant an employee a capability up to `maxEffect`. */
export async function grantCapability(
  ctx: RuntimeContext,
  companyId: string,
  employeeId: string,
  scope: string,
  maxEffect: Effect,
): Promise<void> {
  await ctx.db
    .insertInto("capability_grants")
    .values({ id: randomUUID(), company_id: companyId, employee_id: employeeId, scope, max_effect: maxEffect })
    .onConflict((oc) => oc.columns(["employee_id", "scope"]).doUpdateSet({ max_effect: maxEffect }))
    .execute();
}
