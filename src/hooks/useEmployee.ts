import { useCallback, useEffect, useState } from "react";
import { Employee } from "../types";
import { command, query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

export function useEmployee(conversationId: string | null) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!conversationId) {
      if (isCurrent(token)) {
        setEmployee(null);
        setLoaded(true);
      }
      return;
    }
    const row = await query<Employee | null>("employees.byConversation", { conversationId }, null);
    if (!isCurrent(token)) return; // report §1.3: a newer reload superseded this one
    setEmployee(row);
    setLoaded(true);
  }, [conversationId, begin, isCurrent]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  const updateField = useCallback(
    async <K extends keyof Employee>(field: K, value: Employee[K]) => {
      if (!employee || !conversationId) return;
      await command("employee.update", { conversationId, field, value }, null);
      setEmployee((prev) => (prev ? { ...prev, [field]: value } : prev));
    },
    [employee, conversationId],
  );

  return { employee, loaded, updateField, reload };
}
