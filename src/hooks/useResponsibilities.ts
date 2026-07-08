import { useCallback, useEffect, useState } from "react";
import { Responsibility } from "../types";
import { command, query } from "../lib/runtimeClient";

export function useResponsibilities(employeeId: string) {
  const [responsibilities, setResponsibilities] = useState<Responsibility[]>([]);

  const reload = useCallback(async () => {
    setResponsibilities(await query<Responsibility[]>("responsibilities.list", { employeeId }, null));
  }, [employeeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const add = useCallback(
    async (text: string) => {
      await command("responsibility.add", { employeeId, text }, null);
      await reload();
    },
    [employeeId, reload],
  );

  const update = useCallback(async (id: string, text: string) => {
    await command("responsibility.update", { id, text }, null);
    setResponsibilities((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await command("responsibility.remove", { id }, null);
    setResponsibilities((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return { responsibilities, add, update, remove, reload };
}
