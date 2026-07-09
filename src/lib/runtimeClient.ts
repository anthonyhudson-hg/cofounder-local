import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CommandEnvelope,
  EventEnvelope,
  QueryEnvelope,
  ResultEnvelope,
  RuntimeOutbound,
} from "@shared/protocol";
import { useAgentStatusStore } from "../store/agentStatus";

/**
 * Typed client for the agent runtime (refactor #2/#7). Sends Commands/Queries
 * over the Tauri bridge (`send_to_runtime`) and receives Results/Events on the
 * `runtime://event` stream. The runtime is the sole DB owner.
 *
 * We do NOT gate on the runtime's one-time `ready` event — it may fire before the
 * client registers its listener (a missed-event race that would hang forever).
 * Instead we retry the send until the runtime process's stdin is available.
 */

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
};
const pending = new Map<string, Pending>();
type EventListener = (event: EventEnvelope) => void;
const eventListeners = new Set<EventListener>();
type DeltaListener = (channel: string, data: unknown) => void;
const deltaListeners = new Map<string, DeltaListener>();

// Plain commands/queries should fail fast; a streaming command (message.send) may
// legitimately run for minutes but keeps producing deltas, so its idle timer resets
// on every delta instead of using a single fixed deadline (report §1.1).
const DEFAULT_TIMEOUT_MS = 30_000;
const STREAM_IDLE_TIMEOUT_MS = 120_000;

function timeoutError(id: string, timeoutMs: number): Error {
  return new Error(
    `No response from the runtime within ${Math.round(timeoutMs / 1000)}s (request ${id}). The sidecar/runtime process may be unresponsive.`,
  );
}

function scheduleTimeout(id: string, timeoutMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.reject(timeoutError(id, timeoutMs));
  }, timeoutMs);
}

/** Reset a pending request's inactivity timeout — called on each streamed delta. */
function touchPending(id: string): void {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  p.timer = scheduleTimeout(id, p.timeoutMs);
}

let started = false;
let startPromise: Promise<void> | null = null;

// Must match the error string sidecar.rs returns from `send_to_runtime` before the
// runtime process has registered its stdin. Kept as a named constant so the boot
// retry in sendToRuntimeWithRetry isn't silently coupled to a bare literal.
const RUNTIME_NOT_RUNNING = "runtime is not running";

/** Start the runtime event bus once (idempotent; safe to call from anywhere). */
export function startRuntimeBus(): Promise<void> {
  if (started) return Promise.resolve();
  if (startPromise) return startPromise;
  startPromise = listen<RuntimeOutbound>("runtime://event", (evt) => {
    const msg = evt.payload;
    switch (msg.kind) {
      case "ready":
        break;
      case "result": {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.ok) p.resolve((msg as ResultEnvelope & { ok: true }).data);
        else p.reject(new Error((msg as ResultEnvelope & { ok: false }).error.message));
        break;
      }
      case "event":
        for (const l of eventListeners) {
          try {
            l(msg);
          } catch (err) {
            // Isolate listeners from each other — one throwing subscriber must not
            // stop every other hook's event handler from running (report §3.8-adjacent).
            console.error("onRuntimeEvent listener threw", err);
          }
        }
        break;
      case "status":
        // Ephemeral live-activity status broadcast to every window (see the
        // runtime's agentStatus.ts). Routed straight into the store rather than
        // through a request id — it belongs to no specific command.
        useAgentStatusStore.getState().apply(msg.status);
        break;
      case "delta": {
        touchPending(msg.id);
        const dl = deltaListeners.get(msg.id);
        if (dl) dl(msg.channel, msg.data);
        break;
      }
    }
  })
    .then(() => {
      started = true;
    })
    .catch((err) => {
      // A failed listen() used to be cached forever — every later command()/query()
      // would await the same rejected promise with no way to re-init. Clear it so a
      // subsequent call retries subscribing.
      startPromise = null;
      throw err;
    });
  return startPromise;
}

export function onRuntimeEvent(listener: EventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Invoke send_to_runtime, retrying while the runtime process is still coming up
 * (its stdin not yet registered on the Rust side). ~6s of headroom at boot.
 */
async function sendToRuntimeWithRetry(message: unknown): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      await invoke("send_to_runtime", { message });
      return;
    } catch (err) {
      lastErr = err;
      const m = err instanceof Error ? err.message : String(err);
      if (!m.includes(RUNTIME_NOT_RUNNING)) throw err instanceof Error ? err : new Error(m);
      await sleep(150);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function send(envelope: CommandEnvelope | QueryEnvelope, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = scheduleTimeout(envelope.id, timeoutMs);
    pending.set(envelope.id, { resolve, reject, timer, timeoutMs });
    sendToRuntimeWithRetry(envelope).catch((err) => {
      const p = pending.get(envelope.id);
      if (p) clearTimeout(p.timer);
      pending.delete(envelope.id);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function command<T = unknown>(type: string, payload: unknown, companyId: string | null): Promise<T> {
  await startRuntimeBus();
  const env: CommandEnvelope = { kind: "command", id: crypto.randomUUID(), type, companyId, payload };
  return send(env) as Promise<T>;
}

export async function query<T = unknown>(type: string, payload: unknown, companyId: string | null): Promise<T> {
  await startRuntimeBus();
  const env: QueryEnvelope = { kind: "query", id: crypto.randomUUID(), type, companyId, payload };
  return send(env) as Promise<T>;
}

/**
 * A command that streams deltas (e.g. `message.send` yielding assistant text
 * chunks) before its final result. `onDelta(channel, data)` fires per chunk, and
 * each delta resets the idle timeout so a long-but-actively-streaming turn survives
 * while a genuinely stuck one still fails loudly instead of hanging forever.
 */
export async function commandStreaming<T = unknown>(
  type: string,
  payload: unknown,
  companyId: string | null,
  onDelta: DeltaListener,
): Promise<T> {
  await startRuntimeBus();
  const id = crypto.randomUUID();
  deltaListeners.set(id, onDelta);
  const env: CommandEnvelope = { kind: "command", id, type, companyId, payload };
  try {
    return (await send(env, STREAM_IDLE_TIMEOUT_MS)) as T;
  } finally {
    deltaListeners.delete(id);
  }
}
