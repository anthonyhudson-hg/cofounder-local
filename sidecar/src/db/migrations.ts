/**
 * Runtime-owned migrations, inline so they travel with the code (works in dev,
 * in the tsc `dist/` build, and in a future single-binary bundle without any
 * asset-copy step). Append new migrations; never edit an applied one.
 *
 * `0001_baseline` is the exact end-state of the original Rust/tauri-plugin-sql
 * migrations 1..13. A database already migrated by that path is BASELINED
 * (recorded as applied without executing) by the migrator — see runMigrations.
 */

export interface Migration {
  name: string;
  /** True only for the baseline: skip execution if the schema already exists. */
  baseline?: boolean;
  sql: string;
}

// Exported so the migrator can verify an adopted (pre-existing, Rust-migrated)
// database's schema actually matches this baseline before recording it as applied
// without running it (report §4.7) — see verifyBaselineSchema in migrator.ts.
export const BASELINE_SQL = `
CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('channel','dm')),
    name TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    company_id TEXT REFERENCES companies(id),
    is_group INTEGER NOT NULL DEFAULT 0,
    session_provider TEXT
);
CREATE INDEX idx_conversations_company ON conversations(company_id);

CREATE TABLE employees (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id),
    job_title TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT 'claude-sonnet-5',
    default_effort TEXT NOT NULL DEFAULT 'medium',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    avatar TEXT,
    mission TEXT NOT NULL DEFAULT '',
    preamble TEXT NOT NULL DEFAULT '',
    additional_details TEXT NOT NULL DEFAULT '',
    company_id TEXT REFERENCES companies(id),
    manager_employee_id TEXT REFERENCES employees(id)
);
CREATE INDEX idx_employees_company ON employees(company_id);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL DEFAULT '',
    model TEXT,
    effort TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    total_cost_usd REAL,
    status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('pending','streaming','complete','error')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    debug_payload TEXT,
    thread_root_id TEXT REFERENCES messages(id),
    reply_to_message_id TEXT REFERENCES messages(id),
    author_employee_id TEXT REFERENCES employees(id),
    notified_at TEXT
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_thread_root ON messages(thread_root_id);

CREATE TABLE reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    emoji TEXT NOT NULL,
    reactor TEXT NOT NULL DEFAULT 'user',
    notified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, emoji, reactor)
);
CREATE INDEX idx_reactions_message ON reactions(message_id);

CREATE TABLE employee_responsibilities (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL REFERENCES employees(id),
    text TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_responsibilities_employee ON employee_responsibilities(employee_id, position);

CREATE TABLE channel_memberships (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    effective_from TEXT NOT NULL DEFAULT (datetime('now')),
    effective_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_channel_memberships_channel ON channel_memberships(conversation_id);
CREATE INDEX idx_channel_memberships_employee ON channel_memberships(employee_id);

CREATE TABLE relevance_checks (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    decision TEXT NOT NULL CHECK (decision IN ('respond','skip')),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_relevance_checks_message ON relevance_checks(message_id);

CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    session_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    session_provider TEXT,
    UNIQUE(conversation_id, employee_id)
);

CREATE TABLE departments (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(company_id, name)
);
`;

const EVENTS_SQL = `
CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    company_id TEXT,
    type TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '{"kind":"system"}',
    subject_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    causation_id TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_company_seq ON events(company_id, seq);
CREATE INDEX idx_events_type ON events(type);

-- Outbox: runtime side-effects (routines, notifications, tool follow-ups) that
-- must run reliably off a committed event, replayable after a crash/restart.
CREATE TABLE event_outbox (
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    handler TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (event_seq, handler)
);
CREATE INDEX idx_outbox_pending ON event_outbox(status) WHERE status = 'pending';
`;

const SECRETS_SQL = `
-- Company-scoped secrets, encrypted at rest with a master key held in the OS
-- keychain (refactor #9). Ciphertext + nonce are libsodium secretbox.
CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(company_id, name)
);
`;

const CAPABILITIES_SQL = `
-- Per-employee capability grants (refactor #4 gate): which tools/connectors an
-- agent may use and the max side-effect class it may take without approval.
CREATE TABLE capability_grants (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    scope TEXT NOT NULL,              -- e.g. 'tool:memory', 'connector:github'
    max_effect TEXT NOT NULL DEFAULT 'read' CHECK (max_effect IN ('none','read','write-internal','external-read','external-write')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(employee_id, scope)
);
CREATE INDEX idx_capability_grants_employee ON capability_grants(employee_id);

-- Human approval requests for actions above an agent's autonomy (refactor:
-- approval/governance). Surfaced to the user; resolved approve/deny.
CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    employee_id TEXT REFERENCES employees(id),
    action TEXT NOT NULL,            -- tool/connector action being gated
    detail TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT
);
CREATE INDEX idx_approvals_pending ON approvals(company_id, status);

-- Agent-definition extension (refactor #11): personality/style/expertise/
-- autonomy for orchestration discovery + approval thresholds. One row per employee.
CREATE TABLE agent_profiles (
    employee_id TEXT PRIMARY KEY REFERENCES employees(id),
    personality TEXT NOT NULL DEFAULT '',
    communication_style TEXT NOT NULL DEFAULT '',
    expertise TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
    autonomy_level TEXT NOT NULL DEFAULT 'suggest' CHECK (autonomy_level IN ('suggest','act-with-approval','autonomous')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const MEMORY_SQL = `
