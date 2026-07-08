import { command, query } from "./runtimeClient";

/**
 * Active-company accessors, now backed by the runtime (was tauri-plugin-sql on
 * the `settings` table). The runtime is the sole DB owner.
 */
export async function getActiveCompanyId(): Promise<string | null> {
  const r = await query<{ activeCompanyId: string | null }>("company.active", {}, null);
  return r.activeCompanyId;
}

export async function setActiveCompanyId(companyId: string): Promise<void> {
  await command("company.setActive", { companyId }, null);
}
