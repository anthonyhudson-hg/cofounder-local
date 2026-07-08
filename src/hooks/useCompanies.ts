import { useCallback, useEffect, useState } from "react";
import { Company } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

/**
 * Company list + lifecycle, now backed entirely by the runtime (was
 * tauri-plugin-sql). Create/clone/remove seed + cascade on the runtime side;
 * the list reloads on any company.* event.
 */
export function useCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    const rows = await query<Company[]>("companies.list", {}, null);
    // A burst of company.* events can fire overlapping reloads; only commit the
    // most recently started one (report §1.3).
    if (isCurrent(token)) setCompanies(rows);
    return rows;
  }, [begin, isCurrent]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => onRuntimeEvent((e) => { if (e.type.startsWith("company.")) void reload(); }),
    [reload],
  );

  const create = useCallback(async (name: string): Promise<string> => {
    const r = await command<{ id: string }>("company.create", { name }, null);
    return r.id;
  }, []);

  const update = useCallback(
    async <K extends keyof Company>(companyId: string, field: K, value: Company[K]) => {
      await command("company.update", { companyId, field, value }, null);
    },
    [],
  );

  const rename = useCallback(async (companyId: string, name: string) => {
    await command("company.update", { companyId, field: "name", value: name }, null);
  }, []);

  const clone = useCallback(async (sourceCompanyId: string, newName: string): Promise<string> => {
    const r = await command<{ id: string }>("company.clone", { sourceId: sourceCompanyId, name: newName }, null);
    return r.id;
  }, []);

  const remove = useCallback(async (companyId: string): Promise<string> => {
    const r = await command<{ fallbackId: string }>("company.remove", { companyId }, null);
    return r.fallbackId;
  }, []);

  return { companies, reload, create, update, rename, clone, remove };
}
