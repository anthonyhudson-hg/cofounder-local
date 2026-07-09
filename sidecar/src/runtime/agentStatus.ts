import type { RuntimeContext } from "./context";

export interface StatusInput {
  conversationId: string;
  employeeId: string | null;
  messageId?: string | null;
  /** Machine phase: thinking | tool | relevance | writing | approval | cascade. */
  phase: string;
  message: string;
  toolName?: string | null;
  snippet?: string | null;
  done?: boolean;
}

/**
 * Publish an ephemeral live-activity status for an in-flight turn. Broadcast to
 * every window and never persisted (see events/bus.ts). The turn loop calls this
 * as it moves through its steps so the UI can narrate "Thinking → Using X →
 * Receiving output" in real time, the same way Paperclip's run runtime-status does.
 */
export function emitStatus(ctx: RuntimeContext, input: StatusInput): void {
  ctx.bus.publishStatus({
    conversationId: input.conversationId,
    employeeId: input.employeeId,
    messageId: input.messageId ?? null,
    phase: input.phase,
    message: input.message,
    toolName: input.toolName ?? null,
    snippet: input.snippet ?? null,
    lastEventAt: new Date().toISOString(),
    done: input.done ?? false,
  });
}

/** Signal that an employee's in-flight turn in a conversation has finished, so
 *  the client clears its "working" indicator immediately (not just on TTL). */
export function emitStatusDone(ctx: RuntimeContext, conversationId: string, employeeId: string | null): void {
  emitStatus(ctx, { conversationId, employeeId, phase: "done", message: "", done: true });
}

/** One recorded step of a turn's activity timeline, persisted into the message's
 *  debug_payload so the debug view can replay chronologically what the agent did. */
export interface ActivityLogEntry {
  at: string;
  phase: string;
  message: string;
  toolName: string | null;
  snippet: string | null;
}

export type TurnStatusStep = Omit<StatusInput, "conversationId" | "employeeId" | "messageId">;

/**
 * Bundles the repeated (conversationId, employeeId, messageId) for one turn and,
 * as a side effect of each `emit`, records the step into an in-memory `log` — so
 * the same call both broadcasts the live status AND builds the chronological
 * timeline that gets written into the message's debug_payload.
 */
export function createTurnStatus(
  ctx: RuntimeContext,
  base: { conversationId: string; employeeId: string | null; messageId?: string | null },
): { emit: (step: TurnStatusStep) => void; done: () => void; log: ActivityLogEntry[] } {
  const log: ActivityLogEntry[] = [];
  return {
    emit(step) {
      emitStatus(ctx, { ...base, ...step });
      log.push({
        at: new Date().toISOString(),
        phase: step.phase,
        message: step.message,
        toolName: step.toolName ?? null,
        snippet: step.snippet ?? null,
      });
    },
    done() {
      emitStatusDone(ctx, base.conversationId, base.employeeId);
    },
    log,
  };
}

/** "mcp__cofounder__memory_write" -> "Memory write". Mirrors the client copy in
 *  src/lib/liveActivity.ts (intentional Node/browser fork — keep in sync). */
export function friendlyToolName(raw: string): string {
  const short = raw.startsWith("mcp__") ? raw.split("__").pop() ?? raw : raw;
  const words = short.replace(/[_.]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A one-line preview of streamed assistant text for the status subtitle. */
export function statusSnippet(text: string, max = 140): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
