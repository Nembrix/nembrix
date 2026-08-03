/**
 * Generate the app icon SOURCE PNG from the Nembrix brand mark.
 *
 * `brand/nembrix-mark.svg` is now a complete, self-contained icon — it
 * already includes its own rounded-square plate (silver gradient) and the
 * database-drum mark. So we render it full-bleed to a 1024×1024 PNG at
 * `src-tauri/icons/source.png` rather than compositing it onto a separate
 * dark plate (which the old flat "expansion hex" mark needed).
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

mkdirSync(dirname(OUT), { recursive: true });

// The mark's viewBox is a square (128×128) that fills the whole canvas —
// render it 1:1 to the target size. `fit: "fill"` is safe here precisely
// because the source is square; there is no aspect ratio to preserve.
await sharp(readFileSync(MARK_SVG))
  .resize(SIZE, SIZE, { fit: "fill" })
  .png({ compressionLevel: 9 })
  .toFile(OUT);

console.log(`wrote ${OUT}`);
