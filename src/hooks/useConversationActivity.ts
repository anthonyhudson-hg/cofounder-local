import { useCallback, useEffect, useState } from "react";
import { onRuntimeEvent, query } from "../lib/runtimeClient";

export function useConversationActivity(companyId: string | null) {
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!companyId) {
      setActiveIds(new Set());
      return;
    }
    const ids = await query<string[]>("conversations.activity", {}, companyId);
    setActiveIds(new Set(ids));
  }, [companyId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => onRuntimeEvent((e) => { if (e.type === "message.created") void reload(); }),
    [reload],
  );

  return { activeIds, reload };
}
