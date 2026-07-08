import type { RuntimeContext } from "../runtime/context";

/**
 * Side-effect classes, ordered least→most dangerous. A tool declares the effect
 * it performs; the capability gate compares it to the agent's standing grant to
 * decide allow / needs-approval / deny.
 */
export const EFFECT_ORDER = [
  "none",
  "read",
  "write-internal",
  "external-read",
  "external-write",
] as const;
export type Effect = (typeof EFFECT_ORDER)[number];

export function effectRank(e: Effect): number {
  return EFFECT_ORDER.indexOf(e);
}

/** Context handed to a tool at invocation. Always company + employee scoped. */
export interface ToolContext {
  ctx: RuntimeContext;
  companyId: string;
  employeeId: string;
  correlationId?: string | null;
}

export interface Tool<Input = unknown, Output = unknown> {
  name: string;
  /** Capability scope this tool belongs to, e.g. "tool:memory", "connector:github". */
  scope: string;
  effect: Effect;
  description: string;
  run(tc: ToolContext, input: Input): Promise<Output>;
}
