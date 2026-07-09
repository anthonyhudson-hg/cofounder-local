import { ActivityLogEntry, DebugPayload, Message, modelLabel, type Question, type SubAnswer } from "../types";

interface Props {
  message: Message;
  /** Questions this assistant message asked via question_ask, if any. */
  questions?: Question[];
}

function summarizeDebugAnswer(a: SubAnswer): string {
  switch (a.kind) {
    case "select":
      return [...a.selected, ...(a.other ? [`Other: ${a.other}`] : [])].join(", ") || "(none)";
    case "text":
      return a.value || "(blank)";
    case "number":
      return String(a.value);
    case "date":
      return a.value || "(none)";
    case "file":
      return a.files.map((f) => `${f.name} (${f.mimeType})`).join(", ") || "(none)";
  }
}

function describeInput(q: Question["spec"]["questions"][number]): string {
  const i = q.input;
  switch (i.kind) {
    case "select":
      return `select${i.multiSelect ? " (multi)" : ""}${i.allowOther ? " +other" : ""}: ${i.options.map((o) => o.label).join(" | ")}`;
    case "text":
      return `text${i.multiline ? " (multiline)" : ""}`;
    case "number":
      return `number${i.slider ? " (slider)" : ""}${i.unit ? ` ${i.unit}` : ""}`;
    case "date":
      return "date";
    case "file":
      return `file${i.imageOnly ? " (images)" : ""}${i.multiple ? " (multiple)" : ""}`;
  }
}

function formatStepTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function stepLabel(e: ActivityLogEntry): string {
  const primary = e.toolName ? `Using ${e.toolName}` : e.message || e.phase;
  return e.snippet ? `${primary} — "${e.snippet}"` : primary;
}

export function DebugPanel({ message, questions }: Props) {
  let payload: DebugPayload | null;
  try {
    payload = message.debug_payload ? JSON.parse(message.debug_payload) : null;
  } catch {
    payload = null;
  }

  if (!payload) {
    return <div className="debug-inline debug-inline-empty">No debug data recorded for this message.</div>;
  }

  return (
    <div className="debug-inline">
      {questions && questions.length > 0 && (
        <div className="debug-inline-section">
          <div className="debug-inline-key">Questions asked ({questions.length})</div>
          <pre className="debug-pre">
            {questions
              .map((q) => {
                const head = `[${q.status}] ${q.spec.title ?? "(untitled)"} — asked ${q.created_at}${q.resolved_at ? `, resolved ${q.resolved_at}` : ""}`;
                const subs = q.spec.questions
                  .map((sq) => {
                    const ans = q.answers?.answers[sq.id];
                    return `  • ${sq.header}: ${sq.question}\n    input: ${describeInput(sq)}\n    answer: ${ans ? summarizeDebugAnswer(ans) : "(unanswered)"}`;
                  })
                  .join("\n");
                return `${head}\n${subs}`;
              })
              .join("\n\n")}
          </pre>
        </div>
      )}
      {payload.activityLog && payload.activityLog.length > 0 && (
        <div className="debug-inline-section">
          <div className="debug-inline-key">Activity timeline ({payload.activityLog.length} steps)</div>
          <pre className="debug-pre debug-activity-log">
            {payload.activityLog.map((e) => `${formatStepTime(e.at)}  ${stepLabel(e)}`).join("\n")}
          </pre>
        </div>
      )}
      <div className="debug-inline-row">
        <span className="debug-inline-key">Model</span>
        <span>
          {modelLabel(payload.model)} ({payload.model})
        </span>
      </div>
      <div className="debug-inline-row">
        <span className="debug-inline-key">Effort</span>
        <span>{payload.effort}</span>
      </div>
      <div className="debug-inline-row">
        <span className="debug-inline-key">Session</span>
        <span>{payload.resumeSessionId ?? "(new session)"}</span>
      </div>
      {payload.channel && (
        <>
          <div className="debug-inline-row">
            <span className="debug-inline-key">Thread</span>
            <span>{payload.channel.threadRootId ?? "(new top-level post)"}</span>
          </div>
          <div className="debug-inline-row">
            <span className="debug-inline-key">Reply to</span>
            <span>{payload.channel.replyToMessageId ?? "(none)"}</span>
          </div>
          <div className="debug-inline-section">
            <div className="debug-inline-key">Relevance checks</div>
            <pre className="debug-pre">
              {payload.channel.relevanceChecks.length
                ? payload.channel.relevanceChecks
                    .map((c) => `[${c.decision}] ${c.employeeName}: ${c.reason}`)
                    .join("\n")
                : "(none recorded)"}
            </pre>
          </div>
          <div className="debug-inline-section">
            <div className="debug-inline-key">Reactions applied</div>
            <pre className="debug-pre">
              {payload.channel.reactionsApplied.length
                ? payload.channel.reactionsApplied.map((r) => `${r.emoji} → ${r.messageId}`).join("\n")
                : "(none)"}
            </pre>
          </div>
        </>
      )}
      {payload.reactionNotices.length > 0 && (
        <div className="debug-inline-section">
          <div className="debug-inline-key">Reaction notices injected</div>
          <pre className="debug-pre">
            {payload.reactionNotices
              .map((n) => `${n.emoji} from ${n.fromName} (${n.intent}) on: "${n.onMessagePreview}"`)
              .join("\n")}
          </pre>
        </div>
      )}

      <div className="debug-inline-section">
        <div className="debug-inline-key">Company profile</div>
        <pre className="debug-pre">{payload.companyProfile || "(none)"}</pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">Company system prompt</div>
        <pre className="debug-pre">{payload.companySystemPrompt || "(none)"}</pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">Identity block</div>
        <pre className="debug-pre">{payload.identityBlock || "(none)"}</pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">Mission</div>
        <pre className="debug-pre">{payload.mission || "(none)"}</pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">Preamble</div>
        <pre className="debug-pre">{payload.preamble || "(none)"}</pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">Responsibilities</div>
        <pre className="debug-pre">
          {payload.responsibilities.length
            ? payload.responsibilities.map((r) => `- ${r}`).join("\n")
            : "(none)"}
        </pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">Additional details</div>
        <pre className="debug-pre">{payload.additionalDetails || "(none)"}</pre>
      </div>
      <div className="debug-inline-section">
        <div className="debug-inline-key">User prompt</div>
        <pre className="debug-pre">{payload.prompt}</pre>
      </div>

      {message.status === "complete" && (
        <div className="debug-inline-section">
          <div className="debug-inline-key">Usage</div>
          <pre className="debug-pre">
            {JSON.stringify(
              {
                input_tokens: message.input_tokens,
                output_tokens: message.output_tokens,
                cache_creation_input_tokens: message.cache_creation_input_tokens,
                cache_read_input_tokens: message.cache_read_input_tokens,
                total_cost_usd_estimate: message.total_cost_usd,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
