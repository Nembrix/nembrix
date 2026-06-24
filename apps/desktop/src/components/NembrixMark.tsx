/**
 * Nembrix brand mark — "expansion hex".
 *
 * Loads the canonical SVG from `assets/nembrix-mark.svg`, which is a
 * copy of `brand/nembrix-mark.svg` (the brand source of truth).
 */
import { type CSSProperties } from "react";
import markUrl from "@/assets/nembrix-mark.svg";

interface Props {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export default function NembrixMark({ size = 32, className, style }: Props) {
  return (
    <img
      src={markUrl}
      width={size}
      height={size}
      alt="Nembrix"
      className={className}
      style={style}
      draggable={false}
    />
  );
}
