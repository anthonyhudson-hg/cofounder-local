import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import "../domains/register";
import { createRuntimeContext, type RuntimeContext } from "../runtime/context";
import { openSqlite } from "../db/index";
import { runMigrations } from "../db/migrator";
import { BASELINE_SQL } from "../db/migrations";
import { createCompany } from "../domains/companies/service";
import { grantCapability } from "../tools/capability";
import { invokeTool } from "../tools/registry";
import { resolveApproval } from "../domains/approvals/service";
import { storeSecret, getSecret } from "../secrets/vault";
import { companyWorkspaceRoot } from "../connectors/workspace";
import { buildMemoryWriteToolDef } from "../providers/claudeMemoryTool";

function freshCtx(): RuntimeContext {
  const p = path.join(os.tmpdir(), `cf-test-${randomUUID()}.db`);
  process.env.COFOUNDER_DB_PATH = p;
  process.env.COFOUNDER_KEY_DIR = os.tmpdir();
  return createRuntimeContext();
}

test("migrator: fresh DB applies all migrations; existing DB baselines", () => {
  const fresh = openSqlite(path.join(os.tmpdir(), `cf-mig-${randomUUID()}.db`));
  const r1 = runMigrations(fresh);
  assert.ok(r1.applied.includes("0001_baseline"));
  assert.equal(r1.baselined.length, 0);
  fresh.close();

  // A genuine legacy Rust-migrated DB has the FULL baseline schema already, not just
  // a bare `companies` table — the migrator now verifies this before adopting it
  // (report §4.7), so the fixture here has to be realistic.
  const existing = openSqlite(path.join(os.tmpdir(), `cf-mig-${randomUUID()}.db`));
  existing.exec(BASELINE_SQL);
  const r2 = runMigrations(existing);
  assert.ok(r2.baselined.includes("0001_baseline"), "existing schema baselined, not re-run");
  existing.close();
});

