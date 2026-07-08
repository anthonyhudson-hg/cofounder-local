import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { registerRequestHandler, unregisterRequestHandler } from "../lib/sidecarBus";
import { modelProvider } from "../types";

export function useTokenCount(text: string, model: string) {
  const [tokens, setTokens] = useState<number | null>(null);
  const [exact, setExact] = useState(true);
  const lastRequestId = useRef<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (lastRequestId.current) {
        unregisterRequestHandler(lastRequestId.current);
      }
      const id = crypto.randomUUID();
      lastRequestId.current = id;

      registerRequestHandler(id, (event) => {
        if (event.type === "token_count") {
          setTokens(event.tokens);
          setExact(event.exact);
        } else if (event.type === "error") {
          // Timed out or the sidecar rejected the request: don't leave the UI implying
          // a stale count is current — mark it approximate instead (report §5.9).
          setExact(false);
        }
        unregisterRequestHandler(id);
      });

      invoke("cos_count_tokens", { id, provider: modelProvider(model), model, systemPrompt: text }).catch(() => {
        unregisterRequestHandler(id);
      });
    }, 500);

    return () => {
      clearTimeout(handle);
      if (lastRequestId.current) unregisterRequestHandler(lastRequestId.current);
    };
  }, [text, model]);

  return { tokens, exact };
}
