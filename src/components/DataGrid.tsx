import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pin, PinOff, BarChart3, Save } from "lucide-react";
import type { Tab } from "@/store";
import { useStore } from "@/store";
import type { CellValue, ForeignKey, RelationNode } from "@/ipc/types";
import ColumnSummaryPopover from "@/features/grid/ColumnSummaryPopover";
import ForeignKeyPanel from "@/features/grid/ForeignKeyPanel";
import { rewriteSqlWithFilters } from "@/features/grid/filter-sql";
import { scopeKey, getWidth, setWidth } from "@/components/grid-column-widths";
import ContextMenu, { type ContextItem } from "@/components/ContextMenu";
import { buildUpdate, cellToText, pkValuesFor, valueLiteral } from "@/components/grid_edit";
import * as api from "@/ipc/commands";

const ROW_H = 22;
const GUTTER_W = 44;        // wider — hosts the row number + pin button
const DEFAULT_COL_W = 160;
const FK_BADGE_W = 26;

function renderCell(v: CellValue): { text: string; isNull: boolean } {
  switch (v.kind) {
    case "null": return { text: "NULL", isNull: true };
    case "bool": return { text: v.value ? "true" : "false", isNull: false };
    case "int":
    case "float": return { text: String(v.value), isNull: false };
    case "text":
    case "raw": return { text: v.value, isNull: false };
    case "document": return { text: JSON.stringify(v.value), isNull: false };
    case "bytes": return { text: `<${v.value.length} bytes>`, isNull: false };
  }
}

/**
 * Estimate a sensible column width from the data so the grid doesn't feel
 * cramped on numeric ids or overflow on long text. Sampled from the first N
 * rows.
 */
function widthForColumn(
  name: string,
  rows: CellValue[][],
  colIdx: number,
  hasFkBadge: boolean,
): number {
  const HEADER_PAD = 32 + (hasFkBadge ? FK_BADGE_W : 0);
  const SAMPLE = Math.min(50, rows.length);
  let maxChars = name.length;
  for (let i = 0; i < SAMPLE; i++) {
    const text = renderCell(rows[i][colIdx]).text;
    if (text.length > maxChars) maxChars = text.length;
  }
  // ~7 px/char for our monospace, clamped.
  const px = Math.min(420, Math.max(80, maxChars * 7 + HEADER_PAD));
  return px;
}