test("migrator: refuses to adopt a database whose schema doesn't actually match the baseline (report §4.7)", () => {
  // A bare `companies` table used to be enough to fool the old "does companies
  // exist" check into silently recording a clean baseline for a schema actually
  // missing 15+ tables and several columns — undetected until a later "no such
  // table/column" error at query time.
  const incomplete = openSqlite(path.join(os.tmpdir(), `cf-mig-incomplete-${randomUUID()}.db`));
  incomplete.exec("CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  assert.throws(() => runMigrations(incomplete), /doesn't match what the runtime expects/);
  incomplete.close();
});

test("LEAKAGE INVARIANT: scoped repos + secrets never cross companies", async () => {
  const ctx = freshCtx();
  const a = await createCompany(ctx, { name: "Acme" }, { kind: "user" });
  const b = await createCompany(ctx, { name: "Globex" }, { kind: "user" });

  const aConvs = await ctx.repos.forCompany(a.id).listConversations();
  const bConvs = await ctx.repos.forCompany(b.id).listConversations();
  assert.ok(aConvs.length > 0 && bConvs.length > 0);
  // No conversation from A appears in B's scoped view and vice-versa.
  const aIds = new Set(aConvs.map((c) => c.id));
  assert.ok(bConvs.every((c) => !aIds.has(c.id)), "no cross-company conversation leakage");

  await storeSecret(ctx, a.id, "token", "A-secret");
  assert.equal(await getSecret(ctx, a.id, "token"), "A-secret");
  assert.equal(await getSecret(ctx, b.id, "token"), null, "secret not visible cross-company");

  await ctx.db.destroy();
});

test("event spine: company.create emits company.created with monotonic seq", async () => {
  const ctx = freshCtx();
  const events: { type: string; seq: number }[] = [];
  ctx.bus.subscribe((e) => events.push({ type: e.type, seq: e.seq }));
  await createCompany(ctx, { name: "A" }, { kind: "user" });
  await createCompany(ctx, { name: "B" }, { kind: "user" });
  const created = events.filter((e) => e.type === "company.created");
  assert.equal(created.length, 2);
  assert.ok(created[1].seq > created[0].seq, "seq is monotonic");
  await ctx.db.destroy();
});

test("capability gate: deny without grant, allow within, approval beyond", async () => {
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const tc = { ctx, companyId, employeeId: emp };

  await assert.rejects(() => invokeTool({ ctx, companyId, employeeId: "nobody" }, "memory.read", {}), /denied/);

  await grantCapability(ctx, companyId, emp, "tool:memory", "write-internal");
  const w = await invokeTool(tc, "memory.write", { key: "k", value: "v" });
  assert.equal(w.status, "ok");

  await grantCapability(ctx, companyId, emp, "tool:memory", "read"); // downgrade
  const gated = await invokeTool(tc, "memory.write", { key: "k2", value: "v2" });
  assert.equal(gated.status, "approval");
  await ctx.db.destroy();
});

test("capability gate: 'suggest' autonomy downgrades an otherwise-allowed write to approval (a real backstop, not just prompt guidance)", async () => {
  const { updateAgentProfileField } = await import("../domains/employees/service");
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const tc = { ctx, companyId, employeeId: emp };

  await grantCapability(ctx, companyId, emp, "tool:memory", "write-internal");
  // Baseline: no agent_profiles row yet (unconfigured) behaves exactly like
  // today, before this feature existed — the grant alone decides.
  const before = await invokeTool(tc, "memory.write", { key: "k", value: "v" });
  assert.equal(before.status, "ok");

  await updateAgentProfileField(ctx, emp, "autonomy_level", "suggest");
  const afterSuggest = await invokeTool(tc, "memory.write", { key: "k2", value: "v2" });
  assert.equal(afterSuggest.status, "approval", "suggest downgrades a write even though the grant covers it");

  // A pure read stays ungated even under "suggest" — asking permission for
  // every read would make the product unusable.
  const readResult = await invokeTool(tc, "memory.read", { key: "k" });
  assert.equal(readResult.status, "ok");

  // Reverting to "act-with-approval" restores the grant-only baseline.
  await updateAgentProfileField(ctx, emp, "autonomy_level", "act-with-approval");
  const afterRevert = await invokeTool(tc, "memory.write", { key: "k3", value: "v3" });
  assert.equal(afterRevert.status, "ok");

  await ctx.db.destroy();
});

test("capability grants: list/grant/revoke round-trip, cross-company leakage is rejected, revoke falls back to deny, and each mutation emits an event", async () => {
  const { listGrants, revokeCapability } = await import("../tools/capability");
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const { id: otherCompanyId } = await createCompany(ctx, { name: "B" }, { kind: "user" });

  assert.deepEqual(await listGrants(ctx, companyId, emp), [], "no grants yet");

  await grantCapability(ctx, companyId, emp, "tool:memory", "write-internal");
  assert.deepEqual(await listGrants(ctx, companyId, emp), [{ scope: "tool:memory", maxEffect: "write-internal" }]);

  // Re-granting the same scope updates in place, not a duplicate row.
  await grantCapability(ctx, companyId, emp, "tool:memory", "read");
  assert.deepEqual(await listGrants(ctx, companyId, emp), [{ scope: "tool:memory", maxEffect: "read" }]);

  // A grant/revoke/list attempt against the WRONG company for this employee
  // is rejected outright, not silently scoped/ignored (leakage-class check).
  await assert.rejects(() => listGrants(ctx, otherCompanyId, emp), /not in company/);
  await assert.rejects(() => grantCapability(ctx, otherCompanyId, emp, "tool:memory", "write-internal"), /not in company/);
  await assert.rejects(() => revokeCapability(ctx, otherCompanyId, emp, "tool:memory"), /not in company/);
  // Confirm the rejected cross-company grant attempt didn't actually write anything.
  assert.deepEqual(await listGrants(ctx, companyId, emp), [{ scope: "tool:memory", maxEffect: "read" }]);

  await revokeCapability(ctx, companyId, emp, "tool:memory");
  assert.deepEqual(await listGrants(ctx, companyId, emp), [], "revoke hard-deletes the row");
  // Post-revoke, invokeTool falls back to a real deny (no row), not approval,
  // and never silently no-ops.
  await assert.rejects(
    () => invokeTool({ ctx, companyId, employeeId: emp }, "memory.write", { key: "k", value: "v" }),
    /denied/,
  );

  const eventRows = await ctx.db
    .selectFrom("events")
    .where("company_id", "=", companyId)
    .where("type", "in", ["capability.granted", "capability.revoked"])
    .orderBy("seq")
    .selectAll()
    .execute();
  assert.deepEqual(
    eventRows.map((r) => r.type),
    ["capability.granted", "capability.granted", "capability.revoked"],
  );

  await ctx.db.destroy();
});

test("listScopes: reflects exactly the tools registered today (tool:memory, connector:github)", async () => {
  const { listScopes } = await import("../tools/registry");
  const scopes = listScopes();
  const byScope = Object.fromEntries(scopes.map((s) => [s.scope, s]));
  assert.equal(byScope["tool:memory"].maxEffect, "write-internal", "memory.write outranks memory.read");
  assert.deepEqual(new Set(byScope["tool:memory"].tools), new Set(["memory.write", "memory.read"]));
  assert.equal(byScope["connector:github"].maxEffect, "external-write");
});

test("agent profile: defaults, update, JSON expertise round-trip, and field/value validation", async () => {
  const { getAgentProfile, updateAgentProfileField } = await import("../domains/employees/service");
  const ctx = freshCtx();
  const { cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });

  // No row yet — defaults match today's unconfigured behavior, not the DB
  // column's own "suggest" default (which only applies once a row exists).
  const initial = await getAgentProfile(ctx, emp);
  assert.deepEqual(initial, { personality: "", communicationStyle: "", expertise: [], autonomyLevel: "act-with-approval" });

  await updateAgentProfileField(ctx, emp, "personality", "Blunt, dry humor, gets to the point fast.");
  await updateAgentProfileField(ctx, emp, "communication_style", "Short messages, bullet points over prose.");
  await updateAgentProfileField(ctx, emp, "expertise", JSON.stringify(["fundraising", "hiring"]));
  await updateAgentProfileField(ctx, emp, "autonomy_level", "autonomous");

  const updated = await getAgentProfile(ctx, emp);
  assert.equal(updated.personality, "Blunt, dry humor, gets to the point fast.");
  assert.equal(updated.communicationStyle, "Short messages, bullet points over prose.");
  assert.deepEqual(updated.expertise, ["fundraising", "hiring"]);
  assert.equal(updated.autonomyLevel, "autonomous");

  await assert.rejects(() => updateAgentProfileField(ctx, emp, "not_a_real_field", "x"), /invalid agent profile field/);
  await assert.rejects(() => updateAgentProfileField(ctx, emp, "autonomy_level", "yolo"), /invalid autonomy level/);
  await assert.rejects(() => updateAgentProfileField(ctx, emp, "expertise", "not json"), /JSON-encoded string array/);
  await assert.rejects(() => updateAgentProfileField(ctx, "nonexistent-employee", "personality", "x"), /employee not found/);

  await ctx.db.destroy();
});

