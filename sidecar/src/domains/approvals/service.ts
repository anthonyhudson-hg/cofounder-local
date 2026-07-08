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
