import { ArrowBendUpLeft, CaretRight, DotsThreeVertical, Plus } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { QUICK_REACTIONS } from "../lib/emoji";
import { MentionTarget } from "../lib/mentions";
import { Message, modelLabel } from "../types";
import { Avatar } from "./Avatar";
import { DebugPanel } from "./DebugPanel";
import { Emoji } from "./Emoji";
import { EmojiPicker } from "./EmojiPicker";
import { MarkdownContent } from "./MarkdownContent";

interface ReplyPreview {
  authorName: string;
  snippet: string;
}

interface Props {
  message: Message;
  displayName: string;
  avatar?: string | null;
  reactions: string[];
  onToggleReaction: (emoji: string) => void;
  showDebug: boolean;
  mentionTargets: MentionTarget[];
  onMentionClick: (target: MentionTarget) => void;
  replyCount?: number;
  onOpenThread?: () => void;
  onReply?: () => void;
  replyPreview?: ReplyPreview | null;
}

function formatTime(iso: string): string {
  const d = new Date(iso.includes("Z") || iso.includes("+") ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatUsage(m: Message): string | null {
  if (m.role !== "assistant" || m.status !== "complete") return null;
  const parts: string[] = [];
  if (m.input_tokens != null) parts.push(`${m.input_tokens.toLocaleString()} in`);
  if (m.output_tokens != null) parts.push(`${m.output_tokens.toLocaleString()} out`);
  if (m.total_cost_usd != null) parts.push(`~$${m.total_cost_usd.toFixed(4)} est.`);
  return parts.length ? parts.join(" · ") : null;
}

export function MessageRow({
  message: m,
  displayName,
  avatar,
  reactions,
  onToggleReaction,
  showDebug,
  mentionTargets,
  onMentionClick,
  replyCount,
  onOpenThread,
  onReply,
  replyPreview,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const usage = formatUsage(m);
  const modelEffortLine =
    m.role === "assistant" && m.model
      ? `${modelLabel(m.model)}${m.effort ? ` · ${m.effort[0].toUpperCase()}${m.effort.slice(1)}` : ""}`
      : null;

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div className="message-row">
      <Avatar name={displayName} avatar={m.role === "assistant" ? avatar : null} bot={m.role === "assistant"} />
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{displayName}</span>
          <span className="message-time">{formatTime(m.created_at)}</span>
          {modelEffortLine && <span className="message-model-effort">{modelEffortLine}</span>}
        </div>
        {replyPreview && (
          <div className="reply-preview">
            Replying to <strong>{replyPreview.authorName}</strong>: {replyPreview.snippet}
          </div>
        )}
        <div className="message-content">
          <MarkdownContent content={m.content} targets={mentionTargets} onMentionClick={onMentionClick} />
          {m.status === "streaming" && <span className="streaming-cursor" />}
          {m.status === "error" && <div className="message-error">Error: {m.error_message}</div>}
        </div>
        {usage && <div className="message-usage">{usage}</div>}
        {reactions.length > 0 && (
          <div className="reaction-badges">
            {Array.from(new Set(reactions)).map((emoji) => (
              <button key={emoji} className="reaction-badge" onClick={() => onToggleReaction(emoji)}>
                <Emoji emoji={emoji} size={15} />
              </button>
            ))}
          </div>
        )}
        {!!replyCount && (
          <button className="thread-replies-btn" onClick={onOpenThread}>
            {replyCount} {replyCount === 1 ? "reply" : "replies"} <CaretRight />
          </button>
        )}
        {showDebug && m.role === "assistant" && <DebugPanel message={m} />}
      </div>

      <div className="hover-toolbar">
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            className="hover-toolbar-btn reaction-pick"
            title={`React ${emoji}`}
            onClick={() => onToggleReaction(emoji)}
          >
            <Emoji emoji={emoji} size={17} />
          </button>
        ))}
        <div className="kebab-wrapper">
          <button
            className="hover-toolbar-btn reaction-pick"
            title="More reactions"
            onClick={() => setPickerOpen((v) => !v)}
          >
            <Plus />
          </button>
          {pickerOpen && <EmojiPicker onPick={onToggleReaction} onClose={() => setPickerOpen(false)} />}
        </div>
        {onReply && (
          <button className="hover-toolbar-btn" title="Reply in thread" onClick={onReply}>
            <ArrowBendUpLeft />
          </button>
        )}
        <div className="kebab-wrapper" ref={menuRef}>
          <button
            className="hover-toolbar-btn kebab-btn"
            title="More actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <DotsThreeVertical weight="bold" />
          </button>
          {menuOpen && (
            <div className="kebab-menu">
              <button
                className="kebab-menu-item"
                onClick={() => {
                  navigator.clipboard.writeText(m.content);
                  setMenuOpen(false);
                }}
              >
                Copy text
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
