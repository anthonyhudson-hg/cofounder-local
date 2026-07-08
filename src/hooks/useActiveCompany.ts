import { useCallback, useEffect, useState } from "react";
import { Company } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";
import { getActiveCompanyId } from "../lib/activeCompany";

/**
 * The active company, now sourced from the runtime (was tauri-plugin-sql). Reloads
 * on any company.* event so switches/edits reflect immediately.
 */
export function useActiveCompany() {
  const [company, setCompany] = useState<Company | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const [companies, activeId] = await Promise.all([
      query<Company[]>("companies.list", {}, null),
      getActiveCompanyId(),
    ]);
    setCompany(companies.find((c) => c.id === activeId) ?? companies[0] ?? null);
    setLoaded(true);
  }, []);

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
