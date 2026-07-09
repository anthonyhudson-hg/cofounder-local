export type ConversationKind = "channel" | "dm";

export interface Company {
  id: string;
  name: string;
  profile: string;
  system_prompt: string;
  avatar: string | null;
  color: string | null;
  position: number;
  created_at: string;
  onboarded: number;
}

export interface Conversation {
  id: string;
  company_id: string;
  kind: ConversationKind;
  /** SQLite has no native boolean — 0 or 1. Only meaningful when kind === "dm": a
   * group DM is a "dm" with more than one participant (see channel_memberships). */
  is_group: number;
  name: string;
  session_id: string | null;
  created_at: string;
}

/** A codebase an agent can work in — one root dir on disk. `remote_url` null = local-only. */
export interface Project {
  id: string;
  company_id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  default_branch: string;
  created_at: string;
}

export type TaskStatus = "open" | "in_progress" | "in_review" | "done" | "abandoned";

/** A unit of work in a project — keys a git worktree + branch + PR. */
export interface Task {
  id: string;
  company_id: string;
  project_id: string;
  employee_id: string | null;
  title: string;
  status: TaskStatus;
  base_branch: string;
  branch_name: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "pending" | "streaming" | "complete" | "error";

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model: string | null;
  effort: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  status: MessageStatus;
  error_message: string | null;
  debug_payload: string | null;
  thread_root_id: string | null;
  reply_to_message_id: string | null;
  author_employee_id: string | null;
  created_at: string;
}

export const REACTOR_USER = "user";

export interface Reaction {
  id: string;
  message_id: string;
  emoji: string;
  reactor: string;
  notified_at: string | null;
  created_at: string;
}

export interface ChannelMembership {
  id: string;
  conversation_id: string;
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export interface RelevanceCheck {
  id: string;
  message_id: string;
  employee_id: string;
  decision: "respond" | "skip";
  reason: string;
  created_at: string;
}

export interface Employee {
  id: string;
  company_id: string;
  conversation_id: string;
  job_title: string;
  department: string;
  manager_employee_id: string | null;
  mission: string;
  preamble: string;
  additional_details: string;
  default_model: string;
  default_effort: Effort;
  avatar: string | null;
  created_at: string;
}

export interface Department {
  id: string;
  company_id: string;
  name: string;
  position: number;
  created_at: string;
}

export interface Responsibility {
  id: string;
  employee_id: string;
  text: string;
  position: number;
  created_at: string;
}

/**
 * Starter suggestions shown when browsing departments to hire into — not the
 * source of truth. Actual departments are ad-hoc and DB-backed (see the
 * `departments` table / useDepartments); this list just seeds ideas for a
 * company that hasn't created any of its own yet.
 */
export const DEFAULT_DEPARTMENT_SUGGESTIONS = [
  "Executive",
  "Engineering",
  "Product",
  "Design",
  "Marketing",
  "Sales",
  "Customer Success",
  "Support",
  "Operations",
  "Finance",
  "Legal",
  "People / HR",
  "IT",
  "Data & Analytics",
  "Business Development",
  "Strategy",
  "Communications",
  "Procurement",
  "Research & Development",
  "Other",
];

export interface ReactionNotice {
  emoji: string;
  fromName: string;
  onMessagePreview: string;
  intent: string;
}

export interface ChannelDebugMeta {
  relevanceChecks: { employeeName: string; decision: "respond" | "skip"; reason: string }[];
  replyToMessageId: string | null;
  threadRootId: string | null;
  reactionsApplied: { messageId: string; emoji: string }[];
}

/** One entry in a turn's behind-the-scenes activity timeline (see the debug view). */
export interface ActivityLogEntry {
  /** ISO timestamp of this step. */
  at: string;
  /** Machine phase: thinking | tool | relevance | writing | approval | done. */
  phase: string;
  /** Human status ("Thinking", "Receiving agent output"). */
  message: string;
  /** Friendly tool name when phase === "tool". */
  toolName?: string | null;
  /** A short preview of what the agent had produced at this point, if any. */
  snippet?: string | null;
}

export interface DebugPayload {
  model: string;
  effort: Effort;
  companySystemPrompt: string;
  companyProfile: string;
  identityBlock: string;
  mission: string;
  preamble: string;
  responsibilities: string[];
  additionalDetails: string;
  prompt: string;
  reactionNotices: ReactionNotice[];
  resumeSessionId: string | null;
  sentAt: string;
  channel?: ChannelDebugMeta;
  /** Chronological record of every live-activity status the turn emitted. */
  activityLog?: ActivityLogEntry[];
  /** Ids of any questions the agent asked this turn (see the Questions debug section). */
  questionIds?: string[];
}

// ---- Ask-user-question tool (mirror of sidecar/src/domains/questions/spec.ts —
// keep in sync by hand, same Node/browser split as promptBuilder/mentions/models). ----

export const QUESTION_OTHER_OPTION_LABEL = "Other";
export const QUESTION_MAX_FILE_TOTAL_BYTES = 5 * 1024 * 1024;

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export type QuestionInput =
  | { kind: "select"; options: QuestionOption[]; multiSelect: boolean; allowOther: boolean }
  | { kind: "text"; placeholder?: string; multiline?: boolean }
  | { kind: "number"; min?: number; max?: number; step?: number; unit?: string; slider?: boolean }
  | { kind: "date"; min?: string; max?: string }
  | { kind: "file"; accept?: string; multiple?: boolean; imageOnly?: boolean };

export interface SubQuestion {
  id: string;
  header: string;
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

/** A question row (spec/answers parsed) as returned by query:questions.list, or
 *  synthesized optimistically from a "question" delta while a turn streams. */
export interface Question {
  id: string;
  conversation_id: string;
  /** DM: the asking assistant message id. Channel: null (anchored to the
   *  responder's ephemeral row by employee instead). */
  asking_message_id: string | null;
  employee_id: string;
  spec: QuestionSpec;
  answers: AnswerPayload | null;
  status: "pending" | "answered" | "cancelled";
  created_at: string;
  resolved_at: string | null;
  /** Client-only: set when we answered but the agent was no longer waiting
   *  (orphaned by a restart) — the answer was recorded but the turn didn't resume. */
  orphaned?: boolean;
}

export type Provider = "claude" | "codex";

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export interface ModelOption {
  id: string;
  label: string;
  provider: Provider;
}

export const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "claude" },
  { id: "claude-opus-4-8", label: "Opus 4.8", provider: "claude" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "claude" },
  { id: "claude-fable-5", label: "Fable 5", provider: "claude" },
  // Availability depends on the Codex login's plan. gpt-5.5 is available to
  // ChatGPT-account logins; the codex-native variants require a Codex/Business
  // plan. Unavailable models surface a clear "not supported" error at send time.
  { id: "gpt-5.5", label: "GPT-5.5", provider: "codex" },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", provider: "codex" },
  { id: "gpt-5-codex", label: "GPT-5 Codex", provider: "codex" },
];

