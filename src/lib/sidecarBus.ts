import { listen } from "@tauri-apps/api/event";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type SidecarEvent =
  | { type: "ready" }
  | { type: "delta"; id: string; text: string }
  | {
      type: "done";
      id: string;
      sessionId: string | null;
      success: boolean;
      usage: Usage;
      totalCostUsd: number;
    }
  | { type: "error"; id: string; message: string }
  | { type: "token_count"; id: string; tokens: number; exact: boolean }
  | { type: "relevance_result"; id: string; respond: boolean; reason: string }
  | {
      type: "channel_result";
      id: string;
      respondsWithText: boolean;
      text: string;
      replyToMessageId: string | null;
      threadRootId: string | null;
      reactions: { messageId: string; emoji: string }[];
      sessionId: string | null;
      success: boolean;
      usage: Usage;
      totalCostUsd: number;
    };

type Handler = (event: SidecarEvent) => void;

/** Default idle window: if no event (including deltas) arrives for a registered
 *  request id within this window, we synthesize an error instead of hanging forever. */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

interface Registration {
  handler: Handler;
  timer: ReturnType<typeof setTimeout>;
  idleTimeoutMs: number;
}

const handlers = new Map<string, Registration>();
let started = false;

function timeoutEvent(id: string, idleTimeoutMs: number): SidecarEvent {
  return {
    type: "error",
    id,
    message: `No response from the sidecar within ${Math.round(idleTimeoutMs / 1000)}s — it may have crashed or hung. Try again.`,
  };
}

function scheduleTimeout(id: string, idleTimeoutMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const reg = handlers.get(id);
    if (!reg) return;
    handlers.delete(id);
    reg.handler(timeoutEvent(id, idleTimeoutMs));
  }, idleTimeoutMs);
}

/**
 * Register a handler for sidecar events keyed by request id. `idleTimeoutMs` (default 90s)
 * resets on every event delivered for this id (including "delta"), so a long-running but
 * actively-streaming response stays alive while a genuinely stuck one times out with a
 * synthetic `{type:"error"}` event instead of hanging the caller forever.
 */
export function registerRequestHandler(id: string, handler: Handler, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS): void {
  const existing = handlers.get(id);
  if (existing) clearTimeout(existing.timer);
  handlers.set(id, { handler, timer: scheduleTimeout(id, idleTimeoutMs), idleTimeoutMs });
}

export function unregisterRequestHandler(id: string): void {
  const reg = handlers.get(id);
  if (reg) clearTimeout(reg.timer);
  handlers.delete(id);
}

export async function startSidecarBus(): Promise<void> {
  if (started) return;
  started = true;
  await listen<SidecarEvent>("cos://event", (event) => {
    const payload = event.payload;
    if (payload.type === "ready") return;
    const reg = handlers.get(payload.id);
    if (!reg) return;
    clearTimeout(reg.timer);
    reg.timer = scheduleTimeout(payload.id, reg.idleTimeoutMs);
    reg.handler(payload);
  });
}