test("agent profile: personality/communication-style/expertise/autonomy appear in the composed system prompt", async () => {
  const { composeSystemPrompt } = await import("../runtime/promptBuilder");
  const withProfile = composeSystemPrompt(
    "",
    "",
    "You are Ada, Engineer in the Eng department. You report to Founder.",
    { mission: "", preamble: "", additional_details: "" },
    [],
    { personality: "Enthusiastic and curious.", communicationStyle: "Casual, lots of emoji.", expertise: ["rust", "distributed systems"], autonomyLevel: "autonomous" },
  );
  assert.match(withProfile, /Personality: Enthusiastic and curious\./);
  assert.match(withProfile, /Communication style: Casual, lots of emoji\./);
  assert.match(withProfile, /Areas of expertise: rust, distributed systems/);
  assert.match(withProfile, /Autonomy level: autonomous\./);

  // Omitting the profile entirely (no 6th arg) must not blow up or leave stray
  // "undefined" text in the prompt — every other caller of this function
  // predates this feature.
  const withoutProfile = composeSystemPrompt("", "", "identity", { mission: "", preamble: "", additional_details: "" }, []);
  assert.ok(!withoutProfile.includes("undefined"));
  assert.ok(!withoutProfile.includes("Autonomy level"));
});

test("approval round-trip: resolve approved re-runs the gated action", async () => {
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  await grantCapability(ctx, companyId, emp, "tool:memory", "read");
  const tc = { ctx, companyId, employeeId: emp };
  const gated = await invokeTool(tc, "memory.write", { key: "gk", value: "gv" });
  assert.equal(gated.status, "approval");
  if (gated.status !== "approval") return;
  const resolved = await resolveApproval(ctx, gated.approvalId, "approved", "user");
  const { runToolApproved } = await import("../tools/registry");
  await runToolApproved({ ctx, companyId, employeeId: resolved.employeeId! }, resolved.action, resolved.detail);
  const read = await invokeTool(tc, "memory.read", { key: "gk" });
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.equal((read.output as { entries: { value: string }[] }).entries[0].value, "gv");
  await ctx.db.destroy();
});

