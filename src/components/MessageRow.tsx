import { ArrowBendUpLeft, CaretRight, CircleNotch, DotsThreeVertical, Plus } from "@phosphor-icons/react";
import { memo, useEffect, useRef, useState } from "react";
import { QUICK_REACTIONS } from "../lib/emoji";
import { activityStatusText, type LiveActivity } from "../lib/liveActivity";
import { MentionTarget } from "../lib/mentions";
import { Message, modelLabel } from "../types";
import { Avatar } from "./Avatar";
import { DebugPanel } from "./DebugPanel";
import { Emoji } from "./Emoji";
import { EmojiPicker } from "./EmojiPicker";
import { MarkdownContent } from "./MarkdownContent";

/** Re-renders every second while `active` so the "N ago" line stays live without
 *  the server having to stream a status per second (Paperclip's useLiveElapsed). */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Blue "Running" pill shown next to an agent's name while its turn is in flight. */
export function RunningBadge() {
  return (
    <span className="running-badge">
      <CircleNotch className="running-badge-spinner" weight="bold" />
      Running
    </span>
  );
}

/** The live "Working… / Using X · N ago" block — a shimmering verb over a ticking
 *  status subtitle. Mirrors Paperclip's run runtime-status line. */
export function AgentActivityBlock({ activity }: { activity: LiveActivity }) {
  const now = useNowTick(true);
  const statusText = activityStatusText(activity, now);
  return (
    <div className="agent-activity">
      <CircleNotch className="agent-activity-spinner" weight="bold" />
      <div className="agent-activity-text">
        <span className="shimmer-text agent-activity-verb">Working</span>
        {statusText && <span className="agent-activity-status">{statusText}</span>}
      </div>
    </div>
  );
}

/** A synthetic row for a turn that has no message row yet: a channel responder
 *  before it posts, the channel relevance gate (no `name`), or any other window
 *  watching a turn it didn't initiate. Renders like a message row. */
export function AgentWorkingRow({ name, avatar, activity }: { name?: string; avatar?: string | null; activity: LiveActivity }) {
  if (!name) {
    // Conversation-level status (e.g. "Checking who should respond") — no agent.
    return (
      <div className="message-row agent-working-row conversation-activity">
        <div className="message-body">
          <AgentActivityBlock activity={activity} />
        </div>
      </div>
    );
  }
  return (
    <div className="message-row agent-working-row">
      <Avatar name={name} avatar={avatar ?? null} bot />
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{name}</span>
          <RunningBadge />
        </div>
        <AgentActivityBlock activity={activity} />
      </div>
    </div>
  );
}

interface Props {
  message: Message;
  displayName: string;
  avatar?: string | null;
  reactions: string[];
  // Raw, row-id-taking callbacks (stable references from the owning hook) rather than
  // MessageList pre-binding a fresh `() => onX(m.id)` closure per row per render — that
  // would defeat memoization below since a "new" prop value looks like a real change
  // (report §5.2/§6.1: every row was re-rendering on every streamed token).
  onToggleReaction: (messageId: string, emoji: string) => void;
  showDebug: boolean;
  mentionTargets: MentionTarget[];
  onMentionClick: (target: MentionTarget) => void;
  replyCount?: number;
  onOpenThread?: (messageId: string) => void;
  onReply?: (message: Message) => void;
  // Split into primitives (not a `{authorName, snippet}` object) so a value that
  // hasn't actually changed compares equal under React.memo's default shallow
  // comparison even if MessageList recomputes it fresh every render.
  replyAuthorName?: string;
  replySnippet?: string;
  /** Live "what is this agent doing right now" status for this message, while its
   *  turn is in flight — server-authored, see store/agentStatus.ts. */
  activity?: LiveActivity;
}

function formatTime(iso: string): string {
  // `iso` is naive/UTC unless it carries an explicit offset — match a real trailing
  // offset (`Z` or `+HH:MM`/`-HH:MM`) rather than a bare substring check, which missed
  // negative offsets (`...-05:00` contains neither "Z" nor "+") and silently blanked
  // the timestamp for them (report §5.5).
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasOffset ? iso : iso + "Z");
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

