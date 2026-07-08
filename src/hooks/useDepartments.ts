import { useCallback, useEffect, useState } from "react";
import { Department } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";

export function useDepartments(companyId: string | null) {
  const [departments, setDepartments] = useState<Department[]>([]);

  const reload = useCallback(async () => {
    if (!companyId) {
      setDepartments([]);
      return;
    }
    setDepartments(await query<Department[]>("departments.list", {}, companyId));
  }, [companyId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => onRuntimeEvent((e) => { if (e.type.startsWith("department.")) void reload(); }),
    [reload],
  );

  const create = useCallback(
    async (name: string): Promise<Department | null> => {
      if (!companyId || !name.trim()) return null;
      const dept = await command<Department | null>("department.create", { name }, companyId);
      await reload();
      return dept;
    },
    [companyId, reload],
  );

  return { departments, reload, create };
}
