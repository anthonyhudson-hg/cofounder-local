import { useCallback, useRef, useState } from "react";

export function useResizableWidth(
  initialWidth: number,
  min: number,
  max: number,
  direction: "left" | "right",
) {
  const [width, setWidth] = useState(initialWidth);
  const startRef = useRef({ x: 0, width: initialWidth });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startRef.current = { x: e.clientX, width };

      const onMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startRef.current.x;
        const next = direction === "right" ? startRef.current.width + delta : startRef.current.width - delta;
        setWidth(Math.min(max, Math.max(min, next)));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width, min, max, direction],
  );

  return { width, onMouseDown };
}
