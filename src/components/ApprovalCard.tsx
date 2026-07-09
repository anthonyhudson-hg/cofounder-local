import { Check, CircleNotch, Prohibit, ShieldCheck, Warning } from "@phosphor-icons/react";
import { useState } from "react";
import type { Approval, ApprovalDecision } from "../types";

interface Props {
  approval: Approval;
  employeeName: string;
  /** Label for the "Always in …" button — "#channel" for a channel, "this DM" for a DM. */
  scopeLabel: string;
  /** Stable, id-taking callback from the owning hook (memo-safe). */
  onResolve: (approvalId: string, decision: ApprovalDecision) => void;
}

/** Human phrasing for a registry tool name. */
const ACTION_VERBS: Record<string, string> = {
  "shell.run": "run a shell command",
  "git.open_pr": "commit & open a pull request",
  "fs.edit": "edit a file",
  "fs.delete": "delete a file",
  "fs.move": "move/rename a file",
  "fs.create": "create a file",
  "message.send": "post a message",
  "memory.write": "save a memory",
};

function actionPhrase(action: string): string {
  return ACTION_VERBS[action] ?? `run ${action}`;
}

/** Pulls the most useful preview line(s) out of the merged approval detail. */
function renderDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.command === "string") return d.command;
  if (typeof d.diffPreview === "string") return d.diffPreview;
  if (Array.isArray(d.filesChanged)) return (d.filesChanged as string[]).join("\n") || `${d.fileCount ?? 0} files`;
  if (typeof d.path === "string") return d.path;
  if (typeof d.from === "string" && typeof d.to === "string") return `${d.from} → ${d.to}`;
  if (typeof d.text === "string") return d.text;
  if (typeof d.value === "string") return `${d.key ? `${d.key}: ` : ""}${d.value}`;
  // Fall back to a compact JSON of anything non-preview.
  const { taskId, ...rest } = d;
  void taskId;
  const keys = Object.keys(rest);
  return keys.length ? JSON.stringify(rest, null, 2) : null;
}

export function ApprovalCard({ approval, employeeName, scopeLabel, onResolve }: Props) {
  const [submitted, setSubmitted] = useState<ApprovalDecision | null>(null);
  const detailText = renderDetail(approval.detail);

  if (approval.status !== "pending") {
    const denied = approval.status === "denied";
    return (
      <div className={`question-card approval-card is-resolved ${denied ? "is-cancelled" : ""}`}>
        <div className="question-card-head">
          {denied ? <Prohibit weight="fill" className="approval-card-icon denied" /> : <ShieldCheck weight="fill" className="approval-card-icon" />}
          <span className="question-card-title">
            {employeeName} · {actionPhrase(approval.action)}
          </span>
          <span className={`question-card-status ${denied ? "cancelled" : "answered"}`}>{denied ? "Denied" : "Approved"}</span>
        </div>
        {detailText && (
          <div className="question-card-body">
            <pre className="approval-detail">{detailText}</pre>
          </div>
        )}
        {approval.orphaned && (
          <div className="question-card-note">The agent was no longer waiting — send a new message if you still want this done.</div>
        )}
      </div>
    );
  }

  const decide = (decision: ApprovalDecision) => {
    if (submitted) return;
    setSubmitted(decision);
    onResolve(approval.id, decision);
  };
  const busy = submitted !== null;

  return (
    <div className="question-card approval-card">
      <div className="question-card-head">
        <Warning weight="fill" className="approval-card-icon warn" />
        <span className="question-card-title">
          {employeeName} wants to {actionPhrase(approval.action)}
        </span>
        <span className="question-card-waiting shimmer-text">{busy ? "Applying…" : "Needs your approval"}</span>
      </div>
      {detailText && (
        <div className="question-card-body">
          <pre className="approval-detail">{detailText}</pre>
        </div>
      )}
      <div className="approval-card-foot">
        <button type="button" className="approval-btn deny" onClick={() => decide("denied")} disabled={busy}>
          {submitted === "denied" ? <CircleNotch className="question-submit-spinner" weight="bold" /> : <Prohibit weight="bold" />}
          Deny
        </button>
        <button type="button" className="approval-btn once" onClick={() => decide("once")} disabled={busy}>
          {submitted === "once" ? <CircleNotch className="question-submit-spinner" weight="bold" /> : <Check weight="bold" />}
          Allow once
        </button>
        <button type="button" className="approval-btn always" onClick={() => decide("always")} disabled={busy}>
          {submitted === "always" ? <CircleNotch className="question-submit-spinner" weight="bold" /> : null}
          Allow always
        </button>
        <button type="button" className="approval-btn always-here" onClick={() => decide("always-here")} disabled={busy}>
          {submitted === "always-here" ? <CircleNotch className="question-submit-spinner" weight="bold" /> : null}
          Always in {scopeLabel}
        </button>
      </div>
    </div>
  );
}
