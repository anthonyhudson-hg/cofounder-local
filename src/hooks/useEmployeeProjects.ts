import { useCallback, useEffect, useState } from "react";
import { command, query } from "../lib/runtimeClient";
import { useStaleGuard } from "./useStaleGuard";

/** The set of projects an employee is scoped to (its project allowlist), plus a
 *  setter that replaces it. Company-global employees; only this scoping ties an
 *  employee to specific codebases. */
export function useEmployeeProjects(companyId: string | null, employeeId: string) {
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!employeeId) {
      if (isCurrent(token)) {
        setProjectIds([]);
        setLoaded(true);
      }
      return;
    }
    const ids = await query<string[]>("employee.projects", { employeeId }, null);
    if (!isCurrent(token)) return;
    setProjectIds(ids);
    setLoaded(true);
  }, [employeeId, begin, isCurrent]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  const setProjects = useCallback(
    async (ids: string[]) => {
      setProjectIds(ids); // optimistic
      await command("employee.setProjects", { employeeId, projectIds: ids }, companyId);
    },
    [companyId, employeeId],
  );

  const toggle = useCallback(
    (projectId: string) => {
      const next = projectIds.includes(projectId) ? projectIds.filter((id) => id !== projectId) : [...projectIds, projectId];
      void setProjects(next);
    },
    [projectIds, setProjects],
  );

  return { projectIds, loaded, setProjects, toggle };
}
