import { useState } from "react";

interface Props {
  name: string;
  avatar?: string | null;
  bot?: boolean;
  className?: string;
}

export function Avatar({ name, avatar, bot, className }: Props) {
  const [failed, setFailed] = useState(false);
  const classes = ["avatar", bot ? "avatar-bot" : "", className ?? ""].filter(Boolean).join(" ");
  if (avatar && !failed) {
    // Falls back to the initial-letter glyph below if the data URL is corrupted/truncated
    // (e.g. an interrupted upload) instead of showing a permanent broken-image icon (report §5.6).
    return <img className={classes} src={avatar} alt={name} onError={() => setFailed(true)} />;
  }
  return <div className={classes}>{name.charAt(0).toUpperCase()}</div>;
}
