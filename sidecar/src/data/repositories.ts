import type { Kysely } from "kysely";
import type { Database } from "../db/schema";

/**
 * A company-scoping boundary: `repos.forCompany(companyId)` pre-filters every
 * query it exposes by that id, so cross-company leakage would be impossible by
 * construction for anything routed through it. IMPORTANT — this is NOT yet the
 * actual safety net for most of the app: `listConversations` here is exercised
 * only by the test suite; the `listConversations` actually wired to the UI lives
 * in `domains/conversations/service.ts` as a separate implementation that talks
 * to `ctx.db` directly with its own manual `.where("company_id", ...)`, and every
 * other domain service (messages, reactions, employees, agent sessions, etc.)
 * follows that same direct-`ctx.db` pattern, not this one. Don't assume anything
 * outside this file is protected by it — until domain services are migrated to
 * route through `repos.forCompany()`, cross-company scoping correctness depends
 * on each service remembering its own WHERE clause, same as usual. Migrating the
 * domains onto this accessor is tracked as a follow-up.
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
