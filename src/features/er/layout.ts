/**
 * Minimal force-directed layout for the ER diagram.
 *
 * Why roll my own rather than pull in d3-force? d3-force adds ~30KB to the
 * bundle for a feature we only run a few hundred ticks for. The algorithm
 * here is the classic Fruchterman–Reingold pattern:
 *
 *   - Every pair of nodes pushes each other apart (Coulomb-style)
 *   - Every edge pulls its endpoints together (spring)
 *   - A "gravity" term gently centers the graph
 *   - Velocities decay each tick (cooling)
 *
 * Determinism: positions are seeded from a simple PRNG keyed by the node
 * count, so the same schema lays out the same way on every run unless the
 * user has dragged nodes.
 */

export interface NodeIn {
  id: string;                    // schema.name
  width: number;
  height: number;
}

export interface EdgeIn {
  source: string;                // node id
  target: string;
}

export interface NodePos {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  /** Pinned by the user — gets dragged but not simulated. */
  pinned?: boolean;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Repulsion strength. */
  charge: number;
  /** Spring length. */
  edgeLength: number;
  /** Spring stiffness 0..1. */
  edgeStiffness: number;
  /** Centering pull 0..1. */
  gravity: number;
  /** Velocity damping per tick 0..1. */
  damping: number;
  /** Maximum velocity magnitude. Prevents nodes flying off-canvas. */
  maxVelocity: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  width: 1200,
  height: 800,
  charge: 6000,
  edgeLength: 180,
  edgeStiffness: 0.02,
  gravity: 0.02,
  damping: 0.82,
  maxVelocity: 30,
};

/**
 * Tune the layout parameters for the graph size. Tight defaults look
 * great with 10+ tables but cram 3 nodes into a tiny triangle that
 * overlaps. Spread small graphs apart by reducing gravity, lengthening
 * edges, and stiffening repulsion so the few nodes there are can find
 * comfortable spacing.
 */
export function autoTune(
  baseline: LayoutOptions,
  nodeCount: number,
  avgNodeWidth = 200,
  avgNodeHeight = 90,
): LayoutOptions {
  if (nodeCount === 0) return baseline;
  // Minimum spacing that guarantees a node won't overlap its neighbour.
  const minSpacing = Math.max(avgNodeWidth, avgNodeHeight) * 1.6;
  if (nodeCount <= 6) {
    // Small graph: very weak gravity (so they don't collapse into the
    // center), long edges (so connected nodes still have breathing
    // room), beefy charge so unconnected nodes drift apart.
    return {
      ...baseline,
      charge: baseline.charge * 2.2,
      edgeLength: Math.max(baseline.edgeLength, minSpacing * 1.4),
      gravity: baseline.gravity * 0.3,
      damping: 0.78,
    };
  }
  if (nodeCount <= 15) {
    return {
      ...baseline,
      charge: baseline.charge * 1.4,
      edgeLength: Math.max(baseline.edgeLength, minSpacing),
      gravity: baseline.gravity * 0.65,
    };
  }
  return baseline;
}

/* Mulberry32 — tiny seedable PRNG so initial positions are deterministic. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedPositions(
  nodes: NodeIn[],
  opts: Partial<LayoutOptions> = {},
  fixed: Record<string, { x: number; y: number }> = {},
): NodePos[] {
  const { width, height } = { ...DEFAULT_LAYOUT, ...opts };
  const rand = rng(nodes.length * 17 + 1);
  // Lay nodes on a jittered circle to keep them away from the center, which
  // gives the force loop something to push against on tick 1.
  const cx = width / 2;
  const cy = height / 2;
  // With ≤6 nodes, push the seed circle further out so the first tick
  // already has them well-separated — small graphs otherwise tend to
  // collapse into the center before charge can spread them out. Cap
  // the radius so jitter doesn't push nodes outside the viewport.
  const spread = nodes.length <= 6 ? 0.45 : 0.35;
  const r = Math.min(width, height) * spread;
  return nodes.map((n, i) => {
    if (fixed[n.id]) {
      return { id: n.id, ...fixed[n.id], vx: 0, vy: 0, width: n.width, height: n.height, pinned: true };
    }
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2 + rand() * 0.4;
    return {
      id: n.id,
      x: cx + Math.cos(angle) * r + (rand() - 0.5) * 40,
      y: cy + Math.sin(angle) * r + (rand() - 0.5) * 40,
      vx: 0,
      vy: 0,
      width: n.width,
      height: n.height,
    };
  });
}

/**
 * One simulation tick — mutates `positions` in place and returns the same
 * array for chaining. Run ~200 of these on init, then ~30/sec while
 * dragging or on hover-pinning interactions.
 */
export function tick(
  positions: NodePos[],
  edges: EdgeIn[],
  opts: Partial<LayoutOptions> = {},
): NodePos[] {
  const o = { ...DEFAULT_LAYOUT, ...opts };
  const byId = new Map<string, NodePos>();
  for (const p of positions) byId.set(p.id, p);

  // Reset force accumulators.
  const fx = new Float32Array(positions.length);
  const fy = new Float32Array(positions.length);
  const idxById = new Map<string, number>();
  positions.forEach((p, i) => idxById.set(p.id, i));

  // Pairwise repulsion. O(n²) — fine up to a few hundred nodes.
  for (let i = 0; i < positions.length; i++) {
    const pi = positions[i];
    for (let j = i + 1; j < positions.length; j++) {
      const pj = positions[j];
      let dx = pi.x - pj.x;
      let dy = pi.y - pj.y;
      const dist2 = dx * dx + dy * dy + 0.01;
      const dist = Math.sqrt(dist2);
      const force = o.charge / dist2;
      dx /= dist; dy /= dist;
      fx[i] += dx * force; fy[i] += dy * force;
      fx[j] -= dx * force; fy[j] -= dy * force;
    }
  }

  // Spring forces along edges.
  for (const e of edges) {
    const i = idxById.get(e.source);
    const j = idxById.get(e.target);
    if (i == null || j == null) continue;
    const pi = positions[i];
    const pj = positions[j];
    const dx = pj.x - pi.x;
    const dy = pj.y - pi.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const displacement = dist - o.edgeLength;
    const force = displacement * o.edgeStiffness;
    const nx = dx / dist;
    const ny = dy / dist;
    fx[i] += nx * force; fy[i] += ny * force;
    fx[j] -= nx * force; fy[j] -= ny * force;
  }

  // Gravity toward center + integrate.
  const cx = o.width / 2;
  const cy = o.height / 2;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (p.pinned) continue;
    fx[i] += (cx - p.x) * o.gravity;
    fy[i] += (cy - p.y) * o.gravity;
    p.vx = (p.vx + fx[i]) * o.damping;
    p.vy = (p.vy + fy[i]) * o.damping;
    // Clamp velocity so a stray repulsion can't fling a node to (∞,∞).
    const vMag = Math.hypot(p.vx, p.vy);
    if (vMag > o.maxVelocity) {
      p.vx = (p.vx / vMag) * o.maxVelocity;
      p.vy = (p.vy / vMag) * o.maxVelocity;
    }
    p.x += p.vx;
    p.y += p.vy;
  }
  return positions;
}

/** Run the layout to (approximate) steady state. */
export function relax(
  nodes: NodeIn[],
  edges: EdgeIn[],
  opts: Partial<LayoutOptions> = {},
  iterations = 250,
  fixed: Record<string, { x: number; y: number }> = {},
): NodePos[] {
  const positions = seedPositions(nodes, opts, fixed);
  for (let i = 0; i < iterations; i++) tick(positions, edges, opts);
  return positions;
}
