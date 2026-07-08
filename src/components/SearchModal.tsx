import { X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Conversation, Employee } from "../types";
import { Avatar } from "./Avatar";

export interface SearchEntry {
  employee: Employee;
  conversation: Conversation;
}

interface Props {
  entries: SearchEntry[];
  onSelect: (conversationId: string) => void;
  onClose: () => void;
}

export function SearchModal({ entries, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      ({ employee, conversation }) =>
        conversation.name.toLowerCase().includes(q) ||
        employee.job_title.toLowerCase().includes(q) ||
        employee.department.toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Find people</h3>
          <button className="modal-close" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="search-modal-body">
          <input
            autoFocus
            className="search-modal-input"
            placeholder="Search by name, title, or department…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="search-modal-results">
            {filtered.length === 0 && <div className="search-modal-empty">No one matches "{query}".</div>}
            {filtered.map(({ employee, conversation }) => (
              <button
                key={conversation.id}
                className="search-modal-row"
                onClick={() => {
                  onSelect(conversation.id);
                  onClose();
                }}
              >
                <Avatar name={conversation.name} avatar={employee.avatar} bot className="search-modal-avatar" />
                <div className="search-modal-row-text">
                  <div className="search-modal-row-name">{conversation.name}</div>
                  <div className="search-modal-row-meta">
                    {employee.job_title}
                    {employee.department ? ` · ${employee.department}` : ""}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
