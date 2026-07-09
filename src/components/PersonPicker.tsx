import { Avatar } from "./Avatar";

interface PersonPickerRowProps {
  name: string;
  avatar: string | null | undefined;
  /** Secondary line under the name, e.g. job title · department. */
  meta?: string;
  checked: boolean;
  onToggle: () => void;
}

/**
 * One selectable person row: checkbox + avatar + name + optional meta line.
 * Shared by GroupModal and ChannelMembersModal (and any future picker) so the
 * markup and `person-picker-*` styling stay in one place instead of being
 * re-implemented per modal.
 */
export function PersonPickerRow({ name, avatar, meta, checked, onToggle }: PersonPickerRowProps) {
  return (
    <label className="person-picker-row">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <Avatar name={name} avatar={avatar} bot className="person-picker-avatar" />
      <div className="person-picker-text">
        <div className="person-picker-name">{name}</div>
        {meta ? <div className="person-picker-meta">{meta}</div> : null}
      </div>
    </label>
  );
}
