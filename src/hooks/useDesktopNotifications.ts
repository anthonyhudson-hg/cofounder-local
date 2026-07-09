import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted as tauriIsPermissionGranted,
  requestPermission as tauriRequestPermission,
  sendNotification as tauriSendNotification,
} from "@tauri-apps/plugin-notification";
import { useEffect, useRef } from "react";
import { command } from "../lib/runtimeClient";
import { ensureNotificationWindow, pushNotification } from "../lib/notificationPopup";
import { MessageTarget } from "../lib/search";

interface PendingRow {
  id: string;
  content: string;
  conversation_id: string;
  conversation_name: string;
  conversation_kind: string;
  company_name: string | null;
  thread_root_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
}

const POLL_INTERVAL_MS = 4000;

const webNotificationsSupported = typeof window !== "undefined" && "Notification" in window;

/** Brings the app window to the foreground (from minimized/background) after a notification click. */
async function focusAppWindow() {
  const win = getCurrentWindow();
  try {
    await win.unminimize();
  } catch {
    // best-effort
  }
  try {
    await win.setFocus();
  } catch {
    // best-effort
  }
}

/**
 * Raises desktop notifications for new assistant messages across every company.
 * The runtime owns the durable `notified_at` marker (baseline + drain commands);
 * this hook polls the drain and shows the notification.
 *
 * Primary path is the custom always-on-top popup window (Teams-style card with
 * inline reply — see `lib/notificationPopup.ts`). If that can't be created we fall
 * back to a web notification (clickable → jumps to the message), and finally to the
 * Tauri plugin toast (display-only; its click event is mobile-only).
 */
export function useDesktopNotifications(
  enabled: boolean,
  activeConversationId: string,
  onOpenMessage: (target: MessageTarget) => void,
) {
  const activeConversationIdRef = useRef(activeConversationId);
  const enabledRef = useRef(enabled);
  const onOpenMessageRef = useRef(onOpenMessage);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    onOpenMessageRef.current = onOpenMessage;
  }, [onOpenMessage]);

  useEffect(() => {
    let cancelled = false;
    let baselined = false;

    // Warm up: create the popup window, and request OS-notification permission for
    // the fallback path.
    void ensureNotificationWindow().catch(() => {});
    (async () => {
      if (webNotificationsSupported && Notification.permission === "default") {
        try {
          await Notification.requestPermission();
        } catch {
          // ignore
        }
      }
      try {
        if (!(await tauriIsPermissionGranted())) await tauriRequestPermission();
      } catch {
        // ignore
      }
    })();

    const fallbackNotify = (title: string, body: string, target: MessageTarget) => {
      if (webNotificationsSupported && Notification.permission === "granted") {
        try {
          const n = new Notification(title, { body });
          n.onclick = () => {
            n.close();
            void focusAppWindow();
            onOpenMessageRef.current(target);
          };
          return;
        } catch {
          // fall through to the plugin
        }
      }
      try {
        tauriSendNotification({ title, body });
      } catch {
        // notifications are best-effort
      }
    };

    const notify = async (row: PendingRow) => {
      const title = row.company_name ? `${row.company_name} · ${row.conversation_name}` : row.conversation_name;
      const sender = row.author_name ?? row.conversation_name;
      const body = row.content.slice(0, 180);
      const target: MessageTarget = { conversationId: row.conversation_id, messageId: row.id, threadRootId: row.thread_root_id };
      try {
        await pushNotification({ ...target, conversationKind: row.conversation_kind, title, sender, body, avatar: row.author_avatar });
      } catch {
        fallbackNotify(title, body, target);
      }
    };

    const tick = async () => {
      if (!baselined) {
        await command("notifications.baseline", {}, null);
        baselined = true;
        return;
      }

      const { pending } = await command<{ pending: PendingRow[] }>("notifications.drain", {}, null);
      if (cancelled || pending.length === 0) return;
      if (!enabledRef.current) return;

      const isFocused = await getCurrentWindow().isFocused();
      for (const row of pending) {
        if (isFocused && row.conversation_id === activeConversationIdRef.current) continue;
        await notify(row);
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
