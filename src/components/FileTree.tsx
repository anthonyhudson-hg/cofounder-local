import { CaretRight, File as FileIcon, FolderSimple } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { GitStatusLetter } from "../types";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

function buildTree(files: string[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, children: [] };
  for (const f of files) {
    const parts = f.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const p = parts.slice(0, i + 1).join("/");
      let child = cur.children.find((c) => c.name === part && c.dir === !isFile);
      if (!child) {
        child = { name: part, path: p, dir: !isFile, children: [] };
        cur.children.push(child);
      }
      cur = child;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** Does any descendant of `dirPath` have a git status? (so a folder can flag changes) */
function dirHasStatus(dirPath: string, status: Record<string, GitStatusLetter>): boolean {
  const prefix = dirPath + "/";
  for (const p of Object.keys(status)) if (p.startsWith(prefix)) return true;
  return false;
}

interface RowProps {
  node: Node;
  depth: number;
  status: Record<string, GitStatusLetter>;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function TreeRow({ node, depth, status, selected, expanded, onToggle, onSelect }: RowProps) {
  const indent = 6 + depth * 12;
  if (node.dir) {
    const open = expanded.has(node.path);
    const changed = dirHasStatus(node.path, status);
    return (
      <>
        <button className={`ft-row ft-dir ${changed ? "ft-changed-dir" : ""}`} style={{ paddingLeft: indent }} onClick={() => onToggle(node.path)}>
          <CaretRight className={`ft-caret ${open ? "open" : ""}`} size={11} weight="bold" />
          <FolderSimple className="ft-icon" size={14} weight={open ? "fill" : "regular"} />
          <span className="ft-name">{node.name}</span>
        </button>
        {open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} status={status} selected={selected} expanded={expanded} onToggle={onToggle} onSelect={onSelect} />)}
      </>
    );
  }
  const st = status[node.path];
  return (
    <button
      className={`ft-row ft-file ${selected === node.path ? "active" : ""} ${st ? `git-${st === "?" ? "untracked" : st}` : ""}`}
      style={{ paddingLeft: indent + 14 }}
      onClick={() => onSelect(node.path)}
      title={node.path}
    >
      <FileIcon className="ft-icon" size={14} />
      <span className="ft-name">{node.name}</span>
      {st && <span className={`ft-status git-${st === "?" ? "untracked" : st}`}>{st}</span>}
    </button>
  );
}

interface Props {
  files: string[];
  status: Record<string, GitStatusLetter>;
  selected: string | null;
  onSelect: (path: string) => void;
}

export function FileTree({ files, status, selected, onSelect }: Props) {
  const nodes = useMemo(() => buildTree(files), [files]);
  // Default: expand the top-level directories so the tree isn't fully collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.filter((n) => n.dir).map((n) => n.path)));
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (files.length === 0) return <div className="ft-empty">No files.</div>;
  return (
    <div className="file-tree">
      {nodes.map((n) => (
        <TreeRow key={n.path} node={n} depth={0} status={status} selected={selected} expanded={expanded} onToggle={toggle} onSelect={onSelect} />
      ))}
    </div>
  );
}
