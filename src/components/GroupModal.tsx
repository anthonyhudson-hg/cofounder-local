import { X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Employee } from "../types";
import { Avatar } from "./Avatar";
import { EmployeeInfo } from "./MessageList";

interface Props {
  employees: Employee[];
  employeesById: Record<string, EmployeeInfo>;
  onCreate: (name: string, employeeIds: string[]) => Promise<void>;
  onClose: () => void;
}

export function GroupModal({ employees, employeesById, onCreate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => (employeesById[e.id]?.name ?? "").toLowerCase().includes(q));
  }, [employees, employeesById, query]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canCreate = selected.size >= 2 && !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const ids = Array.from(selected);
      const defaultName = ids.map((id) => employeesById[id]?.name).filter(Boolean).join(", ");
      await onCreate(name.trim() || defaultName, ids);
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New group</h3>
          <button className="modal-close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="search-modal-body">
          <input
            className="search-modal-input"
            placeholder="Group name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            autoFocus
            className="search-modal-input"
            placeholder="Add people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="search-modal-results">
            {filtered.length === 0 && <div className="search-modal-empty">No one matches "{query}".</div>}
            {filtered.map((e) => (
              <label key={e.id} className="search-modal-row group-modal-row">
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                <Avatar
                  name={employeesById[e.id]?.name ?? "Employee"}
                  avatar={employeesById[e.id]?.avatar}
                  bot
                  className="search-modal-avatar"
                />
                <div className="search-modal-row-text">
                  <div className="search-modal-row-name">{employeesById[e.id]?.name ?? "Employee"}</div>
                  <div className="search-modal-row-meta">
                    {e.job_title}
                    {e.department ? ` · ${e.department}` : ""}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="settings-save-row">
            <button className="settings-save-btn" disabled={!canCreate} onClick={handleCreate}>
              {creating ? "Creating…" : `Create group${selected.size ? ` (${selected.size})` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
