import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { findMentions, MentionTarget } from "../lib/mentions";

const MENTION_SCHEME = "cofounder-mention";

function injectMentionLinks(content: string, targets: MentionTarget[]): string {
  const matches = findMentions(content, targets);
  if (matches.length === 0) return content;

  let result = "";
  let cursor = 0;
  for (const m of matches) {
    result += content.slice(cursor, m.start);
    const raw = content.slice(m.start, m.end);
    result += `[${raw}](${MENTION_SCHEME}:${m.type}:${encodeURIComponent(m.target.conversationId)})`;
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
                  if (href) void openUrl(href);
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
