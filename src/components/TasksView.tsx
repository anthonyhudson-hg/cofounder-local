import { openUrl } from "@tauri-apps/plugin-opener";
import { GitBranch, ListChecks } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useProjects } from "../hooks/useProjects";
import { useTasks } from "../hooks/useTasks";
import { Task, TaskStatus } from "../types";
import { Avatar } from "./Avatar";
import { EmployeeInfo } from "./MessageList";

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  abandoned: "Abandoned",
};

// Filter order shown as tabs; "active" folds open + in_progress + in_review.
const FILTERS: { key: string; label: string; match: (t: Task) => boolean }[] = [
  { key: "active", label: "Active", match: (t) => t.status === "open" || t.status === "in_progress" || t.status === "in_review" },
  { key: "in_review", label: "In review", match: (t) => t.status === "in_review" },
  { key: "done", label: "Done", match: (t) => t.status === "done" },
  { key: "all", label: "All", match: () => true },
];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString();
}

interface Props {
  companyId: string | null;
  employeesById: Record<string, EmployeeInfo>;
}

/** Dedicated Tasks page: every unit of work agents have going in your codebases. */
export function TasksView({ companyId, employeesById }: Props) {
  const { tasks, loaded } = useTasks(companyId);
  const { projects } = useProjects(companyId);
  const [filter, setFilter] = useState("active");

  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? "project";
  }, [projects]);

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const shown = tasks.filter(active.match);

  return (
    <div className="tasks-view">
      <div className="tasks-view-inner">
        <div className="tasks-view-head">
          <h2 className="home-view-title">
            <ListChecks size={22} weight="fill" /> Tasks
          </h2>
          <span className="activity-sub">Work your employees are doing in your codebases — each lands as a branch/PR.</span>
        </div>

        <div className="tasks-filter-tabs">
          {FILTERS.map((f) => {
            const count = tasks.filter(f.match).length;
            return (
              <button key={f.key} className={`tasks-filter-tab ${filter === f.key ? "active" : ""}`} onClick={() => setFilter(f.key)}>
                {f.label}
                <span className="tasks-filter-count">{count}</span>
              </button>
            );
          })}
        </div>

        {!loaded ? null : projects.length === 0 ? (
          <div className="activity-empty">
            No projects yet. Add codebases in Company settings → Projects and scope employees to them, then ask an employee to
            work on one — it opens a task here.
          </div>
        ) : shown.length === 0 ? (
          <div className="activity-empty">No {active.label.toLowerCase()} tasks.</div>
        ) : (
          <ul className="tasks-view-list">
            {shown.map((t) => {
              const assignee = t.employee_id ? employeesById[t.employee_id] : null;
              return (
                <li key={t.id} className="tasks-view-item">
                  <div className="tasks-view-item-top">
                    <span className={`task-status-badge status-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    <span className="tasks-view-item-title">{t.title}</span>
                  </div>
                  <div className="tasks-view-item-meta">
                    {assignee && (
                      <span className="tasks-view-assignee">
                        <Avatar name={assignee.name} avatar={assignee.avatar} bot className="tasks-view-avatar" />
                        {assignee.name}
                      </span>
                    )}
                    <span className="task-project">{projectName(t.project_id)}</span>
                    {t.branch_name && (
                      <code className="task-branch">
                        <GitBranch size={11} weight="bold" /> {t.branch_name}
                      </code>
                    )}
                    <span className="tasks-view-when">{formatWhen(t.updated_at)}</span>
                    {t.pr_url && (
                      <button className="task-pr-link" onClick={() => void openUrl(t.pr_url!)}>
                        View PR ↗
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
