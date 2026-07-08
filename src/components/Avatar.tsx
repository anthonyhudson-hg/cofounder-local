interface Props {
  name: string;
  avatar?: string | null;
  bot?: boolean;
  className?: string;
}

export function Avatar({ name, avatar, bot, className }: Props) {
  const classes = ["avatar", bot ? "avatar-bot" : "", className ?? ""].filter(Boolean).join(" ");
  if (avatar) {
    return <img className={classes} src={avatar} alt={name} />;
  }
  return <div className={classes}>{name.charAt(0).toUpperCase()}</div>;
}
