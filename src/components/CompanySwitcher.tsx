import { Check, Copy, Gear, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Company } from "../types";

interface Props {
  current: Company;
  companies: Company[];
  onSwitch: (id: string) => void;
  onCreate: (name: string) => Promise<string>;
  onClone: () => Promise<string>;
  onOpenSettings: () => void;
}

function CompanyGlyph({ company, className }: { company: Company; className?: string }) {
  if (company.avatar) {
    return <img className={className} src={company.avatar} alt={company.name} />;
  }
  const initial = company.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className={className} style={{ background: company.color ?? "#4a5568" }}>
      {initial}
    </span>
  );
}

export function CompanySwitcher({ current, companies, onSwitch, onCreate, onClone, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const handleSwitch = (id: string) => {
    if (id !== current.id) onSwitch(id);
    setOpen(false);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const id = await onCreate(name);
      onSwitch(id);
      setNewName("");
      setCreating(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleClone = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await onClone();
      onSwitch(id);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="company-switcher" ref={rootRef}>
      <button
        className="company-switcher-btn"
        title={current.name}
        onClick={() => setOpen((v) => !v)}
      >
        <CompanyGlyph company={current} className="company-glyph" />
      </button>

      {open && (
        <div className="company-switcher-menu">
          <div className="company-switcher-menu-header">Companies</div>
          <ul className="company-switcher-list">
            {companies.map((c) => (
              <li key={c.id}>
                <button
                  className={`company-switcher-item ${c.id === current.id ? "active" : ""}`}
                  onClick={() => handleSwitch(c.id)}
                >
                  <CompanyGlyph company={c} className="company-glyph company-glyph-sm" />
                  <span className="company-switcher-item-name">{c.name}</span>
                  {c.id === current.id && <Check className="company-switcher-check" weight="bold" />}
                </button>
              </li>
            ))}
          </ul>

          <div className="company-switcher-actions">
            {creating ? (
              <div className="company-switcher-create">
                <input
                  autoFocus
                  placeholder="Company name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <button className="company-switcher-create-btn" disabled={!newName.trim() || busy} onClick={handleCreate}>
                  Create
                </button>
              </div>
            ) : (
              <button className="company-switcher-action" disabled={busy} onClick={() => setCreating(true)}>
                <Plus weight="bold" /> New company
              </button>
            )}
            <button className="company-switcher-action" disabled={busy} onClick={handleClone}>
              <Copy /> Clone “{current.name}”
            </button>
            <button
              className="company-switcher-action"
              onClick={() => {
                onOpenSettings();
                setOpen(false);
              }}
            >
              <Gear /> Company settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
