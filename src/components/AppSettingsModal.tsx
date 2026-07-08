import { X } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { readImageAsResizedDataUrl } from "../lib/avatar";
import { Company } from "../types";
import { THEMES, applyTheme, themeForColor } from "../lib/themes";

interface Props {
  company: Company;
  onUpdateField: <K extends keyof Company>(field: K, value: Company[K]) => void;
  canDelete: boolean;
  onDelete: () => void;
  onClose: () => void;
}

export function AppSettingsModal({ company, onUpdateField, canDelete, onDelete, onClose }: Props) {
  const [name, setName] = useState(company.name);
  const [profile, setProfile] = useState(company.profile);
  const [systemPrompt, setSystemPrompt] = useState(company.system_prompt);
  const [savedFlash, setSavedFlash] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isDirty =
    name !== company.name || profile !== company.profile || systemPrompt !== company.system_prompt;

  const handleSave = () => {
    if (name !== company.name) onUpdateField("name", name);
    if (profile !== company.profile) onUpdateField("profile", profile);
    if (systemPrompt !== company.system_prompt) onUpdateField("system_prompt", systemPrompt);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await readImageAsResizedDataUrl(file);
      onUpdateField("avatar", dataUrl);
    } finally {
      setUploading(false);
    }
  };

  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal app-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Company settings</h3>
          <button className="modal-close" onClick={onClose}>
            <X />
          </button>
        </div>

        <div className="debug-body">
          <div className="debug-field">
            <div className="debug-label">Icon</div>
            <div className="settings-avatar-row">
              {company.avatar ? (
                <img className="settings-avatar" src={company.avatar} alt={name} />
              ) : (
                <span className="settings-avatar company-avatar-fallback" style={{ background: company.color ?? "#4a154b" }}>
                  {initial}
                </span>
              )}
              <div className="settings-avatar-actions">
                <button className="settings-link-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  {uploading ? "Uploading…" : company.avatar ? "Change icon" : "Upload icon"}
                </button>
                {company.avatar && (
                  <button className="settings-link-btn danger" onClick={() => onUpdateField("avatar", null)}>
                    Remove
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handlePhotoSelected}
                />
              </div>
            </div>
          </div>

          <div className="debug-field">
            <div className="debug-label">Theme</div>
            <p className="settings-hint">Recolors the whole app for this company. Switches automatically when you change companies.</p>
            <div className="company-theme-picker">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  className={`company-theme ${themeForColor(company.color).key === t.key ? "active" : ""}`}
                  title={t.name}
                  onClick={() => {
                    applyTheme(t);
                    onUpdateField("color", t.accent);
                  }}
                >
                  <span className="company-theme-swatch" style={{ background: t.sidebar }}>
                    <span className="company-theme-accent" style={{ background: t.accentActive }} />
                  </span>
                  <span className="company-theme-name">{t.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="debug-field">
            <div className="debug-label">Company name</div>
            <input className="hire-search-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="debug-field">
            <div className="debug-label">Company profile</div>
            <p className="settings-hint">
              A short factual description of the company — injected into every employee's prompt for context.
            </p>
            <textarea
              className="app-settings-textarea"
              value={profile}
              rows={4}
              onChange={(e) => setProfile(e.target.value)}
            />
          </div>

          <div className="debug-field">
            <div className="debug-label">Company system prompt</div>
            <p className="settings-hint">
              Prepended to every employee's own system prompt, ahead of their name/title/department identity
              block. Use this for company-wide ground rules that should apply to all AI employees.
            </p>
            <textarea
              className="app-settings-textarea"
              value={systemPrompt}
              rows={10}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div className="settings-save-row">
            <button className="settings-save-btn" disabled={!isDirty} onClick={handleSave}>
              Save changes
            </button>
            {savedFlash && <span className="settings-saved-flash">Saved</span>}
          </div>

          <div className="debug-field company-danger-zone">
            <div className="debug-label">Danger zone</div>
            {confirmDelete ? (
              <div className="company-danger-confirm">
                <p className="settings-hint">
                  Permanently delete <strong>{company.name}</strong> and all of its channels, employees, and
                  chat history? This cannot be undone.
                </p>
                <div className="settings-save-row">
                  <button className="settings-link-btn danger" onClick={onDelete}>
                    Delete permanently
                  </button>
                  <button className="settings-link-btn" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="settings-link-btn danger"
                disabled={!canDelete}
                title={canDelete ? undefined : "You can't delete your only company"}
                onClick={() => setConfirmDelete(true)}
              >
                Delete this company
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
