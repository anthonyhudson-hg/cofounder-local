import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";
import { registerTool } from "../../tools/registry";
import type { Tool, ToolContext } from "../../tools/types";
import { resolveQuestion } from "./registry";
import {
  validateAnswerAgainstSpec,
  validateRawQuestionSpec,
  type AnswerPayload,
  type QuestionSpec,
  type SubAnswer,
} from "./spec";

/** A question row with `spec`/`answers` parsed, for the client + debug view. */
export interface QuestionRecord {
  id: string;
  conversation_id: string;
  asking_message_id: string | null;
  employee_id: string;
  spec: QuestionSpec;
  answers: AnswerPayload | null;
  status: "pending" | "answered" | "cancelled";
  created_at: string;
  resolved_at: string | null;
}

/**
 * Persists a pending question + emits question.asked, atomically. Returns the
 * new question id. The blocking wait (until the user answers) lives in the MCP
 * tool handler (providers/claudeAskQuestionTool.ts), kept separate from this
 * write so the DB/event append stays a short transaction and the wait is pure
 * control-flow.
 */
export async function askQuestion(tc: ToolContext, spec: QuestionSpec): Promise<string> {
  if (!tc.conversationId) throw new Error("askQuestion: conversationId is required");
  const id = randomUUID();
  await mutate(tc.ctx, async (trx, emit) => {
    await trx
      .insertInto("questions")
      .values({
        id,
        company_id: tc.companyId,
        conversation_id: tc.conversationId!,
        asking_message_id: tc.askingMessageId ?? null,
        employee_id: tc.employeeId,
        spec: JSON.stringify(spec),
        correlation_id: tc.correlationId ?? null,
      })
      .execute();
    await emit({
      companyId: tc.companyId,
      type: "question.asked",
      subjectId: id,
      actor: { kind: "employee", employeeId: tc.employeeId },
      payload: { conversationId: tc.conversationId, askingMessageId: tc.askingMessageId ?? null },
      correlationId: tc.correlationId ?? null,
    });
  });
  return id;
}

/**
 * Records the user's answer (validated against the stored spec) and resolves
 * the blocked tool handler so the model continues its turn. Persist-first (like
 * resolveApproval): a crash between the commit and resolveQuestion loses only
 * the live continuation, never the recorded answer. `resolved: false` means no
 * handler was waiting — the question was orphaned by a restart; the answer is
 * still saved for history, but the agent is no longer waiting to continue.
 */
export async function answerQuestion(
  ctx: RuntimeContext,
  companyId: string,
  questionId: string,
  answers: Record<string, SubAnswer>,
): Promise<{ resolved: boolean }> {
  const payload: AnswerPayload = { answers, answeredAt: new Date().toISOString() };
  await mutate(ctx, async (trx, emit) => {
    const row = await trx
      .selectFrom("questions")
      .where("id", "=", questionId)
      .where("company_id", "=", companyId)
      .selectAll()
      .executeTakeFirstOrThrow();
    if (row.status !== "pending") throw new Error(`question ${questionId} already ${row.status}`);
    const spec = JSON.parse(row.spec) as QuestionSpec;
    validateAnswerAgainstSpec(spec, payload);
    await trx
      .updateTable("questions")
      .set({ answers: JSON.stringify(payload), status: "answered", resolved_at: new Date().toISOString() })
      .where("id", "=", questionId)
      .execute();
    await emit({
      companyId,
      type: "question.answered",
      subjectId: questionId,
      actor: { kind: "user" },
      payload: { conversationId: row.conversation_id },
    });
  });
  const resolved = resolveQuestion(questionId, payload);
  return { resolved };
}

/**
 * Marks a pending question cancelled (turn stopped / abandoned) and emits
 * question.cancelled. Idempotent: a no-op if the question is already resolved.
 */
export async function cancelQuestion(ctx: RuntimeContext, questionId: string): Promise<void> {
  await mutate(ctx, async (trx, emit) => {
    const row = await trx
      .selectFrom("questions")
      .where("id", "=", questionId)
      .select(["status", "company_id", "conversation_id"])
      .executeTakeFirst();
    if (!row || row.status !== "pending") return;
    await trx
      .updateTable("questions")
      .set({ status: "cancelled", resolved_at: new Date().toISOString() })
      .where("id", "=", questionId)
      .execute();
    await emit({
      companyId: row.company_id,
      type: "question.cancelled",
      subjectId: questionId,
      actor: { kind: "system" },
      payload: { conversationId: row.conversation_id },
    });
  });
}

/** Lists a conversation's questions (spec/answers parsed), oldest first. The
 *  in-chat card renders `status: "pending"`; the debug view requests all. */
export async function listQuestions(
  ctx: RuntimeContext,
  conversationId: string,
  status?: "pending" | "answered" | "cancelled" | null,
): Promise<QuestionRecord[]> {
  let q = ctx.db.selectFrom("questions").where("conversation_id", "=", conversationId).selectAll();
  if (status) q = q.where("status", "=", status);
  const rows = await q.orderBy("created_at").execute();
  return rows.map((r) => ({
    id: r.id,
    conversation_id: r.conversation_id,
    asking_message_id: r.asking_message_id,
    employee_id: r.employee_id,
    spec: JSON.parse(r.spec) as QuestionSpec,
    answers: r.answers ? (JSON.parse(r.answers) as AnswerPayload) : null,
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
  }));
}

/**
 * Registered only so `tool:ask-user` shows up in the permissions UI's
 * listScopes() and the effect model stays coherent. The real logic lives in the
 * MCP definition (providers/claudeAskQuestionTool.ts) because it must block on
 * the SDK's own await — it does NOT flow through invokeTool (asking a human is
 * `effect: "none"`, never gated or approved). `run` is intentionally never
 * called; it throws loudly if some future code path tries.
 */
const askUserQuestion: Tool = {
  name: "question.ask",
  scope: "tool:ask-user",
  effect: "none",
  description: "Pause and ask the user up to 4 structured questions, then wait for their answer.",
  validateInput: validateRawQuestionSpec,
  async run() {
    throw new Error("question.ask runs via its MCP definition, not invokeTool");
  },
};

export function registerQuestionTools(): void {
  registerTool(askUserQuestion);
}