// Single source of truth for "the default model" — previously duplicated as the
// literal string "claude-sonnet-5" at each fallback site, which would silently drift
// out of sync if this registry's first entry ever changed (report §5-cross-cutting).
export const DEFAULT_MODEL_ID = MODELS[0].id;

export const PROVIDERS: Provider[] = ["claude", "codex"];

export function modelLabel(id: string | null): string {
  return MODELS.find((m) => m.id === id)?.label ?? id ?? "";
}

/** Which backend owns a model id. Defaults to Claude for unknown ids. */
export function modelProvider(id: string | null): Provider {
  return MODELS.find((m) => m.id === id)?.provider ?? "claude";
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const AUTONOMY_LEVELS = ["suggest", "act-with-approval", "autonomous"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  suggest: "Suggest",
  "act-with-approval": "Act with approval",
  autonomous: "Autonomous",
};

export const AUTONOMY_HINTS: Record<AutonomyLevel, string> = {
  suggest: "Proposes actions and waits for your confirmation before doing anything consequential.",
  "act-with-approval": "Acts directly within its granted permissions; anything beyond that is held for your approval.",
  autonomous: "Acts independently without pausing to ask, within its granted permissions.",
};

/** Mirrors sidecar/src/domains/employees/service.ts's AgentProfile shape. */
export interface AgentProfile {
  personality: string;
  communicationStyle: string;
  expertise: string[];
  autonomyLevel: AutonomyLevel;
}

/** Mirrors sidecar/src/tools/types.ts's EFFECT_ORDER — least to most dangerous. */
export const CAPABILITY_EFFECTS = ["none", "read", "write-internal", "external-read", "external-write"] as const;
export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];

export const CAPABILITY_EFFECT_LABELS: Record<CapabilityEffect, string> = {
  none: "No access",
  read: "Read-only",
  "write-internal": "Read & write",
  "external-read": "Read external services",
  "external-write": "Read & write external services",
};

/** A grantable scope reflecting the tools currently registered server-side (tools/registry.ts's listScopes()). */
export interface CapabilityScope {
  scope: string;
  maxEffect: CapabilityEffect;
  tools: string[];
}

export interface CapabilityGrant {
  scope: string;
  maxEffect: CapabilityEffect;
}

const KNOWN_SCOPE_LABELS: Record<string, string> = {
  "tool:memory": "Memory",
  "connector:github": "GitHub connector",
};

/** Human-readable label for a scope string; unrecognized scopes (new tools/
 *  connectors registered later) still get a reasonable fallback instead of
 *  needing a frontend change every time one is added. */
export function scopeLabel(scope: string): string {
  if (KNOWN_SCOPE_LABELS[scope]) return KNOWN_SCOPE_LABELS[scope];
  const name = scope.split(":")[1] ?? scope;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
