import { useCallback, useEffect, useState } from "react";
import { Employee } from "../types";
import { onRuntimeEvent, query } from "../lib/runtimeClient";

export function useEmployees(companyId: string | null) {
  const [employees, setEmployees] = useState<Employee[]>([]);

  const reload = useCallback(async () => {
    if (!companyId) {
      setEmployees([]);
      return;
    }
    setEmployees(await query<Employee[]>("employees.list", {}, companyId));
  }, [companyId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => onRuntimeEvent((e) => { if (e.type.startsWith("employee.") || e.type === "company.onboarded") void reload(); }),
    [reload],
  );

  return { employees, reload };
}
