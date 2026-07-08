import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";

export function useNotificationPreference() {
  const [enabled, setEnabledState] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await query<{ enabled: boolean }>("notifications.pref", {}, null);
      setEnabledState(r.enabled);
      setLoaded(true);
    })();
  }, []);

  const setEnabled = useCallback(async (value: boolean) => {
    setEnabledState(value);
    await command("notifications.setPref", { enabled: value }, null);
  }, []);

  return { enabled, setEnabled, loaded };
}
