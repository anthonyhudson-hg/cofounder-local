import { useEffect } from "react";

/**
 * Calls `onClose` when Escape is pressed while `active` is true. None of the app's
 * modals/popovers handled Escape before this (report §1.6) — click-outside worked
 * everywhere it should, but keyboard-only users had no way to dismiss any of them.
 */
export function useEscapeToClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [active, onClose]);
}