function MessageRowImpl({
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
  replyAuthorName,
  replySnippet,
  activity,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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

  // Group instead of dedup-and-discard: previously N employees reacting with the same
  // emoji collapsed to a single badge with the count thrown away (report §5.9).
  const reactionCounts = new Map<string, number>();
  for (const emoji of reactions) reactionCounts.set(emoji, (reactionCounts.get(emoji) ?? 0) + 1);

  return (
    <div className="message-row" data-message-id={m.id}>
      <Avatar name={displayName} avatar={m.role === "assistant" ? avatar : null} bot={m.role === "assistant"} />
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{displayName}</span>
          {activity ? <RunningBadge /> : <span className="message-time">{formatTime(m.created_at)}</span>}
          {modelEffortLine && <span className="message-model-effort">{modelEffortLine}</span>}
        </div>
        {replyAuthorName && (
          <div className="reply-preview">
            Replying to <strong>{replyAuthorName}</strong>{replySnippet ? `: ${replySnippet}` : ""}
          </div>
        )}
        <div className="message-content">
          <MarkdownContent content={m.content} targets={mentionTargets} onMentionClick={onMentionClick} />
          {m.status === "streaming" && m.content.length > 0 && <span className="streaming-cursor" />}
          {activity && (m.content.length === 0 || activity.toolName) && <AgentActivityBlock activity={activity} />}
          {m.status === "pending" && <span className="message-queued">Queued…</span>}
          {m.status === "error" && <div className="message-error">Error: {m.error_message}</div>}
        </div>
        {usage && <div className="message-usage">{usage}</div>}
        {reactionCounts.size > 0 && (
          <div className="reaction-badges">
            {Array.from(reactionCounts.entries()).map(([emoji, count]) => (
              <button key={emoji} className="reaction-badge" onClick={() => onToggleReaction(m.id, emoji)}>
                <Emoji emoji={emoji} size={15} />
                {count > 1 && <span className="reaction-badge-count">{count}</span>}
              </button>
            ))}
          </div>
        )}
        {!!replyCount && (
          <button className="thread-replies-btn" onClick={() => onOpenThread?.(m.id)}>
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
            aria-label={`React ${emoji}`}
            onClick={() => onToggleReaction(m.id, emoji)}
          >
            <Emoji emoji={emoji} size={17} />
          </button>
        ))}
        <div className="kebab-wrapper">
          <button
            className="hover-toolbar-btn reaction-pick"
            title="More reactions"
            aria-label="More reactions"
            onClick={() => setPickerOpen((v) => !v)}
          >
            <Plus />
          </button>
          {pickerOpen && (
            <EmojiPicker onPick={(emoji) => onToggleReaction(m.id, emoji)} onClose={() => setPickerOpen(false)} />
          )}
        </div>
        {onReply && (
          <button
            className="hover-toolbar-btn"
            title="Reply in thread"
            aria-label="Reply in thread"
            onClick={() => onReply(m)}
          >
            <ArrowBendUpLeft />
          </button>
        )}
        <div className="kebab-wrapper" ref={menuRef}>
          <button
            className="hover-toolbar-btn kebab-btn"
            title="More actions"
            aria-label="More actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <DotsThreeVertical weight="bold" />
          </button>
          {menuOpen && (
            <div className="kebab-menu">
              <button
                className="kebab-menu-item"
                onClick={() => {
                  navigator.clipboard
                    .writeText(m.content)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    })
                    .catch(() => {});
                  setMenuOpen(false);
                }}
              >
                {copied ? "Copied!" : "Copy text"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoized: this hook's `messages` array gets a new reference on every streamed token
// (see useConversation/useChannel's applyPatch), but unchanged rows keep the SAME
// message object reference — so as long as the other props stay referentially/value
// stable (see MessageList's use of raw callbacks + primitive reply-preview props +
// a shared empty-reactions sentinel), only the row actually streaming re-renders
// instead of every row in the conversation on every token (report §6.1/Part 0 #8).
export const MessageRow = memo(MessageRowImpl);
