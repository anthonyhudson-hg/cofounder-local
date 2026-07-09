import { Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useProjects } from "../hooks/useProjects";

/** Company-settings section for registering the codebases agents can work in. */
export function ProjectsSection({ companyId }: { companyId: string }) {
  const { projects, loaded, create, remove } = useProjects(companyId);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");

  const [runAdd, { busy, error }] = useAsyncAction(async () => {
    await create(name.trim(), rootPath.trim());
    setName("");
    setRootPath("");
  });

  const canAdd = !!name.trim() && !!rootPath.trim() && !busy;

  return (
    <div className="debug-field">
      <div className="debug-label">Projects</div>
      <p className="settings-hint">
        Codebases your employees can work in. Point at an existing git repo on disk — agents edit it only through isolated
        git worktrees and land changes as branches/PRs, never your live working tree.
      </p>

      {loaded && projects.length === 0 && <p className="settings-hint">No projects yet.</p>}

      {projects.length > 0 && (
        <div className="project-list">
          {projects.map((p) => (
            <div key={p.id} className="project-row">
              <div className="project-row-main">
                <div className="project-row-name">
                  {p.name}
                  <span className={`project-badge ${p.remote_url ? "remote" : "local"}`}>{p.remote_url ? "GitHub" : "local-only"}</span>
                  <span className="project-branch">{p.default_branch}</span>
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

      <div className="project-add">
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
  );
}
