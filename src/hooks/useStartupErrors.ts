import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

/**
 * Surfaces sidecar/runtime process spawn failures to the UI. Previously these only
 * went to a console the packaged app's user will never see — the window would open
 * looking fully functional, with every send then failing later with no indication
 * of root cause (report §4.2).
 */
export function useStartupErrors(): string | null {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlistenPromises = [
      listen<string>("cos://startup-error", (e) => setError(`Chief of Staff assistant failed to start: ${e.payload}`)),
      listen<string>("runtime://startup-error", (e) => setError(`Background runtime failed to start: ${e.payload}`)),
    ];
    return () => {
      unlistenPromises.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, []);

  return error;
}
