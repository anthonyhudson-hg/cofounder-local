/**
 * Which runtime command an inline notification reply should use, based on the
 * conversation it targets.
 *
 * A 1:1 DM replies through the DM turn (`message.send`). A channel or group DM
 * must go through the channel turn (`message.sendChannel`) instead — those
 * resolve each member's own provider/model server-side and have no single
 * employee to address, so `message.send` (which targets one employee's DM) is
 * the wrong command for them.
 *
 * Kept as a pure, tested primitive so the notification popup's inline reply
 * (see NotificationWindow) routes correctly regardless of which conversation a
 * proactive agent post landed in.
 */
export type NotificationReplyKind = "dm" | "channel" | "group";

export function notificationReplyCommand(kind: NotificationReplyKind): "message.send" | "message.sendChannel" {
  return kind === "dm" ? "message.send" : "message.sendChannel";
}
