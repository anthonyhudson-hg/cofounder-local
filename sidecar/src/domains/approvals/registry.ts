/**
 * In-flight blocked approval handlers, keyed by approval id. When a gated tool
 * call needs sign-off mid-turn, the interactive helper (providers/
 * interactiveApproval.ts) registers a waiter here and awaits it; command:
 * approval.resolve resolves it with the user's decision, unblocking the handler
 * so the tool runs inline and the model continues the same turn. Mirrors
 * domains/questions/registry.ts and runtime/turnRegistry.ts — process-wide,
 * dies on restart (an orphaned pending approval then has no waiter and
 * resolveApprovalWaiter returns false).
 */

export type ApprovalDecision = "denied" | "once" | "always" | "always-here";

type Waiter = { resolve: (d: ApprovalDecision) => void; reject: (e: Error) => void };

const waiters = new Map<string, Waiter>();

export function registerApproval(id: string, waiter: Waiter): void {
  waiters.set(id, waiter);
}

export function unregisterApproval(id: string): void {
  waiters.delete(id);
}

/** Unblocks the handler waiting on this approval with the user's decision.
 *  Returns false if none is waiting (orphaned by a restart / background). */
export function resolveApprovalWaiter(id: string, decision: ApprovalDecision): boolean {
  const waiter = waiters.get(id);
  if (!waiter) return false;
  waiters.delete(id);
  waiter.resolve(decision);
  return true;
}
