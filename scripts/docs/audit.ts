/**
 * Audit doc image coverage.
 *
 * Scans every MDX file under apps/docs/src/content/docs, extracts the
 * `…/media/<name>.<ext>` paths it references, and reports which are
 * missing from apps/docs/src/assets/media. Also lists scenes that don't
 * have a corresponding image reference (orphaned PNGs).
 *
 * Run: `yarn docs:media:audit`
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DOCS_DIR = join(ROOT, "apps", "docs", "src", "content", "docs");
const MEDIA_DIR = join(ROOT, "apps", "docs", "src", "assets", "media");

// Matches both the current relative refs (…/assets/media/foo.png) and any
// legacy absolute /media/foo.png — the trailing `/media/<name>` is common.
const MEDIA_RE = /\/media\/([a-z0-9-]+)\.(png|webp|jpg|jpeg|gif|webm|mp4)/g;

interface Reference {
  /** Filename without extension — matches a scene's `name`. */
  slug: string;
  /** Original extension as written. */
  ext: string;
  /** Doc paths that referenced this media file. */
  sources: string[];
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (entry.endsWith(".mdx") || entry.endsWith(".md")) files.push(p);
  }
  return files;
}

function collectReferences(): Map<string, Reference> {
  const out = new Map<string, Reference>();
  for (const file of walk(DOCS_DIR)) {
    const content = readFileSync(file, "utf8");
    const rel = relative(ROOT, file);
    let m: RegExpExecArray | null;
    MEDIA_RE.lastIndex = 0;
    while ((m = MEDIA_RE.exec(content)) !== null) {
      const slug = m[1];
      const ext = m[2];
      const key = `${slug}.${ext}`;
      const existing = out.get(key);
      if (existing) existing.sources.push(rel);
      else out.set(key, { slug, ext, sources: [rel] });
    }
  }
  return out;
}

function collectExisting(): Set<string> {
  if (!existsSync(MEDIA_DIR)) return new Set();
  return new Set(
    readdirSync(MEDIA_DIR).filter((f) =>
      /\.(png|webp|jpg|jpeg|gif|webm|mp4)$/i.test(f),
    ),
  );
}

function main() {
  const refs = collectReferences();
  const existing = collectExisting();

  const missing: Reference[] = [];
  const present: Reference[] = [];
  for (const ref of refs.values()) {
    const file = `${ref.slug}.${ref.ext}`;
    if (existing.has(file)) present.push(ref);
    else missing.push(ref);
  }

  const referenced = new Set([...refs.values()].map((r) => `${r.slug}.${r.ext}`));
  const orphans = [...existing].filter((f) => !referenced.has(f));

  console.log("Docs media coverage");
  console.log("───────────────────");
  console.log(`Referenced:  ${refs.size}`);
  console.log(`Present:     ${present.length}`);
  console.log(`Missing:     ${missing.length}`);
  console.log(`Orphans:     ${orphans.length}`);
  console.log("");

  if (missing.length > 0) {
    console.log(`Missing (${missing.length}):`);
    for (const ref of missing.sort((a, b) => a.slug.localeCompare(b.slug))) {
      console.log(`  • ${ref.slug}.${ref.ext}`);
      for (const src of ref.sources) console.log(`      from ${src}`);
    }
    console.log("");
  }
  if (orphans.length > 0) {
    console.log(`Orphan files (in media/ but not referenced):`);
    for (const f of orphans.sort()) console.log(`  • ${f}`);
    console.log("");
  }

  // Exit non-zero if anything is missing so CI / pre-commit hooks can
  // catch unreviewed doc additions. The capture pipeline itself doesn't
  // run in CI; this only blocks if you add a doc reference without
  // committing the matching image.
  process.exit(missing.length > 0 ? 1 : 0);
}

main();
