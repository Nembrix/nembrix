import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, autoTune, relax, seedPositions, tick, type NodeIn } from "./layout";

const NODES: NodeIn[] = [
  { id: "public.users",  width: 180, height: 80 },
  { id: "public.orders", width: 180, height: 100 },
  { id: "public.items",  width: 180, height: 120 },
  { id: "public.audit",  width: 180, height: 60 },
];
const EDGES = [
  { source: "public.orders", target: "public.users" },
  { source: "public.items",  target: "public.orders" },
];

describe("seedPositions", () => {
  it("is deterministic across runs with the same input", () => {
    const a = seedPositions(NODES);
    const b = seedPositions(NODES);
    expect(a).toEqual(b);
  });

  it("preserves pinned positions from the `fixed` map", () => {
    const fixed = { "public.users": { x: 200, y: 200 } };
    const seeded = seedPositions(NODES, {}, fixed);
    const u = seeded.find((p) => p.id === "public.users")!;
    expect(u.x).toBe(200);
    expect(u.y).toBe(200);
    expect(u.pinned).toBe(true);
  });

  it("scatters nodes inside the viewport", () => {
    const seeded = seedPositions(NODES);
    for (const p of seeded) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(DEFAULT_LAYOUT.width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(DEFAULT_LAYOUT.height);
    }
  });
});

describe("tick", () => {
  it("never produces NaN positions even with extreme charge", () => {
    const seeded = seedPositions(NODES);
    for (let i = 0; i < 50; i++) {
      tick(seeded, EDGES, { charge: 1e9 });
    }
    for (const p of seeded) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Number.isFinite(p.vx)).toBe(true);
      expect(Number.isFinite(p.vy)).toBe(true);
    }
  });

  it("does not move pinned nodes", () => {
    const seeded = seedPositions(NODES, {}, { "public.users": { x: 200, y: 200 } });
    for (let i = 0; i < 20; i++) tick(seeded, EDGES);
    const u = seeded.find((p) => p.id === "public.users")!;
    expect(u.x).toBe(200);
    expect(u.y).toBe(200);
  });

  it("clamps velocity below maxVelocity", () => {
    // Push everything apart hard, then tick once.
    const seeded = seedPositions(NODES, { charge: 1e7 });
    tick(seeded, EDGES, { charge: 1e7, maxVelocity: 30 });
    for (const p of seeded) {
      expect(Math.hypot(p.vx, p.vy)).toBeLessThanOrEqual(30 + 0.01);
    }
  });
});

describe("relax", () => {
  it("returns one NodePos per input node", () => {
    const out = relax(NODES, EDGES);
    expect(out).toHaveLength(NODES.length);
    expect(out.map((p) => p.id).sort()).toEqual(NODES.map((n) => n.id).sort());
  });

  it("settles a 2-node edge near the configured edge length", () => {
    // With both ends free and a single edge, the spring + gravity balance
    // close to `edgeLength` (the spring's rest length).
    const pair: NodeIn[] = [
      { id: "a", width: 100, height: 60 },
      { id: "b", width: 100, height: 60 },
    ];
    const out = relax(
      pair,
      [{ source: "a", target: "b" }],
      { width: 800, height: 600, edgeLength: 180, gravity: 0.01 },
      600,
    );
    const dist = Math.hypot(out[0].x - out[1].x, out[0].y - out[1].y);
    // Loose bound — the spring competes with gravity and repulsion, but the
    // edge force keeps the pair within ±40 px of edgeLength.
    expect(dist).toBeGreaterThan(140);
    expect(dist).toBeLessThan(240);
  });

  it("settles velocities — nodes are not still flying after enough ticks", () => {
    const out = relax(NODES, EDGES, {}, 600);
    for (const p of out) {
      expect(Math.hypot(p.vx, p.vy)).toBeLessThan(1);
    }
  });
});

describe("autoTune", () => {
  it("loosens layout for small graphs (≤6 nodes)", () => {
    const t = autoTune(DEFAULT_LAYOUT, 3);
    expect(t.charge).toBeGreaterThan(DEFAULT_LAYOUT.charge);
    expect(t.edgeLength).toBeGreaterThan(DEFAULT_LAYOUT.edgeLength);
    expect(t.gravity).toBeLessThan(DEFAULT_LAYOUT.gravity);
  });

  it("returns the baseline for big graphs", () => {
    const t = autoTune(DEFAULT_LAYOUT, 30);
    expect(t).toEqual(DEFAULT_LAYOUT);
  });

  it("medium graphs get a mild bump but stay closer to baseline", () => {
    const small = autoTune(DEFAULT_LAYOUT, 4);
    const med = autoTune(DEFAULT_LAYOUT, 10);
    expect(med.charge).toBeGreaterThan(DEFAULT_LAYOUT.charge);
    expect(med.charge).toBeLessThan(small.charge);
  });

  it("a 3-node graph settles with nodes that don't overlap", () => {
    const tiny: NodeIn[] = [
      { id: "a", width: 200, height: 100 },
      { id: "b", width: 200, height: 100 },
      { id: "c", width: 200, height: 100 },
    ];
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ];
    const out = relax(tiny, edges, autoTune(DEFAULT_LAYOUT, 3), 400);
    // Compare every pair: their centers should be at least roughly a
    // node-width apart (we used 200 above).
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const dx = out[i].x - out[j].x;
        const dy = out[i].y - out[j].y;
        const dist = Math.hypot(dx, dy);
        expect(dist).toBeGreaterThan(180);
      }
    }
  });
});
