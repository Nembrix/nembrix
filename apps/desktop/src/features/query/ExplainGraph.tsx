/**
 * Graphical EXPLAIN visualizer.
 *
 * Lays the plan out as a top-down flow: the root sits at the top, each
 * tier of children fanned out below it, arrows connecting parent →
 * child. Hot nodes (high cost or actual time relative to peers) get a
 * red tint so expensive branches jump off the page.
 *
 * Why this on top of the existing tree view? The tree view is great
 * for reading textually; the graph view is great for seeing the SHAPE
 * — which join feeds which, how deep the plan is, where the heavy
 * work happens. Both have their place; users pick.
 */

import { useMemo } from "react";
import { compactNumber, heatLevel, type ExplainResult, type PlanNode } from "./explain";
import { formatMs } from "@/components/RunningTimer";

const NODE_W = 160;
const NODE_H = 64;
const H_GAP = 28;
const V_GAP = 36;

interface LaidOut {
  node: PlanNode;
  x: number;
  y: number;
  /** Path from root → this node. Used as React key. */
  path: string;
}

/** Recursively compute the cumulative width each subtree occupies. */
function subtreeWidth(node: PlanNode): number {
  if (!node.children.length) return NODE_W;
  const childTotal = node.children.reduce(
    (acc, c) => acc + subtreeWidth(c),
    Math.max(0, node.children.length - 1) * H_GAP,
  );
  return Math.max(NODE_W, childTotal);
}

/** Place every node at its (x, y). Each subtree is centered under its
 *  parent, and siblings sit side by side with H_GAP between them. */
function layout(root: PlanNode): { nodes: LaidOut[]; totalWidth: number; totalHeight: number } {
  const out: LaidOut[] = [];
  let depthMax = 0;

  function visit(node: PlanNode, originX: number, depth: number, path: string): number {
    const myWidth = subtreeWidth(node);
    const myX = originX + myWidth / 2 - NODE_W / 2;
    const myY = depth * (NODE_H + V_GAP);
    out.push({ node, x: myX, y: myY, path });
    depthMax = Math.max(depthMax, depth);
    let cursor = originX;
    if (node.children.length) {
      for (let i = 0; i < node.children.length; i++) {
        const childWidth = subtreeWidth(node.children[i]);
        visit(node.children[i], cursor, depth + 1, `${path}/${i}`);
        cursor += childWidth + H_GAP;
      }
    }
    return myWidth;
  }

  const totalWidth = visit(root, 0, 0, "0");
  const totalHeight = (depthMax + 1) * (NODE_H + V_GAP);
  return { nodes: out, totalWidth, totalHeight };
}

export function ExplainGraph({ result }: { result: ExplainResult }) {
  const denom = result.maxActualMs ?? result.maxCost;
  const mode: "cost" | "actual" = result.maxActualMs != null ? "actual" : "cost";

  const { nodes, totalWidth, totalHeight } = useMemo(() => layout(result.root), [result.root]);

  // Build a quick lookup so the arrow renderer can find parent → child
  // coordinates by path.
  const byPath = useMemo(() => {
    const m = new Map<string, LaidOut>();
    for (const n of nodes) m.set(n.path, n);
    return m;
  }, [nodes]);

  return (
    <div className="explain-graph">
      <svg
        viewBox={`-20 -20 ${totalWidth + 40} ${totalHeight + 40}`}
        width="100%"
        height={totalHeight + 40}
        preserveAspectRatio="xMidYMin meet"
      >
        {/* Arrows first so they render under nodes. */}
        {nodes.map((laid) =>
          laid.node.children.map((_, i) => {
            const child = byPath.get(`${laid.path}/${i}`);
            if (!child) return null;
            const x1 = laid.x + NODE_W / 2;
            const y1 = laid.y + NODE_H;
            const x2 = child.x + NODE_W / 2;
            const y2 = child.y;
            // Use a gentle S-curve so siblings don't all overlap on a
            // single vertical pull.
            const my = (y1 + y2) / 2;
            const path = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
            return (
              <path
                key={`${laid.path}->${child.path}`}
                d={path}
                className="explain-graph-edge"
                fill="none"
              />
            );
          })
        )}

        {/* Nodes */}
        {nodes.map((laid) => {
          const n = laid.node;
          const weight =
            denom > 0
              ? mode === "actual"
                ? (n.actual?.totalMs ?? 0) / denom
                : n.costEnd / denom
              : 0;
          const heat = heatLevel(weight);
          return (
            <g key={laid.path} transform={`translate(${laid.x},${laid.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={6}
                className={`explain-graph-node heat-${heat}`}
              />
              <text x={10} y={16} className="explain-graph-type">
                {n.type}
              </text>
              {n.target && (
                <text x={10} y={30} className="explain-graph-target">
                  {truncate(n.target, 20)}
                </text>
              )}
              <text x={10} y={46} className="explain-graph-meta">
                {n.actual
                  ? `${formatMs(n.actual.totalMs)} · ${compactNumber(n.actual.rows)} rows`
                  : `cost ${compactNumber(n.costEnd)} · ~${compactNumber(n.rowsEstimated)} rows`}
              </text>
              {n.joinType && (
                <text x={10} y={58} className="explain-graph-tag">
                  {n.joinType}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
