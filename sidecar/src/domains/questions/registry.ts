/**
 * In-flight blocked question handlers, keyed by question id. When the
 * question_ask tool asks a question it registers a waiter here and awaits it;
 * command:question.answer looks the waiter up and resolves it, unblocking the
 * tool handler so the model can continue the same turn. Mirrors
 * runtime/turnRegistry.ts exactly — a process-wide map that survives across IPC
 * calls within one sidecar process and dies on restart (an orphaned pending
 * question after a restart simply has no waiter; resolveQuestion returns false).
 */
import type { AnswerPayload } from "./spec";

type Waiter = { resolve: (a: AnswerPayload) => void; reject: (e: Error) => void };

const waiters = new Map<string, Waiter>();

export function registerQuestion(id: string, waiter: Waiter): void {
  waiters.set(id, waiter);
}

export function unregisterQuestion(id: string): void {
  waiters.delete(id);
}

/**
 * Resolves the blocked handler for a question. Returns false if no handler is
 * waiting (the question was orphaned by a sidecar restart, or already settled)
 * — the caller has still persisted the answer; there's just no live turn to
 * continue.
 */
export function resolveQuestion(id: string, answer: AnswerPayload): boolean {
  const waiter = waiters.get(id);
  if (!waiter) return false;
  waiters.delete(id);
  waiter.resolve(answer);
  return true;
}
