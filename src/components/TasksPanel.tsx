import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import { useProjects } from "../hooks/useProjects";
import { useTasks } from "../hooks/useTasks";
import { TaskStatus } from "../types";

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  abandoned: "Abandoned",
};

/** Home-view panel: the tasks agents have going in your codebases + their PRs. */
export function TasksPanel({ companyId }: { companyId: string | null }) {
  const { tasks, loaded } = useTasks(companyId);
  const { projects } = useProjects(companyId);
  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? "project";
  }, [projects]);

  // Nothing to show and no projects registered — keep Home uncluttered.
  if (loaded && tasks.length === 0 && projects.length === 0) return null;

  return (
    <div className="tasks-panel">
      <div className="activity-header">
        <h2>Tasks</h2>
        <span className="activity-sub">Work your employees are doing in your codebases</span>
      </div>
      {!loaded ? null : tasks.length === 0 ? (
        <div className="activity-empty">No tasks yet — an employee opens one when it starts working on a project.</div>
      ) : (
        <ul className="tasks-list">
          {tasks.map((t) => (
            <li key={t.id} className="task-item">
              <div className="task-item-main">
                <span className={`task-status-badge status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                <span className="task-item-title">{t.title}</span>
              </div>
              <div className="task-item-meta">
                <span className="task-project">{projectName(t.project_id)}</span>
                {t.branch_name && <code className="task-branch">{t.branch_name}</code>}
                {t.pr_url && (
                  <button className="task-pr-link" onClick={() => void openUrl(t.pr_url!)}>
                    View PR ↗
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
