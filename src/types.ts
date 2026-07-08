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
