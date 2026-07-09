import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";

export function useNotificationPreference() {
  const [enabled, setEnabledState] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await query<{ enabled: boolean }>("notifications.pref", {}, null);
        if (!cancelled) setEnabledState(r.enabled);
      } catch {
        // keep the default (enabled) on failure
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (value: boolean) => {
    setEnabledState(value);
    await command("notifications.setPref", { enabled: value }, null);
  }, []);

  return { enabled, setEnabled, loaded };
}
