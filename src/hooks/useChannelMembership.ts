import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";

export function useChannelMembership(employeeId: string) {
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const ids = await query<string[]>("memberships.forEmployee", { employeeId }, null);
    setMemberOf(new Set(ids));
  }, [employeeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggle = useCallback(
    async (channelId: string) => {
      await command("membership.toggle", { conversationId: channelId, employeeId }, null);
      await reload();
    },
    [employeeId, reload],
  );

  return { memberOf, toggle };
}
