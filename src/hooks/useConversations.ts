import { useCallback, useEffect, useState } from "react";
import { Conversation } from "../types";
import { command, onRuntimeEvent, query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

export function useConversations(companyId: string | null) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!companyId) {
      if (isCurrent(token)) {
        setConversations([]);
        setLoaded(true);
      }
      return;
    }
    const rows = await query<Conversation[]>("conversations.list", {}, companyId);
    // Discard if a newer reload (e.g. a company switch) started after this one — report §1.3.
    if (!isCurrent(token)) return;
    setConversations(rows);
    setLoaded(true);
  }, [companyId, begin, isCurrent]);

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
