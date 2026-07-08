import { useCallback, useEffect, useState } from "react";
import { Employee } from "../types";
import { command, query } from "../lib/runtimeClient";

export function useEmployee(conversationId: string | null) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!conversationId) {
      setEmployee(null);
      setLoaded(true);
      return;
    }
    const row = await query<Employee | null>("employees.byConversation", { conversationId }, null);
    setEmployee(row);
    setLoaded(true);
  }, [conversationId]);

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
