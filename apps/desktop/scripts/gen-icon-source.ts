/**
 * Generate the app icon SOURCE PNG from the Nembrix brand mark.
 *
 * `brand/nembrix-mark.svg` is a transparent outline mark (the database
 * puck), so we composite it centered onto a rounded-square plate — the
 * shape macOS/Windows expect for an app icon — and write a 1024×1024 PNG
 * to `src-tauri/icons/source.png`.
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
// Use the SOLID mark for the icon: on a small app-icon plate the filled
// body reads more clearly than the thin outline stroke.
const MARK_SVG = join(REPO_ROOT, "brand", "nembrix-mark-solid.svg");
const OUT = join(__dirname, "..", "src-tauri", "icons", "source.png");

const SIZE = 1024;
// Corner radius ~18% of the canvas — the macOS "squircle"-ish rounding.
const RADIUS = 180;
// Leave the mark at ~54% of the canvas so it breathes inside the plate.
const MARK_FRAC = 0.54;

// Light silver plate so the dark mark reads (matches the app's neutral
// surfaces rather than a heavy black tile).
const plate = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="#eef1f5"/>
      <stop offset="55%" stop-color="#dfe4ea"/>
      <stop offset="100%" stop-color="#cdd4dd"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" fill="url(#bg)"/>
</svg>
`;

// Render the brand mark to a transparent square, preserving aspect ratio.
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
