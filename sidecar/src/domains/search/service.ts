import { sql, type SqlBool } from "kysely";
import type { RuntimeContext } from "../../runtime/context";
import { getUserProfile } from "../settings/service";

export interface SearchChannelHit {
  conversationId: string;
  name: string;
  isGroup: boolean;
}

export interface SearchPersonHit {
  conversationId: string;
  employeeId: string;
  name: string;
  jobTitle: string;
  department: string;
  avatar: string | null;
}

export interface SearchMessageHit {
  messageId: string;
  conversationId: string;
  conversationName: string;
  conversationKind: "dm" | "channel";
  isGroup: boolean;
  threadRootId: string | null;
  authorName: string;
  snippet: string;
  createdAt: string;
}

export interface GlobalSearchResults {
  channels: SearchChannelHit[];
  people: SearchPersonHit[];
  messages: SearchMessageHit[];
}

/** Escapes LIKE wildcards so a user typing `%` or `_` searches for the literal char. */
function likePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

/**
 * `col LIKE pat ESCAPE '\'` — the ESCAPE clause is what makes the backslash-escaping
 * in `likePattern` actually take effect (SQLite's default LIKE has no escape char, so
 * without this an escaped `%`/`_` would still act as a wildcard). `col` may be a
 * dotted, aliased column reference (e.g. `"c.name"`).
 */
function likeEsc(col: string, pat: string) {
  return sql<SqlBool>`${sql.ref(col)} like ${pat} escape '\\'`;
}

const EMPTY: GlobalSearchResults = { channels: [], people: [], messages: [] };

/**
 * Slack-style global search over a company's channels (incl. group DMs), people
 * (name/title/department), and message content (which includes thread replies —
 * they're just message rows with a thread_root_id). Case-insensitive substring
 * match via LIKE; each category is capped so the suggestions dropdown stays small.
 */
export async function globalSearch(
  ctx: RuntimeContext,
  companyId: string,
  q: string,
  limit = 8,
): Promise<GlobalSearchResults> {
  const trimmed = q.trim();
  if (!trimmed) return EMPTY;
  const pat = likePattern(trimmed);

  // Channels + group DMs by name.
  const channelRows = await ctx.db
    .selectFrom("conversations")
    .where("company_id", "=", companyId)
    .where((eb) => eb.or([eb("kind", "=", "channel"), eb.and([eb("kind", "=", "dm"), eb("is_group", "=", 1)])]))
    .where(likeEsc("name", pat))
    .select(["id", "name", "is_group"])
    .orderBy("name")
    .limit(limit)
    .execute();

  // People: an employee's 1:1 DM (not a group), matched on display name/title/dept.
  const peopleRows = await ctx.db
    .selectFrom("employees as e")
    .innerJoin("conversations as c", "c.id", "e.conversation_id")
    .where("e.company_id", "=", companyId)
    .where("c.is_group", "=", 0)
    .where((eb) => eb.or([likeEsc("c.name", pat), likeEsc("e.job_title", pat), likeEsc("e.department", pat)]))
    .select(["e.id as employeeId", "e.conversation_id as conversationId", "c.name as name", "e.job_title as jobTitle", "e.department as department", "e.avatar as avatar"])
    .orderBy("c.name")
    .limit(limit)
    .execute();

  // Messages by content. author_employee_id → that employee's DM-conversation name;
  // null author = the founder. Newest first.
  const { userFullName } = await getUserProfile(ctx);
  const messageRows = await ctx.db
    .selectFrom("messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .leftJoin("employees as ae", "ae.id", "m.author_employee_id")
    .leftJoin("conversations as ac", "ac.id", "ae.conversation_id")
    .where("c.company_id", "=", companyId)
    .where(likeEsc("m.content", pat))
    .where("m.content", "!=", "")
    .select((eb) => [
      "m.id as messageId",
      "m.conversation_id as conversationId",
      "c.name as conversationName",
      "c.kind as conversationKind",
      "c.is_group as isGroup",
      "m.thread_root_id as threadRootId",
      "m.content as content",
      "m.created_at as createdAt",
      eb.case().when("m.author_employee_id", "is", null).then(userFullName || "You").else(eb.ref("ac.name")).end().as("authorName"),
    ])
    .orderBy("m.created_at", "desc")
    .limit(limit)
    .execute();

  return {
    channels: channelRows.map((r) => ({ conversationId: r.id, name: r.name, isGroup: !!r.is_group })),
    people: peopleRows.map((r) => ({
      conversationId: r.conversationId,
      employeeId: r.employeeId,
      name: r.name,
      jobTitle: r.jobTitle,
      department: r.department,
      avatar: r.avatar,
    })),
    messages: messageRows.map((r) => ({
      messageId: r.messageId,
      conversationId: r.conversationId,
      conversationName: r.conversationName,
      conversationKind: r.conversationKind,
      isGroup: !!r.isGroup,
      threadRootId: r.threadRootId,
      authorName: r.authorName ?? "Someone",
      snippet: r.content.slice(0, 240),
      createdAt: r.createdAt,
    })),
  };
}
