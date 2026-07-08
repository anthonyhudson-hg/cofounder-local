import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { findMentions, MentionTarget } from "../lib/mentions";

const MENTION_SCHEME = "cofounder-mention";

// Only these schemes may be opened via the OS handler. This app renders AI-generated
// markdown (which can itself be prompt-injected via tool output), so a crafted
// `[click here](file:///...)` or a locally-registered custom URI scheme must not be
// opened with a single click and zero warning (report §2.4).
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isSafeExternalUrl(href: string): boolean {
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

// Escapes markdown control characters in mention text before it's spliced into
// `[text](url)` link syntax. Without this, a channel/employee name containing e.g.
// `]( javascript:... )[` could break out of the intended link text and inject an
// attacker-chosen href into a real, clickable link (report §2.4) — channel names are
// now also restricted to a safe charset at creation time (see Sidebar.tsx) as
// defense in depth, but this is the layer that actually prevents the injection.
function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

function injectMentionLinks(content: string, targets: MentionTarget[]): string {
  const matches = findMentions(content, targets);
  if (matches.length === 0) return content;

  let result = "";
  let cursor = 0;
  for (const m of matches) {
    result += content.slice(cursor, m.start);
    const raw = content.slice(m.start, m.end);
    result += `[${escapeMarkdownLinkText(raw)}](${MENTION_SCHEME}:${m.type}:${encodeURIComponent(m.target.conversationId)})`;
    cursor = m.end;
  }
  result += content.slice(cursor);
  return result;
}

interface Props {
  content: string;
  targets: MentionTarget[];
  onMentionClick: (target: MentionTarget) => void;
}

export function MarkdownContent({ content, targets, onMentionClick }: Props) {
  const processed = injectMentionLinks(content, targets);

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith(`${MENTION_SCHEME}:`)) {
              const [, type, encodedId] = href.split(":");
              const conversationId = decodeURIComponent(encodedId);
              const target = targets.find((t) => t.conversationId === conversationId && t.type === type);
              return (
                <button
                  className={`mention-pill mention-${type}`}
                  onClick={() => target && onMentionClick(target)}
                >
                  {children}
                </button>
              );
            }
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (!href) return;
                  if (isSafeExternalUrl(href)) void openUrl(href);
                  else console.warn(`Blocked opening a link with a disallowed scheme: ${href}`);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
