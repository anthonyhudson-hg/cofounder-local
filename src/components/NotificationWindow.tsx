import { ArrowRight, X } from "@phosphor-icons/react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import "../App.css";
import { commandStreaming, query, startRuntimeBus } from "../lib/runtimeClient";
import { NOTIF_OPEN, NOTIF_PUSH, NOTIF_READY, type NotificationPayload } from "../lib/notificationPopup";
import { DEFAULT_MODEL_ID, Effort, Employee, modelProvider } from "../types";
import { Avatar } from "./Avatar";

const AUTO_DISMISS_MS = 10_000;
const MARGIN = 16;

/** Positions the popup in the bottom-right of the current monitor's work area. */
async function positionBottomRight(win: ReturnType<typeof getCurrentWindow>) {
  try {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const size = await win.outerSize();
    const scale = monitor.scaleFactor;
    // Tauri's Monitor reports full screen size, not the work area, so reserve the
    // taskbar. Derive its thickness from the webview's own work-area gap
    // (screen.height − availHeight, in CSS px) instead of a hardcoded guess — this
    // adapts to different taskbar sizes and collapses to ~0 when it auto-hides.
    const taskbarCssPx = Math.max(0, window.screen.height - window.screen.availHeight);
    const x = monitor.position.x + monitor.size.width - size.width - Math.round(MARGIN * scale);
    const y = monitor.position.y + monitor.size.height - size.height - Math.round((MARGIN + taskbarCssPx) * scale);
    await win.setPosition(new PhysicalPosition(x, y));
  } catch {
    // best-effort positioning
  }
}

/**
 * The custom always-on-top notification popup (a separate Tauri window rendering the
 * same bundle via ?window=notification). Shows one message card with an inline reply;
 * on send it fires the DM turn and dismisses, letting the main app surface the reply.
 */
export function NotificationWindow() {
  const [current, setCurrent] = useState<NotificationPayload | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredRef = useRef(false);
  const inputFocusedRef = useRef(false);

  const win = getCurrentWindow();

  const dismiss = async () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    try {
      await win.hide();
    } catch {
      // best-effort
    }
    setCurrent(null);
    setReplyText("");
    setSent(false);
    setSending(false);
  };

  const scheduleDismiss = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => {
      if (hoveredRef.current || inputFocusedRef.current) scheduleDismiss();
      else void dismiss();
    }, AUTO_DISMISS_MS);
  };

  useEffect(() => {
    // This window is transparent — clear the shared bundle's opaque page background.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    void startRuntimeBus();
    let unlisten: UnlistenFn | undefined;
    (async () => {
      unlisten = await listen<NotificationPayload>(NOTIF_PUSH, async (e) => {
        setCurrent(e.payload);
        setReplyText("");
        setSent(false);
        setSending(false);
        await positionBottomRight(win);
        try {
          await win.show();
          await win.setAlwaysOnTop(true);
        } catch {
          // best-effort
        }
        scheduleDismiss();
      });
      await emit(NOTIF_READY, {});
    })();
    return () => {
      unlisten?.();
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openInApp = async () => {
    if (!current) return;
    await emit(NOTIF_OPEN, {
      conversationId: current.conversationId,
      messageId: current.messageId,
      threadRootId: current.threadRootId,
    });
    await dismiss();
  };

  const sendReply = async () => {
    const text = replyText.trim();
    // Inline reply is DM-only: the send path below resolves the conversation's
    // single employee and streams a DM turn, which doesn't exist for a channel
    // (employees.byConversation returns null there). The UI hides the input for
    // non-DMs, but guard here too so a stray call can't silently no-op.
    if (!text || !current || sending || current.conversationKind !== "dm") return;
    setSending(true);
    try {
      const emp = await query<Employee | null>("employees.byConversation", { conversationId: current.conversationId }, null);
      if (!emp) throw new Error("no employee for this conversation");
      const model = emp.default_model || DEFAULT_MODEL_ID;
      const effort = (emp.default_effort || "medium") as Effort;
      // Fire the turn but don't block the popup on the full model response — the
      // runtime persists the user message immediately and the main window surfaces
      // the employee's reply.
      void commandStreaming(
        "message.send",
        { conversationId: current.conversationId, text, model, effort, provider: modelProvider(model), replyTo: null },
        emp.company_id,
        () => {},
      ).catch(() => {});
      setSent(true);
      setTimeout(() => void dismiss(), 1200);
    } catch {
      setSending(false);
    }
  };

  if (!current) return <div className="notif-root" />;

  return (
    <div
      className="notif-root"
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
    >
      <div className="notif-card">
        <button className="notif-close" aria-label="Dismiss" onClick={() => void dismiss()}>
          <X weight="bold" />
        </button>
        <div className="notif-head">
          <Avatar name={current.sender} avatar={current.avatar} bot className="notif-avatar" />
          <div className="notif-headtext">
            <div className="notif-title">{current.title}</div>
            <div className="notif-sender">{current.sender}</div>
          </div>
        </div>
        <div className="notif-body">{current.body}</div>

        {sent ? (
          <div className="notif-sent">Sent ✓</div>
        ) : current.conversationKind === "dm" ? (
          <div className="notif-actions">
            <input
              className="notif-reply-input"
              placeholder={`Reply to ${current.sender}…`}
              value={replyText}
              autoFocus
              spellCheck={false}
              disabled={sending}
              onFocus={() => (inputFocusedRef.current = true)}
              onBlur={() => (inputFocusedRef.current = false)}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void sendReply();
                } else if (e.key === "Escape") {
                  void dismiss();
                }
              }}
            />
            <button className="notif-send" aria-label="Send reply" disabled={!replyText.trim() || sending} onClick={() => void sendReply()}>
              <ArrowRight weight="bold" />
            </button>
            <button className="notif-open" onClick={() => void openInApp()}>
              Open
            </button>
          </div>
        ) : (
          // Inline reply is DM-only (see sendReply). For a channel/group post there's
          // no single employee to stream a turn to, so offer Open only rather than a
          // reply box that would silently fail.
          <div className="notif-actions notif-actions-open-only">
            <button className="notif-open" onClick={() => void openInApp()}>
              Open
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
