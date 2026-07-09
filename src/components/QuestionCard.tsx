import { Check, CircleNotch, Paperclip, Question as QuestionIcon, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  QUESTION_MAX_FILE_TOTAL_BYTES,
  QUESTION_OTHER_OPTION_LABEL,
  type Question,
  type SubAnswer,
  type SubQuestion,
} from "../types";

interface Props {
  question: Question;
  employeeName: string;
  /** Stable, id-taking callback from the owning hook (memo-safe). */
  onAnswer: (questionId: string, answers: Record<string, SubAnswer>) => void;
}

/** Reads a File into the inline base64 shape the answer payload carries. */
function readFileAsBase64(file: File): Promise<{ name: string; mimeType: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // data:<mime>;base64,XXXX
      const comma = result.indexOf(",");
      resolve({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function initialAnswer(q: SubQuestion): SubAnswer {
  switch (q.input.kind) {
    case "select":
      return { kind: "select", selected: [], other: "" };
    case "text":
      return { kind: "text", value: "" };
    case "number":
      return { kind: "number", value: q.input.min ?? 0 };
    case "date":
      return { kind: "date", value: "" };
    case "file":
      return { kind: "file", files: [] };
  }
}

/** Whether a single sub-answer satisfies its (possibly required) sub-question. */
function isAnswered(q: SubQuestion, a: SubAnswer): boolean {
  switch (a.kind) {
    case "select": {
      const usedOther = a.selected.includes(QUESTION_OTHER_OPTION_LABEL);
      if (usedOther && !(a.other ?? "").trim()) return false;
      return a.selected.length > 0;
    }
    case "text":
      return !q.required || a.value.trim().length > 0;
    case "number":
      return typeof a.value === "number" && !Number.isNaN(a.value);
    case "date":
      return !q.required || a.value.length > 0;
    case "file":
      return !q.required || a.files.length > 0;
  }
}

function totalFileBytes(answers: Record<string, SubAnswer>): number {
  let total = 0;
  for (const a of Object.values(answers)) {
    if (a.kind === "file") for (const f of a.files) total += Math.floor((f.dataBase64.length * 3) / 4);
  }
  return total;
}

// ---- read-only summary (answered / cancelled) ----

function summarizeAnswer(a: SubAnswer): string {
  switch (a.kind) {
    case "select": {
      const parts = a.selected.filter((s) => s !== QUESTION_OTHER_OPTION_LABEL);
      if (a.other && a.other.trim()) parts.push(a.other.trim());
      return parts.join(", ") || "—";
    }
    case "text":
      return a.value.trim() || "—";
    case "number":
      return String(a.value);
    case "date":
      return a.value || "—";
    case "file":
      return a.files.map((f) => f.name).join(", ") || "—";
  }
}

function AnsweredCard({ question, employeeName }: { question: Question; employeeName: string }) {
  const cancelled = question.status === "cancelled";
  return (
    <div className={`question-card is-resolved ${cancelled ? "is-cancelled" : ""}`}>
      <div className="question-card-head">
        <QuestionIcon weight="fill" className="question-card-icon" />
        <span className="question-card-title">{question.spec.title ?? `${employeeName} asked`}</span>
        <span className={`question-card-status ${cancelled ? "cancelled" : "answered"}`}>
          {cancelled ? "Cancelled" : "Answered"}
        </span>
      </div>
      <div className="question-card-body">
        {question.spec.questions.map((q) => {
          const a = question.answers?.answers[q.id];
          return (
            <div className="question-sub is-resolved" key={q.id}>
              <div className="question-sub-header">{q.header}</div>
              <div className="question-sub-prompt">{q.question}</div>
              {cancelled ? (
                <div className="question-answer-summary muted">No answer</div>
              ) : a && a.kind === "file" && a.files.length ? (
                <div className="question-file-list">
                  {a.files.map((f, i) =>
                    f.mimeType.startsWith("image/") ? (
                      <img key={i} className="question-file-thumb" src={`data:${f.mimeType};base64,${f.dataBase64}`} alt={f.name} />
                    ) : (
                      <span key={i} className="question-file-chip"><Paperclip /> {f.name}</span>
                    ),
                  )}
                </div>
              ) : (
                <div className="question-answer-summary">{a ? summarizeAnswer(a) : "—"}</div>
              )}
            </div>
          );
        })}
      </div>
      {question.orphaned && (
        <div className="question-card-note">The agent was no longer waiting — your answer was saved, but send a new message to continue.</div>
      )}
    </div>
  );
}

// ---- input controls ----

function SelectControl({
  q,
  answer,
  onChange,
  disabled,
}: {
  q: SubQuestion & { input: Extract<SubQuestion["input"], { kind: "select" }> };
  answer: Extract<SubAnswer, { kind: "select" }>;
  onChange: (a: Extract<SubAnswer, { kind: "select" }>) => void;
  disabled: boolean;
}) {
  const { options, multiSelect, allowOther } = q.input;
  const toggle = (label: string) => {
    if (disabled) return;
    const has = answer.selected.includes(label);
    let selected: string[];
    if (multiSelect) selected = has ? answer.selected.filter((s) => s !== label) : [...answer.selected, label];
    else selected = has ? [] : [label];
    onChange({ ...answer, selected });
  };
  const otherSelected = answer.selected.includes(QUESTION_OTHER_OPTION_LABEL);
  return (
    <div className="question-options">
      {options.map((opt) => {
        const active = answer.selected.includes(opt.label);
        return (
          <button
            type="button"
            key={opt.label}
            className={`question-option ${active ? "active" : ""}`}
            onClick={() => toggle(opt.label)}
            disabled={disabled}
          >
            <span className="question-option-check">{active && <Check weight="bold" />}</span>
            <span className="question-option-text">
              <span className="question-option-label">{opt.label}</span>
              {opt.description && <span className="question-option-desc">{opt.description}</span>}
              {active && opt.preview && <span className="question-option-preview">{opt.preview}</span>}
            </span>
          </button>
        );
      })}
      {allowOther && (
        <button
          type="button"
          className={`question-option ${otherSelected ? "active" : ""}`}
          onClick={() => toggle(QUESTION_OTHER_OPTION_LABEL)}
          disabled={disabled}
        >
          <span className="question-option-check">{otherSelected && <Check weight="bold" />}</span>
          <span className="question-option-text">
            <span className="question-option-label">Other…</span>
          </span>
        </button>
      )}
      {otherSelected && (
        <input
          className="question-text-input question-other-input"
          type="text"
          placeholder="Type your answer"
          value={answer.other ?? ""}
          onChange={(e) => onChange({ ...answer, other: e.target.value })}
          disabled={disabled}
          autoFocus
        />
      )}
    </div>
  );
}

function SubQuestionControl({
  q,
  answer,
  onChange,
  disabled,
}: {
  q: SubQuestion;
  answer: SubAnswer;
  onChange: (a: SubAnswer) => void;
  disabled: boolean;
}) {
  switch (q.input.kind) {
    case "select":
      return (
        <SelectControl
          q={q as SubQuestion & { input: Extract<SubQuestion["input"], { kind: "select" }> }}
          answer={answer as Extract<SubAnswer, { kind: "select" }>}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "text": {
      const a = answer as Extract<SubAnswer, { kind: "text" }>;
      return q.input.multiline ? (
        <textarea
          className="question-text-input"
          rows={3}
          placeholder={q.input.placeholder}
          value={a.value}
          onChange={(e) => onChange({ kind: "text", value: e.target.value })}
          disabled={disabled}
        />
      ) : (
        <input
          className="question-text-input"
          type="text"
          placeholder={q.input.placeholder}
          value={a.value}
          onChange={(e) => onChange({ kind: "text", value: e.target.value })}
          disabled={disabled}
        />
      );
    }
    case "number": {
      const a = answer as Extract<SubAnswer, { kind: "number" }>;
      const { min, max, step, unit, slider } = q.input;
      const useSlider = slider && min != null && max != null;
      return (
        <div className="question-number">
          {useSlider ? (
            <>
              <input
                type="range"
                className="question-range"
                min={min}
                max={max}
                step={step ?? 1}
                value={a.value}
                onChange={(e) => onChange({ kind: "number", value: Number(e.target.value) })}
                disabled={disabled}
              />
              <span className="question-number-value">
                {a.value}
                {unit ? ` ${unit}` : ""}
              </span>
            </>
          ) : (
            <>
              <input
                type="number"
                className="question-text-input question-number-input"
                min={min}
                max={max}
                step={step}
                value={a.value}
                onChange={(e) => onChange({ kind: "number", value: Number(e.target.value) })}
                disabled={disabled}
              />
              {unit && <span className="question-number-unit">{unit}</span>}
            </>
          )}
        </div>
      );
    }
    case "date": {
      const a = answer as Extract<SubAnswer, { kind: "date" }>;
      return (
        <input
          type="date"
          className="question-text-input question-date-input"
          min={q.input.min}
          max={q.input.max}
          value={a.value}
          onChange={(e) => onChange({ kind: "date", value: e.target.value })}
          disabled={disabled}
        />
      );
    }
    case "file": {
      const a = answer as Extract<SubAnswer, { kind: "file" }>;
      const { accept, multiple, imageOnly } = q.input;
      const onFiles = async (list: FileList | null) => {
        if (!list || disabled) return;
        const read = await Promise.all(Array.from(list).map(readFileAsBase64));
        onChange({ kind: "file", files: multiple ? [...a.files, ...read] : read });
      };
      return (
        <div className="question-file">
          <label className={`question-file-drop ${disabled ? "disabled" : ""}`}>
            <Paperclip /> Choose {imageOnly ? "image" : "file"}
            {multiple ? "s" : ""}
            <input
              type="file"
              accept={accept ?? (imageOnly ? "image/*" : undefined)}
              multiple={multiple}
              onChange={(e) => void onFiles(e.target.files)}
              disabled={disabled}
              hidden
            />
          </label>
          {a.files.length > 0 && (
            <div className="question-file-list">
              {a.files.map((f, i) => (
                <span key={i} className="question-file-chip">
                  {f.mimeType.startsWith("image/") ? (
                    <img className="question-file-thumb sm" src={`data:${f.mimeType};base64,${f.dataBase64}`} alt={f.name} />
                  ) : (
                    <Paperclip />
                  )}
                  {f.name}
                  {!disabled && (
                    <button
                      type="button"
                      className="question-file-remove"
                      onClick={() => onChange({ kind: "file", files: a.files.filter((_, j) => j !== i) })}
                      aria-label={`Remove ${f.name}`}
                    >
                      <X weight="bold" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
  }
}

/**
 * The interactive card an agent's `question_ask` renders inline in the chat.
 * Pending → a controlled form (all input types, up to 4 stacked sub-questions,
 * one Submit); answered/cancelled → a read-only summary. Local state is form-only;
 * the `Question` prop from the hook is the source of truth for existence/status.
 */
export function QuestionCard({ question, employeeName, onAnswer }: Props) {
  const [answers, setAnswers] = useState<Record<string, SubAnswer>>(() => {
    const init: Record<string, SubAnswer> = {};
    for (const q of question.spec.questions) init[q.id] = initialAnswer(q);
    return init;
  });
  const [submitted, setSubmitted] = useState(false);

  const overSizeLimit = useMemo(() => totalFileBytes(answers) > QUESTION_MAX_FILE_TOTAL_BYTES, [answers]);
  const canSubmit = useMemo(
    () => !overSizeLimit && question.spec.questions.every((q) => !q.required || isAnswered(q, answers[q.id])),
    [question.spec.questions, answers, overSizeLimit],
  );

  if (question.status !== "pending") {
    return <AnsweredCard question={question} employeeName={employeeName} />;
  }

  const disabled = submitted;
  const submit = () => {
    if (!canSubmit || submitted) return;
    setSubmitted(true);
    onAnswer(question.id, answers);
  };

  return (
    <div className="question-card">
      <div className="question-card-head">
        <QuestionIcon weight="fill" className="question-card-icon" />
        <span className="question-card-title">{question.spec.title ?? `${employeeName} needs your input`}</span>
        <span className="question-card-waiting shimmer-text">
          {submitted ? "Sending…" : "Waiting for your answer"}
        </span>
      </div>
      <div className="question-card-body">
        {question.spec.questions.map((q) => (
          <div className="question-sub" key={q.id}>
            <div className="question-sub-header">
              {q.header}
              {q.required && <span className="question-sub-required">*</span>}
            </div>
            <div className="question-sub-prompt">{q.question}</div>
            <SubQuestionControl q={q} answer={answers[q.id]} onChange={(a) => setAnswers((prev) => ({ ...prev, [q.id]: a }))} disabled={disabled} />
          </div>
        ))}
      </div>
      {overSizeLimit && <div className="question-card-note error">Attachments exceed the 5 MB limit.</div>}
      <div className="question-card-foot">
        <button type="button" className="question-submit" onClick={submit} disabled={!canSubmit || submitted}>
          {submitted ? <CircleNotch className="question-submit-spinner" weight="bold" /> : <Check weight="bold" />}
          {submitted ? "Sending" : "Submit"}
        </button>
      </div>
    </div>
  );
}
