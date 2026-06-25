import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, RotateCcw, Pencil, Eye, FileSpreadsheet, Plus, Play, Download } from "lucide-react";
import type { Tab } from "@/store";
import { useStore } from "@/store";
import type { RelationNode } from "@/ipc/types";
import {
  DEFAULT_LAYOUT, autoTune, relax, tick, type EdgeIn, type NodeIn, type NodePos,
} from "./layout";
import { useErOverlay } from "./useErOverlay";
import { projectAsRelations } from "./overlay";
import ApplyDialog from "./ApplyDialog";
import { exportErCanvas, type ExportFormat } from "./exportCanvas";

/* ───────────────────────── per-schema saved layouts ───────────────────── */

const POSITIONS_KEY = "nembrix.er.positions";

function loadFixed(scope: string): Record<string, { x: number; y: number }> {
  try {
    const all = JSON.parse(localStorage.getItem(POSITIONS_KEY) || "{}");
    return all[scope] ?? {};
  } catch { return {}; }
}
function saveFixed(scope: string, fixed: Record<string, { x: number; y: number }>) {
  try {
    const all = JSON.parse(localStorage.getItem(POSITIONS_KEY) || "{}");
    all[scope] = fixed;
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(all));
  } catch { /* ignore: best-effort */ }
}

/* ───────────────────────── component ───────────────────────── */

const NODE_W = 220;
const HEADER_H = 22;
const ROW_H = 16;
const FOOTER_H = 18;
const MIN_HEIGHT = HEADER_H + FOOTER_H + 4;

