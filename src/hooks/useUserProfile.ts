import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";

export function useUserProfile() {
  const [userFullName, setUserFullNameState] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await query<{ userFullName: string }>("userProfile.get", {}, null);
        if (!cancelled) setUserFullNameState(r.userFullName);
      } catch {
        // keep the default (empty) on failure
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setUserFullName = useCallback(async (value: string) => {
    setUserFullNameState(value);
    await command("userProfile.set", { userFullName: value }, null);
  }, []);

  return { userFullName, setUserFullName, loaded };
}
