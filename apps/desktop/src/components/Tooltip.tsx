import { isValidElement, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 280;
const ARROW = 4;
const PAD = 6;

/**
 * Apply a node to a React ref (callback or object form). Centralises the one
 * unavoidable `.current` write so the call site stays a plain ref setter that
 * only runs at commit time (never during render).
 */
function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref != null) {
    (ref as { current: T | null }).current = node;
  }
}

interface Props {
  /** Tooltip text. Skip entirely if empty/undefined. */
  label?: string | null;
  /** Element to attach to. Must accept ref + mouse handlers. */
  children: React.ReactElement;
  /** Preferred side; auto-flips if it would clip the viewport. */
  side?: "top" | "bottom";
  /** Optional secondary line in dim text (e.g. keyboard shortcut). */
  shortcut?: string;
}

/**
 * Tiny tooltip primitive — no popper.js, just fixed-position + portal.
 *
 * Why not just `title=`? Browser tooltips have a 700ms+ delay, look ugly
 * on dark themes, and can't carry a kbd shortcut. This shows after ~280ms,
 * matches our token palette, and supports a secondary shortcut line.
 *
 * Implementation notes:
 *  - We render into document.body via a portal so overflow:hidden ancestors
 *    (status bar, inspector, etc.) don't clip it.
 *  - Position is computed on show using getBoundingClientRect, then re-runs
 *    on scroll/resize while visible.
 *  - We auto-flip side when the preferred side would overflow.
 */
export default function Tooltip({ label, children, side = "bottom", shortcut }: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: "top" | "bottom" }>(
    { top: 0, left: 0, side },
  );
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const show = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
  };
  const hide = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  };

  // Position the tip whenever it becomes visible or the page shifts.
  useEffect(() => {
    if (!visible) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let chosen: "top" | "bottom" = side;

      // Auto-flip if preferred side doesn't fit.
      if (side === "top" && a.top - t.height - ARROW - PAD < 0) chosen = "bottom";
      if (side === "bottom" && a.bottom + t.height + ARROW + PAD > window.innerHeight) chosen = "top";

      const top = chosen === "top"
        ? a.top - t.height - ARROW
        : a.bottom + ARROW;

      // Centered horizontally; clamp inside viewport with PAD margin.
      let left = a.left + a.width / 2 - t.width / 2;
      left = Math.max(PAD, Math.min(window.innerWidth - t.width - PAD, left));
      setPos({ top, left, side: chosen });
    };

    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [visible, side]);

  // Bail out only after all hooks have run, so hook order stays stable.
  // (Returning `children` unchanged when there's no label / no valid element.)
  const child = label && isValidElement(children) ? children : null;
  if (!child) return children;

  // The child's own ref (if any). Reading a prop during render is allowed.
  const childRef = (child as React.ReactElement & {
    ref?: React.Ref<HTMLElement>;
  }).ref;

  // Ref callback (commit-time only): set the anchor and forward to the child's
  // original ref. Writing `.current` inside a ref callback is permitted.
  const captureRef = (el: HTMLElement | null) => {
    anchorRef.current = el;
    assignRef(childRef, el);
  };

  // Merge our handlers with the child's so the consumer's existing ones still
  // fire. Reading the child's type/props during render is allowed (they are
  // plain props, not refs). The ref is attached via JSX below so the linter
  // recognises it as a (commit-time) ref callback rather than a render read.
  const childProps = child.props as Record<string, unknown>;
  const Tag = child.type as React.ElementType;
  const mergedProps: Record<string, unknown> = {
    ...childProps,
    onMouseEnter: (e: React.MouseEvent) => {
      (childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined)?.(e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      (childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      (childProps.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent) => {
      (childProps.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      hide();
    },
  };

  return (
    <>
      <Tag {...mergedProps} ref={captureRef} />
      {visible && createPortal(
        <div
          ref={tipRef}
          className={`tooltip side-${pos.side}`}
          role="tooltip"
          style={{ top: pos.top, left: pos.left }}
        >
          <span className="tooltip-label">{label}</span>
          {shortcut && <span className="tooltip-shortcut">{shortcut}</span>}
        </div>,
        document.body,
      )}
    </>
  );
}