export default function DataGrid({ tab }: { tab: Tab }) {
  const { schemas, updateTab } = useStore();
  const cols = tab.columns ?? [];
  const rawRows = tab.rows ?? [];
  // Client-side sort state. `null` means natural row order (server-side).
  // Cycling: null → asc → desc → null on repeated header clicks.
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const rows = useMemo(() => {
    if (!sort || sort.col >= cols.length) return rawRows;
    const idx = sort.col;
    const sign = sort.dir === "asc" ? 1 : -1;
    // Sort by the cell's primitive value; nulls always go last regardless
    // of direction so the user can still scan to the bottom for them.
    const copy = [...rawRows];
    const valueOf = (cell: CellValue | undefined): unknown =>
      cell == null || cell.kind === "null" ? null : (cell as { value: unknown }).value;
    copy.sort((a, b) => {
      const av = valueOf(a[idx]);
      const bv = valueOf(b[idx]);
      const an = av == null;
      const bn = bv == null;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
      const as = String(av);
      const bs = String(bv);
      return as.localeCompare(bs, undefined, { numeric: true }) * sign;
    });
    return copy;
  }, [rawRows, sort, cols.length]);
  const parentRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [summary, setSummary] = useState<{ x: number; y: number; col: number } | null>(null);
  const [fkPanel, setFkPanel] = useState<{ fk: ForeignKey; cell: CellValue } | null>(null);
  /** Currently-edited cell. While set, the cell renders an <input>. */
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  /** Right-click context menu state. */
  const [cellCtx, setCellCtx] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  /** Whether we're currently committing pending edits — disables the
   *  Save button so we don't double-fire. */
  const [savingEdits, setSavingEdits] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const pendingEdits = tab.pendingEdits ?? {};
  const pendingCount = Object.keys(pendingEdits).length;

  /** Pull the table's primary key from the schema cache — used both for
   *  the Save flow and to decide whether to allow edit at all. */
  const pk = useMemo<string[]>(() => {
    if (!tab.sourceRelation) return [];
    const tree = schemas[tab.connId];
    const sc = tree?.databases[0]?.schemas.find((s) => s.name === tab.sourceRelation!.schema);
    return sc?.tables.find((t) => t.name === tab.sourceRelation!.table)?.primary_key ?? [];
  }, [schemas, tab.connId, tab.sourceRelation]);
  const editable = pk.length > 0 && !!tab.sourceRelation;

  // Live width overrides from drag (committed to localStorage on mouseup).
  // Stored in state so the table re-renders during the drag.
  const scope = useMemo(
    () => scopeKey(tab.connId, tab.sourceRelation, tab.id),
    [tab.connId, tab.sourceRelation, tab.id],
  );
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  // Hydrate persisted overrides whenever the scope changes.
  useEffect(() => {
    const next: Record<string, number> = {};
    for (const c of cols) {
      const w = getWidth(scope, c.name);
      if (w != null) next[c.name] = w;
    }
    setOverrides(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, cols.length]);

  // Observe the scroll container's width so we can stretch the table to fill
  // it whenever the columns alone don't reach the right edge.
  useEffect(() => {
    if (!parentRef.current) return;
    const el = parentRef.current;
    setContainerW(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      setContainerW(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Resolve schema info for FK navigation.
  const relation = useMemo<RelationNode | undefined>(() => {
    if (!tab.sourceRelation) return undefined;
    const tree = schemas[tab.connId];
    const db = tree?.databases[0];
    const sc = db?.schemas.find((s) => s.name === tab.sourceRelation!.schema);
    return sc?.tables.find((t) => t.name === tab.sourceRelation!.table)
        ?? sc?.views.find((v) => v.name === tab.sourceRelation!.table);
  }, [schemas, tab.connId, tab.sourceRelation]);

  const fkByCol = useMemo(() => {
    const m = new Map<string, ForeignKey>();
    for (const fk of relation?.foreign_keys ?? []) {
      if (fk.columns.length === 1) m.set(fk.columns[0], fk);
    }
    return m;
  }, [relation]);

  /**
   * The single source of truth for column widths — shared between header
   * and body via identical <colgroup>s so they always align.
   *
   * Override priority: drag-set width > sampled width > DEFAULT_COL_W.
   * `resizeTick` is in the deps so the memo recomputes while dragging.
   */
  const colWidths = useMemo(
    () => cols.map((c, i) => {
      const o = overrides[c.name];
      if (o != null) return o;
      return rows.length === 0
        ? DEFAULT_COL_W
        : widthForColumn(c.name, rows, i, fkByCol.has(c.name));
    }),
    [cols, rows, fkByCol, overrides],
  );

  const totalColW = GUTTER_W + colWidths.reduce((a, b) => a + b, 0);
  // Filler col absorbs remaining horizontal space when the columns are
  // narrower than the visible container — so horizontal row rules and
  // hover stripes extend cleanly to the right edge.
  const fillerW = Math.max(0, containerW - totalColW);
  const totalTableW = totalColW + fillerW;
  const pinned = tab.pinned ?? [];
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const displayOrder = useMemo(() => {
    if (!pinned.length) return rows.map((_, i) => i);
    const others = rows.map((_, i) => i).filter((i) => !pinnedSet.has(i));
    return [...pinned, ...others];
  }, [rows, pinned, pinnedSet]);

  const virtualCount = Math.max(0, displayOrder.length - pinned.length);
  const rowVirtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const togglePin = (rowIdx: number) => {
    const next = pinnedSet.has(rowIdx)
      ? pinned.filter((i) => i !== rowIdx)
      : [...pinned, rowIdx];
    updateTab(tab.id, { pinned: next });
  };

  /* ⌘S to save all pending edits. The handler is hoisted up here (not
   * with the rest of the edit logic below) so it runs even when the
   * grid early-returns on "no columns yet" — otherwise React sees a
   * different hook count between renders and crashes the tree. The
   * saveAllEdits function is defined later, so we route through a ref. */
  const saveAllEditsRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = useStore.getState().activeTabId;
      if (active !== tab.id) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && pendingCount > 0) {
        e.preventDefault();
        void saveAllEditsRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab.id, pendingCount]);

  // No columns yet → nothing useful to render; show the status placeholder.
  // (Once a query has actually executed we always get column metadata back
  // from the streamer, even for an empty result set.)
  if (!cols.length) {
    return (
      <div className="placeholder">
        <span className="muted">{tab.running ? "Running…" : "No results yet."}</span>
      </div>
    );
  }
  // Columns are known but the query returned zero rows. Fall through and
  // render the header row anyway so the user can see the schema; we add
  // a small "0 rows" hint inside the scrolling body in lieu of cells.

  const onHeaderClick = (_e: React.MouseEvent, idx: number) => {
    // Cycle sort state: none → asc → desc → none.
    setSort((cur) => {
      if (!cur || cur.col !== idx) return { col: idx, dir: "asc" };
      if (cur.dir === "asc") return { col: idx, dir: "desc" };
      return null;
    });
  };

  /** Open the column-summary popover. Triggered by the small chart
   *  icon in the header (the header itself is now reserved for sort). */
  const openSummary = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSummary({ x: rect.left, y: rect.bottom, col: idx });
  };

  /**
   * Start a column-width drag. We track the starting width + cursor X,
   * then update the override on every move. On mouseup we persist to
   * localStorage. The grip stops the click from bubbling so the column
   * summary popover doesn't open mid-drag.
   */
  const startResize = (e: React.MouseEvent, col: string, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[idx];
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(40, Math.round(startW + (ev.clientX - startX)));
      setOverrides((prev) => prev[col] === next ? prev : { ...prev, [col]: next });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const finalW = Math.max(40, Math.round(startW + (ev.clientX - startX)));
      setWidth(scope, col, finalW);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onCellClick = (rowIdx: number, colIdx: number) => {
    const colName = cols[colIdx]?.name;
    const fk = colName ? fkByCol.get(colName) : undefined;
    if (!fk) return;
    const cell = rows[rowIdx][colIdx];
    if (cell.kind === "null") return;
    setFkPanel({ fk, cell });
  };

  /** Stash a pending edit on the tab. Doesn't write to the DB yet. */
  const setPending = (rowIdx: number, colIdx: number, value: string) => {
    const key = `${rowIdx}:${colIdx}`;
    const next = { ...pendingEdits, [key]: value };
    updateTab(tab.id, { pendingEdits: next });
  };
  const clearPending = (rowIdx: number, colIdx: number) => {
    const key = `${rowIdx}:${colIdx}`;
    const next = { ...pendingEdits };
    delete next[key];
    updateTab(tab.id, { pendingEdits: next });
  };
  const discardAllEdits = () => updateTab(tab.id, { pendingEdits: {} });

  /** Commit every pending edit in a single transaction, then refresh. */
  const saveAllEdits = async () => {
    if (pendingCount === 0 || savingEdits) return;
    if (!editable || !tab.sourceRelation) {
      setSaveErr("This table has no primary key — edits can't be saved.");
      return;
    }
    setSavingEdits(true);
    setSaveErr(null);
    const stmts: string[] = ["BEGIN;"];
    try {
      for (const [key, raw] of Object.entries(pendingEdits)) {
        const [rStr, cStr] = key.split(":");
        const rowIdx = Number(rStr);
        const colIdx = Number(cStr);
        const col = cols[colIdx];
        if (!col) continue;
        const pkVals = pkValuesFor(cols, rows[rowIdx], pk);
        if (!pkVals) throw new Error(`Row ${rowIdx}: PK columns missing from result.`);
        const newLit = raw === "__NULL__"
          ? "NULL"
          : valueLiteral(raw, col.type_name);
        stmts.push(buildUpdate({
          schema: tab.sourceRelation.schema,
          table: tab.sourceRelation.table,
          column: col.name,
          newLiteral: newLit,
          pkColumns: pk,
          pkValues: pkVals,
        }));
      }
      stmts.push("COMMIT;");
      for (const sql of stmts) {
        await api.execute(tab.connId, sql);
      }
      // Clear pending + force a refresh of the data so the user sees the
      // committed values.
      updateTab(tab.id, {
        pendingEdits: {},
        refreshTick: (tab.refreshTick ?? 0) + 1,
      });
    } catch (e) {
      try { await api.execute(tab.connId, "ROLLBACK;"); } catch { /* ignore */ }
      setSaveErr(String(e));
    } finally {
      setSavingEdits(false);
    }
  };

  // Keep the ⌘S handler (set up above the early return) pointed at the
  // current saveAllEdits closure. Cheap to do on every render.
  saveAllEditsRef.current = saveAllEdits;

  /** Right-click on a cell → context menu. */
  const onCellContextMenu = (e: React.MouseEvent, rowIdx: number, colIdx: number) => {
    e.preventDefault();
    const cell = rows[rowIdx][colIdx];
    const text = cellToText(cell);
    const items: ContextItem[] = [
      { label: "Copy",
        onClick: () => void navigator.clipboard.writeText(text) },
      { label: "Copy as JSON",
        onClick: () => void navigator.clipboard.writeText(JSON.stringify(cell)) },
      { label: "Copy row (TSV)",
        onClick: () => void navigator.clipboard.writeText(
          rows[rowIdx].map(cellToText).join("\t"),
        ) },
      { separator: true },
      editable
        ? { label: "Edit", onClick: () => setEditing({ row: rowIdx, col: colIdx }) }
        : { label: "Edit (no PK on table)", onClick: () => {} },
      editable
        ? { label: "Set NULL", onClick: () => setPending(rowIdx, colIdx, "__NULL__") }
        : { label: "Set NULL (no PK on table)", onClick: () => {} },
    ];
    setCellCtx({ x: e.clientX, y: e.clientY, items });
  };

  const items = rowVirtualizer.getVirtualItems();
  const bodyTotalH = rowVirtualizer.getTotalSize();
  // Ensure the column rules extend at least to the bottom of the visible viewport.
  const minBodyH = (parentRef.current?.clientHeight ?? 320) - ROW_H; // header height
  const renderedH = Math.max(bodyTotalH, minBodyH);

  /** Reusable <colgroup> so header + body line up exactly. Includes a
   *  filler col when the columns are narrower than the container, so row
   *  rules + hover stripes extend to the right edge. */
  const colgroup = (
    <colgroup>
      <col style={{ width: GUTTER_W }} />
      {colWidths.map((w, i) => <col key={i} style={{ width: w }} />)}
      {fillerW > 0 && <col className="grid-filler-col" style={{ width: fillerW }} />}
    </colgroup>
  );

  return (
    <>
      {pendingCount > 0 && (
        <div className="grid-edit-banner">
          <span>
            <strong>{pendingCount}</strong> pending edit{pendingCount === 1 ? "" : "s"}
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          <button className="btn-link" onClick={discardAllEdits} disabled={savingEdits}>
            Discard
          </button>
          <button
            className="btn-pill primary"
            onClick={() => void saveAllEdits()}
            disabled={savingEdits}
          >
            <Save size={11} /> {savingEdits ? "Saving…" : "Save"} <span className="kbd">⌘S</span>
          </button>
        </div>
      )}
      {saveErr && (
        <div className="modal-backdrop" onClick={() => setSaveErr(null)}>
          <div
            className="modal"
            style={{ width: 560 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span style={{ color: "var(--danger)" }}>Save failed</span>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" onClick={() => setSaveErr(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ marginTop: 0 }}>
                The database rejected your changes. The transaction was
                rolled back — nothing was committed, so you can edit and
                retry.
              </p>
              <pre className="message-pane err" style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                padding: 10,
                fontSize: 12,
                maxHeight: 240,
                overflowY: "auto",
              }}>{saveErr}</pre>
            </div>
            <div className="modal-footer">
              <span style={{ flex: 1 }} />
              <button className="btn-pill" onClick={() => setSaveErr(null)}>Close</button>
              <button
                className="btn-pill primary"
                onClick={() => { setSaveErr(null); void saveAllEdits(); }}
                disabled={savingEdits}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
      <div ref={parentRef} className="grid-scroll">
        {/* HEADER — its own table so it can stick while the body scrolls. */}
        <table className="grid grid-header" style={{ width: totalTableW }}>
          {colgroup}
          <thead>
            <tr>
              <th className="grid-gutter" />
              {cols.map((c, i) => {
                const sortDir = sort?.col === i ? sort.dir : null;
                return (
                <th
                  key={c.name}
                  title={`${c.name} :: ${c.type_name}\nClick to sort · drag right border to resize`}
                  onClick={(e) => onHeaderClick(e, i)}
                  className={`${fkByCol.has(c.name) ? "fk" : ""} ${sortDir ? "sorted" : ""}`}
                >
                  <span className="hdr-name">{c.name}</span>
                  {fkByCol.has(c.name) && <span className="fk-badge" title={`→ ${fkByCol.get(c.name)?.referenced_table}`}>fk</span>}
                  {sortDir && (
                    <span className="hdr-sort" aria-label={`Sorted ${sortDir}ending`}>
                      {sortDir === "asc" ? "▲" : "▼"}
                    </span>
                  )}
                  <span className="hdr-stats" onClick={(e) => openSummary(e, i)}><BarChart3 size={10} /></span>
                  <span
                    className="col-resize-grip"
                    onMouseDown={(e) => startResize(e, c.name, i)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      // Double-click resets to the sampled width.
                      const next = { ...overrides };
                      delete next[c.name];
                      setOverrides(next);
                      setWidth(scope, c.name, widthForColumn(c.name, rows, i, fkByCol.has(c.name)));
                    }}
                    role="separator"
                    aria-orientation="vertical"
                    title="Drag to resize · double-click to reset"
                  />
                </th>
                );
              })}
              {fillerW > 0 && <th className="grid-filler-cell" aria-hidden="true" />}
            </tr>
          </thead>
        </table>

        {/* BODY — same colgroup so columns align with the header. */}
        <table className="grid grid-body" style={{ width: totalTableW, height: renderedH }}>
          {colgroup}
          <tbody>
            {pinned.map((rowIdx) => (
              <Row
                key={`pin-${rowIdx}`}
                rowIdx={rowIdx}
                displayIdx={rowIdx + 1}
                row={rows[rowIdx]}
                cols={cols}
                fkByCol={fkByCol}
                pinned
                onTogglePin={() => togglePin(rowIdx)}
                onCellClick={onCellClick}
                hasFiller={fillerW > 0}
                editing={editing}
                editable={editable}
                pendingEdits={pendingEdits}
                onStartEdit={(r, c) => setEditing({ row: r, col: c })}
                onCommitEdit={(r, c, v) => {
                  setEditing(null);
                  const orig = cellToText(rows[r][c]);
                  if (v !== orig) setPending(r, c, v);
                  else clearPending(r, c);
                }}
                onCancelEdit={() => setEditing(null)}
                onContextMenu={onCellContextMenu}
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                  display: "table-row",
                  background: "var(--bg-1)",
                  borderTop: "2px solid var(--accent)",
                }}
              />
            ))}
            {/* Spacer + absolute rows for virtualization */}
            <tr style={{ height: bodyTotalH }} aria-hidden="true">
              <td colSpan={cols.length + 1} style={{ padding: 0, border: 0 }}>
                <div className="virtual-pad" style={{ height: bodyTotalH, position: "relative" }}>
                  {items.map((vi) => {
                    const rowIdx = displayOrder[vi.index + pinned.length];
                    return (
                      <table
                        key={`r-${rowIdx}`}
                        className="grid grid-virt-row"
                        style={{
                          position: "absolute",
                          top: vi.start,
                          left: 0,
                          width: totalTableW,
                          height: ROW_H,
                        }}
                      >
                        {colgroup}
                        <tbody>
                          <Row
                            rowIdx={rowIdx}
                            displayIdx={rowIdx + 1}
                            row={rows[rowIdx]}
                            cols={cols}
                            fkByCol={fkByCol}
                            pinned={false}
                            onTogglePin={() => togglePin(rowIdx)}
                            onCellClick={onCellClick}
                            hasFiller={fillerW > 0}
                            editing={editing}
                            editable={editable}
                            pendingEdits={pendingEdits}
                            onStartEdit={(r, c) => setEditing({ row: r, col: c })}
                            onCommitEdit={(r, c, v) => {
                              setEditing(null);
                              const orig = cellToText(rows[r][c]);
                              if (v !== orig) setPending(r, c, v);
                              else clearPending(r, c);
                            }}
                            onCancelEdit={() => setEditing(null)}
                            onContextMenu={onCellContextMenu}
                          />
                        </tbody>
                      </table>
                    );
                  })}
                </div>
              </td>
            </tr>
            {/* Tail filler row so the vertical column rules extend below the last data row. */}
            {renderedH > bodyTotalH && (
              <tr style={{ height: renderedH - bodyTotalH }} className="grid-filler">
                <td className="grid-gutter" />
                {cols.map((c) => <td key={c.name} />)}
                {fillerW > 0 && <td className="grid-filler-cell" aria-hidden="true" />}
              </tr>
            )}
          </tbody>
        </table>
        {/* Inline hint when the query ran but returned no rows. We render
            this as an overlay so it sits above the filler stripes without
            disturbing the column-aligned table layout. */}
        {rows.length === 0 && !tab.running && (
          <div className="grid-empty-hint">
            <span className="muted">No rows match — the table or query returned 0 results.</span>
          </div>
        )}
      </div>

      {cellCtx && (
        <ContextMenu
          x={cellCtx.x}
          y={cellCtx.y}
          items={cellCtx.items}
          onClose={() => setCellCtx(null)}
        />
      )}

      {summary && (
        <ColumnSummaryPopover
          anchor={{ x: summary.x, y: summary.y }}
          col={cols[summary.col]}
          rows={rows}
          colIndex={summary.col}
          onClose={() => setSummary(null)}
          onAddFilter={(value) => {
            const colName = cols[summary.col].name;
            const next = [
              ...(tab.filters ?? []),
              {
                id: crypto.randomUUID(),
                column: colName,
                op: value === "__NULL__" ? "IS NULL" as const : "=" as const,
                value: value === "__NULL__" ? null : value,
              },
            ];
            const currentSql = useStore.getState().tabs.find((t) => t.id === tab.id)?.sql ?? "";
            updateTab(tab.id, { filters: next, sql: rewriteSqlWithFilters(currentSql, next) });
            setSummary(null);
          }}
        />
      )}

      {fkPanel && (
        <ForeignKeyPanel
          connId={tab.connId}
          fk={fkPanel.fk}
          cellValue={fkPanel.cell}
          onClose={() => setFkPanel(null)}
        />
      )}
    </>
  );
}

function Row({
  rowIdx, displayIdx, row, cols, fkByCol, pinned, onTogglePin, onCellClick, style, hasFiller,
  editing, editable, pendingEdits,
  onStartEdit, onCommitEdit, onCancelEdit, onContextMenu,
}: {
  rowIdx: number;
  /** 1-indexed row number shown in the gutter. */
  displayIdx: number;
  row: CellValue[];
  cols: { name: string; type_name: string }[];
  fkByCol: Map<string, ForeignKey>;
  pinned: boolean;
  onTogglePin: () => void;
  onCellClick: (r: number, c: number) => void;
  style?: React.CSSProperties;
  hasFiller: boolean;
  /** Coordinates of the cell currently in edit mode, if any. */
  editing: { row: number; col: number } | null;
  /** True when the table has a PK and edits are safe to write. */
  editable: boolean;
  /** Pending edits keyed by "rowIdx:colIdx" → user-typed string
   *  (or the sentinel "__NULL__"). */
  pendingEdits: Record<string, string>;
  onStartEdit: (r: number, c: number) => void;
  onCommitEdit: (r: number, c: number, value: string) => void;
  onCancelEdit: () => void;
  onContextMenu: (e: React.MouseEvent, r: number, c: number) => void;
}) {
  return (
    <tr style={style}>
      <td className="grid-gutter">
        <span className="row-number">{displayIdx}</span>
        <button
          className="pin-btn"
          onClick={onTogglePin}
          title={pinned ? "Unpin row" : "Pin row"}
        >
          {pinned ? <PinOff size={11} /> : <Pin size={11} />}
        </button>
      </td>
      {row.map((cell, ci) => {
        const { text, isNull } = renderCell(cell);
        const isFk = fkByCol.has(cols[ci].name);
        const isEditing = editing?.row === rowIdx && editing.col === ci;
        const pendingKey = `${rowIdx}:${ci}`;
        const pending = pendingEdits[pendingKey];
        const isDirty = pending !== undefined;
        // Pending value display: literal NULL sentinel becomes the
        // muted "NULL" text; otherwise show what the user typed.
        const displayText = isDirty
          ? (pending === "__NULL__" ? "NULL" : pending)
          : text;
        return (
          <td
            key={ci}
            className={[
              isNull && !isDirty ? "null" : "",
              pending === "__NULL__" ? "null pending-null" : "",
              isFk && !isEditing ? "fk-cell" : "",
              isEditing ? "editing" : "",
              isDirty ? "dirty" : "",
            ].filter(Boolean).join(" ")}
            onClick={() => {
              if (isFk && !isEditing && !isDirty) onCellClick(rowIdx, ci);
            }}
            onDoubleClick={() => editable && onStartEdit(rowIdx, ci)}
            onContextMenu={(e) => onContextMenu(e, rowIdx, ci)}
            title={isFk ? `→ ${fkByCol.get(cols[ci].name)?.referenced_schema}.${fkByCol.get(cols[ci].name)?.referenced_table}` : undefined}
          >
            {isEditing ? (
              <input
                className="cell-edit-input"
                autoFocus
                defaultValue={isDirty
                  ? (pending === "__NULL__" ? "" : pending)
                  : text}
                onBlur={(e) => onCommitEdit(rowIdx, ci, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onCommitEdit(rowIdx, ci, (e.target as HTMLInputElement).value);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onCancelEdit();
                  }
                }}
              />
            ) : (
              displayText
            )}
          </td>
        );
      })}
      {hasFiller && <td className="grid-filler-cell" aria-hidden="true" />}
    </tr>
  );
}
