import type { RuntimeContext } from "../runtime/context";
import type { DeltaSink } from "../runtime/dispatch";

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
  /**
   * How many message.send-triggered response cascades deep this turn already is.
   * A user/tool-initiated channel message runs its responders at depth 0; if a
   * responder itself calls the message.send tool, the cascade it kicks off runs
   * at depth+1. The message.send tool refuses to start a further cascade past a
   * fixed ceiling so two agents can't ping-pong message.send at each other
   * forever, burning tokens with no user in the loop. Absent ⇒ 0.
   */
  cascadeDepth?: number;
  // --- interactive/blocking tools (question_ask) ---
  /** The conversation this turn belongs to — where a question card renders. */
  conversationId?: string;
  /** DM: the streaming assistant message asking. Channel: null (a responder has
   *  no message row until it posts, so its card keys off employeeId instead). */
  askingMessageId?: string | null;
  /** The initiating turn's live delta sink — how a blocking tool draws its card
   *  and streams keepalives that reset the client's stream-idle timer. */
  sink?: DeltaSink;
  /** Fires on user Stop / stale-session retry — a blocking tool must reject its
   *  wait when this aborts so it doesn't hang forever. */
  abortSignal?: AbortSignal;
  /** False for background cascades (message.send responders) that have no live
   *  user — a question tool degrades gracefully instead of blocking forever. The
   *  no-op sink used there is an anonymous object, so this flag (not sink
   *  identity) is the reliable "is there a human here" signal. Absent ⇒ treat as
   *  non-interactive. */
  interactive?: boolean;
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
