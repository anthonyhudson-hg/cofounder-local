import { Gear, Plus, UsersThree } from "@phosphor-icons/react";
import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { useAgentActivity } from "../store/agentActivity";
import { Conversation } from "../types";
import { Avatar } from "./Avatar";

export interface DmMeta {
  employeeId: string;
  jobTitle: string;
}

interface SidebarProps {
  channels: Conversation[];
  dms: Conversation[];
  activeId: string;
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
  onOpenSettings: (id: string) => void;
  onOpenAppSettings: () => void;
  onOpenSearch: () => void;
  onOpenGroup: () => void;
  onOpenHire: () => void;
  onCreateChannel: (name: string) => Promise<void>;
  workspaceName: string;
  avatarByConversationId: Record<string, string | null>;
  dmMeta: Record<string, DmMeta>;
}

export function Sidebar({
  channels,
  dms,
  activeId,
  onSelect,
  open,
  onClose,
  onOpenSettings,
  onOpenAppSettings,
  onOpenSearch,
  onOpenGroup,
  onOpenHire,
  onCreateChannel,
  workspaceName,
  avatarByConversationId,
  dmMeta,
}: SidebarProps) {
  const { width, onMouseDown } = useResizableWidth(260, 200, 420, "right");
  const activeAgents = useAgentActivity((s) => s.active);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [runCreateChannel, { busy: creating, error: createError }, clearCreateError] = useAsyncAction(
    async (name: string) => {
      await onCreateChannel(name);
      setChannelName("");
      setCreatingChannel(false);
    },
  );

  const submitChannel = async () => {
    const name = channelName.trim();
    if (!name || creating) return;
    await runCreateChannel(name);
  };

  useEscapeToClose(open, onClose);

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`} style={{ width }}>
        <div className="sidebar-header">
          <span className="workspace-name">{workspaceName}</span>
          <button
            className="sidebar-settings-btn sidebar-header-settings-btn"
            title="Company settings"
            aria-label="Company settings"
            onClick={onOpenAppSettings}
          >
            <Gear />
          </button>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title sidebar-section-title-row">
            <span>Channels</span>
            <button
              className="sidebar-add-btn"
              title="Create channel"
              aria-label="Create channel"
              onClick={() => setCreatingChannel((v) => !v)}
            >
              <Plus />
            </button>
          </div>
          <ul className="sidebar-list">
            {channels.map((c) => (
              <li key={c.id}>
                <button
                  className={`sidebar-item ${activeId === c.id ? "active" : ""}`}
                  onClick={() => {
                    onSelect(c.id);
                    onClose();
                  }}
                >
                  <span className="hash">#</span>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
          {creatingChannel && (
            <div className="sidebar-create-channel">
              <span className="hash">#</span>
              <input
                autoFocus
                placeholder="new-channel"
                value={channelName}
                maxLength={80}
                onChange={(e) => {
                  // Restrict to a safe charset: markdown control characters ([ ] ( ) \)
                  // in a channel name can break out of mention-link syntax elsewhere
                  // in the app (report §2.4) — keep names to a plain slug.
                  const clean = e.target.value
                    .replace(/\s+/g, "-")
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "");
                  setChannelName(clean);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitChannel();
                  if (e.key === "Escape") {
                    setCreatingChannel(false);
                    clearCreateError();
                  }
                }}
                disabled={creating}
              />
              {createError && <p className="form-error">{createError}</p>}
            </div>
          )}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title sidebar-section-title-row">
            <span>Direct Messages</span>
            <span className="sidebar-section-actions">
              <button className="sidebar-add-btn" title="New group" aria-label="New group" onClick={onOpenGroup}>
                <UsersThree />
              </button>
              <button className="sidebar-add-btn" title="Find people" aria-label="Find people" onClick={onOpenSearch}>
                <Plus />
              </button>
            </span>
          </div>
          <ul className="sidebar-list">
            {dms.map((c) => {
              const meta = dmMeta[c.id];
              const isActive = meta ? activeAgents.has(meta.employeeId) : false;
              return (
              <li key={c.id} className="sidebar-list-row">
                <button
                  className={`sidebar-item ${activeId === c.id ? "active" : ""}`}
                  onClick={() => {
                    onSelect(c.id);
                    onClose();
                  }}
                >
                  <span className="sidebar-avatar-wrap">
                    <Avatar name={c.name} avatar={avatarByConversationId[c.id]} className="sidebar-avatar" />
                    {meta && (
                      <span
                        className={`agent-status-dot ${isActive ? "working" : "idle"}`}
                        title={isActive ? "Working now" : "Idle"}
                      />
                    )}
                  </span>
                  <span className="sidebar-dm-label">
                    <span className="sidebar-dm-name">{c.name}</span>
                    {meta?.jobTitle && <span className="sidebar-dm-title">{meta.jobTitle}</span>}
                  </span>
                </button>
                {!c.is_group && (
                  <button
                    className="sidebar-settings-btn"
                    title={`${c.name} settings`}
                    aria-label={`${c.name} settings`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenSettings(c.id);
                    }}
                  >
                    <Gear />
                  </button>
                )}
              </li>
              );
            })}
          </ul>
        </div>

        <button className="sidebar-hire-btn" onClick={onOpenHire}>
          <Plus className="sidebar-hire-icon" weight="bold" /> Hire employee
        </button>

        <div className="resize-handle resize-handle-right" onMouseDown={onMouseDown} />
      </aside>
    </>
  );
}
