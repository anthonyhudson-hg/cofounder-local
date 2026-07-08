import type { RuntimeContext } from "../../runtime/context";

/**
 * Shared key/value accessors for the `settings` table. Previously `companies/service.ts`
 * (`getActiveCompanyId`/`setActiveCompanyId`) and `settings/service.ts` each implemented
 * the identical get/set-setting SQL shape independently (report §1.7).
 */
export async function getSetting(ctx: RuntimeContext, key: string): Promise<string | null> {
  const row = await ctx.db.selectFrom("settings").where("key", "=", key).select("value").executeTakeFirst();
  return row?.value ?? null;
}

export async function setSetting(ctx: RuntimeContext, key: string, value: string): Promise<void> {
  await ctx.db
    .insertInto("settings")
    .values({ key, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}
