import type { Kysely } from "kysely";
import type { Database } from "../db/schema";
import { openSqlite, createKysely, resolveDbPath, type BetterSqlite } from "../db/index";
import { runMigrations, type MigrationResult } from "../db/migrator";
import { createRepositories, type Repositories } from "../data/repositories";
import { EventBus } from "../events/bus";

/** Everything a handler needs. The single place that owns the DB connection. */
export interface RuntimeContext {
  sqlite: BetterSqlite;
  db: Kysely<Database>;
  repos: Repositories;
  bus: EventBus;
  migration: MigrationResult;
  dbPath: string;
}

/** Opens + migrates the runtime's SQLite and assembles the context. */
export function createRuntimeContext(): RuntimeContext {
  const dbPath = resolveDbPath();
  const sqlite = openSqlite(dbPath);
  const migration = runMigrations(sqlite);
  const db = createKysely(sqlite);
  const repos = createRepositories(db);
  const bus = new EventBus();
  return { sqlite, db, repos, bus, migration, dbPath };
}
