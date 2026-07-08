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

test("chat turn loop (runtime): streams, persists messages, resumes session", async () => {
  const { sendMessage } = await import("../domains/conversations/service");
  const ctx = freshCtx();
  const { id: companyId } = await createCompany(ctx, { name: "A" }, { kind: "user" });
  const cos = await ctx.db
    .selectFrom("employees")
    .where("company_id", "=", companyId)
    .select(["id", "conversation_id"])
    .executeTakeFirstOrThrow();

  // fake provider: streams two chunks, returns a session id + usage
  const fakeProvider = {
    async *runTurn(opts: { prompt: string }) {
      yield "Hello, ";
      yield `you said: ${opts.prompt}`;
      return {
        sessionId: "sess-123",
        success: true,
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        totalCostUsd: 0.001,
      };
    },
  };

  const deltas: string[] = [];
  const sink = { delta: (_c: string, d: unknown) => deltas.push((d as { text: string }).text) };

  const events: string[] = [];
  ctx.bus.subscribe((e) => events.push(e.type));

  const res = await sendMessage(
    ctx,
    { companyId, conversationId: cos.conversation_id, text: "ping" },
    sink,
    fakeProvider as never,
  );

  // streamed both chunks
  assert.deepEqual(deltas, ["Hello, ", "you said: ping"]);

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
