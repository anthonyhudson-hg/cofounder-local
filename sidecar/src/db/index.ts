import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database as Db } from "./schema";

export type BetterSqlite = Database.Database;

/**
 * Resolves the SQLite file the runtime owns. Priority:
 *   1. COFOUNDER_DB_PATH (passed by the Rust host = the Tauri app-config dir)
 *   2. a stable local dev fallback under the OS temp dir
 * The client no longer opens this file directly — the runtime is the sole owner.
 */
export function resolveDbPath(): string {
  const fromEnv = process.env.COFOUNDER_DB_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.tmpdir(), "cofounder-dev.db");
}

/** Opens the underlying better-sqlite3 handle with WAL + FK enforcement. */
export function openSqlite(dbPath: string): BetterSqlite {
  const sqlite = new Database(dbPath);
  // WAL lets the runtime write while the (transitional) Rust reader reads the
  // same file without lock contention; foreign_keys enforces referential integrity.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

/** Wraps a better-sqlite3 handle in a typed Kysely instance. */
export function createKysely(sqlite: BetterSqlite): Kysely<Db> {
  return new Kysely<Db>({ dialect: new SqliteDialect({ database: sqlite }) });
}
