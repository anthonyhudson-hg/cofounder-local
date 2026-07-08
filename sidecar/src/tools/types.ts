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
  /**
   * Optional: enriches the human approval prompt beyond the raw input args — e.g. a
   * file-change preview for a write action — so a human approval isn't blind to what
   * the tool will actually do (report §2.2). Called at request time, before approval,
   * separately from `run`.
   */
  describeForApproval?(tc: ToolContext, input: Input): Promise<Record<string, unknown>>;
  /**
   * Optional: validates raw tool input before the capability gate/run even see it.
   * Throws (with a clear message) on malformed input. There was no runtime schema
   * validation anywhere in this pipeline — tool input arrives as `unknown` off the
   * wire and would otherwise only fail deep inside `run()` with an opaque low-level
   * error (report §2.6). Called synchronously; keep it cheap (no I/O).
   */
  validateInput?(input: unknown): void;
}
