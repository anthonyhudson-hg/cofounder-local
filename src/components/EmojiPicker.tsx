import { useEffect, useRef } from "react";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { EMOJI_CATEGORIES } from "../lib/emoji";
import { Emoji } from "./Emoji";

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEscapeToClose(true, onClose);

  return (
    <div className="emoji-picker" ref={ref}>
      {EMOJI_CATEGORIES.map((cat) => (
        <div key={cat.label} className="emoji-picker-category">
          <div className="emoji-picker-category-label">{cat.label}</div>
          <div className="emoji-picker-grid">
            {cat.emojis.map((emoji) => (
              <button
                key={emoji}
                className="emoji-picker-item"
                onClick={() => {
                  onPick(emoji);
                  onClose();
                }}
              >
                <Emoji emoji={emoji} size={22} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
