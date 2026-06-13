/**
 * Nembrix brand mark — "forked path".
 *
 * Inline SVG so it ships with the bundle (no extra HTTP request) and
 * can be recolored by the consumer. Geometry mirrors
 * `brand/nembrix-mark.svg`; keep them in sync.
 *
 * The mark is a stylized N where the right vertical is replaced with
 * a fork — a single source connection branches into two sessions.
 * Three endpoint dots (source + two destinations) make the topology
 * explicit at scales ≥ 32px; at favicon size they fade into the
 * silhouette and the mark still reads as a letter.
 */
import { type CSSProperties } from "react";

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** When set, the mark is rendered in this color instead of the
   *  brand gradient. Use for monochrome contexts (status bars, dock
   *  badges, social embeds that strip gradients). */
  monoColor?: string;
}

export default function NembrixMark({ size = 32, className, style, monoColor }: Props) {
  const fg = monoColor ? "#ffffff" : "url(#nembrix-fg)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Nembrix"
      className={className}
      style={style}
    >
      {!monoColor && (
        <defs>
          <linearGradient id="nembrix-bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
          <linearGradient id="nembrix-fg" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#e5edff" />
          </linearGradient>
        </defs>
      )}
      <rect width="64" height="64" rx="12" fill={monoColor ?? "url(#nembrix-bg)"} />
      <rect x="13" y="14" width="6" height="38" rx="3" fill={fg} />
      <path d="M 13 14 L 19 14 L 47.5 36 L 43.5 36 Z" fill={fg} />
      <path d="M 43.5 36 L 51.5 21.5 L 55 23 L 47 37.5 Z" fill={fg} />
      <path d="M 43.5 36 L 51.5 50.5 L 55 49 L 47 34.5 Z" fill={fg} />
      <circle cx="45" cy="36" r="5.5" fill={fg} />
      <circle cx="16" cy="11" r="3.2" fill={fg} />
      <circle cx="53" cy="22" r="3.2" fill={fg} />
      <circle cx="53" cy="50" r="3.2" fill={fg} />
    </svg>
  );
}
