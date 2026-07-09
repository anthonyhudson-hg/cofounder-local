import { useCallback, useEffect, useState } from "react";
import { onRuntimeEvent, query, startRuntimeBus } from "../lib/runtimeClient";
import { ProjectFile, ProjectTree } from "../types";
import { useStaleGuard } from "./useStaleGuard";

/** Live file tree + per-file git status for a project's linked repo. Polls while
 *  mounted and refreshes on agent activity so the git indicators stay current. */
export function useProjectTree(companyId: string | null, projectId: string | null) {
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    if (!companyId || !projectId) {
      setTree(null);
      return;
    }
    const token = begin();
    try {
      const t = await query<ProjectTree>("project.tree", { projectId }, companyId);
      if (!isCurrent(token)) return;
      setTree(t);
      setError(null);
    } catch (e) {
      if (isCurrent(token)) setError(e instanceof Error ? e.message : String(e));
    }
  }, [companyId, projectId, begin, isCurrent]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!projectId) return;
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [reload, projectId]);

  useEffect(() => {
    void startRuntimeBus();
    return onRuntimeEvent((e) => {
      if (e.type.startsWith("task.") || e.type.startsWith("tool.")) void reload();
    });
  }, [reload]);

  return { tree, error, reload };
}

/** Read-only content of one file in the project's linked repo (for the preview). */
export function useProjectFile(companyId: string | null, projectId: string | null, path: string | null) {
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useStaleGuard();

  useEffect(() => {
    if (!companyId || !projectId || !path) {
      setFile(null);
      setError(null);
      return;
    }
    const token = begin();
    setLoading(true);
    setError(null);
    query<ProjectFile>("project.file", { projectId, path }, companyId)
      .then((f) => {
        if (!isCurrent(token)) return;
        setFile(f);
        setLoading(false);
      })
      .catch((e) => {
        if (!isCurrent(token)) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [companyId, projectId, path, begin, isCurrent]);

  return { file, loading, error };
}

/** Generic loader for a project repo query (commits/branches/pulls/issues). Reloads
 *  on agent-activity events so commits/branches stay fresh; exposes reload for a
 *  manual refresh (used for the remote GitHub queries). */
export function useProjectRepoQuery<T>(queryType: string, companyId: string | null, projectId: string | null, liveOnEvents = false) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { begin, isCurrent } = useStaleGuard();

  const reload = useCallback(async () => {
    if (!companyId || !projectId) {
      setData(null);
      return;
    }
    const token = begin();
    setLoading(true);
    setError(null);
    try {
      const d = await query<T>(queryType, { projectId }, companyId);
      if (!isCurrent(token)) return;
      setData(d);
      setLoading(false);
    } catch (e) {
      if (!isCurrent(token)) return;
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [queryType, companyId, projectId, begin, isCurrent]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!liveOnEvents) return;
    void startRuntimeBus();
    return onRuntimeEvent((e) => {
      if (e.type.startsWith("task.") || e.type.startsWith("tool.")) void reload();
    });
  }, [reload, liveOnEvents]);

  return { data, loading, error, reload };
}
