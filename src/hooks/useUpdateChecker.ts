import { useCallback, useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Checks for an app update once on mount, and exposes a manual re-check plus
 * an install action (download, install, relaunch). A failed check (no
 * release published yet, transient network error) fails silently — this
 * fires unprompted on every launch, so it must never surface a scary error
 * for something the user didn't ask for.
 */
export function useUpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      const result = await check();
      setUpdate(result);
      if (result) setDismissed(false);
    } catch (err) {
      console.error("[update] check failed", err);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkNow();
  }, [checkNow]);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (err) {
      console.error("[update] install failed", err);
      setInstalling(false);
    }
  }, [update]);

  return {
    available: !dismissed && update !== null,
    version: update?.version ?? null,
    checking,
    installing,
    checkNow,
    install,
    dismiss: () => setDismissed(true),
  };
}
