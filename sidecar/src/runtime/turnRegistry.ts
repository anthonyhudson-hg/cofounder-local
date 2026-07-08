/**
 * In-flight turn abort controllers, keyed by the assistant message id the
 * client already knows (returned in SendMessageResult and the "meta" delta —
 * see conversations/service.ts's sendMessage). command:message.cancel is a
 * separate, later IPC call from the client; this process-wide map is the
 * only way for it to reach into a command:message.send handler that's still
 * running.
 */
const controllers = new Map<string, AbortController>();

export function registerTurn(messageId: string, controller: AbortController): void {
  controllers.set(messageId, controller);
}

export function unregisterTurn(messageId: string): void {
  controllers.delete(messageId);
}

/** Returns false if no turn with this id is currently in flight (already finished, or never existed). */
export function cancelTurn(messageId: string): boolean {
  const controller = controllers.get(messageId);
  if (!controller) return false;
  controller.abort();
  return true;
}
