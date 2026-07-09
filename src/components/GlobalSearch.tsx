import { ChatText, Hash, MagnifyingGlass, UsersThree } from "@phosphor-icons/react";
import { MutableRefObject, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useGlobalSearch } from "../hooks/useGlobalSearch";
import { MessageTarget, SearchChannelHit, SearchMessageHit, SearchPersonHit, totalHits } from "../lib/search";
import { Avatar } from "./Avatar";

interface Props {
  companyId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onSelectMessage: (target: MessageTarget) => void;
  /** App assigns a focus() fn here so the sidebar's search affordance can focus this box. */
  focusRef?: MutableRefObject<(() => void) | null>;
}

type Row =
  | { type: "channel"; hit: SearchChannelHit }
  | { type: "person"; hit: SearchPersonHit }
  | { type: "message"; hit: SearchMessageHit };

/** Case-insensitive highlight of `q` within `text`, returning React nodes. */
function highlight(text: string, q: string): ReactNode {
  const needle = q.trim().toLowerCase();
  if (!needle) return text;
  const nodes: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) {
      nodes.push(text.slice(i));
      break;
    }
    if (at > i) nodes.push(text.slice(i, at));
    nodes.push(<mark key={key++}>{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  return nodes;
}

/** Trims a long message snippet to a window around the first match so the row stays short. */
function snippetWindow(text: string, q: string, radius = 60): string {
  const at = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (at < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + q.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function GlobalSearch({ companyId, onSelectConversation, onSelectMessage, focusRef }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { results, loading } = useGlobalSearch(companyId, q);

  const rows = useMemo<Row[]>(
    () => [
      ...results.channels.map((hit) => ({ type: "channel" as const, hit })),
      ...results.people.map((hit) => ({ type: "person" as const, hit })),
      ...results.messages.map((hit) => ({ type: "message" as const, hit })),
    ],
    [results],
  );

  const showDropdown = open && q.trim().length > 0;

  // Reset the keyboard cursor whenever the result set changes.
  useEffect(() => setActiveIndex(0), [rows]);

  // Cmd/Ctrl+K focuses the search from anywhere; also expose focus() to the parent.
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      setOpen(true);
    };
    if (focusRef) focusRef.current = focus;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (focusRef) focusRef.current = null;
    };
  }, [focusRef]);

  // Close on outside click.
  useEffect(() => {
    if (!showDropdown) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showDropdown]);

  const dismiss = () => {
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const selectRow = (row: Row) => {
    if (row.type === "message") {
      onSelectMessage({ conversationId: row.hit.conversationId, messageId: row.hit.messageId, threadRootId: row.hit.threadRootId });
    } else {
      onSelectConversation(row.hit.conversationId);
    }
    dismiss();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (q) dismiss();
      else inputRef.current?.blur();
      return;
    }
    if (!showDropdown || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIndex] ?? rows[0];
      if (row) selectRow(row);
    }
  };

  // Section boundaries: index of the first row of each group, for rendering headers.
  const firstPerson = results.channels.length;
  const firstMessage = results.channels.length + results.people.length;

  return (
    <div className="global-search" ref={containerRef}>
      <div className="global-search-box">
        <MagnifyingGlass className="global-search-icon" weight="bold" />
        <input
          ref={inputRef}
          className="global-search-input"
          placeholder="Search messages, people, channels…"
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
      </div>

      {showDropdown && (
        <div className="global-search-dropdown">
          {loading && totalHits(results) === 0 && <div className="global-search-status">Searching…</div>}
          {!loading && totalHits(results) === 0 && (
            <div className="global-search-status">No results for “{q.trim()}”.</div>
          )}

          {rows.map((row, i) => {
            const active = i === activeIndex;
            const header =
              i === 0 && row.type === "channel" ? "Channels" : i === firstPerson && row.type === "person" ? "People" : i === firstMessage && row.type === "message" ? "Messages" : null;
            return (
              <div key={rowKey(row)}>
                {header && <div className="global-search-group">{header}</div>}
                <button
                  className={`global-search-row ${active ? "active" : ""}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  // mousedown (not click) fires before the input's blur, so the row
                  // isn't torn down before its handler runs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectRow(row);
                  }}
                >
                  {renderRow(row, q)}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function rowKey(row: Row): string {
  if (row.type === "message") return `m:${row.hit.messageId}`;
  if (row.type === "person") return `p:${row.hit.employeeId}`;
  return `c:${row.hit.conversationId}`;
}

function renderRow(row: Row, q: string): ReactNode {
  if (row.type === "channel") {
    return (
      <>
        <span className="global-search-row-icon">{row.hit.isGroup ? <UsersThree weight="fill" /> : <Hash weight="bold" />}</span>
        <span className="global-search-row-main">
          <span className="global-search-row-title">{highlight(row.hit.name, q)}</span>
          <span className="global-search-row-meta">{row.hit.isGroup ? "Group" : "Channel"}</span>
        </span>
      </>
    );
  }
  if (row.type === "person") {
    return (
      <>
        <Avatar name={row.hit.name} avatar={row.hit.avatar} bot className="global-search-row-avatar" />
        <span className="global-search-row-main">
          <span className="global-search-row-title">{highlight(row.hit.name, q)}</span>
          <span className="global-search-row-meta">
            {highlight(row.hit.jobTitle || "", q)}
            {row.hit.department ? ` · ${row.hit.department}` : ""}
          </span>
        </span>
      </>
    );
  }
  const label = row.hit.isGroup || row.hit.conversationKind === "channel" ? `#${row.hit.conversationName}` : row.hit.conversationName;
  return (
    <>
      <span className="global-search-row-icon">
        <ChatText weight="fill" />
      </span>
      <span className="global-search-row-main">
        <span className="global-search-row-title">
          {row.hit.authorName} <span className="global-search-row-in">in {label}</span>
        </span>
        <span className="global-search-row-snippet">{highlight(snippetWindow(row.hit.snippet, q), q)}</span>
      </span>
    </>
  );
}
