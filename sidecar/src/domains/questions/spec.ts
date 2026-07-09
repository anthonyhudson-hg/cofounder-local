/**
 * Shared shapes for the `question_ask` tool — an agent asks the user up to 4
 * structured sub-questions and blocks until they answer. This module is the
 * runtime-side source of truth; `src/types.ts` carries a hand-kept mirror for
 * the browser (same Node/browser split as promptBuilder/mentions/models — see
 * CLAUDE.md). Keep the two in sync by hand.
 *
 * Pure types + pure helpers only (no zod, no db) so it's safe to import from
 * both the tool definition and the persistence service.
 */

export const MAX_SUBQUESTIONS = 4;
export const MAX_SELECT_OPTIONS = 12;
/** Total decoded bytes of all uploaded files across one answer (base64 rides
 *  inline in the answer JSON in v1 — see the service validator). */
export const MAX_FILE_TOTAL_BYTES = 5 * 1024 * 1024;
/** The always-available free-text escape hatch appended to a select question
 *  when `allowOther` — kept out of the model-facing option list so it reads as
 *  an escape hatch, not a suggested choice. */
export const OTHER_OPTION_LABEL = "Other";

export interface QuestionOption {
  /** Short chip label. */
  label: string;
  /** One-line helper shown under the label. */
  description?: string;
  /** Optional richer preview (markdown-ish) shown when the option is focused. */
  preview?: string;
}

export type QuestionInput =
  | { kind: "select"; options: QuestionOption[]; multiSelect: boolean; allowOther: boolean }
  | { kind: "text"; placeholder?: string; multiline?: boolean }
  | { kind: "number"; min?: number; max?: number; step?: number; unit?: string; slider?: boolean }
  | { kind: "date"; min?: string; max?: string }
  | { kind: "file"; accept?: string; multiple?: boolean; imageOnly?: boolean };

export interface SubQuestion {
  /** Stable within the spec ("q1".."q4"); answers key off this. */
  id: string;
  /** Short chip/tag, e.g. "Deployment target". */
  header: string;
  /** The actual prompt text. */
  question: string;
  input: QuestionInput;
  required: boolean;
}

export interface QuestionSpec {
  title?: string;
  questions: SubQuestion[];
}

export type SubAnswer =
  | { kind: "select"; selected: string[]; other?: string }
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "date"; value: string }
  | { kind: "file"; files: { name: string; mimeType: string; dataBase64: string }[] };

export interface AnswerPayload {
  answers: Record<string, SubAnswer>;
  answeredAt: string;
}

/** The raw, already-zod-validated tool input before ids are assigned. */
export interface RawQuestionSpec {
  title?: string;
  questions: Array<{ header: string; question: string; input: QuestionInput; required?: boolean }>;
}

/**
 * Assigns stable `q1..qN` ids and defaults `required` to true. The "Other"
 * escape-hatch option is injected client-side (kept out of the persisted spec)
 * so the stored/model-facing option list stays exactly what the agent asked.
 */
export function normalizeSpec(raw: RawQuestionSpec): QuestionSpec {
  return {
    title: raw.title,
    questions: raw.questions.slice(0, MAX_SUBQUESTIONS).map((q, i) => ({
      id: `q${i + 1}`,
      header: q.header,
      question: q.question,
      input: q.input,
      required: q.required ?? true,
    })),
  };
}