test("approvals: listApprovals defaults to pending, is company-scoped, and status filters/history work", async () => {
  const { listApprovals } = await import("../domains/approvals/service");
  const ctx = freshCtx();
  const { id: companyA, cosEmployeeId: empA } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const { id: companyB, cosEmployeeId: empB } = await createCompany(ctx, { name: "B" }, { kind: "user" });

  await grantCapability(ctx, companyA, empA, "tool:memory", "read");
  await grantCapability(ctx, companyB, empB, "tool:memory", "read");
  const gatedA = await invokeTool({ ctx, companyId: companyA, employeeId: empA }, "memory.write", { key: "k", value: "v" });
  const gatedB = await invokeTool({ ctx, companyId: companyB, employeeId: empB }, "memory.write", { key: "k", value: "v" });
  assert.equal(gatedA.status, "approval");
  assert.equal(gatedB.status, "approval");
  if (gatedA.status !== "approval" || gatedB.status !== "approval") return;

  // Company-scoped: A's list never contains B's request or vice versa.
  const pendingA = await listApprovals(ctx, companyA);
  assert.equal(pendingA.length, 1);
  assert.equal(pendingA[0].id, gatedA.approvalId);
  assert.equal(pendingA[0].status, "pending");
  assert.equal(pendingA[0].employeeId, empA);

  await resolveApproval(ctx, gatedA.approvalId, "approved", "user");

  // Default (pending-only) no longer includes the now-resolved request.
  const pendingAfter = await listApprovals(ctx, companyA);
  assert.equal(pendingAfter.length, 0);

  // Full history (status: null) still shows it, now approved.
  const historyA = await listApprovals(ctx, companyA, null);
  assert.equal(historyA.length, 1);
  assert.equal(historyA[0].status, "approved");
  assert.equal(historyA[0].resolvedBy, "user");

  await ctx.db.destroy();
});

test("audit log: listEvents is most-recent-first, company-scoped, and paginates backwards via beforeSeq", async () => {
  const { listEvents } = await import("../domains/audit/service");
  const ctx = freshCtx();
  const { id: companyA } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const { id: companyB } = await createCompany(ctx, { name: "B" }, { kind: "user" });

  // createCompany itself already emits company.created + seedDefaults events
  // for each company — enough real history to paginate through without
  // fabricating events by hand.
  const allA = await listEvents(ctx, companyA, { limit: 500 });
  assert.ok(allA.length >= 2, "company A has real seeded event history");

  const allB = await listEvents(ctx, companyB, { limit: 500 });
  const aIds = new Set(allA.map((e) => e.id));
  assert.ok(allB.every((e) => !aIds.has(e.id)), "no cross-company event leakage");

  // Most-recent-first: seq strictly decreasing.
  for (let i = 1; i < allA.length; i++) {
    assert.ok(allA[i - 1].seq > allA[i].seq, "events are ordered most-recent-first by seq");
  }

  // Pagination: paging with beforeSeq set to the oldest-seen seq from a first
  // page reproduces the rest of the list with no overlap and no gap.
  const firstPage = await listEvents(ctx, companyA, { limit: 1 });
  assert.equal(firstPage.length, 1);
  const secondPage = await listEvents(ctx, companyA, { beforeSeq: firstPage[0].seq, limit: 500 });
  assert.deepEqual(
    [firstPage[0].seq, ...secondPage.map((e) => e.seq)],
    allA.map((e) => e.seq),
    "first page + beforeSeq-paginated rest reconstructs the full list",
  );

  // actor/payload are parsed back out of their JSON columns, not left as raw strings.
  assert.equal(typeof allA[0].actor, "object");
  assert.equal(typeof allA[0].payload, "object");

  await ctx.db.destroy();
});

