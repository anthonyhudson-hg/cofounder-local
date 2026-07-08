import { useCallback, useEffect, useState } from "react";
import { Company } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";
import { getActiveCompanyId } from "../lib/activeCompany";
import { useStaleGuard } from "./useStaleGuard";

/**
 * The active company, now sourced from the runtime (was tauri-plugin-sql). Reloads
 * on any company.* event so switches/edits reflect immediately.
 */
export function useActiveCompany() {
  const [company, setCompany] = useState<Company | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    const [companies, activeId] = await Promise.all([
      query<Company[]>("companies.list", {}, null),
      getActiveCompanyId(),
    ]);
    // A burst of company.* events (e.g. create + rename) can fire overlapping reloads;
    // only the most recently started one may commit (report §1.3).
    if (!isCurrent(token)) return;
    setCompany(companies.find((c) => c.id === activeId) ?? companies[0] ?? null);
    setLoaded(true);
  }, [begin, isCurrent]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => onRuntimeEvent((e) => { if (e.type.startsWith("company.")) void reload(); }),
    [reload],
  );

  const updateField = useCallback(
    async <K extends keyof Company>(field: K, value: Company[K]) => {
      if (!company) return;
      await command("company.update", { companyId: company.id, field, value }, null);
      setCompany((prev) => (prev ? { ...prev, [field]: value } : prev));
    },
    [company],
  );

  return { company, loaded, updateField, reload };
}
