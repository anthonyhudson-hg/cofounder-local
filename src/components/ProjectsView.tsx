import { ArrowClockwise, FolderSimple, GitBranch, Plus, Trash } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ReactNode, useEffect, useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useProjects } from "../hooks/useProjects";
import { useProjectFile, useProjectRepoQuery, useProjectTree } from "../hooks/useProjectRepo";
import { Branch, Commit, GitStatusLetter, Issue, Pull } from "../types";
import { FileTree } from "./FileTree";

type Tab = "code" | "commits" | "branches" | "pulls" | "issues";
const TABS: { key: Tab; label: string }[] = [
  { key: "code", label: "Code" },
  { key: "commits", label: "Commits" },
  { key: "branches", label: "Branches" },
  { key: "pulls", label: "Pull requests" },
  { key: "issues", label: "Issues" },
];

function gitClass(st: GitStatusLetter): string {
  return `git-${st === "?" ? "untracked" : st}`;
}

// ---- file preview (read-only, editor-looking) ----

function FilePreview({ companyId, projectId, path, status }: { companyId: string | null; projectId: string; path: string; status?: GitStatusLetter }) {
  const { file, loading, error } = useProjectFile(companyId, projectId, path);
  const lineCount = file && !file.binary ? file.content.split("\n").length : 0;
  return (
    <div className="file-preview">
      <div className="file-preview-bar">
        <span className="file-preview-path">{path}</span>
        {status && <span className={`ft-status ${gitClass(status)}`}>{status}</span>}
        {file?.truncated && <span className="file-preview-trunc">truncated preview</span>}
      </div>
      {error ? (
        <div className="file-preview-empty">Couldn't open this file: {error}</div>
      ) : loading || !file ? (
        <div className="file-preview-empty">Loading…</div>
      ) : file.binary ? (
        <div className="file-preview-empty">Binary file — no preview.</div>
      ) : (
        <div className="file-preview-body">
          <div className="file-preview-gutter" aria-hidden>
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="file-preview-code">{file.content}</pre>
        </div>
      )}
    </div>
  );
}

// ---- remote/list tabs ----

function StateBadge({ state, draft }: { state: string; draft?: boolean }) {
  const s = draft ? "draft" : state;
  return <span className={`repo-state-badge state-${s}`}>{s}</span>;
}

function RepoListShell({ loading, error, empty, onRefresh, children }: { loading: boolean; error: string | null; empty: boolean; onRefresh: () => void; children: ReactNode }) {
  return (
    <div className="repo-list-wrap">
      <div className="repo-list-toolbar">
        <button className="settings-link-btn" onClick={onRefresh} disabled={loading}>
          <ArrowClockwise size={13} /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error ? (
        <div className="activity-empty">{error}</div>
      ) : loading && empty ? (
        <div className="activity-empty">Loading…</div>
      ) : empty ? (
        <div className="activity-empty">Nothing here yet.</div>
      ) : (
        children
      )}
    </div>
  );
}

function CommitsTab({ companyId, projectId }: { companyId: string | null; projectId: string }) {
  const { data, loading, error, reload } = useProjectRepoQuery<Commit[]>("project.commits", companyId, projectId, true);
  const rows = data ?? [];
  return (
    <RepoListShell loading={loading} error={error} empty={rows.length === 0} onRefresh={reload}>
      <ul className="repo-list">
        {rows.map((c) => (
          <li key={c.sha} className="repo-list-item">
            <div className="repo-list-main">
              <span className="repo-list-title">{c.subject}</span>
            </div>
            <div className="repo-list-meta">
              <code className="repo-sha">{c.shortSha}</code>
              <span>{c.author}</span>
              <span className="repo-when">{c.date}</span>
            </div>
          </li>
        ))}
      </ul>
    </RepoListShell>
  );
}

function BranchesTab({ companyId, projectId }: { companyId: string | null; projectId: string }) {
  const { data, loading, error, reload } = useProjectRepoQuery<Branch[]>("project.branches", companyId, projectId, true);
  const rows = data ?? [];
  return (
    <RepoListShell loading={loading} error={error} empty={rows.length === 0} onRefresh={reload}>
      <ul className="repo-list">
        {rows.map((b) => (
          <li key={b.name} className="repo-list-item">
            <div className="repo-list-main">
              <GitBranch size={14} weight="bold" />
              <span className="repo-list-title">{b.name}</span>
              {b.current && <span className="repo-state-badge state-current">current</span>}
            </div>
          </li>
        ))}
      </ul>
    </RepoListShell>
  );
}

function PullsTab({ companyId, projectId }: { companyId: string | null; projectId: string }) {
  const { data, loading, error, reload } = useProjectRepoQuery<Pull[]>("project.pulls", companyId, projectId);
  const rows = data ?? [];
  return (
    <RepoListShell loading={loading} error={error} empty={rows.length === 0} onRefresh={reload}>
      <ul className="repo-list">
        {rows.map((pr) => (
          <li key={pr.number} className="repo-list-item repo-list-link" onClick={() => void openUrl(pr.url)}>
            <div className="repo-list-main">
              <StateBadge state={pr.state} draft={pr.draft} />
              <span className="repo-list-title">{pr.title}</span>
              <span className="repo-num">#{pr.number}</span>
            </div>
            <div className="repo-list-meta">
              <span>{pr.author}</span>
              <span className="repo-when">{new Date(pr.updatedAt).toLocaleDateString()}</span>
            </div>
          </li>
        ))}
      </ul>
    </RepoListShell>
  );
}

