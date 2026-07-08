import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";

export function useUserProfile() {
  const [userFullName, setUserFullNameState] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await query<{ userFullName: string }>("userProfile.get", {}, null);
      setUserFullNameState(r.userFullName);
      setLoaded(true);
    })();
  }, []);

  const setUserFullName = useCallback(async (value: string) => {
    setUserFullNameState(value);
    await command("userProfile.set", { userFullName: value }, null);
  }, []);

  return { userFullName, setUserFullName, loaded };
}
