import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../runtime/context";
import { mutate } from "../../runtime/unitOfWork";

export interface ApprovalRequest {
  companyId: string;
  employeeId: string;
  action: string;
  detail: unknown;
  correlationId?: string | null;
}

export interface ApprovalListItem {
  id: string;
  employeeId: string | null;
  action: string;
  detail: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** Lists a company's approval requests, most recent first. Defaults to pending
 *  only (the actionable set); pass `status: null` for the full history. */
export async function listApprovals(
  ctx: RuntimeContext,
  companyId: string,
  status: "pending" | "approved" | "denied" | "expired" | null = "pending",
): Promise<ApprovalListItem[]> {
  let q = ctx.db.selectFrom("approvals").where("company_id", "=", companyId).selectAll();
  if (status) q = q.where("status", "=", status);
  const rows = await q.orderBy("requested_at", "desc").execute();
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    action: r.action,
    detail: JSON.parse(r.detail),
    status: r.status,
    requestedAt: r.requested_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
  }));
}

/** Records a pending human-approval request and emits approval.requested. */
export async function requestApproval(ctx: RuntimeContext, req: ApprovalRequest): Promise<string> {
  const id = randomUUID();
  await mutate(ctx, async (trx, emit) => {
    await trx
      .insertInto("approvals")
      .values({
        id,
        company_id: req.companyId,
        employee_id: req.employeeId,
        action: req.action,
        detail: JSON.stringify(req.detail ?? {}),
      })
      .execute();
    await emit({
      companyId: req.companyId,
      type: "approval.requested",
      subjectId: id,
      actor: { kind: "employee", employeeId: req.employeeId },
      payload: { action: req.action, detail: req.detail },
      correlationId: req.correlationId ?? null,
    });
  });
  return id;
}

/** Resolves an approval (approve/deny) and emits approval.resolved. */
export async function resolveApproval(
  ctx: RuntimeContext,
  approvalId: string,
  decision: "approved" | "denied",
  resolvedBy: string,
): Promise<{ companyId: string; action: string; detail: unknown; employeeId: string | null }> {
  return mutate(ctx, async (trx, emit) => {
    const row = await trx
      .selectFrom("approvals")
      .where("id", "=", approvalId)
      .selectAll()
      .executeTakeFirstOrThrow();
    if (row.status !== "pending") throw new Error(`approval ${approvalId} already ${row.status}`);

    await trx
      .updateTable("approvals")
      .set({ status: decision, resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
      .where("id", "=", approvalId)
      .execute();

    await emit({
      companyId: row.company_id,
      type: "approval.resolved",
      subjectId: approvalId,
      actor: { kind: "user" },
      payload: { decision, action: row.action },
    });

    return {
      companyId: row.company_id,
      action: row.action,
      detail: JSON.parse(row.detail),
      employeeId: row.employee_id,
    };
  });
}
