import { useCallback, useEffect, useRef, useState } from "react";

export function useResizableWidth(
  initialWidth: number,
  min: number,
  max: number,
  direction: "left" | "right",
) {
  const [width, setWidth] = useState(initialWidth);
  const startRef = useRef({ x: 0, width: initialWidth });
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // If the component unmounts mid-drag (panel closed while the mouse button is
    // still held), the mousemove/mouseup listeners registered in onMouseDown would
    // otherwise leak and keep calling setWidth on an unmounted component forever
    // (report §5.9).
    return () => cleanupRef.current?.();
  }, []);

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
        cleanupRef.current = null;
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      cleanupRef.current = onUp;
    },
    [width, min, max, direction],
  );

  return { width, onMouseDown };
}
