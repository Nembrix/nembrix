/**
 * Parsing + presentation helpers for Postgres EXPLAIN output.
 *
 * We always ask for `FORMAT JSON` so we get a structured tree we can
 * walk recursively. The shape is well-documented:
 *   https://www.postgresql.org/docs/current/sql-explain.html
 *
 * Each Plan node has:
 *   - Node Type (Seq Scan, Index Scan, Hash Join, …)
 *   - Relation Name (when scanning a table)
 *   - Startup Cost / Total Cost (planner's estimate)
 *   - Plan Rows / Plan Width (planner's row estimate + average row size)
 *   - Actual Startup Time / Actual Total Time / Actual Rows / Actual Loops (when ANALYZE)
 *   - Plans: array of children
 *
 * We don't try to render every field; just the ones a developer most often
 * cares about. The full JSON is also kept available so power users can
 * eyeball it.
 */

export interface RawPlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Alias"?: string;
  "Index Name"?: string;
  "Startup Cost": number;
  "Total Cost": number;
  "Plan Rows": number;
  "Plan Width": number;
  "Actual Startup Time"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Filter"?: string;
  "Index Cond"?: string;
  "Hash Cond"?: string;
  "Join Type"?: string;
  "Plans"?: RawPlanNode[];
  [k: string]: unknown;
}

export interface RawExplainResult {
  "Plan": RawPlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
  [k: string]: unknown;
}

export interface PlanNode {
  type: string;
  /** What this node operates on — table, index, hash, etc. */
  target?: string;
  costStart: number;
  costEnd: number;
  rowsEstimated: number;
  width: number;
  /** Present only with EXPLAIN ANALYZE. */
  actual?: {
    startupMs: number;
    totalMs: number;
    rows: number;
    loops: number;
  };
  /** Free-text predicates surfaced inline so we don't bury them in raw JSON. */
  condition?: string;
  filter?: string;
  rowsRemoved?: number;
  joinType?: string;
  children: PlanNode[];
  /** Raw node for power-user inspection. */
  raw: RawPlanNode;
}

export interface ExplainResult {
  root: PlanNode;
  planningMs?: number;
  executionMs?: number;
  /** Cost of the most expensive node — used to scale the heat bar. */
  maxCost: number;
  /** Time of the slowest node (ANALYZE only). */
  maxActualMs?: number;
  raw: RawExplainResult;
}

/** Walk a single raw Plan node, recursing into children. */
function transform(raw: RawPlanNode): PlanNode {
  const out: PlanNode = {
    type: raw["Node Type"],
    target: pickTarget(raw),
    costStart: raw["Startup Cost"],
    costEnd: raw["Total Cost"],
    rowsEstimated: raw["Plan Rows"],
    width: raw["Plan Width"],
    condition: (raw["Index Cond"] ?? raw["Hash Cond"]) as string | undefined,
    filter: raw["Filter"] as string | undefined,
    rowsRemoved: raw["Rows Removed by Filter"] as number | undefined,
    joinType: raw["Join Type"] as string | undefined,
    children: (raw["Plans"] ?? []).map(transform),
    raw,
  };
  if (typeof raw["Actual Total Time"] === "number") {
    out.actual = {
      startupMs: raw["Actual Startup Time"] ?? 0,
      totalMs: raw["Actual Total Time"],
      rows: raw["Actual Rows"] ?? 0,
      loops: raw["Actual Loops"] ?? 1,
    };
  }
  return out;
}

function pickTarget(raw: RawPlanNode): string | undefined {
  const rel = raw["Relation Name"];
  const alias = raw["Alias"];
  const idx = raw["Index Name"];
  if (rel && alias && alias !== rel) return `${rel} ${alias}`;
  return rel ?? idx;
}

function maxCost(node: PlanNode): number {
  let m = node.costEnd;
  for (const c of node.children) m = Math.max(m, maxCost(c));
  return m;
}
function maxActualMs(node: PlanNode): number {
  let m = node.actual?.totalMs ?? 0;
  for (const c of node.children) m = Math.max(m, maxActualMs(c));
  return m;
}

/** Build the public ExplainResult from PG's array-wrapped JSON output. */
export function parseExplainJson(text: string): ExplainResult {
  const arr = JSON.parse(text) as RawExplainResult[];
  if (!Array.isArray(arr) || !arr[0]?.Plan) {
    throw new Error("Unexpected EXPLAIN JSON shape");
  }
  const raw = arr[0];
  const root = transform(raw.Plan);
  const result: ExplainResult = {
    root,
    planningMs: raw["Planning Time"],
    executionMs: raw["Execution Time"],
    maxCost: maxCost(root),
    raw,
  };
  if (root.actual) result.maxActualMs = maxActualMs(root);
  return result;
}

/** Format a cost or row count compactly: 12345 → "12.3K", 1234567 → "1.23M". */
export function compactNumber(n: number): string {
  if (n < 1000) return n.toFixed(0);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "K";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(2) + "B";
}

/** Color hint for a node by its proportional weight (0..1). */
export function heatLevel(weight: number): "cool" | "warm" | "hot" {
  if (weight >= 0.66) return "hot";
  if (weight >= 0.25) return "warm";
  return "cool";
}
