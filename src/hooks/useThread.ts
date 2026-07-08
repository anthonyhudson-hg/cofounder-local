import { useCallback, useEffect, useState } from "react";
import { Message } from "../types";
import { query } from "../lib/runtimeClient";

export function useThread(conversationId: string, threadRootId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);

  const reload = useCallback(async () => {
    if (!threadRootId) {
      setMessages([]);
      return;
    }
    setMessages(await query<Message[]>("messages.thread", { conversationId, threadRootId }, null));
  }, [conversationId, threadRootId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { messages, reload };
}