test("chat turn loop (runtime): streams, persists messages, resumes session", async () => {
  const { sendMessage } = await import("../domains/conversations/service");
  const ctx = freshCtx();
  const { id: companyId } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const cos = await ctx.db
    .selectFrom("employees")
    .where("company_id", "=", companyId)
    .select(["id", "conversation_id"])
    .executeTakeFirstOrThrow();

  // fake provider: streams two text chunks plus a tool-activity start/end pair,
  // returns a session id + usage
  const fakeProvider = {
    async *runTurn(opts: { prompt: string }) {
      yield { kind: "text", text: "Hello, " };
      yield { kind: "tool", name: "memory_write", phase: "start" };
      yield { kind: "tool", name: "memory_write", phase: "end" };
      yield { kind: "text", text: `you said: ${opts.prompt}` };
      return {
        sessionId: "sess-123",
        success: true,
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        totalCostUsd: 0.001,
      };
    },
  };

  const allDeltas: { channel: string; data: unknown }[] = [];
  const sink = { delta: (channel: string, data: unknown) => allDeltas.push({ channel, data }) };

  const events: string[] = [];
  ctx.bus.subscribe((e) => events.push(e.type));

  const res = await sendMessage(
    ctx,
    { companyId, conversationId: cos.conversation_id, text: "ping" },
    sink,
    fakeProvider as never,
  );

  // streamed both text chunks
  const textDeltas = allDeltas.filter((d) => d.channel === "text").map((d) => (d.data as { text: string }).text);
  assert.deepEqual(textDeltas, ["Hello, ", "you said: ping"]);

  // tool-activity chunks reach the client on their own "tool" delta channel,
  // not mixed into the text stream and not silently dropped.
  const toolDeltas = allDeltas
    .filter((d) => d.channel === "tool")
    .map((d) => d.data as { messageId: string; name: string; phase: string });
  assert.deepEqual(toolDeltas, [
    { messageId: res.assistantMessageId, name: "memory_write", phase: "start" },
    { messageId: res.assistantMessageId, name: "memory_write", phase: "end" },
  ]);

  // the debug-payload "meta" delta fires exactly once, before any text delta, so
  // an in-flight message's debug info is available immediately rather than only
  // after the whole turn (and the client's post-send reload()) completes.
  const metaIndex = allDeltas.findIndex((d) => d.channel === "meta");
  const firstTextIndex = allDeltas.findIndex((d) => d.channel === "text");
  assert.ok(metaIndex !== -1, "expected a meta delta");
  assert.ok(metaIndex < firstTextIndex, "meta delta must precede text deltas");
  const metaPayload = allDeltas[metaIndex].data as { messageId: string; debugPayload: string };
  assert.equal(metaPayload.messageId, res.assistantMessageId);
  const parsedDebug = JSON.parse(metaPayload.debugPayload);
  assert.equal(parsedDebug.prompt, "ping");

  // persisted user + assistant messages (on top of the seeded CoS greeting)
  const msgs = await ctx.db
    .selectFrom("messages")
    .where("conversation_id", "=", cos.conversation_id)
    .selectAll()
    .orderBy("created_at")
    .execute();
  assert.equal(msgs.length, 3); // greeting + user + assistant
  assert.ok(msgs.some((m) => m.id === res.userMessageId));
  const assistant = msgs.find((m) => m.id === res.assistantMessageId)!;
  assert.equal(assistant.content, "Hello, you said: ping");
  assert.equal(assistant.status, "complete");
  assert.equal(assistant.output_tokens, 5);

  // session resumed on the conversation, provider recorded
  const conv = await ctx.db.selectFrom("conversations").where("id", "=", cos.conversation_id).selectAll().executeTakeFirstOrThrow();
  assert.equal(conv.session_id, "sess-123");
  assert.equal(conv.session_provider, "claude");

  // full event trace
  assert.ok(events.filter((e) => e === "message.created").length === 2);
  assert.ok(events.includes("message.completed"));

  await ctx.db.destroy();
});

