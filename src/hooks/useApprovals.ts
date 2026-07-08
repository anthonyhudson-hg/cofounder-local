import { useCallback, useEffect, useState } from "react";
import { command, onRuntimeEvent, query, startRuntimeBus } from "../lib/runtimeClient";

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

/** Pending approvals for the active company, kept live via the runtime event
 *  stream (approval.requested/approval.resolved) rather than polling. */
export function useApprovals(companyId: string | null) {
  const [approvals, setApprovals] = useState<ApprovalListItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!companyId) {
      setApprovals([]);
      setLoaded(true);
      return;
    }
    const rows = await query<ApprovalListItem[]>("approvals.list", { status: "pending" }, companyId);
    setApprovals(rows);
    setLoaded(true);
  }, [companyId]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  useEffect(() => {
    void startRuntimeBus();
    return onRuntimeEvent((e) => {
      if (e.type === "approval.requested" || e.type === "approval.resolved") void reload();
    });
  }, [reload]);

  const resolve = useCallback(
    async (approvalId: string, decision: "approved" | "denied") => {
      await command("approval.resolve", { approvalId, decision }, companyId);
      await reload();
    },
    [companyId, reload],
  );

  return { approvals, loaded, resolve, reload };
}
