import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "@phosphor-icons/react";
import { ReactNode, useEffect, useState } from "react";

const appWindow = getCurrentWindow();

interface Props {
  children?: ReactNode;
}

export function TitleBar({ children }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    appWindow.isMaximized().then((v) => {
      if (!cancelled) setMaximized(v);
    });
    const unlisten = appWindow.onResized(async () => {
      const v = await appWindow.isMaximized();
      if (!cancelled) setMaximized(v);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-content" data-tauri-drag-region>
        {children}
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" title="Minimize" onClick={() => appWindow.minimize()}>
          <Minus size={14} weight="bold" />
        </button>
        <button
          className="titlebar-btn"
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => appWindow.toggleMaximize()}
        >
          <Square size={12} weight="bold" />
        </button>
        <button className="titlebar-btn titlebar-btn-close" title="Close" onClick={() => appWindow.close()}>
          <X size={14} weight="bold" />
        </button>
      </div>
    </div>
  );
}
