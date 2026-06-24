/**
 * Export the ER canvas to a downloadable image.
 *
 * Approach:
 *  - SVG: clone the live <svg>, inline computed styles so it renders
 *    standalone outside the DOM, serialize, blob, download.
 *  - PNG / JPEG: serialize the SVG to a data URI, blit onto a canvas
 *    sized to the diagram's natural bounds (not the viewport), then
 *    toBlob.
 *  - PDF: rasterize to PNG first, then embed in a single-page PDF via
 *    jsPDF sized to the image so nothing is cropped.
 *
 * The natural-bounds calculation matters: the toolbar reports pan/zoom
 * relative to the viewport, but an export should capture the full
 * schema regardless of what's currently scrolled into view.
 */

import { jsPDF } from "jspdf";

export type ExportFormat = "svg" | "png" | "jpeg" | "pdf";

/** Used to keep an export from blowing up at high zooms — a 4k pixel
 *  cap is well past presentation needs but stops accidental gigapixel
 *  bitmaps in pathological cases. */
const MAX_RASTER_DIMENSION = 4000;

interface Bounds { x: number; y: number; width: number; height: number; }

/** Compute the bounding box of all rendered <g> nodes inside the
 *  transform group, in user-space coordinates. */
function computeBounds(transformGroup: SVGGElement): Bounds {
  // getBBox() returns the union of all child bounding boxes in the
  // local coordinate system — exactly what we want because the
  // transform group is what holds pan/zoom.
  const bbox = transformGroup.getBBox();
  // Add a margin so node strokes and shadows don't get clipped.
  const margin = 24;
  return {
    x: bbox.x - margin,
    y: bbox.y - margin,
    width: bbox.width + margin * 2,
    height: bbox.height + margin * 2,
  };
}

/** Recursively inline the styles needed for offline render. SVG outside
 *  the document loses all stylesheet-driven properties, so we copy
 *  computed values onto a `style` attribute. */
function inlineComputedStyles(src: SVGElement, dst: SVGElement): void {
  const srcChildren = Array.from(src.children);
  const dstChildren = Array.from(dst.children);
  const cs = window.getComputedStyle(src);

  // Only ship the props that actually affect SVG rendering. The full
  // computed style is ~300 properties and inflates the file by 10×.
  const props = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
    "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
    "font-family", "font-size", "font-weight", "text-anchor",
    "opacity", "color",
  ];
  let inline = "";
  for (const p of props) {
    const v = cs.getPropertyValue(p);
    if (v) inline += `${p}:${v};`;
  }
  if (inline) dst.setAttribute("style", inline);

  for (let i = 0; i < srcChildren.length; i++) {
    inlineComputedStyles(srcChildren[i] as SVGElement, dstChildren[i] as SVGElement);
  }
}

/** Build a standalone SVG string scoped to `bounds`, with all styles
 *  inlined. */
export function serializeStandaloneSvg(
  svg: SVGSVGElement,
  transformGroup: SVGGElement,
  bounds: Bounds,
): string {
  // Deep-clone everything so the inlined styles don't leak back into
  // the live diagram.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const cloneGroup = clone.querySelector("g") as SVGGElement | null;
  if (cloneGroup) {
    // Drop the pan/zoom transform on the clone — the export framing is
    // controlled by viewBox, not by the transform.
    cloneGroup.removeAttribute("transform");
  }
  inlineComputedStyles(svg, clone);

  clone.setAttribute("width", String(bounds.width));
  clone.setAttribute("height", String(bounds.height));
  clone.setAttribute(
    "viewBox",
    `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`,
  );
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // Strip the background <rect> with "er-bg" — viewBox already handles
  // framing, and leaving it makes the SVG harder to recolor later.
  const bg = clone.querySelector("rect.er-bg");
  if (bg) bg.parentNode?.removeChild(bg);

  // Mention the transformGroup so the linter doesn't flag it — it's
  // used only to compute bounds outside this helper.
  void transformGroup;

  return new XMLSerializer().serializeToString(clone);
}

/** Rasterize SVG markup onto a canvas at a given pixel scale. */
async function rasterize(
  svgMarkup: string,
  bounds: Bounds,
  scale: number,
  background: string | null,
): Promise<HTMLCanvasElement> {
  // Clamp scale so absurd zooms (or huge diagrams) can't OOM the tab.
  const maxDim = Math.max(bounds.width, bounds.height) * scale;
  const safeScale = maxDim > MAX_RASTER_DIMENSION
    ? MAX_RASTER_DIMENSION / Math.max(bounds.width, bounds.height)
    : scale;

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(bounds.width * safeScale);
  canvas.height = Math.ceil(bounds.height * safeScale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Image load failed: ${String(e)}`));
    img.src = url;
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has a chance to actually start the download.
  setTimeout(() => URL.revokeObjectURL(url), 250);
}

/** Run an ER export end-to-end: compute bounds, serialize, rasterize
 *  if needed, trigger download. */
export async function exportErCanvas(
  svg: SVGSVGElement,
  transformGroup: SVGGElement,
  format: ExportFormat,
  schemaName: string,
): Promise<void> {
  const bounds = computeBounds(transformGroup);
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("Nothing to export — diagram is empty.");
  }
  const markup = serializeStandaloneSvg(svg, transformGroup, bounds);
  const base = `er-${schemaName.replace(/[^a-z0-9]/gi, "_")}`;

  if (format === "svg") {
    downloadBlob(new Blob([markup], { type: "image/svg+xml" }), `${base}.svg`);
    return;
  }

  // Raster path: PNG / JPEG / PDF all start from the same canvas.
  const scale = 2; // crisp on retina; clamped inside rasterize
  const bg = format === "jpeg" ? "#ffffff" : null;
  const canvas = await rasterize(markup, bounds, scale, bg);

  if (format === "png" || format === "jpeg") {
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const quality = format === "jpeg" ? 0.92 : undefined;
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, quality));
    if (!blob) throw new Error("Failed to encode raster");
    downloadBlob(blob, `${base}.${format === "png" ? "png" : "jpg"}`);
    return;
  }

  // PDF
  const dataUrl = canvas.toDataURL("image/png");
  // Orient PDF to the diagram aspect ratio so the schema fills the page.
  const orientation = canvas.width >= canvas.height ? "landscape" : "portrait";
  const pdf = new jsPDF({
    orientation,
    unit: "pt",
    // Use the canvas pixel size as the page size — guarantees no
    // cropping, no down-sampling, no awkward letter/A4 fit math.
    format: [canvas.width, canvas.height],
  });
  pdf.addImage(dataUrl, "PNG", 0, 0, canvas.width, canvas.height);
  pdf.save(`${base}.pdf`);
}
