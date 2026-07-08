import { useCallback, useEffect, useState } from "react";
import { Employee } from "../types";
import { onRuntimeEvent, query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

export function useEmployees(companyId: string | null) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!companyId) {
      if (isCurrent(token)) setEmployees([]);
      return;
    }
    const rows = await query<Employee[]>("employees.list", {}, companyId);
    if (!isCurrent(token)) return; // report §1.3: a newer reload superseded this one
    setEmployees(rows);
  }, [companyId, begin, isCurrent]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => onRuntimeEvent((e) => { if (e.type.startsWith("employee.") || e.type === "company.onboarded") void reload(); }),
    [reload],
  );

  return { employees, reload };
}
