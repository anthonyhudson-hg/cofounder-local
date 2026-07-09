import { X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { Employee } from "../types";
import { EmployeeInfo } from "./MessageList";
import { PersonPickerRow } from "./PersonPicker";

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

  const [runCreate, { busy: creating, error: createError }] = useAsyncAction(async () => {
    const ids = Array.from(selected);
    const defaultName = ids.map((id) => employeesById[id]?.name).filter(Boolean).join(", ");
    await onCreate(name.trim() || defaultName, ids);
    onClose();
  });

  const canCreate = selected.size >= 2 && !creating;

  useEscapeToClose(true, onClose);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal group-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>New group</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="person-picker-body">
          <input
            className="person-picker-input"
            placeholder="Group name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            autoFocus
            className="person-picker-input"
            placeholder="Add people…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="person-picker-results">
            {filtered.length === 0 && <div className="person-picker-empty">No one matches "{query}".</div>}
            {filtered.map((e) => (
              <PersonPickerRow
                key={e.id}
                name={employeesById[e.id]?.name ?? "Employee"}
                avatar={employeesById[e.id]?.avatar}
                meta={`${e.job_title}${e.department ? ` · ${e.department}` : ""}`}
                checked={selected.has(e.id)}
                onToggle={() => toggle(e.id)}
              />
            ))}
          </div>
          {selected.size < 2 && (
            <p className="settings-hint">Select at least 2 people to create a group.</p>
          )}
          <div className="settings-save-row">
            <button className="settings-save-btn" disabled={!canCreate} onClick={runCreate}>
              {creating ? "Creating…" : `Create group${selected.size ? ` (${selected.size})` : ""}`}
            </button>
          </div>
          {createError && <p className="form-error">{createError}</p>}
        </div>
      </div>
    </div>
  );
}
