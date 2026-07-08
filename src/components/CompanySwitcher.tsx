import { Check, Copy, Gear, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
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
  const [failed, setFailed] = useState(false);
  if (company.avatar && !failed) {
    return (
      <img
        className={className}
        src={company.avatar}
        alt={company.name}
        onError={() => setFailed(true)}
      />
    );
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

  useEscapeToClose(open, () => {
    setOpen(false);
    setCreating(false);
  });

  const handleSwitch = (id: string) => {
    if (id !== current.id) onSwitch(id);
    setOpen(false);
  };

  const [runCreate, { busy: creatingBusy, error: createError }] = useAsyncAction(async () => {
    const name = newName.trim();
    if (!name) return;
    const id = await onCreate(name);
    onSwitch(id);
    setNewName("");
    setCreating(false);
    setOpen(false);
  });

  const [runClone, { busy: cloningBusy, error: cloneError }] = useAsyncAction(async () => {
    const id = await onClone();
    onSwitch(id);
    setOpen(false);
  });

  const busy = creatingBusy || cloningBusy;

  return (
    <div className="company-switcher" ref={rootRef}>
      <button
        className="company-switcher-btn"
        title={current.name}
        aria-label={current.name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <CompanyGlyph company={current} className="company-glyph" />
      </button>

      {open && (
        <div className="company-switcher-menu" role="menu">
          <div className="company-switcher-menu-header">Companies</div>
          <ul className="company-switcher-list">
            {companies.map((c) => (
              <li key={c.id}>
                <button
                  className={`company-switcher-item ${c.id === current.id ? "active" : ""}`}
                  role="menuitem"
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
                    if (e.key === "Enter") runCreate();
                    if (e.key === "Escape") setCreating(false);
                  }}
                />
                <button className="company-switcher-create-btn" disabled={!newName.trim() || busy} onClick={runCreate}>
                  {creatingBusy ? "Creating…" : "Create"}
                </button>
                {createError && <p className="form-error">{createError}</p>}
              </div>
            ) : (
              <button className="company-switcher-action" role="menuitem" disabled={busy} onClick={() => setCreating(true)}>
                <Plus weight="bold" /> New company
              </button>
            )}
            <button className="company-switcher-action" role="menuitem" disabled={busy} onClick={runClone}>
              <Copy /> {cloningBusy ? "Copying…" : `Clone “${current.name}”`}
            </button>
            {cloneError && <p className="form-error">{cloneError}</p>}
            <button
              className="company-switcher-action"
              role="menuitem"
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
