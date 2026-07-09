import { randomUUID } from "node:crypto";
import { mutate } from "../../runtime/unitOfWork";
import { listMembershipsForEmployee } from "../../domains/employees/service";
import { runChannelResponders } from "../../domains/conversations/service";
import { registerTool } from "../registry";
import type { Tool, ToolContext } from "../types";

// How many message.send-triggered cascades may chain before we stop kicking off
// more responders. Depth 0 is the original user/tool post; each responder that
// itself calls message.send bumps it. 3 leaves room for a genuine short relay
// (A pings B, B loops in C) while cutting off an unbounded A↔B ping-pong.
const MAX_CASCADE_DEPTH = 3;

interface SendInput {
  conversationName: string;
  text: string;
}

interface SendOutput {
  conversationName: string;
  messageId: string;
}

function validateSendInput(input: unknown): void {
  if (!input || typeof input !== "object") throw new Error("message.send: input must be an object");
  const { conversationName, text } = input as Partial<SendInput>;
  if (typeof conversationName !== "string" || !conversationName.trim()) {
    throw new Error("message.send: 'conversationName' must be a non-empty string");
  }
  if (typeof text !== "string" || !text.trim()) throw new Error("message.send: 'text' must be a non-empty string");
}

/**
 * Lets an agent post proactively into any channel or group conversation it's
 * a member of — the whole point being "reach out where you have access,"
 * not just "reply where you were addressed." Deliberately excludes 1:1 DMs:
 * those are structurally a single user<->employee pair (employees.conversation_id),
 * so "post into someone else's DM" doesn't fit the data model — only
 * channels/groups have the kind of multi-member "access" this is about.
 */
const messageSend: Tool<SendInput, SendOutput> = {
  name: "message.send",
  scope: "tool:messaging",
  effect: "write-internal",
  description:
    "Post a message as yourself into a channel or group conversation you're a member of (not a 1:1 DM). Use this to proactively reach out somewhere, not just reply where you were addressed.",
  validateInput: validateSendInput,
  async run(tc: ToolContext, input: SendInput): Promise<SendOutput> {
    // The gate is real access, not a name guess: only conversations this
    // employee is CURRENTLY a member of (channel_memberships, no
    // effective_to) are even candidates — matches this app's existing
    // "membership decides visibility" model everywhere else.
    const memberConvIds = await listMembershipsForEmployee(tc.ctx, tc.employeeId);
    const accessible = memberConvIds.length
      ? await tc.ctx.db
          .selectFrom("conversations")
          .where("id", "in", memberConvIds)
          .where("company_id", "=", tc.companyId)
          .where((eb) => eb.or([eb("kind", "=", "channel"), eb("is_group", "=", 1)]))
          .select(["id", "name"])
          .execute()
      : [];

    const cleanedName = input.conversationName.trim().replace(/^#/, "").toLowerCase();
    const match = accessible.find((c) => c.name.toLowerCase() === cleanedName);
    if (!match) {
      const names = accessible.map((c) => c.name).join(", ") || "(none)";
      throw new Error(
        `You don't have access to a channel or group named "${input.conversationName}". Conversations you can post in: ${names}`,
      );
    }

    const messageId = randomUUID();
    await mutate(tc.ctx, async (trx, emit) => {
      await trx
        .insertInto("messages")
        .values({
          id: messageId,
          conversation_id: match.id,
          role: "assistant",
          content: input.text,
          status: "complete",
          author_employee_id: tc.employeeId,
        })
        .execute();
      await emit({
        companyId: tc.companyId,
        type: "message.created",
        subjectId: messageId,
        actor: { kind: "employee", employeeId: tc.employeeId },
        payload: { conversationId: match.id, role: "assistant" },
        correlationId: tc.correlationId ?? null,
      });
    });

    // Let other members react/respond in the background, exactly like any
    // other message landing in that conversation — not awaited, so this tool
    // call (and the calling employee's own turn) doesn't hang on however
    // long that cascade takes; a human posting in Slack doesn't wait for
    // replies either. excludeEmployeeId keeps the poster from relevance-
    // gating against (and potentially replying to) its own post.
    //
    // The message still posts unconditionally above; the guard here only stops
    // us from AUTO-TRIGGERING yet another round of responders once a cascade has
    // gone too deep, which is the only thing that can run away — two agents each
    // calling message.send in response to the other, forever, with no user in
    // the loop (report T1.1). Past the ceiling the post simply lands quietly, as
    // if a human had typed it, rather than kicking off more turns.
    const depth = tc.cascadeDepth ?? 0;
    if (depth < MAX_CASCADE_DEPTH) {
      const noOpSink = { delta: () => {} };
      void runChannelResponders(tc.ctx, tc.companyId, match.id, messageId, input.text, noOpSink, {
        excludeEmployeeId: tc.employeeId,
        correlationId: tc.correlationId,
        cascadeDepth: depth + 1,
      }).catch((err) => {
        process.stderr.write(
          `[message.send tool] response cascade for conversation ${match.id} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
    } else {
      process.stderr.write(
        `[message.send tool] cascade depth ${depth} reached MAX_CASCADE_DEPTH (${MAX_CASCADE_DEPTH}) in conversation ${match.id}; posting without triggering further responders\n`,
      );
    }

    return { conversationName: match.name, messageId };
  },
};

export function registerMessagingTools(): void {
  registerTool(messageSend);
}
