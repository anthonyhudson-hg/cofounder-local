import type { BetterSqlite } from "./index";
import { MIGRATIONS, type Migration } from "./migrations";

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

  const record = sqlite.prepare("INSERT INTO schema_migrations (name) VALUES (?)");

  const runOne = (m: Migration) => {
    if (done.has(m.name)) return;

    const schemaAlreadyExists = tableExists(sqlite, "companies");
    if (m.baseline && schemaAlreadyExists) {
      // Existing Rust-migrated DB: adopt it without re-running the baseline.
      record.run(m.name);
      baselined.push(m.name);
      return;
    }

    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      record.run(m.name);
    });
    tx();
    applied.push(m.name);
  };

  for (const m of MIGRATIONS) runOne(m);

  return { applied, baselined, schemaVersion: MIGRATIONS.length };
}
