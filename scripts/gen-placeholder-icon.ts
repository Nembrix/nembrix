/**
 * Generate a placeholder app icon source PNG.
 *
 * Writes a 1024×1024 PNG to `src-tauri/icons/source.png`. From there,
 * `yarn tauri icon src-tauri/icons/source.png` produces every variant
 * the bundlers need (.icns, .ico, the size series).
 *
 * Replace the source PNG with a real icon when you have one — the
 * workflow re-runs `tauri icon` only when source.png changes
 * (well, when you commit a new one). Today this generates a flat
 * "DB" mark on a slate gradient as a stand-in.
 */

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src-tauri", "icons", "source.png");

const SIZE = 1024;

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="180" fill="url(#bg)"/>
  <rect x="180" y="280" width="664" height="100" rx="50" fill="url(#accent)"/>
  <rect x="180" y="460" width="664" height="100" rx="50" fill="url(#accent)" opacity="0.7"/>
  <rect x="180" y="640" width="664" height="100" rx="50" fill="url(#accent)" opacity="0.4"/>
</svg>
`;

mkdirSync(dirname(OUT), { recursive: true });

await sharp(Buffer.from(svg))
  .resize(SIZE, SIZE)
  .png({ compressionLevel: 9 })
  .toFile(OUT);

console.log(`wrote ${OUT}`);
