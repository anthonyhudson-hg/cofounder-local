import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useEffect, useRef } from "react";
import { command } from "../lib/runtimeClient";

interface PendingRow {
  id: string;
  content: string;
  conversation_id: string;
  conversation_name: string;
  company_name: string | null;
}

const POLL_INTERVAL_MS = 4000;

/**
 * Raises native desktop notifications for new assistant messages across every
 * company. The runtime owns the durable `notified_at` marker (baseline + drain
 * commands); this hook just polls the drain and shows the OS notification.
 */
export function useDesktopNotifications(enabled: boolean, activeConversationId: string) {
  const activeConversationIdRef = useRef(activeConversationId);
  const enabledRef = useRef(enabled);
  const permissionGrantedRef = useRef(false);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    let baselined = false;

    (async () => {
      permissionGrantedRef.current = await isPermissionGranted();
      if (!permissionGrantedRef.current) {
        const permission = await requestPermission();
        permissionGrantedRef.current = permission === "granted";
      }
    })();

    const tick = async () => {
      if (!baselined) {
        await command("notifications.baseline", {}, null);
        baselined = true;
        return;
      }

      const { pending } = await command<{ pending: PendingRow[] }>("notifications.drain", {}, null);
      if (cancelled || pending.length === 0) return;
      if (!enabledRef.current || !permissionGrantedRef.current) return;

      const isFocused = await getCurrentWindow().isFocused();
      for (const row of pending) {
        if (isFocused && row.conversation_id === activeConversationIdRef.current) continue;
        try {
          await sendNotification({
            title: row.company_name ? `${row.company_name} · ${row.conversation_name}` : row.conversation_name,
            body: row.content.slice(0, 180),
          });
        } catch {
          // notifications are best-effort
        }
      }
    };

    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
}
