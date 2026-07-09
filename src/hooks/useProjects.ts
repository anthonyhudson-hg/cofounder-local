import { useCallback, useEffect, useState } from "react";
import { command, onRuntimeEvent, query, startRuntimeBus } from "../lib/runtimeClient";
import { Project } from "../types";
import { useStaleGuard } from "./useStaleGuard";

/** The company's registered projects (codebases agents can work in), kept live. */
export function useProjects(companyId: string | null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!companyId) {
      if (isCurrent(token)) {
        setProjects([]);
        setLoaded(true);
      }
      return;
    }
    const rows = await query<Project[]>("projects.list", {}, companyId);
    if (!isCurrent(token)) return;
    setProjects(rows);
    setLoaded(true);
  }, [companyId, begin, isCurrent]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  useEffect(() => {
    void startRuntimeBus();
    return onRuntimeEvent((e) => {
      if (e.type.startsWith("project.")) void reload();
    });
  }, [reload]);

  const create = useCallback(
    async (name: string, rootPath: string) => {
      if (!companyId) throw new Error("No active company");
      await command("project.create", { name, rootPath }, companyId);
      await reload();
    },
    [companyId, reload],
  );

  const remove = useCallback(
    async (projectId: string) => {
      if (!companyId) return;
      await command("project.remove", { projectId }, companyId);
      await reload();
    },
    [companyId, reload],
  );

  return { projects, loaded, create, remove, reload };
}
