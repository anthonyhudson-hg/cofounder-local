import { useCallback, useEffect, useState } from "react";
import { Conversation } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";

export function useConversations(companyId: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!companyId) {
      setConversations([]);
      setLoaded(true);
      return;
    }
    const rows = await query<Conversation[]>("conversations.list", {}, companyId);
    setConversations(rows);
    setLoaded(true);
  }, [companyId]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  useEffect(
    () =>
      onRuntimeEvent((e) => {
        if (e.type.startsWith("conversation.") || e.type.startsWith("employee.") || e.type === "company.onboarded") void reload();
      }),
    [reload],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      await command("conversation.rename", { conversationId: id, name }, companyId);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
    },
    [companyId],
  );

  const channels = conversations.filter((c) => c.kind === "channel");
  const dms = conversations.filter((c) => c.kind === "dm");

  return { conversations, channels, dms, loaded, rename, reload };
}
