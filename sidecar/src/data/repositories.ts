import type { Kysely } from "kysely";
import type { Database } from "../db/schema";

/**
 * The structural company-scoping boundary (refactor #1). All reads/writes of
 * company-owned data go through `repos.forCompany(companyId)`, whose every query
 * is pre-filtered by that id — so cross-company leakage is impossible by
 * construction rather than by remembering a WHERE clause. Root/unscoped tables
 * (companies, settings) are reached via the top-level repo.
 *
 * Domain repositories are added here as each domain is strangled onto the
 * runtime (Phase C). Phase A ships the accessor shape + two proofs.
 */
export interface ScopedRepositories {
  readonly companyId: string;
  listConversations(): Promise<{ id: string; kind: string; name: string }[]>;
}

export interface Repositories {
  readonly db: Kysely<Database>;
  countCompanies(): Promise<number>;
  forCompany(companyId: string): ScopedRepositories;
}

export function createRepositories(db: Kysely<Database>): Repositories {
  return {
    db,

    async countCompanies() {
      const row = await db
        .selectFrom("companies")
        .select(db.fn.countAll<number>().as("n"))
        .executeTakeFirstOrThrow();
      return Number(row.n);
    },

    forCompany(companyId: string): ScopedRepositories {
      // Every query built here is bound to companyId. Handlers never receive an
      // unscoped db handle for company-owned data.
      return {
        companyId,
        async listConversations() {
          return db
            .selectFrom("conversations")
            .where("company_id", "=", companyId)
            .select(["id", "kind", "name"])
            .orderBy("created_at")
            .execute();
        },
      };
    },
  };
}
