import twemoji from "@twemoji/api";
import { useState } from "react";

interface Props {
  emoji: string;
  size?: number;
  className?: string;
}

/**
 * Renders a single emoji as a bundled Twemoji SVG so reactions look the same
 * (iOS-like) everywhere, instead of falling back to whatever emoji font the
 * OS happens to render (Segoe UI Emoji on Windows, Noto on some Linux
 * distros, etc). Only the specific emoji actually used by the reaction
 * picker/quick-reactions are bundled under public/emoji — anything else
 * falls back to the native glyph via onError.
 */
export function Emoji({ emoji, size = 18, className }: Props) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className={className} style={{ fontSize: size }}>
        {emoji}
      </span>
    );
  }

  return (
    <img
      className={className}
      src={`/emoji/${twemoji.convert.toCodePoint(emoji)}.svg`}
      alt={emoji}
      draggable={false}
      style={{ width: size, height: size, verticalAlign: "middle" }}
      onError={() => setFailed(true)}
    />
  );
}
