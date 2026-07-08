import { useCallback } from "react";
import { command } from "../lib/runtimeClient";

export function useCreateGroup(companyId: string | null) {
  const create = useCallback(
    async (name: string, employeeIds: string[]): Promise<string> => {
      if (!companyId) throw new Error("No active company");
      const r = await command<{ conversationId: string }>("group.create", { name, employeeIds }, companyId);
      return r.conversationId;
    },
    [companyId],
  );

  return { create };
}
