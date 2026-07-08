import { listen } from "@tauri-apps/api/event";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export type SidecarEvent =
  | { type: "ready" }
  | { type: "delta"; id: string; text: string }
  | {
      type: "done";
      id: string;
      sessionId: string | null;
      success: boolean;
      usage: Usage;
      totalCostUsd: number;
    }
  | { type: "error"; id: string; message: string }
  | { type: "token_count"; id: string; tokens: number; exact: boolean }
  | { type: "relevance_result"; id: string; respond: boolean; reason: string }
  | {
      type: "channel_result";
      id: string;
      respondsWithText: boolean;
      text: string;
      replyToMessageId: string | null;
      threadRootId: string | null;
      reactions: { messageId: string; emoji: string }[];
      sessionId: string | null;
      success: boolean;
      usage: Usage;
      totalCostUsd: number;
    };

type Handler = (event: SidecarEvent) => void;

const handlers = new Map<string, Handler>();
let started = false;

export function registerRequestHandler(id: string, handler: Handler): void {
  handlers.set(id, handler);
}

export function unregisterRequestHandler(id: string): void {
  handlers.delete(id);
}

export async function startSidecarBus(): Promise<void> {
  if (started) return;
  started = true;
  await listen<SidecarEvent>("cos://event", (event) => {
    const payload = event.payload;
    if (payload.type === "ready") return;
    const handler = handlers.get(payload.id);
    if (handler) handler(payload);
  });
}
