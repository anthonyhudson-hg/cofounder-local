import { useState } from "react";
import { useApprovals } from "../hooks/useApprovals";
import type { ApprovalDecision } from "../types";
import { EmployeeInfo } from "./MessageList";

interface Props {
  companyId: string | null;
  employeesById: Record<string, EmployeeInfo>;
}

/**
 * Surfaces pending human-approval requests (capability-gated actions an
 * employee attempted beyond its standing grant) and lets a human resolve
 * them. The backend (capability_grants/approvals/tool.invoke's re-run-on-
 * approve path) has existed since early in the project; this is the first
 * UI that can actually see or act on it — previously the only way to
 * resolve one was a hand-crafted approval.resolve IPC call.
 */
export function ApprovalsPanel({ companyId, employeesById }: Props) {
  const { approvals, loaded, resolve } = useApprovals(companyId);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const handleResolve = async (approvalId: string, decision: ApprovalDecision) => {
    setResolvingId(approvalId);
    try {
      await resolve(approvalId, decision);
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="approvals-panel">
      <div className="activity-header">
        <h2>Approvals</h2>
        <span className="activity-sub">Actions your employees can't take without your sign-off</span>
      </div>

      {!loaded ? null : approvals.length === 0 ? (
        <div className="activity-empty">Nothing waiting on you right now.</div>
      ) : (
        <ul className="approvals-list">
          {approvals.map((a) => {
            const employeeName = (a.employeeId && employeesById[a.employeeId]?.name) || "An employee";
            const busy = resolvingId === a.id;
            return (
              <li key={a.id} className="approval-item">
                <div className="approval-item-main">
                  <div className="approval-item-title">
                    <strong>{employeeName}</strong> wants to run <code>{a.action}</code>
                  </div>
                  <span className="approval-item-time">{new Date(a.requestedAt).toLocaleString()}</span>
                  {!!a.detail && Object.keys(a.detail as object).length > 0 && (
                    <pre className="debug-pre approval-item-detail">{JSON.stringify(a.detail, null, 2)}</pre>
                  )}
                </div>
                <div className="approval-item-actions">
                  <button
                    className="settings-link-btn danger"
                    disabled={busy}
                    onClick={() => handleResolve(a.id, "denied")}
                  >
                    Deny
                  </button>
                  <button
                    className="settings-save-btn"
                    disabled={busy}
                    onClick={() => handleResolve(a.id, "once")}
                  >
                    {busy ? "Working…" : "Approve"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
