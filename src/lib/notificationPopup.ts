import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MessageTarget } from "./search";

/** Data the main window sends to the popup window to render one notification card. */
export interface NotificationPayload {
  conversationId: string;
  messageId: string;
  threadRootId: string | null;
  /** "dm" | "channel" — the popup only shows an inline reply box for DMs. */
  conversationKind: string;
  title: string;
  sender: string;
  body: string;
  avatar: string | null;
}

const LABEL = "notification";
export const NOTIF_PUSH = "notif://push";
export const NOTIF_READY = "notif://ready";
export const NOTIF_OPEN = "notif://open";

let creating: Promise<void> | null = null;
let popupReady = false;
let buffered: NotificationPayload | null = null;
let readyListenerStarted = false;

async function startReadyListener() {
  if (readyListenerStarted) return;
  readyListenerStarted = true;
  // The popup announces itself once mounted; flush anything that arrived first.
  await listen(NOTIF_READY, () => {
    popupReady = true;
    if (buffered) {
      const p = buffered;
      buffered = null;
      void emitTo(LABEL, NOTIF_PUSH, p);
    }
  });
}

/**
 * Idempotently creates the hidden always-on-top popup window that renders custom
 * notifications. Throws if window creation fails, so callers can fall back to an OS
 * notification. Safe to call repeatedly (StrictMode double-mount included).
 */
export async function ensureNotificationWindow(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    await startReadyListener();
    const existing = await WebviewWindow.getByLabel(LABEL);
    if (existing) return;

    const win = new WebviewWindow(LABEL, {
      url: "index.html?window=notification",
      width: 380,
      height: 168,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      visible: false,
      transparent: true,
      shadow: true,
      title: "Cofounder notification",
    });

    await new Promise<void>((resolve, reject) => {
      win.once("tauri://created", () => resolve()).catch(reject);
      win.once("tauri://error", (e) => reject(new Error(String(e.payload)))).catch(reject);
    });
  })();
  try {
    await creating;
  } catch (err) {
    creating = null; // allow a later retry / fallback
    throw err;
  }
}

/** Shows one notification in the popup window (buffered until the popup is ready). */
export async function pushNotification(payload: NotificationPayload): Promise<void> {
  await ensureNotificationWindow();
  if (popupReady) {
    await emitTo(LABEL, NOTIF_PUSH, payload);
  } else {
    buffered = payload; // one-slot buffer — newest wins until the popup signals ready
  }
}

/** Subscribe to the popup's "Open in app" action. */
export function onNotificationOpen(cb: (target: MessageTarget) => void): Promise<UnlistenFn> {
  return listen<MessageTarget>(NOTIF_OPEN, (e) => cb(e.payload));
}
