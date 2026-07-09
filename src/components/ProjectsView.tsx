import { FolderSimple, GitBranch, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useProjects } from "../hooks/useProjects";

/** Dedicated Projects page: register the codebases agents can work in. */
export function ProjectsView({ companyId }: { companyId: string | null }) {
  const { projects, loaded, create, remove } = useProjects(companyId);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");

  const [runAdd, { busy, error }] = useAsyncAction(async () => {
    await create(name.trim(), rootPath.trim());
    setName("");
    setRootPath("");
  });
  const canAdd = !!companyId && !!name.trim() && !!rootPath.trim() && !busy;

  return (
    <div className="tasks-view">
      <div className="tasks-view-inner">
        <div className="tasks-view-head">
          <h2 className="home-view-title">
            <FolderSimple size={22} weight="fill" /> Projects
          </h2>
          <span className="activity-sub">
            Codebases your employees can work in. Point at an existing git repo on disk — agents edit it only through
            isolated worktrees and land changes as branches/PRs, never your live working tree.
          </span>
        </div>

        <div className="projects-add-card">
          <div className="projects-add-row">
            <input className="hire-search-input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
            <input
              className="hire-search-input"
              placeholder="Absolute path to the repo (e.g. C:\code\my-app)"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
            />
            <button className="settings-save-btn" disabled={!canAdd} onClick={runAdd}>
              {busy ? "Adding…" : "Add project"}
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>

        {!loaded ? null : projects.length === 0 ? (
          <div className="activity-empty">
            No projects yet. Add a git repo above, then scope employees to it in their settings — they can then read and
            change that codebase.
          </div>
        ) : (
          <div className="project-list">
            {projects.map((p) => (
              <div key={p.id} className="project-row">
                <div className="project-row-main">
                  <div className="project-row-name">
                    {p.name}
                    <span className={`project-badge ${p.remote_url ? "remote" : "local"}`}>{p.remote_url ? "GitHub" : "local-only"}</span>
                    <span className="project-branch">
                      <GitBranch size={11} weight="bold" /> {p.default_branch}
                    </span>
                  </div>
                  <div className="project-row-path" title={p.root_path}>{p.root_path}</div>
                </div>
                <button className="settings-link-btn danger" aria-label={`Remove ${p.name}`} title="Remove project" onClick={() => remove(p.id)}>
                  <Trash />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