-- Agent memory (refactor: memory). Company + employee scoped. 'kind' spans the
-- memory tiers: working (scratch), long (durable facts), episodic (event-derived),
-- semantic (retrieval-augmented). Retrieval/embeddings layer builds on this.
CREATE TABLE agent_memory (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    employee_id TEXT NOT NULL REFERENCES employees(id),
    kind TEXT NOT NULL DEFAULT 'long' CHECK (kind IN ('working','long','episodic','semantic')),
    mem_key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(employee_id, kind, mem_key)
);
CREATE INDEX idx_agent_memory_scope ON agent_memory(company_id, employee_id, kind);
`;

export const MIGRATIONS: Migration[] = [
  { name: "0001_baseline", baseline: true, sql: BASELINE_SQL },
  { name: "0002_events", sql: EVENTS_SQL },
  { name: "0003_secrets", sql: SECRETS_SQL },
  { name: "0004_capabilities_approvals_profiles", sql: CAPABILITIES_SQL },
  { name: "0005_agent_memory", sql: MEMORY_SQL },
  {
    name: "0006_company_onboarded",
    // New companies start un-onboarded (they get the setup wizard); every company
    // that already exists at migration time is treated as already set up.
    sql: `ALTER TABLE companies ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0;
          UPDATE companies SET onboarded = 1;`,
  },
  {
    name: "0007_drop_redundant_indexes",
    // Both indexes only duplicated the leading column of an existing UNIQUE index on
    // the same table (reactions(message_id, emoji, reactor), capability_grants(employee_id,
    // scope)) — SQLite already indexes that leading column via the unique constraint,
    // so these added write overhead on every insert with zero query benefit (report §4.8).
    sql: `DROP INDEX IF EXISTS idx_reactions_message;
          DROP INDEX IF EXISTS idx_capability_grants_employee;`,
  },
  {
    name: "0008_drop_event_outbox",
    // The `event_outbox` table (created in 0002) was scaffolding for a
    // committed-event side-effect processor that was never built — nothing has
    // ever inserted into or read from it. Dropping the dead table rather than
    // carrying it (and its FK to `events`) forward indefinitely. If a durable
    // outbox is wanted later, reintroduce it in a fresh migration alongside the
    // processor that actually consumes it.
    sql: `DROP TABLE IF EXISTS event_outbox;`,
  },
  {
    name: "0009_projects_tasks",
    // Project sandboxing: a company has many projects (each a codebase on disk);
    // employees are scoped to projects; tasks key a git worktree+branch+PR.
    sql: `
      CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES companies(id),
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          remote_url TEXT,
          default_branch TEXT NOT NULL DEFAULT 'main',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(company_id, name)
      );
      CREATE INDEX idx_projects_company ON projects(company_id);

      CREATE TABLE employee_projects (
          employee_id TEXT NOT NULL REFERENCES employees(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (employee_id, project_id)
      );
      CREATE INDEX idx_employee_projects_project ON employee_projects(project_id);

      CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES companies(id),
          project_id TEXT NOT NULL REFERENCES projects(id),
          employee_id TEXT REFERENCES employees(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','in_review','done','abandoned')),
          base_branch TEXT NOT NULL DEFAULT 'main',
          branch_name TEXT,
          worktree_path TEXT,
          pr_url TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_tasks_project ON tasks(project_id, status);
    `,
  },
  {
    name: "0010_questions",
    // Structured questions an agent asks the user mid-turn (the question_ask
    // tool). The agent blocks on the SDK's own await until the user answers, so
    // this row is the durable record backing the in-chat question card and the
    // debug view. `asking_message_id` is the DM assistant message that's asking;
    // NULL for a channel responder (which has no message row until it posts).
    sql: `
      CREATE TABLE questions (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES companies(id),
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          asking_message_id TEXT REFERENCES messages(id),
          employee_id TEXT NOT NULL REFERENCES employees(id),
          spec TEXT NOT NULL,
          answers TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','cancelled')),
          correlation_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
      );
      CREATE INDEX idx_questions_conversation ON questions(conversation_id, created_at);
      CREATE INDEX idx_questions_pending ON questions(status) WHERE status = 'pending';
    `,
  },
];
