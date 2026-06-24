import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, GitFork, List, Play, Zap } from "lucide-react";
import * as api from "@/ipc/commands";
import { compactNumber, heatLevel, parseExplainJson, type ExplainResult, type PlanNode } from "./explain";
import { formatMs } from "@/components/RunningTimer";
import { ExplainGraph } from "./ExplainGraph";

/**
 * EXPLAIN / EXPLAIN ANALYZE viewer for a query tab.
 *
 * The pane runs EXPLAIN on demand (button click) instead of automatically
 * — ANALYZE actually executes the query, which is heavy on production
 * databases, so we never want to do it silently. The plan tree renders
 * as a collapsible hierarchy, with a heat bar showing the proportional
 * cost (or actual time when ANALYZE is on) of each node so expensive
 * branches stand out at a glance.
 *
 * Better than psql's plain text:
 *  - Each node's cost is visualized as a bar relative to the slowest peer
 *  - Hot nodes are tinted red, warm orange, cool green
 *  - Per-node detail is hidden behind a disclosure so the tree stays tidy
 *  - Filter / index condition / join type surface inline
 */
export default function AnalysisPane({ connId, sql }: { connId: string; sql: string }) {
  const [mode, setMode] = useState<"explain" | "analyze">("explain");
  const [view, setView] = useState<"tree" | "graph">("tree");
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (which: "explain" | "analyze") => {
    if (!sql.trim()) { setErr("Run a query first."); return; }
    setMode(which);
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      // Wrap the user's SQL. ANALYZE actually executes; BUFFERS adds I/O
      // counters; SETTINGS includes the planner config influencing costs.
      const opts = which === "analyze"
        ? "ANALYZE, VERBOSE, BUFFERS, SETTINGS, FORMAT JSON"
        : "VERBOSE, SETTINGS, FORMAT JSON";
      const wrapped = `EXPLAIN (${opts}) ${sql.trim().replace(/;\s*$/, "")};`;

      // EXPLAIN FORMAT JSON returns one row, one column. Different
      // drivers shape the cell differently:
      //   - Tauri/sqlx surfaces it as text (kind: "text"/"raw").
      //   - Node-postgres auto-parses the `json` column type into a JS
      //     object, which our sidecar tags as kind: "document".
      // Handle all three.
      let json = "";
      let docResult: unknown = null;
      await new Promise<void>((res, rej) => {
        api.stream(connId, wrapped, (b) => {
          for (const row of b.rows) {
            const v = row[0];
            if (v.kind === "text" || v.kind === "raw") {
              json += v.value;
            } else if (v.kind === "document") {
              // EXPLAIN FORMAT JSON returns ONE row only, so the latest
              // document wins — capture and use it directly.
              docResult = v.value;
            }
          }
          if (b.done) res();
        }).catch(rej);
      });
      setResult(parseExplainJson(docResult != null ? JSON.stringify(docResult) : json));
    } catch (e) {
      setErr(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="analysis-pane">
      <div className="analysis-toolbar">
        <button
          className={`btn-pill ${mode === "explain" ? "primary" : ""}`}
          disabled={running}
          onClick={() => void run("explain")}
          title="Run EXPLAIN — planner's cost estimate, no execution"
        >
          <Play size={11} /> EXPLAIN
        </button>
        <button
          className={`btn-pill ${mode === "analyze" ? "primary" : ""}`}
          disabled={running}
          onClick={() => void run("analyze")}
          title="Run EXPLAIN ANALYZE — actually executes the query"
        >
          <Zap size={11} /> EXPLAIN ANALYZE
        </button>
        {running && <span className="muted">Running…</span>}
        {result && (
          <div className="segmented" role="tablist" style={{ marginLeft: 8, flex: "0 0 auto" }}>
            <button
              className={view === "tree" ? "active" : ""}
              onClick={() => setView("tree")}
              title="Hierarchical tree view"
            >
              <List size={11} style={{ marginRight: 4 }} />Tree
            </button>
            <button
              className={view === "graph" ? "active" : ""}
              onClick={() => setView("graph")}
              title="Top-down flow graph"
            >
              <GitFork size={11} style={{ marginRight: 4 }} />Graph
            </button>
          </div>
        )}
        {result?.planningMs != null && (
          <span className="muted" style={{ marginLeft: "auto" }}>
            Planning: {formatMs(result.planningMs)}
            {result.executionMs != null && ` · Execution: ${formatMs(result.executionMs)}`}
          </span>
        )}
      </div>
      {err && (
        <div className="message-pane err" style={{ margin: 8 }}>
          <AlertTriangle size={11} /> {err}
        </div>
      )}
      {!result && !err && !running && (
        <div className="placeholder">
          <span className="muted">
            Click <strong>EXPLAIN</strong> to see the planner's estimate,
            or <strong>EXPLAIN ANALYZE</strong> to actually run the query
            and measure each node.
          </span>
        </div>
      )}
      {result && view === "tree" && (
        <div className="analysis-tree">
          <NodeRow
            node={result.root}
            depth={0}
            denominator={result.maxActualMs ?? result.maxCost}
            mode={result.maxActualMs != null ? "actual" : "cost"}
          />
        </div>
      )}
      {result && view === "graph" && <ExplainGraph result={result} />}
    </div>
  );
}

function NodeRow({
  node, depth, denominator, mode,
}: {
  node: PlanNode;
  depth: number;
  denominator: number;
  /** Whether to weight nodes by actual ms (ANALYZE) or planner cost. */
  mode: "cost" | "actual";
}) {
  const [open, setOpen] = useState(true);
  const weight = denominator > 0
    ? (mode === "actual"
        ? (node.actual?.totalMs ?? 0) / denominator
        : node.costEnd / denominator)
    : 0;
  const heat = heatLevel(weight);
  const hasChildren = node.children.length > 0;

  return (
    <div className="analysis-node" style={{ ["--depth" as never]: depth }}>
      <div className={`analysis-node-row heat-${heat}`}>
        <button
          className="analysis-toggle"
          onClick={() => hasChildren && setOpen(!open)}
          aria-label={open ? "Collapse" : "Expand"}
          disabled={!hasChildren}
        >
          {hasChildren ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </button>
        <div className="analysis-node-main">
          <div className="analysis-node-head">
            <strong>{node.type}</strong>
            {node.target && <span className="muted mono">{node.target}</span>}
            {node.joinType && <span className="muted">({node.joinType})</span>}
          </div>
          <div className="analysis-node-meta">
            {node.actual ? (
              <>
                <span title="Actual total time">{formatMs(node.actual.totalMs)}</span>
                <span className="sep">·</span>
                <span title="Actual rows × loops">
                  {compactNumber(node.actual.rows)} rows
                  {node.actual.loops > 1 && ` × ${node.actual.loops}`}
                </span>
              </>
            ) : (
              <>
                <span title="Estimated total cost">cost {compactNumber(node.costEnd)}</span>
                <span className="sep">·</span>
                <span title="Estimated rows">~{compactNumber(node.rowsEstimated)} rows</span>
              </>
            )}
            {node.rowsRemoved != null && node.rowsRemoved > 0 && (
              <>
                <span className="sep">·</span>
                <span className="muted" title="Rows discarded by filter">
                  -{compactNumber(node.rowsRemoved)} filtered
                </span>
              </>
            )}
          </div>
          {node.condition && (
            <div className="analysis-node-cond mono">{node.condition}</div>
          )}
          {node.filter && (
            <div className="analysis-node-cond mono muted">Filter: {node.filter}</div>
          )}
        </div>
        <div className="analysis-bar" title={`${(weight * 100).toFixed(0)}% of slowest peer`}>
          <div className="analysis-bar-fill" style={{ width: `${Math.max(2, weight * 100)}%` }} />
        </div>
      </div>
      {open && hasChildren && (
        <div className="analysis-children">
          {node.children.map((c, i) => (
            <NodeRow
              key={i}
              node={c}
              depth={depth + 1}
              denominator={denominator}
              mode={mode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
