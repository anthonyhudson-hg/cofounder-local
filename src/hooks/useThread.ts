import { useCallback, useEffect, useState } from "react";
import { Message } from "../types";
import { query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

export function useThread(conversationId: string, threadRootId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!threadRootId) {
      if (isCurrent(token)) setMessages([]);
      return;
    }
    const rows = await query<Message[]>("messages.thread", { conversationId, threadRootId }, null);
    if (!isCurrent(token)) return; // report §1.3: a newer reload superseded this one
    setMessages(rows);
  }, [conversationId, threadRootId, begin, isCurrent]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { messages, reload };
}
