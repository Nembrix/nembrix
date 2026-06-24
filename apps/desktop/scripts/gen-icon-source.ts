/**
 * Generate the app icon SOURCE PNG from the Nembrix brand mark.
 *
 * Composites `brand/nembrix-mark.svg` (the steel-blue "expansion hex")
 * centered, with padding, onto a dark-slate rounded-square plate — the
 * shape macOS/Windows expect for an app icon — and writes a 1024×1024
 * PNG to `src-tauri/icons/source.png`.
 *
 * From there, `yarn tauri icon src-tauri/icons/source.png` produces every
 * variant the bundlers need (.icns, .ico, the PNG size series, the
 * Windows Square*Logo set). Run both via `yarn gen-icon`.
 *
 * Re-run this whenever the brand mark changes.
 */

import sharp from "sharp";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const MARK_SVG = join(REPO_ROOT, "brand", "nembrix-mark.svg");
const OUT = join(__dirname, "..", "src-tauri", "icons", "source.png");

const SIZE = 1024;
// Corner radius ~18% of the canvas — matches the macOS "squircle"-ish
// rounding the previous placeholder used (180/1024).
const RADIUS = 180;
// Leave the mark at ~62% of the canvas so it breathes inside the plate
// rather than bleeding to the corners.
const MARK_FRAC = 0.62;

const plate = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#bg)"/>
</svg>
`;

// Render the brand mark to a transparent square at the target size,
// preserving its aspect ratio (the source viewBox is 847×898).
const markPx = Math.round(SIZE * MARK_FRAC);
const mark = await sharp(readFileSync(MARK_SVG))
  .resize(markPx, markPx, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

mkdirSync(dirname(OUT), { recursive: true });

await sharp(Buffer.from(plate))
  .composite([{ input: mark, gravity: "center" }])
  .png({ compressionLevel: 9 })
  .toFile(OUT);

console.log(`wrote ${OUT}`);