function decodedBase64Bytes(b64: string): number {
  // Cheap size estimate without allocating a Buffer: 4 base64 chars → 3 bytes,
  // minus padding. Good enough for a size cap.
  const len = b64.length;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Validates a user's answers against the spec that produced the question.
 * Throws with a clear, user-facing message on the first problem. Enforces:
 * every required sub-question answered; selected values ∈ options (or "Other"
 * text present when allowed); number/date within range; file size cap.
 */
export function validateAnswerAgainstSpec(spec: QuestionSpec, payload: AnswerPayload): void {
  for (const q of spec.questions) {
    const a = payload.answers[q.id];
    if (!a) {
      if (q.required) throw new Error(`Missing an answer for "${q.header}".`);
      continue;
    }
    if (a.kind !== q.input.kind) {
      throw new Error(`Answer for "${q.header}" is a ${a.kind}, expected ${q.input.kind}.`);
    }

    switch (q.input.kind) {
      case "select": {
        const ans = a as Extract<SubAnswer, { kind: "select" }>;
        const labels = new Set(q.input.options.map((o) => o.label));
        const chose = ans.selected ?? [];
        const usedOther = chose.includes(OTHER_OPTION_LABEL) || (ans.other != null && ans.other !== "");
        for (const s of chose) {
          if (s === OTHER_OPTION_LABEL) continue;
          if (!labels.has(s)) throw new Error(`"${s}" is not an option for "${q.header}".`);
        }
        if (usedOther) {
          if (!q.input.allowOther) throw new Error(`"Other" is not allowed for "${q.header}".`);
          if (!ans.other || !ans.other.trim()) throw new Error(`Please fill in the "Other" value for "${q.header}".`);
        }
        if (!q.input.multiSelect && chose.filter((s) => s !== OTHER_OPTION_LABEL).length + (usedOther ? 1 : 0) > 1) {
          throw new Error(`"${q.header}" only allows one choice.`);
        }
        if (q.required && chose.length === 0 && !usedOther) throw new Error(`Please choose an option for "${q.header}".`);
        break;
      }
      case "text": {
        const ans = a as Extract<SubAnswer, { kind: "text" }>;
        if (typeof ans.value !== "string") throw new Error(`Answer for "${q.header}" must be text.`);
        if (q.required && !ans.value.trim()) throw new Error(`Please answer "${q.header}".`);
        break;
      }
      case "number": {
        const ans = a as Extract<SubAnswer, { kind: "number" }>;
        if (typeof ans.value !== "number" || Number.isNaN(ans.value)) throw new Error(`Answer for "${q.header}" must be a number.`);
        if (q.input.min != null && ans.value < q.input.min) throw new Error(`"${q.header}" must be at least ${q.input.min}.`);
        if (q.input.max != null && ans.value > q.input.max) throw new Error(`"${q.header}" must be at most ${q.input.max}.`);
        break;
      }
      case "date": {
        const ans = a as Extract<SubAnswer, { kind: "date" }>;
        if (typeof ans.value !== "string" || !ans.value) {
          if (q.required) throw new Error(`Please pick a date for "${q.header}".`);
          break;
        }
        if (q.input.min && ans.value < q.input.min) throw new Error(`"${q.header}" must be on or after ${q.input.min}.`);
        if (q.input.max && ans.value > q.input.max) throw new Error(`"${q.header}" must be on or before ${q.input.max}.`);
        break;
      }
      case "file": {
        const ans = a as Extract<SubAnswer, { kind: "file" }>;
        const files = ans.files ?? [];
        if (q.required && files.length === 0) throw new Error(`Please attach a file for "${q.header}".`);
        let total = 0;
        for (const f of files) {
          if (q.input.imageOnly && !f.mimeType.startsWith("image/")) throw new Error(`"${q.header}" only accepts images.`);
          total += decodedBase64Bytes(f.dataBase64);
        }
        if (total > MAX_FILE_TOTAL_BYTES) {
          throw new Error(`Attachments for "${q.header}" exceed the ${Math.round(MAX_FILE_TOTAL_BYTES / (1024 * 1024))} MB limit.`);
        }
        break;
      }
    }
  }
}

/** Renders one sub-answer as a compact, unambiguous line for the model. */
function formatSubAnswer(a: SubAnswer): string {
  switch (a.kind) {
    case "select": {
      const parts = a.selected.filter((s) => s !== OTHER_OPTION_LABEL);
      if (a.other && a.other.trim()) parts.push(`Other: ${a.other.trim()}`);
      return parts.length ? `[${parts.join(", ")}]` : "(no selection)";
    }
    case "text":
      return a.value.trim() ? `"${a.value.trim()}"` : "(left blank)";
    case "number":
      return String(a.value);
    case "date":
      return a.value || "(no date)";
    case "file":
      return a.files.length
        ? a.files.map((f) => `${f.name} (${f.mimeType}, ${Math.round(decodedBase64Bytes(f.dataBase64) / 1024)} KB)`).join(", ")
        : "(no file)";
  }
}

/**
 * The text handed back to the model as the tool result — what it continues the
 * turn on. One line per sub-question, keyed by the question's header.
 */
export function formatAnswerForModel(spec: QuestionSpec, payload: AnswerPayload): string {
  const lines = spec.questions.map((q) => {
    const a = payload.answers[q.id];
    return `${q.header}: ${a ? formatSubAnswer(a) : "(no answer)"}`;
  });
  return `The user answered your question${spec.questions.length > 1 ? "s" : ""}:\n${lines.join("\n")}`;
}

/** Cheap structural guard for the registered Tool's validateInput (defense in
 *  depth alongside the zod schema on the MCP definition). */
export function validateRawQuestionSpec(input: unknown): void {
  if (!input || typeof input !== "object") throw new Error("question.ask: input must be an object");
  const { questions } = input as Partial<RawQuestionSpec>;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_SUBQUESTIONS) {
    throw new Error(`question.ask: 'questions' must be an array of 1..${MAX_SUBQUESTIONS} items`);
  }
}