/** Pick a name that isn't already used in the schema. */
function uniqueName(prefix: string, taken: Set<string>): string {
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${prefix}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}_x`;
}

export default function ErDiagramTab({ tab }: { tab: Tab }) {
  const { schemas } = useStore();
  const tree = schemas[tab.connId];
  // Tab opens with a schema hint in `sourceRelation.schema` (we reuse the slot).
  const schemaName = tab.sourceRelation?.schema ?? tree?.databases[0]?.schemas[0]?.name ?? "public";
  const scope = `${tab.connId}:${schemaName}`;

  const sc = useMemo(
    () => tree?.databases[0]?.schemas.find((s) => s.name === schemaName),
    [tree, schemaName],
  );

  const liveTables: RelationNode[] = useMemo(() => sc?.tables ?? [], [sc]);

  // Per-(connection, schema) edit overlay. State lives here, not in the
  // grid, so opening a new ER tab on the same schema reuses the same
  // persisted edits.
  const overlay = useErOverlay({ connId: tab.connId, schemaName, liveTables });

  // The canvas always renders from the overlay's projected relations.
  // In live-fork with no edits this is byte-identical to the live tree.
  const tables = useMemo(() => projectAsRelations(overlay.state), [overlay.state]);

  // Build the input nodes + edges from the projected tables.
  const { nodes, edges, relByName } = useMemo(() => {
    const relByName = new Map(tables.map((t) => [t.name, t]));
    const nodes: NodeIn[] = tables.map((t) => ({
      id: t.name,
      width: NODE_W,
      height: Math.max(MIN_HEIGHT, HEADER_H + t.columns.length * ROW_H + FOOTER_H + 4),
    }));
    const edges: EdgeIn[] = [];
    for (const t of tables) {
      for (const fk of t.foreign_keys) {
        if (fk.referenced_schema === schemaName && relByName.has(fk.referenced_table)) {
          edges.push({ source: t.name, target: fk.referenced_table });
        }
      }
    }
    return { nodes, edges, relByName };
  }, [tables, schemaName]);

  // Per-table dirty flag from the overlay state, used to badge nodes.
  const dirtyTables = useMemo(() => {
    const s = new Set<string>();
    for (const t of overlay.state.tables) {
      if (t._added || t._dirty || (t.originalName && t.originalName !== t.name)
          || (t._droppedColumns && t._droppedColumns.length > 0)) {
        s.add(t.name);
      } else if (t.columns.some((c) => c._added || c._dirty)) {
        s.add(t.name);
      }
    }
    return s;
  }, [overlay.state]);

  const [positions, setPositions] = useState<NodePos[]>([]);
  const [highlightTable, setHighlightTable] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; offX: number; offY: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [panDrag, setPanDrag] = useState<{ startX: number; startY: number; origin: { x: number; y: number } } | null>(null);
  // Inline-rename state. Only one of these can be active at a time.
  const [tableRename, setTableRename] = useState<{ name: string; draft: string } | null>(null);
  const [colRename, setColRename] = useState<{ table: string; col: string; draft: string } | null>(null);
  // FK drag-to-connect state. While active we draw a rubber-band line
  // from the source anchor to the cursor; releasing on a column anchor
  // commits the FK.
  const [fkDrag, setFkDrag] = useState<
    { fromTable: string; fromCol: string; x: number; y: number } | null
  >(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const transformGroupRef = useRef<SVGGElement>(null);

  const doExport = async (format: ExportFormat) => {
    setExportMenuOpen(false);
    setExportErr(null);
    if (!svgRef.current || !transformGroupRef.current) return;
    try {
      await exportErCanvas(svgRef.current, transformGroupRef.current, format, schemaName);
    } catch (e) {
      setExportErr(String(e));
    }
  };

  // Initial layout. Runs once when nodes/edges change.
  useEffect(() => {
    if (nodes.length === 0) { setPositions([]); return; }
    const fixed = loadFixed(scope);
    const tuned = autoTune(DEFAULT_LAYOUT, nodes.length);
    const out = relax(nodes, edges, tuned, 280, fixed);
    setPositions(out);
     
  }, [nodes, edges, scope]);

  // Drag handling. We use document-level listeners so a drag survives the
  // pointer leaving the node, which is the natural UX.
  useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const svgRect = svgRef.current?.getBoundingClientRect();
      if (!svgRect) return;
      const x = (e.clientX - svgRect.left - pan.x) / zoom - drag.offX;
      const y = (e.clientY - svgRect.top - pan.y) / zoom - drag.offY;
      setPositions((cur) => cur.map((p) =>
        p.id === drag.id ? { ...p, x, y, vx: 0, vy: 0, pinned: true } : p,
      ));
    };
    const up = () => {
      // Persist the new pinned position.
      const fixed = loadFixed(scope);
      const node = positions.find((p) => p.id === drag.id);
      if (node) { fixed[node.id] = { x: node.x, y: node.y }; saveFixed(scope, fixed); }
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, scope, positions, pan, zoom]);

  // FK drag-to-connect — tracks the cursor while pulling a rubber-band
  // line off a column anchor. Commit happens on mouseup if the cursor
  // is over another column anchor (data-attrs on the target node).
  useEffect(() => {
    if (!fkDrag) return;
    const move = (e: MouseEvent) => {
      const svgRect = svgRef.current?.getBoundingClientRect();
      if (!svgRect) return;
      setFkDrag((cur) =>
        cur
          ? {
              ...cur,
              x: (e.clientX - svgRect.left - pan.x) / zoom,
              y: (e.clientY - svgRect.top - pan.y) / zoom,
            }
          : cur,
      );
    };
    const up = (e: MouseEvent) => {
      const target = (e.target as Element).closest("[data-fk-target]");
      if (target) {
        const toTable = target.getAttribute("data-fk-target-table") || "";
        const toCol = target.getAttribute("data-fk-target-col") || "";
        if (toTable && toCol && (toTable !== fkDrag.fromTable || toCol !== fkDrag.fromCol)) {
          overlay.addForeignKey(fkDrag.fromTable, fkDrag.fromCol, toTable, toCol);
        }
      }
      setFkDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [fkDrag, pan, zoom, overlay]);

  // Pan via background drag.
  useEffect(() => {
    if (!panDrag) return;
    const move = (e: MouseEvent) => {
      setPan({
        x: panDrag.origin.x + (e.clientX - panDrag.startX),
        y: panDrag.origin.y + (e.clientY - panDrag.startY),
      });
    };
    const up = () => setPanDrag(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [panDrag]);

  // After dragging stops, run a few cooling ticks so the rest of the graph
  // settles around the pinned node.
  useEffect(() => {
    if (drag) return;
    if (positions.length === 0) return;
    const tuned = autoTune(DEFAULT_LAYOUT, positions.length);
    let raf = 0;
    let count = 0;
    const step = () => {
      setPositions((cur) => {
        const next = [...cur];
        tick(next, edges, tuned);
        return next;
      });
      count++;
      if (count < 30) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.25, Math.min(2.5, z * factor)));
  };

  const resetLayout = () => {
    // Clear pinned and re-relax.
    saveFixed(scope, {});
    const tuned = autoTune(DEFAULT_LAYOUT, nodes.length);
    setPositions(relax(nodes, edges, tuned, 280));
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };

  const fitToView = () => {
    if (positions.length === 0 || !svgRef.current) return;
    const minX = Math.min(...positions.map((p) => p.x));
    const minY = Math.min(...positions.map((p) => p.y));
    const maxX = Math.max(...positions.map((p) => p.x + p.width));
    const maxY = Math.max(...positions.map((p) => p.y + p.height));
    const w = maxX - minX + 80;
    const h = maxY - minY + 80;
    const sw = svgRef.current.clientWidth;
    const sh = svgRef.current.clientHeight;
    const z = Math.min(sw / w, sh / h);
    setZoom(Math.max(0.25, Math.min(2.5, z)));
    setPan({
      x: (sw - (minX + maxX) * z) / 2,
      y: (sh - (minY + maxY) * z) / 2,
    });
  };

  const startNodeDrag = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    const node = positions.find((p) => p.id === id);
    if (!node) return;
    const x = (e.clientX - svgRect.left - pan.x) / zoom;
    const y = (e.clientY - svgRect.top - pan.y) / zoom;
    setDrag({ id, offX: x - node.x, offY: y - node.y });
  };

  if (!sc && overlay.mode === "live-fork") {
    return <div className="placeholder muted">Schema metadata not loaded yet — connect first.</div>;
  }

  // Render edges as straight lines between node midpoints (for now).
  const byId = new Map(positions.map((p) => [p.id, p]));
  const highlighted = highlightTable
    ? new Set<string>([highlightTable,
        ...edges.filter((e) => e.source === highlightTable || e.target === highlightTable)
              .flatMap((e) => [e.source, e.target])])
    : null;

  return (
    <div className="editor-shell">
      <div className="data-view-toolbar">
        <strong>ER diagram</strong>
        <span className="muted">· {schemaName} · {nodes.length} {nodes.length === 1 ? "table" : "tables"} · {edges.length} {edges.length === 1 ? "edge" : "edges"}</span>

        {/* Mode switcher: live-fork mirrors the real schema; sketchpad
            starts blank so the user can design without the live tables. */}
        <div className="segmented er-mode-switch" role="tablist">
          <button
            className={overlay.mode === "live-fork" ? "active" : ""}
            onClick={() => overlay.setMode("live-fork")}
            title="Edit on top of the live schema"
          >
            <Eye size={11} style={{ marginRight: 4 }} />Live fork
          </button>
          <button
            className={overlay.mode === "sketchpad" ? "active" : ""}
            onClick={() => overlay.setMode("sketchpad")}
            title="Design from scratch, ignoring the live schema"
          >
            <FileSpreadsheet size={11} style={{ marginRight: 4 }} />Sketchpad
          </button>
        </div>

        {overlay.dirty && (
          <span className="er-dirty-badge" title="Unsaved overlay edits">
            <Pencil size={11} /> {dirtyTables.size} edited
            {overlay.state.droppedTables.length > 0
              && ` · ${overlay.state.droppedTables.length} dropped`}
          </span>
        )}

        <div className="spacer" />
        <button
          className="btn-pill"
          onClick={() => {
            const taken = new Set(overlay.state.tables.map((t) => t.name));
            const name = uniqueName("new_table", taken);
            overlay.addTable(name);
            // Slip straight into rename so the user can name it without
            // hunting for the affordance.
            setTableRename({ name, draft: name });
          }}
          title="Add a new table to the overlay"
        >
          <Plus size={12} /> Table
        </button>
        <button
          className="btn-pill primary"
          onClick={() => setApplyOpen(true)}
          disabled={!overlay.dirty}
          title="Preview and run the SQL diff that reconciles the live schema with the overlay"
        >
          <Play size={12} /> Apply…
        </button>
        <div className="er-export-wrap">
          <button
            className="btn-pill"
            onClick={() => setExportMenuOpen((v) => !v)}
            title="Export the diagram to an image"
          >
            <Download size={12} /> Export
          </button>
          {exportMenuOpen && (
            <div
              className="er-export-menu"
              onMouseLeave={() => setExportMenuOpen(false)}
            >
              <button onClick={() => void doExport("svg")}>SVG</button>
              <button onClick={() => void doExport("png")}>PNG</button>
              <button onClick={() => void doExport("jpeg")}>JPEG</button>
              <button onClick={() => void doExport("pdf")}>PDF</button>
            </div>
          )}
        </div>
        <button className="btn-pill" onClick={fitToView}><Maximize2 size={12} /> Fit</button>
        <button className="btn-pill" onClick={resetLayout}><RotateCcw size={12} /> Reset layout</button>
        <button
          className="btn-pill"
          onClick={overlay.reset}
          disabled={!overlay.dirty}
          title="Discard overlay edits and re-mirror the live schema"
        >
          <RotateCcw size={12} /> Reset edits
        </button>
      </div>

      {nodes.length === 0 && (
        <div className="er-canvas-empty muted">
          {overlay.mode === "sketchpad"
            ? "Empty sketchpad — click + Table in the toolbar to start."
            : `No tables in ${schemaName}.`}
        </div>
      )}

      {exportErr && (
        <div className="message-pane err" style={{ margin: 8 }}>
          Export failed: {exportErr}
        </div>
      )}

      <svg
        ref={svgRef}
        className="er-canvas"
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (e.target === svgRef.current || (e.target as Element).tagName === "rect" && (e.target as Element).classList.contains("er-bg")) {
            setPanDrag({ startX: e.clientX, startY: e.clientY, origin: { ...pan } });
          }
        }}
      >
        <rect className="er-bg" x={0} y={0} width="100%" height="100%" fill="var(--bg-3)" />

        <g ref={transformGroupRef} transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* edges first so they render under nodes */}
          {edges.map((e, i) => {
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (!a || !b) return null;
            const hot = highlighted ? highlighted.has(e.source) && highlighted.has(e.target) : false;
            const ax = a.x + a.width / 2;
            const ay = a.y + a.height / 2;
            const bx = b.x + b.width / 2;
            const by = b.y + b.height / 2;
            return (
              <g key={i}>
                <line
                  x1={ax} y1={ay} x2={bx} y2={by}
                  className={`er-edge ${hot ? "hot" : ""}`}
                />
                <circle cx={bx} cy={by} r={5} className={`er-edge-tip ${hot ? "hot" : ""}`} />
              </g>
            );
          })}

          {/* FK drag rubber-band */}
          {fkDrag && (() => {
            const srcNode = byId.get(fkDrag.fromTable);
            const srcRel = relByName.get(fkDrag.fromTable);
            if (!srcNode || !srcRel) return null;
            const colIdx = srcRel.columns.findIndex((c) => c.name === fkDrag.fromCol);
            if (colIdx < 0) return null;
            const sx = srcNode.x + srcNode.width - 8;
            const sy = srcNode.y + HEADER_H + 2 + colIdx * ROW_H + ROW_H / 2 - 1;
            return (
              <g className="er-fk-rubber">
                <line x1={sx} y1={sy} x2={fkDrag.x} y2={fkDrag.y} />
                <circle cx={fkDrag.x} cy={fkDrag.y} r={4} />
              </g>
            );
          })()}

          {/* nodes */}
          {positions.map((p) => {
            const rel = relByName.get(p.id);
            if (!rel) return null;
            const dim = highlighted && !highlighted.has(p.id);
            const isRenamingTable = tableRename?.name === p.id;
            const footerY = p.height - FOOTER_H;
            return (
              <g
                key={p.id}
                transform={`translate(${p.x},${p.y})`}
                className={`er-node ${dim ? "dim" : ""} ${dirtyTables.has(p.id) ? "dirty" : ""}`}
                onMouseEnter={() => setHighlightTable(p.id)}
                onMouseLeave={() => setHighlightTable(null)}
              >
                <rect
                  width={p.width}
                  height={p.height}
                  rx={6}
                  className="er-node-bg"
                  onMouseDown={(e) => startNodeDrag(p.id, e)}
                  style={{ cursor: drag?.id === p.id ? "grabbing" : "grab" }}
                />

                {/* Header — title + drop-table affordance */}
                {isRenamingTable ? (
                  <foreignObject x={6} y={2} width={p.width - 28} height={HEADER_H - 2}>
                    <input
                      autoFocus
                      className="er-rename-input"
                      value={tableRename!.draft}
                      onChange={(e) => setTableRename({ ...tableRename!, draft: e.target.value })}
                      onBlur={() => {
                        const next = tableRename!.draft.trim();
                        if (next && next !== p.id) overlay.renameTable(p.id, next);
                        setTableRename(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") setTableRename(null);
                      }}
                    />
                  </foreignObject>
                ) : (
                  <text
                    x={10} y={15}
                    className="er-node-title"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setTableRename({ name: p.id, draft: p.id });
                    }}
                  >
                    {p.id}
                  </text>
                )}
                <g
                  className="er-node-action"
                  transform={`translate(${p.width - 18}, 5)`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    overlay.dropTable(p.id);
                  }}
                >
                  <title>Drop table</title>
                  <rect width={14} height={14} fill="transparent" />
                  <TrashIcon />
                </g>
                <line x1={0} y1={HEADER_H} x2={p.width} y2={HEADER_H} className="er-node-divider" />

                {/* Columns */}
                {rel.columns.map((c, i) => {
                  const isPk = rel.primary_key.includes(c.name);
                  const isFk = rel.foreign_keys.some((fk) => fk.columns.includes(c.name));
                  const renaming = colRename?.table === p.id && colRename.col === c.name;
                  return (
                    <g key={c.name} transform={`translate(0,${HEADER_H + 2 + i * ROW_H})`}>
                      <g
                        className="er-col-pk-hit"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          overlay.togglePk(p.id, c.name);
                        }}
                      >
                        <title>{isPk ? "Remove from PK" : "Make PK"}</title>
                        <rect x={2} y={0} width={14} height={ROW_H - 2} fill="transparent" />
                        {isPk && <KeyComponent />}
                      </g>
                      {renaming ? (
                        <foreignObject x={isPk ? 18 : 10} y={-1} width={p.width - 40 - (isPk ? 18 : 10)} height={ROW_H}>
                          <input
                            autoFocus
                            className="er-rename-input"
                            value={colRename!.draft}
                            onChange={(e) => setColRename({ ...colRename!, draft: e.target.value })}
                            onBlur={() => {
                              const next = colRename!.draft.trim();
                              if (next && next !== c.name) overlay.renameColumn(p.id, c.name, next);
                              setColRename(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              else if (e.key === "Escape") setColRename(null);
                            }}
                          />
                        </foreignObject>
                      ) : (
                        <text
                          x={isPk ? 18 : 10}
                          y={11}
                          className={`er-col ${isFk ? "fk" : ""}`}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setColRename({ table: p.id, col: c.name, draft: c.name });
                          }}
                        >
                          {c.name}
                        </text>
                      )}
                      <text x={p.width - 30} y={11} className="er-col-type" textAnchor="end">
                        {c.type_name}
                      </text>
                      <g
                        className="er-col-action"
                        transform={`translate(${p.width - 24}, 1)`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          overlay.dropColumn(p.id, c.name);
                        }}
                      >
                        <title>Drop column</title>
                        <rect width={12} height={ROW_H - 2} fill="transparent" />
                        <TrashIcon size={10} y={1} />
                      </g>
                      {/* FK anchor — drag from here to a column on
                          another table to create a foreign key. */}
                      <g
                        className="er-fk-anchor"
                        data-fk-target
                        data-fk-target-table={p.id}
                        data-fk-target-col={c.name}
                        transform={`translate(${p.width - 8}, ${ROW_H / 2 - 1})`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const svgRect = svgRef.current?.getBoundingClientRect();
                          if (!svgRect) return;
                          setFkDrag({
                            fromTable: p.id,
                            fromCol: c.name,
                            x: (e.clientX - svgRect.left - pan.x) / zoom,
                            y: (e.clientY - svgRect.top - pan.y) / zoom,
                          });
                        }}
                      >
                        <title>Drag to create a foreign key</title>
                        <circle cx={0} cy={0} r={6} className="er-fk-anchor-hit" fill="transparent" />
                        <circle cx={0} cy={0} r={3} className="er-fk-anchor-dot" />
                      </g>
                    </g>
                  );
                })}

                {/* Footer — Add column */}
                <line x1={0} y1={footerY} x2={p.width} y2={footerY} className="er-node-divider" />
                <g
                  className="er-add-col"
                  transform={`translate(0, ${footerY})`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const taken = new Set(rel.columns.map((c) => c.name));
                    const name = uniqueName("new_column", taken);
                    overlay.addColumn(p.id, { name, type_name: "text", nullable: true, default: null });
                    setColRename({ table: p.id, col: name, draft: name });
                  }}
                >
                  <title>Add column</title>
                  <rect width={p.width} height={FOOTER_H} fill="transparent" />
                  <text x={p.width / 2} y={12} className="er-add-col-text" textAnchor="middle">
                    + Add column
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>

      {applyOpen && (
        <ApplyDialog
          connId={tab.connId}
          schemaName={schemaName}
          state={overlay.state}
          onClose={() => setApplyOpen(false)}
          onApplied={() => {
            // After a successful apply, the live schema will be re-read
            // on the next introspect; for now we clear the overlay so
            // the badges reset.
            overlay.reset();
            setApplyOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** Tiny key icon as SVG path so we don't have to convert lucide-react to SVG-in-SVG. */
function KeyComponent() {
  return (
    <g transform="translate(4,1)" className="er-pk-icon">
      <circle cx={4} cy={5} r={3} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <path d="M7 5 H10 M9 5 V8" fill="none" stroke="currentColor" strokeWidth={1.2} />
    </g>
  );
}

/** Same idea as KeyComponent — a tiny lucide-style trash so we can drop
 *  it inline as an SVG group without nesting <svg>. */
function TrashIcon({ size = 12, y = 0 }: { size?: number; y?: number } = {}) {
  const s = size / 14;
  return (
    <g transform={`translate(0, ${y}) scale(${s})`}>
      <path
        d="M3 3 H11 M5 3 V2 H9 V3 M4 3 L4.5 12 H9.5 L10 3 M6 5 V10 M8 5 V10"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}
