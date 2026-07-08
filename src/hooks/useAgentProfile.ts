import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";
import { AgentProfile } from "../types";

const EMPTY_PROFILE: AgentProfile = {
  personality: "",
  communicationStyle: "",
  expertise: [],
  autonomyLevel: "act-with-approval",
};

export function useAgentProfile(employeeId: string) {
  const [profile, setProfile] = useState<AgentProfile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const row = await query<AgentProfile>("agentProfile.get", { employeeId }, null);
    setProfile(row);
    setLoaded(true);
  }, [employeeId]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  const updateField = useCallback(
    async <K extends keyof AgentProfile>(field: K, value: AgentProfile[K]) => {
      // "expertise" is stored server-side as a JSON-encoded string[] — matches
      // the column's own storage format rather than inventing a second wire
      // encoding (see sidecar/src/domains/employees/service.ts).
      const wireValue = field === "expertise" ? JSON.stringify(value) : String(value);
      const wireField = field === "communicationStyle" ? "communication_style" : field === "autonomyLevel" ? "autonomy_level" : field;
      await command("agentProfile.update", { employeeId, field: wireField, value: wireValue }, null);
      setProfile((prev) => ({ ...prev, [field]: value }));
    },
    [employeeId],
  );

  return { profile, loaded, updateField, reload };
}
