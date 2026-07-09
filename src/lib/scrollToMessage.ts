/**
 * Scrolls a message row (marked with `data-message-id`) into view within `container`
 * and briefly flashes it. Shared by the main message list and the thread panel for
 * jump-to-message from global search. Returns false if the row isn't mounted yet, so
 * callers can retry once messages have loaded.
 */
export function focusMessageRow(container: HTMLElement | null, messageId: string): boolean {
  const el = container?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("message-row-flash");
  window.setTimeout(() => el.classList.remove("message-row-flash"), 1600);
  return true;
}