test("sendMessage (DM, full cutover parity): reply-threading persists thread_root_id, and a trailing [[react:emoji]] is stripped from the reply + persisted as a reaction on the user's message", async () => {
  const { sendMessage } = await import("../domains/conversations/service");
  const ctx = freshCtx();
  const { id: companyId } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const cos = await ctx.db
    .selectFrom("employees")
    .where("company_id", "=", companyId)
    .select(["id", "conversation_id"])
    .executeTakeFirstOrThrow();

  const provider = {
    async *runTurn() {
      yield { kind: "text", text: "Sounds good!\n[[react:👍]]" };
      return {
        sessionId: "sess-thread",
        success: true,
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        totalCostUsd: 0,
      };
    },
  };
  const sink = { delta: () => {} };

  const root = await sendMessage(ctx, { companyId, conversationId: cos.conversation_id, text: "root" }, sink, provider as never);
  const reply = await sendMessage(
    ctx,
    { companyId, conversationId: cos.conversation_id, text: "thanks", replyTo: { messageId: root.userMessageId, threadRootId: null } },
    sink,
    provider as never,
  );

  assert.equal(reply.success, true);
  assert.deepEqual(reply.reaction, { messageId: reply.userMessageId, emoji: "👍" });

  const userMsg = await ctx.db.selectFrom("messages").where("id", "=", reply.userMessageId).selectAll().executeTakeFirstOrThrow();
  assert.equal(userMsg.thread_root_id, root.userMessageId);
  assert.equal(userMsg.reply_to_message_id, root.userMessageId);

  const assistantMsg = await ctx.db.selectFrom("messages").where("id", "=", reply.assistantMessageId).selectAll().executeTakeFirstOrThrow();
  assert.equal(assistantMsg.content, "Sounds good!");
  assert.equal(assistantMsg.thread_root_id, root.userMessageId);
  assert.equal(assistantMsg.reply_to_message_id, null);

  const reactions = await ctx.db.selectFrom("reactions").where("message_id", "=", reply.userMessageId).selectAll().execute();
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].emoji, "👍");
  assert.equal(reactions[0].reactor, cos.id);

  await ctx.db.destroy();
});

test("sendMessage (DM): a provider throwing mid-turn is caught and persisted as an errored message instead of rejecting the command", async () => {
  const { sendMessage } = await import("../domains/conversations/service");
  const ctx = freshCtx();
  const { id: companyId } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const cos = await ctx.db
    .selectFrom("employees")
    .where("company_id", "=", companyId)
    .select(["id", "conversation_id"])
    .executeTakeFirstOrThrow();

  const provider = {
    // eslint-disable-next-line require-yield -- intentionally throws before ever yielding
    async *runTurn() {
      throw new Error("subprocess crashed");
    },
  };
  const sink = { delta: () => {} };

  const res = await sendMessage(ctx, { companyId, conversationId: cos.conversation_id, text: "hi" }, sink, provider as never);
  assert.equal(res.success, false);
  assert.match(res.errorMessage ?? "", /subprocess crashed/);

  const assistantMsg = await ctx.db.selectFrom("messages").where("id", "=", res.assistantMessageId).selectAll().executeTakeFirstOrThrow();
  assert.equal(assistantMsg.status, "error");
  assert.match(assistantMsg.error_message ?? "", /subprocess crashed/);

  await ctx.db.destroy();
});

test("sendChannelMessage (full cutover — new server-side orchestration, no client equivalent existed): @mention bypasses relevance gate and posts a control-block-parsed reply; a non-mentioned member is relevance-gated out", async () => {
  const { sendChannelMessage } = await import("../domains/conversations/service");
  const { createEmployee, toggleMembership } = await import("../domains/employees/service");
  const ctx = freshCtx();
  const { id: companyId, generalConversationId } = await createCompany(ctx, { name: "A" }, { kind: "user" });

  const alice = await createEmployee(ctx, { companyId, name: "Alice" });
  const bob = await createEmployee(ctx, { companyId, name: "Bob" });
  await toggleMembership(ctx, generalConversationId, alice.employeeId);
  await toggleMembership(ctx, generalConversationId, bob.employeeId);

  const relevanceCalls: string[] = [];
  const relevanceProvider = {
    async *runTurn(opts: { prompt: string }) {
      relevanceCalls.push(opts.prompt);
      yield { kind: "text", text: '{"respond": false, "reason": "not relevant"}' };
      return { sessionId: null, success: true, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0 };
    },
  };
  const responderProvider = {
    async *runTurn() {
      yield {
        kind: "text",
        text: '```control\n{"respondsWithText": true, "replyToMessageId": null, "threadRootId": null, "reactions": []}\n```\nOn it!',
      };
      return {
        sessionId: "sess-chan",
        success: true,
        usage: { inputTokens: 2, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        totalCostUsd: 0,
      };
    },
  };

  const result = await sendChannelMessage(
    ctx,
    { companyId, conversationId: generalConversationId, text: "@Alice can you take a look?" },
    relevanceProvider as never,
    responderProvider as never,
  );

  // Once ANY member is @mentioned, every member's decision is made locally —
  // mentioned members always respond, everyone else is skipped — with no
  // relevance-check model call for anyone (mirrors useChannel.ts's sendToMembers).
  assert.equal(relevanceCalls.length, 0);

  const aliceOutcome = result.responders.find((r) => r.employeeId === alice.employeeId);
  const bobOutcome = result.responders.find((r) => r.employeeId === bob.employeeId);
  assert.equal(aliceOutcome?.respond, true);
  assert.equal(aliceOutcome?.posted, true);
  assert.equal(bobOutcome?.respond, false);
  assert.equal(bobOutcome?.posted, false);

  const posted = await ctx.db
    .selectFrom("messages")
    .where("conversation_id", "=", generalConversationId)
    .where("author_employee_id", "=", alice.employeeId)
    .selectAll()
    .execute();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].content, "On it!");

  // #general already has the seeded Chief of Staff as a third member — every
  // member (including it) gets a relevance_checks row, mentioned or not.
  const relevanceRows = await ctx.db.selectFrom("relevance_checks").where("message_id", "=", result.userMessageId).selectAll().execute();
  assert.equal(relevanceRows.length, 3);

  const session = await ctx.db.selectFrom("agent_sessions").where("conversation_id", "=", generalConversationId).where("employee_id", "=", alice.employeeId).selectAll().executeTakeFirst();
  assert.equal(session?.session_id, "sess-chan");

  await ctx.db.destroy();
});

