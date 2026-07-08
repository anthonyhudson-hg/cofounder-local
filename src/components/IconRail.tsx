import { ChatsCircle, House, TreeStructure } from "@phosphor-icons/react";
import { ReactNode } from "react";

export type RailView = "home" | "chats" | "orgchart";

interface Props {
  view: RailView;
  onSelectView: (view: RailView) => void;
  header?: ReactNode;
}

export function IconRail({ view, onSelectView, header }: Props) {
  return (
    <nav className="icon-rail">
      {header && <div className="icon-rail-header">{header}</div>}
      <button
        className={`icon-rail-btn ${view === "home" ? "active" : ""}`}
        title="Home"
        aria-current={view === "home" ? "page" : undefined}
        onClick={() => onSelectView("home")}
      >
        <House className="icon-rail-glyph" weight={view === "home" ? "fill" : "regular"} size={22} />
        <span className="icon-rail-label">Home</span>
      </button>
      <button
        className={`icon-rail-btn ${view === "chats" ? "active" : ""}`}
        title="Chats"
        aria-current={view === "chats" ? "page" : undefined}
        onClick={() => onSelectView("chats")}
      >
        <ChatsCircle className="icon-rail-glyph" weight={view === "chats" ? "fill" : "regular"} size={22} />
        <span className="icon-rail-label">Chats</span>
      </button>
      <button
        className={`icon-rail-btn ${view === "orgchart" ? "active" : ""}`}
        title="Org chart"
        aria-current={view === "orgchart" ? "page" : undefined}
        onClick={() => onSelectView("orgchart")}
      >
        <TreeStructure className="icon-rail-glyph" weight={view === "orgchart" ? "fill" : "regular"} size={22} />
        <span className="icon-rail-label">Org chart</span>
      </button>
    </nav>
  );
}
