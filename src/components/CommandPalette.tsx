import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search, ChevronRight, Database, Table2, Eye, FunctionSquare,
  History, FileText, Command,
} from "lucide-react";
import { useStore } from "@/store";
import { fuzzyMatch, highlightSegments, type FuzzyMatch } from "@/palette/fuzzy";
import {
  buildPaletteItems, loadRecentIds, rememberRecent,
  type ItemKind, type PaletteItem,
} from "@/palette/items";

const ROW_H = 40;

interface Mode {
  prefix: string;
  filter: (k: ItemKind) => boolean;
  hint: string;
}
const MODES: Mode[] = [
  { prefix: ">", filter: (k) => k === "action",                  hint: "Actions" },
  { prefix: "@", filter: (k) => k === "item",                    hint: "Items (tables/views/functions)" },
  { prefix: ":", filter: (k) => k === "tab",                     hint: "Open tabs" },
  { prefix: "#", filter: (k) => k === "history",                 hint: "Recent SQL" },
];

interface Scored {
  it: PaletteItem;
  m: FuzzyMatch;
}

export default function CommandPalette() {
  const { paletteOpen, closePalette, connections, schemas, tabs, selectedConnId, status } = useStore();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset when opened.
  useEffect(() => {
    if (!paletteOpen) return;
    setQ("");
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [paletteOpen]);

  // Recompute candidates whenever any slice the builder reads from changes,
  // so a palette opened mid-load picks up newly-arrived connections/schemas.
  const all = useMemo(
    () => paletteOpen ? buildPaletteItems() : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paletteOpen, connections, schemas, tabs, selectedConnId, status],
  );
  const mode = MODES.find((m) => q.startsWith(m.prefix));
  const text = mode ? q.slice(mode.prefix.length).trimStart() : q;

  const items = useMemo(() => {
    if (!paletteOpen) return [];
    let filtered = mode ? all.filter((c) => mode.filter(c.kind)) : all;
    // Hide disabled actions from the default list. They reappear when the
    // user explicitly types their name.
    if (!text) filtered = filtered.filter((c) => c.enabled !== false);

    if (!text) {
      // Empty query → put recents first, then everything grouped.
      const recents = new Set(loadRecentIds());
      const scored: Scored[] = filtered.map((c) => ({
        it: c,
        m: { score: recents.has(c.id) ? 1000 - Array.from(recents).indexOf(c.id) : 0, positions: [] },
      }));
      return sortAndCap(scored);
    }

    const scored: Scored[] = [];
    for (const c of filtered) {
      const primary = fuzzyMatch(c.title, text);
      const extra = c.searchExtra ? fuzzyMatch(c.searchExtra, text) : null;
      const best = pickBest(primary, extra);
      if (!best) continue;
      // Kind-based weighting: actions slightly favored when no mode is active.
      const kindBonus =
        c.kind === "action"     ? 8 :
        c.kind === "item"       ? 6 :
        c.kind === "tab"        ? 4 :
        c.kind === "connection" ? 4 : 0;
      scored.push({ it: c, m: { score: best.score + kindBonus, positions: best.positions } });
    }
    return sortAndCap(scored);
  }, [paletteOpen, all, mode, text]);

  // Reset active index when filter changes.
  useEffect(() => { setActive(0); }, [q]);

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  // Keep the active item in view as we arrow through.
  useEffect(() => {
    if (!paletteOpen) return;
    virt.scrollToIndex(active, { align: "auto" });
  }, [active, paletteOpen, virt]);

  if (!paletteOpen) return null;

  const choose = async (i: number) => {
    const it = items[i]?.it;
    if (!it) return;
    rememberRecent(it.id);
    closePalette();
    try { await it.run(); } catch (e) { console.error(e); }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault(); setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault(); choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault(); closePalette();
    } else if (e.key === "Tab" && !e.shiftKey && !text) {
      // Tab cycles modes when the query is empty.
      e.preventDefault();
      const i = MODES.findIndex((m) => m === mode);
      const next = MODES[(i + 1 + MODES.length) % MODES.length];
      setQ(next.prefix + " ");
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={closePalette}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={14} />
          <input
            ref={inputRef}
            type="text"
            placeholder={
              mode
                ? `${mode.hint} — type to filter…`
                : "Search actions, connections, tables, history…"
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="palette-mode-hint">
            {mode ? mode.hint : <ModeLegend />}
          </span>
        </div>

        <div className="palette-list" ref={listRef} style={{ height: 380, overflow: "auto" }}>
          {items.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((v) => {
                const row = items[v.index];
                const isActive = v.index === active;
                const showGroupHeader =
                  v.index === 0 ||
                  items[v.index - 1].it.group !== row.it.group;
                return (
                  <div
                    key={row.it.id}
                    className={`palette-row ${isActive ? "active" : ""} ${row.it.enabled === false ? "disabled" : ""}`}
                    style={{
                      position: "absolute",
                      top: v.start,
                      left: 0,
                      right: 0,
                      height: ROW_H,
                    }}
                    onMouseEnter={() => setActive(v.index)}
                    onMouseDown={(e) => { e.preventDefault(); choose(v.index); }}
                  >
                    {showGroupHeader && <div className="palette-group">{row.it.group}</div>}
                    <PaletteRow row={row} />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="palette-footer">
          <span className="muted">
            <span className="kbd">↑</span> <span className="kbd">↓</span> move ·
            {" "}<span className="kbd">↵</span> run ·
            {" "}<span className="kbd">Tab</span> mode ·
            {" "}<span className="kbd">esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({ row }: { row: Scored }) {
  const Icon = iconFor(row.it.kind);
  return (
    <div className="palette-item">
      <span className="palette-icon"><Icon size={13} /></span>
      <span className="palette-title">
        {highlightSegments(row.it.title, row.m.positions).map((seg, i) => (
          <span key={i} className={seg.matched ? "hi" : ""}>{seg.text}</span>
        ))}
      </span>
      {row.it.subtitle && <span className="palette-subtitle">{row.it.subtitle}</span>}
      {row.it.accel && <span className="kbd palette-accel">{row.it.accel}</span>}
    </div>
  );
}

function ModeLegend() {
  return (
    <span style={{ display: "inline-flex", gap: 8 }}>
      {MODES.map((m) => (
        <span key={m.prefix}>
          <span className="kbd">{m.prefix}</span>
          <span className="muted" style={{ marginLeft: 4 }}>{m.hint}</span>
        </span>
      ))}
    </span>
  );
}

function iconFor(k: ItemKind) {
  switch (k) {
    case "action":     return Command;
    case "connection": return Database;
    case "item":       return Table2;
    case "tab":        return FileText;
    case "history":    return History;
  }
}

function pickBest(a: FuzzyMatch | null, b: FuzzyMatch | null): FuzzyMatch | null {
  if (a && b) return a.score >= b.score ? a : b;
  return a ?? b;
}

function sortAndCap(scored: Scored[]): Scored[] {
  // Bring the highest-score group to the top, but preserve in-group order
  // so user reads a coherent grouped list.
  scored.sort((x, y) => y.m.score - x.m.score);
  const out: Scored[] = [];
  const groups = new Map<string, Scored[]>();
  for (const s of scored) {
    const g = groups.get(s.it.group) ?? [];
    g.push(s);
    groups.set(s.it.group, g);
  }
  // Group order = best score per group.
  const groupOrder = [...groups.entries()].sort(
    (a, b) => b[1][0].m.score - a[1][0].m.score,
  );
  for (const [, rows] of groupOrder) out.push(...rows);
  return out.slice(0, 300);
}

// Suppress unused-import warning in dev for icons used only via iconFor().
void [Eye, FunctionSquare, ChevronRight];