function IssuesTab({ companyId, projectId }: { companyId: string | null; projectId: string }) {
  const { data, loading, error, reload } = useProjectRepoQuery<Issue[]>("project.issues", companyId, projectId);
  const rows = data ?? [];
  return (
    <RepoListShell loading={loading} error={error} empty={rows.length === 0} onRefresh={reload}>
      <ul className="repo-list">
        {rows.map((is) => (
          <li key={is.number} className="repo-list-item repo-list-link" onClick={() => void openUrl(is.url)}>
            <div className="repo-list-main">
              <StateBadge state={is.state} />
              <span className="repo-list-title">{is.title}</span>
              <span className="repo-num">#{is.number}</span>
            </div>
            <div className="repo-list-meta">
              <span>{is.author}</span>
              <span className="repo-when">{new Date(is.updatedAt).toLocaleDateString()}</span>
            </div>
          </li>
        ))}
      </ul>
    </RepoListShell>
  );
}

// ---- add-project inline form ----

function AddProjectForm({ onDone, create }: { onDone: () => void; create: (name: string, path: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [run, { busy, error }] = useAsyncAction(async () => {
    await create(name.trim(), path.trim());
    onDone();
  });
  return (
    <div className="project-add-inline">
      <input className="hire-search-input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className="hire-search-input" placeholder="Absolute path to the repo (e.g. C:\code\my-app)" value={path} onChange={(e) => setPath(e.target.value)} />
      <div className="settings-save-row">
        <button className="settings-save-btn" disabled={!name.trim() || !path.trim() || busy} onClick={run}>
          {busy ? "Adding…" : "Add project"}
        </button>
        <button className="settings-link-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

// ---- main view ----

export function ProjectsView({ companyId }: { companyId: string | null }) {
  const { projects, loaded, create, remove } = useProjects(companyId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("code");
  const [adding, setAdding] = useState(false);

  // Keep a valid selection as projects load/change.
  useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((cur) => (cur && projects.some((p) => p.id === cur) ? cur : projects[0].id));
  }, [projects]);

  useEffect(() => {
    setSelectedPath(null);
    setTab("code");
  }, [selectedId]);

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const { tree } = useProjectTree(companyId, selectedId);

  if (loaded && projects.length === 0) {
    return (
      <div className="tasks-view">
        <div className="tasks-view-inner">
          <div className="tasks-view-head">
            <h2 className="home-view-title">
              <FolderSimple size={22} weight="fill" /> Projects
            </h2>
            <span className="activity-sub">Register a git repo to let your employees read and change it (on isolated branches → PRs).</span>
          </div>
          <AddProjectForm onDone={() => setAdding(false)} create={create} />
        </div>
      </div>
    );
  }

  return (
    <div className="project-view">
      <div className="project-view-head">
        <div className="project-view-picker">
          <FolderSimple size={16} weight="fill" />
          <select value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {selected && (
            <span className="project-view-branch">
              <GitBranch size={12} weight="bold" /> {tree?.branch || selected.default_branch}
            </span>
          )}
          {selected && <span className={`project-badge ${selected.remote_url ? "remote" : "local"}`}>{selected.remote_url ? "GitHub" : "local-only"}</span>}
        </div>
        <div className="project-view-actions">
          <button className="settings-link-btn" onClick={() => setAdding((v) => !v)} title="Add project">
            <Plus size={14} /> Add
          </button>
          {selected && (
            <button className="settings-link-btn danger" title="Remove this project" onClick={() => remove(selected.id)}>
              <Trash size={14} />
            </button>
          )}
        </div>
      </div>

      {adding && (
        <div className="project-view-addbar">
          <AddProjectForm onDone={() => setAdding(false)} create={create} />
        </div>
      )}

      <div className="project-view-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`project-view-tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {!selectedId ? null : tab === "code" ? (
        <div className="project-browser">
          <aside className="project-browser-aside">
            {tree ? (
              <FileTree files={tree.files} status={tree.status} selected={selectedPath} onSelect={setSelectedPath} />
            ) : (
              <div className="ft-empty">Loading…</div>
            )}
          </aside>
          <main className="project-browser-main">
            {selectedPath ? (
              <FilePreview companyId={companyId} projectId={selectedId} path={selectedPath} status={tree?.status[selectedPath]} />
            ) : (
              <div className="file-preview-empty file-preview-welcome">Select a file from the tree to preview it.</div>
            )}
          </main>
        </div>
      ) : tab === "commits" ? (
        <CommitsTab companyId={companyId} projectId={selectedId} />
      ) : tab === "branches" ? (
        <BranchesTab companyId={companyId} projectId={selectedId} />
      ) : tab === "pulls" ? (
        <PullsTab companyId={companyId} projectId={selectedId} />
      ) : (
        <IssuesTab companyId={companyId} projectId={selectedId} />
      )}
    </div>
  );
}
