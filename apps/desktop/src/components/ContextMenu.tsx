import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextItem {
  label?: string;
  separator?: true;
  danger?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export default function ContextMenu({
  x, y, items, onClose,
}: {
  x: number; y: number; items: ContextItem[]; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") onClose(); });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  // After mount, measure the rendered menu and flip it into the
  // viewport if either edge would clip. This fixes the inspector
  // "+" dropdown that the caller anchors at the bottom-left of the
  // sidebar — without the flip it would render below the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + r.width > vw - margin) left = Math.max(margin, vw - r.width - margin);
    if (top + r.height > vh - margin) top = Math.max(margin, y - r.height); // flip up
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div className="sep" key={`s${i}`} />
        ) : (
          <div
            key={i}
            className={`item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""}`}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </div>
        )
      )}
    </div>
  );
}
