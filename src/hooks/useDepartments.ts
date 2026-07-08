import { useCallback, useEffect, useState } from "react";
import { Department } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

export function useDepartments(companyId: string | null) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!companyId) {
      if (isCurrent(token)) setDepartments([]);
      return;
    }
    const rows = await query<Department[]>("departments.list", {}, companyId);
    if (!isCurrent(token)) return; // report §1.3: a newer reload superseded this one
    setDepartments(rows);
  }, [companyId, begin, isCurrent]);

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