test("PROOF-OF-LIFE: github connector commit through gate + approval + vault", async () => {
  const { execFileSync } = await import("node:child_process");
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });

  // a throwaway git repo to commit into — must live inside the company's sandboxed
  // workspace root; commit_push now rejects any path outside it (report §2.2).
  const repo = path.join(companyWorkspaceRoot(companyId), `cf-repo-${randomUUID()}`);
  fs.mkdirSync(repo, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "a@b.c"]);
  g(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# hello");

  // PAT lives in the encrypted vault (proves connector<->vault path)
  await storeSecret(ctx, companyId, "github_pat", "ghp_dummy");

  // Without a grant, an external-write is denied.
  await assert.rejects(
    () => invokeTool({ ctx, companyId, employeeId: emp }, "github.commit_push", { cwd: repo, message: "x" }),
    /denied/,
  );

  // Grant external-read only -> the write must be human-approved.
  await grantCapability(ctx, companyId, emp, "connector:github", "external-read");
  const gated = await invokeTool({ ctx, companyId, employeeId: emp }, "github.commit_push", {
    cwd: repo,
    message: "agent: initial commit",
  });
  assert.equal(gated.status, "approval");
  if (gated.status !== "approval") return;

  // Human approves -> the commit actually happens.
  const resolved = await resolveApproval(ctx, gated.approvalId, "approved", "user");
  const { runToolApproved } = await import("../tools/registry");
  const out = (await runToolApproved(
    { ctx, companyId, employeeId: resolved.employeeId! },
    resolved.action,
    resolved.detail,
  )) as { committed: boolean; sha: string };
  assert.equal(out.committed, true);
  assert.match(out.sha, /^[0-9a-f]{40}$/);
  // the commit is real
  const log = g(["log", "--oneline"]).trim();
  assert.match(log, /agent: initial commit/);

  await ctx.db.destroy();
});

test("github connector: a cwd outside the company workspace is rejected (report §2.2)", async () => {
  const { execFileSync } = await import("node:child_process");
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  await grantCapability(ctx, companyId, emp, "connector:github", "external-write");

  // Anywhere outside this company's own workspace root must be refused, however
  // "real" a git repo it is — this is the exact exfiltration path §2.2 flagged.
  const outsideRepo = path.join(os.tmpdir(), `cf-outside-repo-${randomUUID()}`);
  fs.mkdirSync(outsideRepo, { recursive: true });
  const g = (args: string[]) => execFileSync("git", args, { cwd: outsideRepo, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "a@b.c"]);
  g(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(outsideRepo, "secret.txt"), "shouldn't be touched");

  await assert.rejects(
    () => invokeTool({ ctx, companyId, employeeId: emp }, "github.commit_push", { cwd: outsideRepo, message: "x" }),
    /escapes the company workspace/,
  );
  // A traversal attempt against the workspace root must be refused too.
  await assert.rejects(
    () =>
      invokeTool(
        { ctx, companyId, employeeId: emp },
        "github.commit_push",
        { cwd: "../../../etc", message: "x" },
      ),
    /escapes the company workspace/,
  );

  await ctx.db.destroy();
});

