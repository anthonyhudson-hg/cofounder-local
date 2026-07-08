import Database from "better-sqlite3";
import type { BetterSqlite } from "./index";
import { BASELINE_SQL, MIGRATIONS, type Migration } from "./migrations";

export interface MigrationResult {
  applied: string[];
  baselined: string[];
  schemaVersion: number;
}

function tableExists(sqlite: BetterSqlite, name: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function ensureMigrationsTable(sqlite: BetterSqlite): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
}

function appliedNames(sqlite: BetterSqlite): Set<string> {
  const rows = sqlite.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function tableInfoColumns(sqlite: BetterSqlite, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((c) => c.name));
}

/**
 * Verifies an existing (pre-existing, Rust-migrated) database actually matches the
 * expected baseline schema before the migrator adopts it (records `0001_baseline` as
 * applied without running it). Previously the only check was "does a `companies`
 * table exist" — any drift between the hand-transcribed `BASELINE_SQL` and the real
 * historical schema (a missing table, a renamed/missing column) went undetected and
 * silently recorded as a clean baseline, only surfacing later as an opaque "no such
 * table/column" error at first query time (report §4.7).
 *
 * Runs `BASELINE_SQL` against a throwaway in-memory database and lets SQLite's own
 * parser derive the expected table/column set — safer and more accurate than
 * hand-rolling a DDL parser, and read-only against the real database.
 */
function verifyBaselineSchema(sqlite: BetterSqlite): void {
  const reference = new Database(":memory:");
  let expected: Map<string, Set<string>>;
  try {
    reference.exec(BASELINE_SQL);
    const tables = reference.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expected = new Map(tables.map((t) => [t.name, tableInfoColumns(reference, t.name)]));
  } finally {
    reference.close();
  }

  const problems: string[] = [];
  for (const [table, expectedCols] of expected) {
    if (!tableExists(sqlite, table)) {
      problems.push(`missing table: ${table}`);
      continue;
    }
    const actualCols = tableInfoColumns(sqlite, table);
    for (const col of expectedCols) {
      if (!actualCols.has(col)) problems.push(`table ${table} is missing expected column ${col}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to adopt this database as the 0001_baseline: its schema doesn't match what the runtime expects.\n${problems.join("\n")}`,
    );
  }
}

/**
 * Runs pending migrations. The baseline (0001) is RECORDED WITHOUT EXECUTING
 * when the schema already exists — i.e. the database was previously migrated by
 * the old Rust/tauri-plugin-sql path (detected via the `companies` table). This
 * lets the runtime take ownership of an existing `cofounder.db` and continue
 * forward from 0002, while a brand-new database runs the full baseline.
 */
export function runMigrations(sqlite: BetterSqlite): MigrationResult {
  ensureMigrationsTable(sqlite);
  const done = appliedNames(sqlite);
  const applied: string[] = [];
  const baselined: string[] = [];
  const schemaAlreadyExists = tableExists(sqlite, "companies");

  const record = sqlite.prepare("INSERT INTO schema_migrations (name) VALUES (?)");

  const runOne = (m: Migration) => {
    if (done.has(m.name)) return;

    if (m.baseline && schemaAlreadyExists) {
      // Existing Rust-migrated DB: adopt it without re-running the baseline, but only
      // after confirming its schema actually matches what we expect.
      verifyBaselineSchema(sqlite);
      record.run(m.name);
      baselined.push(m.name);
      return;
    }

    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      record.run(m.name);
    });
    try {
      tx();
      applied.push(m.name);
    } catch (err) {
      if (m.baseline && /already exists/i.test(String(err)) && tableExists(sqlite, "companies")) {
        // Two sidecar processes racing the first migration on a fresh DB (plausible
        // given the sidecar-lifecycle tech debt, or simply running dev twice) — the
        // loser's CREATE TABLE throws "table already exists" here instead of detecting
        // "the winner already finished, adopt what they built" (report §4.7). Verify
        // the now-existing schema and baseline onto it instead of crashing startup.
        verifyBaselineSchema(sqlite);
        record.run(m.name);
        baselined.push(m.name);
        return;
      }
      throw err;
    }
  };

  for (const m of MIGRATIONS) runOne(m);

  // Report the actual count of applied-or-baselined rows, not just the length of the
  // in-code MIGRATIONS array — the two would silently diverge if a migration were
  // ever removed or reordered (report §4.7).
  const schemaVersion = appliedNames(sqlite).size;
  return { applied, baselined, schemaVersion };
}
