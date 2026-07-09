import { useCallback, useEffect, useState } from "react";
import { onRuntimeEvent, query, startRuntimeBus } from "../lib/runtimeClient";
import { Task } from "../types";
import { useStaleGuard } from "./useStaleGuard";

/** All tasks for the active company (work in projects), kept live via task.* events. */
export function useTasks(companyId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    const token = begin();
    if (!companyId) {
      if (isCurrent(token)) {
        setTasks([]);
        setLoaded(true);
      }
      return;
    }
    const rows = await query<Task[]>("tasks.list", {}, companyId);
    if (!isCurrent(token)) return;
    setTasks(rows);
    setLoaded(true);
  }, [companyId, begin, isCurrent]);

  useEffect(() => {
    setLoaded(false);
    reload();
  }, [reload]);

  useEffect(() => {
    void startRuntimeBus();
    return onRuntimeEvent((e) => {
      if (e.type.startsWith("task.")) void reload();
    });
  }, [reload]);

  return { tasks, loaded, reload };
}
