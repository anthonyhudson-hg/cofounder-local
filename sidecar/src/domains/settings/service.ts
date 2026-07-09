import type { RuntimeContext } from "../../runtime/context";
import { getSetting, setSetting } from "./kv";

export async function getUserProfile(ctx: RuntimeContext): Promise<{ userFullName: string }> {
  return { userFullName: (await getSetting(ctx, "user_full_name")) ?? "" };
}

export async function setUserFullName(ctx: RuntimeContext, value: string): Promise<void> {
  await setSetting(ctx, "user_full_name", value);
}

export async function getNotificationPreference(ctx: RuntimeContext): Promise<{ enabled: boolean }> {
  const v = await getSetting(ctx, "desktop_notifications_enabled");
  return { enabled: v === null || v === "1" };
}

export async function setNotificationPreference(ctx: RuntimeContext, enabled: boolean): Promise<void> {
  await setSetting(ctx, "desktop_notifications_enabled", enabled ? "1" : "0");
}

/** Mark all currently-unnotified assistant messages as seen (first-run baseline). */
export async function baselineNotifications(ctx: RuntimeContext): Promise<void> {
  await ctx.db
    .updateTable("messages")
    .set({ notified_at: new Date().toISOString() })
    .where("role", "=", "assistant")
    .where("status", "=", "complete")
    .where("notified_at", "is", null)
    .execute();
}

export interface PendingNotification {
  id: string;
  content: string;
  conversation_id: string;
  conversation_name: string;
  /** "dm" | "channel" — the popup only offers an inline reply for DMs. */
  conversation_kind: string;
  company_name: string | null;
  /** Set when the message lives inside a thread — lets a notification click jump into it. */
  thread_root_id: string | null;
  /** The employee that sent the message (its DM-conversation name) + avatar, for the popup card. */
  author_name: string | null;
  author_avatar: string | null;
}

/** Return + atomically mark unnotified completed assistant messages (all companies). */
export async function drainNotifications(ctx: RuntimeContext): Promise<PendingNotification[]> {
  const rows = (await ctx.db
    .selectFrom("messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .leftJoin("companies as co", "co.id", "c.company_id")
    .leftJoin("employees as ae", "ae.id", "m.author_employee_id")
    .leftJoin("conversations as ac", "ac.id", "ae.conversation_id")
    .where("m.role", "=", "assistant")
    .where("m.status", "=", "complete")
    .where("m.notified_at", "is", null)
    .select([
      "m.id",
      "m.content",
      "m.conversation_id",
      "c.name as conversation_name",
      "c.kind as conversation_kind",
      "co.name as company_name",
      "m.thread_root_id",
      "ac.name as author_name",
      "ae.avatar as author_avatar",
    ])
    .orderBy("m.created_at")
    .execute()) as PendingNotification[];

  if (rows.length > 0) {
    await ctx.db
      .updateTable("messages")
      .set({ notified_at: new Date().toISOString() })
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
  }
  return rows;
}
