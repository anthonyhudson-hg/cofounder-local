import type { Generated } from "kysely";

/**
 * Kysely table interfaces mirroring 0001_baseline.sql. Columns with a SQL
 * DEFAULT are `Generated<T>` so inserts may omit them. This is the single
 * source of truth for the runtime's typed data-access layer.
 */

export interface CompaniesTable {
  id: string;
  name: string;
  profile: Generated<string>;
  system_prompt: Generated<string>;
  avatar: string | null;
  color: string | null;
  position: Generated<number>;
  created_at: Generated<string>;
  onboarded: Generated<number>;
}

export interface SettingsTable {
  key: string;
  value: string;
}

export interface ConversationsTable {
  id: string;
  kind: "channel" | "dm";
  name: string;
  session_id: string | null;
  created_at: Generated<string>;
  company_id: string | null;
  is_group: Generated<number>;
  session_provider: string | null;
}

export interface EmployeesTable {
  id: string;
  conversation_id: string;
  job_title: Generated<string>;
  department: Generated<string>;
  default_model: Generated<string>;
  default_effort: Generated<string>;
  created_at: Generated<string>;
  avatar: string | null;
  mission: Generated<string>;
  preamble: Generated<string>;
  additional_details: Generated<string>;
  company_id: string | null;
  manager_employee_id: string | null;
}

export interface MessagesTable {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: Generated<string>;
  model: string | null;
  effort: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_cost_usd: number | null;
  status: Generated<"pending" | "streaming" | "complete" | "error">;
  error_message: string | null;
  created_at: Generated<string>;
  debug_payload: string | null;
  thread_root_id: string | null;
  reply_to_message_id: string | null;
  author_employee_id: string | null;
  notified_at: string | null;
}

export interface ReactionsTable {
  id: string;
  message_id: string;
  emoji: string;
  reactor: Generated<string>;
  notified_at: string | null;
  created_at: Generated<string>;
}

export interface EmployeeResponsibilitiesTable {
  id: string;
  employee_id: string;
  text: string;
  position: Generated<number>;
  created_at: Generated<string>;
}

export interface ChannelMembershipsTable {
  id: string;
  conversation_id: string;
  employee_id: string;
  effective_from: Generated<string>;
  effective_to: string | null;
  created_at: Generated<string>;
}

export interface RelevanceChecksTable {
  id: string;
  message_id: string;
  employee_id: string;
  decision: "respond" | "skip";
  reason: Generated<string>;
  created_at: Generated<string>;
}

export interface AgentSessionsTable {
  id: string;
  conversation_id: string;
  employee_id: string;
  session_id: string | null;
  updated_at: Generated<string>;
  session_provider: string | null;
}

export interface DepartmentsTable {
  id: string;
  company_id: string;
  name: string;
  position: Generated<number>;
  created_at: Generated<string>;
}

export interface EventsTable {
  seq: Generated<number>;
  id: string;
  company_id: string | null;
  type: string;
  actor: Generated<string>;
  subject_id: string | null;
  payload: Generated<string>;
  causation_id: string | null;
  correlation_id: string | null;
  created_at: Generated<string>;
}

export interface EventOutboxTable {
  event_seq: number;
  handler: string;
  status: Generated<"pending" | "done" | "error">;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: Generated<string>;
}

export interface SecretsTable {
  id: string;
  company_id: string;
  name: string;
  ciphertext: string;
  nonce: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

export interface CapabilityGrantsTable {
  id: string;
  company_id: string;
  employee_id: string;
  scope: string;
  max_effect: Generated<"none" | "read" | "write-internal" | "external-read" | "external-write">;
  created_at: Generated<string>;
}

export interface ApprovalsTable {
  id: string;
  company_id: string;
  employee_id: string | null;
  action: string;
  detail: Generated<string>;
  status: Generated<"pending" | "approved" | "denied" | "expired">;
  requested_at: Generated<string>;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface AgentProfilesTable {
  employee_id: string;
  personality: Generated<string>;
  communication_style: Generated<string>;
  expertise: Generated<string>;
  autonomy_level: Generated<"suggest" | "act-with-approval" | "autonomous">;
  updated_at: Generated<string>;
}

export interface AgentMemoryTable {
  id: string;
  company_id: string;
  employee_id: string;
  kind: Generated<"working" | "long" | "episodic" | "semantic">;
  mem_key: string;
  value: string;
  created_at: Generated<string>;
  updated_at: Generated<string>;
}

/** Tracks which runtime migrations have been applied (owned by the runtime). */
export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<string>;
}

export interface Database {
  companies: CompaniesTable;
  settings: SettingsTable;
  conversations: ConversationsTable;
  employees: EmployeesTable;
  messages: MessagesTable;
  reactions: ReactionsTable;
  employee_responsibilities: EmployeeResponsibilitiesTable;
  channel_memberships: ChannelMembershipsTable;
  relevance_checks: RelevanceChecksTable;
  agent_sessions: AgentSessionsTable;
  departments: DepartmentsTable;
  events: EventsTable;
  event_outbox: EventOutboxTable;
  secrets: SecretsTable;
  capability_grants: CapabilityGrantsTable;
  approvals: ApprovalsTable;
  agent_profiles: AgentProfilesTable;
  agent_memory: AgentMemoryTable;
  schema_migrations: SchemaMigrationsTable;
}