test("dispatch: validateInbound rejects malformed messages before dispatch() ever sees them (report §1.4/§3.3)", async () => {
  const { validateInbound, dispatch } = await import("../runtime/dispatch");
  const ctx = freshCtx();

  // Every test before this one exercised domain services directly, bypassing
  // dispatch()/the wire-protocol validation boundary entirely — the malformed-id
  // path that caused a client to hang forever (report §3.3) was completely
  // unexercised. These assert the actual boundary function directly.
  assert.equal(validateInbound({ kind: "query", type: "ping", companyId: null, payload: {} }), false, "missing id");
  assert.equal(validateInbound({ kind: "query", id: "x", companyId: null, payload: {} }), false, "missing type");
  assert.equal(
    validateInbound({ kind: "bogus", id: "x", type: "ping", companyId: null, payload: {} }),
    false,
    "wrong kind",
  );
  assert.equal(
    validateInbound({ kind: "query", id: "x", type: "ping", companyId: 123, payload: {} }),
    false,
    "companyId wrong type",
  );
  assert.equal(
    validateInbound({ kind: "query", id: "x", type: "ping", companyId: null, payload: {} }),
    true,
    "well-shaped message passes",
  );

  // A well-shaped but unregistered type fails cleanly through dispatch — a normal
  // rejected promise with a clear message, not a crash or a hang.
  await assert.rejects(
    () =>
      dispatch(
        ctx,
        { kind: "query", id: "x", type: "not-a-real-handler", companyId: null, payload: {} } as never,
        { delta: () => {} },
      ),
    /no handler for query:not-a-real-handler/,
  );

  await ctx.db.destroy();
});

test("claudeMemoryTool: memory_write MCP handler goes through the real capability gate (deny/approval/allow)", async () => {
  const ctx = freshCtx();
  const { id: companyId, cosEmployeeId: emp } = await createCompany(ctx, { name: "Acme" }, { kind: "user" });

  // Stub of the SDK's own tool() — we only need it to hand back the handler
  // so we can drive it directly, without touching the real Claude SDK.
  const stubToolFn = ((
    _name: string,
    _desc: string,
    _schema: unknown,
    handler: (args: unknown, extra: unknown) => Promise<unknown>,
  ) => ({ handler })) as unknown as Parameters<typeof buildMemoryWriteToolDef>[0];

  const def = buildMemoryWriteToolDef(stubToolFn, { ctx, companyId, employeeId: emp });

  // No grant at all -> capability denied, surfaced as an error-flagged result,
  // not an uncaught throw (an MCP handler throwing would crash the SDK's turn).
  const denied = await def.handler({ key: "k1", value: "v1", kind: undefined }, {});
  assert.equal(denied.isError, true);
  assert.match((denied.content[0] as { text: string }).text, /Could not save this memory/);
  assert.match((denied.content[0] as { text: string }).text, /capability denied/);

  // Grant capped at "read" -> write-internal exceeds it -> queued for approval,
  // not silently executed and not a hard error.
  await grantCapability(ctx, companyId, emp, "tool:memory", "read");
  const pending = await def.handler({ key: "k2", value: "v2", kind: undefined }, {});
  assert.equal(pending.isError, true);
  assert.match((pending.content[0] as { text: string }).text, /queued/);
  assert.match((pending.content[0] as { text: string }).text, /has NOT happened yet/);

  // Grant covers write-internal -> actually executes, same as the direct
  // tool.invoke IPC path.
  await grantCapability(ctx, companyId, emp, "tool:memory", "write-internal");
  const ok = await def.handler({ key: "k3", value: "v3", kind: undefined }, {});
  assert.equal(ok.isError, undefined);
  assert.equal((ok.content[0] as { text: string }).text, "Saved.");
  const row = await ctx.db.selectFrom("agent_memory").where("mem_key", "=", "k3").selectAll().executeTakeFirstOrThrow();
  assert.equal(row.value, "v3");

  await ctx.db.destroy();
});

// keep tmp dir from filling forever in CI
test.after?.(() => {
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith("cf-test-") || f.startsWith("cf-mig-")) {
        try {
          fs.unlinkSync(path.join(os.tmpdir(), f));
        } catch {
          // best-effort cleanup only — a locked/already-removed file is fine to skip
        }
      }
    }
  } catch {
    // best-effort cleanup only — a transient tmpdir read failure isn't test-fatal
  }
});
