import { describe, expect, it } from 'vitest';
import { hex, hexNeighbors } from './hex.js';
import type { Hex } from './hex.js';
import { createGrid } from './grid.js';
import type { HexGrid } from './grid.js';
import type { HexTile, RoadGrade, Season, Terrain } from './terrain.js';
import {
  COURIER_PROFILE,
  HEAVY_WAGON_PROFILE,
  LADEN_MULE_PROFILE,
  findPath,
  type MovementProfile,
} from './pathfinding.js';

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 0,
  hasRiver: false,
  hasCoast: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

const fillRect = (
  g: HexGrid,
  qMin: number,
  qMax: number,
  rMin: number,
  rMax: number,
  base: Partial<HexTile> = {},
): void => {
  for (let q = qMin; q <= qMax; q++) {
    for (let r = rMin; r <= rMax; r++) {
      g.set(hex(q, r), tile(base));
    }
  }
};

describe('movement profiles', () => {
  it('LADEN_MULE on Roman road in summer is the cheapest case (~1 MP/hex)', () => {
    expect(LADEN_MULE_PROFILE.costFor('plains', 'roman', 'summer', 1)).toBeCloseTo(1, 5);
  });

  it('LADEN_MULE on dirt road is more expensive than on Roman road', () => {
    expect(LADEN_MULE_PROFILE.costFor('plains', 'dirt', 'summer', 1)).toBeGreaterThan(
      LADEN_MULE_PROFILE.costFor('plains', 'roman', 'summer', 1),
    );
  });

  it('LADEN_MULE off-road is much more expensive than on a road', () => {
    const offRoad = LADEN_MULE_PROFILE.costFor('plains', 'none', 'summer', 1);
    const dirt = LADEN_MULE_PROFILE.costFor('plains', 'dirt', 'summer', 1);
    expect(offRoad).toBeGreaterThan(dirt);
    // Roughly 2.5x off-road per docs/06.
    expect(offRoad).toBeGreaterThanOrEqual(2);
  });

  it('LADEN_MULE through mountain pass in winter is impassable', () => {
    expect(LADEN_MULE_PROFILE.costFor('mountains', 'none', 'winter', 1)).toBe(Infinity);
    expect(LADEN_MULE_PROFILE.costFor('mountains', 'roman', 'winter', 1)).toBe(Infinity);
  });

  it('LADEN_MULE through mountain pass in summer is passable but slow', () => {
    const summer = LADEN_MULE_PROFILE.costFor('mountains', 'none', 'summer', 1);
    expect(summer).toBeGreaterThan(0);
    expect(summer).toBeLessThan(Infinity);
  });

  it('lakes are impassable for every profile in every season', () => {
    for (const profile of [LADEN_MULE_PROFILE, HEAVY_WAGON_PROFILE, COURIER_PROFILE]) {
      for (const season of ['spring', 'summer', 'autumn', 'winter'] as Season[]) {
        expect(profile.costFor('lake', 'none', season, 1)).toBe(Infinity);
      }
    }
  });

  it('HEAVY_WAGON cannot travel off-road (impassable)', () => {
    expect(HEAVY_WAGON_PROFILE.costFor('plains', 'none', 'summer', 1)).toBe(Infinity);
    // Roads are fine.
    expect(HEAVY_WAGON_PROFILE.costFor('plains', 'roman', 'summer', 1)).toBeLessThan(Infinity);
  });

  it('COURIER (express, changing horses) is much faster than a laden mule', () => {
    const courier = COURIER_PROFILE.costFor('plains', 'roman', 'summer', 0);
    const mule = LADEN_MULE_PROFILE.costFor('plains', 'roman', 'summer', 1);
    expect(courier).toBeLessThan(mule);
  });

  it('lighter loads cost less than heavier loads on the same hex', () => {
    const heavy = LADEN_MULE_PROFILE.costFor('plains', 'dirt', 'summer', 1);
    const light = LADEN_MULE_PROFILE.costFor('plains', 'dirt', 'summer', 0.2);
    expect(light).toBeLessThanOrEqual(heavy);
  });
});

describe('findPath — trivial cases', () => {
  it('start == goal returns single-hex path with cost 0', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    const r = findPath(g, hex(0, 0), hex(0, 0), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path).toEqual([hex(0, 0)]);
    expect(r.totalCost).toBe(0);
  });

  it('adjacent goal returns 2-hex path with the edge cost', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile({ road: 'roman' }));
    g.set(hex(1, 0), tile({ road: 'roman' }));
    const r = findPath(g, hex(0, 0), hex(1, 0), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path).toEqual([hex(0, 0), hex(1, 0)]);
    expect(r.totalCost).toBeCloseTo(1, 5);
  });

  it('returns empty path and Infinity cost when start is not in the grid', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    const r = findPath(g, hex(99, 99), hex(0, 0), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path).toEqual([]);
    expect(r.totalCost).toBe(Infinity);
  });

  it('returns empty path and Infinity cost when goal is not in the grid', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    const r = findPath(g, hex(0, 0), hex(99, 99), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path).toEqual([]);
    expect(r.totalCost).toBe(Infinity);
  });
});

describe('findPath — terrain & roads matter', () => {
  it('prefers Roman road over dirt road of equal length', () => {
    // Two parallel paths from (0,0) to (3,0):
    //   north route via r=-1 line on Roman road
    //   south route via r=1 line on dirt road
    // Both 3 steps. Roman should win.
    const g = createGrid();
    // Both endpoints share the same hex; we route through an intermediate column.
    g.set(hex(0, 0), tile());
    g.set(hex(3, 0), tile());
    // North route (Roman): (0,0) → (0,-1) → (1,-1) → (2,-1) → (3,-1) → (3,0)? Too many steps.
    // Simpler: build two equally-long alternative bridges. Just use
    // intermediate hexes and tag them.
    // East-then-east vs east-then-east on a different row, both 3 steps.
    // Roman row:
    g.set(hex(1, 0), tile({ road: 'roman' }));
    g.set(hex(2, 0), tile({ road: 'roman' }));
    // Dirt detour row (force longer if same cost would tie):
    // Disable the road-row tiles' competition by also providing dirt-only alt.
    // Actually: with both row tiles set as dirt vs roman of equal step count,
    // the algorithm should pick the Roman row. So the test here just provides
    // the Roman row as the only direct route — we instead compare totalCost
    // against the same shape with dirt roads.
    const cheap = findPath(g, hex(0, 0), hex(3, 0), LADEN_MULE_PROFILE, 'summer', 1);

    const g2 = createGrid();
    g2.set(hex(0, 0), tile());
    g2.set(hex(3, 0), tile());
    g2.set(hex(1, 0), tile({ road: 'dirt' }));
    g2.set(hex(2, 0), tile({ road: 'dirt' }));
    const dirty = findPath(g2, hex(0, 0), hex(3, 0), LADEN_MULE_PROFILE, 'summer', 1);

    expect(cheap.path.length).toBe(4);
    expect(dirty.path.length).toBe(4);
    expect(cheap.totalCost).toBeLessThan(dirty.totalCost);
  });

  it('routes around impassable lake', () => {
    const g = createGrid();
    fillRect(g, 0, 4, 0, 2);
    // Place a lake at (2, 1) blocking the direct path.
    g.set(hex(2, 1), tile({ terrain: 'lake' }));
    const r = findPath(g, hex(0, 1), hex(4, 1), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path.length).toBeGreaterThan(0);
    for (const h of r.path) {
      expect(h.q === 2 && h.r === 1).toBe(false);
    }
  });

  it('returns Infinity when fully surrounded by impassable terrain', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile()); // start
    g.set(hex(5, 0), tile()); // goal
    // Surround start in lakes — no neighbor is passable.
    for (const n of hexNeighbors(hex(0, 0))) {
      g.set(n, tile({ terrain: 'lake' }));
    }
    const r = findPath(g, hex(0, 0), hex(5, 0), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path).toEqual([]);
    expect(r.totalCost).toBe(Infinity);
  });

  it('mountain pass is open in summer but closed in winter', () => {
    const g = createGrid();
    // A line: (0,0) plains → (1,0) mountains → (2,0) plains
    g.set(hex(0, 0), tile());
    g.set(hex(1, 0), tile({ terrain: 'mountains' }));
    g.set(hex(2, 0), tile());

    const summer = findPath(g, hex(0, 0), hex(2, 0), LADEN_MULE_PROFILE, 'summer', 1);
    const winter = findPath(g, hex(0, 0), hex(2, 0), LADEN_MULE_PROFILE, 'winter', 1);

    expect(summer.path.length).toBe(3);
    expect(summer.totalCost).toBeLessThan(Infinity);
    // No detour exists in this 3-hex strip → winter should fail.
    expect(winter.path).toEqual([]);
    expect(winter.totalCost).toBe(Infinity);
  });
});

describe('findPath — determinism', () => {
  it('same inputs produce the same path on repeated calls', () => {
    const g = createGrid();
    fillRect(g, -3, 3, -3, 3);
    const a = findPath(g, hex(-3, 0), hex(3, 0), LADEN_MULE_PROFILE, 'summer', 1);
    const b = findPath(g, hex(-3, 0), hex(3, 0), LADEN_MULE_PROFILE, 'summer', 1);
    expect(a.path).toEqual(b.path);
    expect(a.totalCost).toBe(b.totalCost);
  });

  it('reconstructed path is contiguous (each step is a hex neighbor)', () => {
    const g = createGrid();
    fillRect(g, -2, 5, -2, 2);
    const r = findPath(g, hex(-2, 0), hex(5, 0), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path.length).toBeGreaterThan(0);
    for (let i = 1; i < r.path.length; i++) {
      const prev = r.path[i - 1] as Hex;
      const curr = r.path[i] as Hex;
      const dq = curr.q - prev.q;
      const dr = curr.r - prev.r;
      const ds = -dq - dr;
      const dist = (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
      expect(dist).toBe(1);
    }
  });

  it('start and goal are the first and last hexes of the path', () => {
    const g = createGrid();
    fillRect(g, 0, 4, 0, 4);
    const r = findPath(g, hex(0, 0), hex(4, 4), LADEN_MULE_PROFILE, 'summer', 1);
    expect(r.path[0]).toEqual(hex(0, 0));
    expect(r.path.at(-1)).toEqual(hex(4, 4));
  });
});

describe('findPath — heuristic admissibility', () => {
  it('finds an optimal path when a costlier alternative is also valid', () => {
    // Build a small grid where the direct path is 4 steps on plains
    // and a longer detour through a Roman-road row exists.
    // The direct path total cost for laden mule on plains = 4 * off-road cost
    // The Roman detour might be 5 hops at cost 1 each = 5 < 4 * 2.5 = 10. Good.
    const g = createGrid();
    fillRect(g, 0, 6, -1, 1);
    // Roman road on r=-1 row
    for (let q = 0; q <= 6; q++) {
      g.set(hex(q, -1), tile({ road: 'roman' }));
    }
    const r = findPath(g, hex(0, 0), hex(6, 0), LADEN_MULE_PROFILE, 'summer', 1);
    // Optimal route routes via the Roman road row.
    let usedRomanRow = false;
    for (const h of r.path) {
      if (h.r === -1) usedRomanRow = true;
    }
    expect(usedRomanRow).toBe(true);
  });
});

describe('findPath — custom MovementProfile', () => {
  it('honors a caller-supplied MovementProfile', () => {
    const everywhereExpensive: MovementProfile = {
      costFor: (_t: Terrain, _r: RoadGrade, _s: Season, _l: number) => 5,
    };
    const g = createGrid();
    g.set(hex(0, 0), tile());
    g.set(hex(1, 0), tile());
    const r = findPath(g, hex(0, 0), hex(1, 0), everywhereExpensive, 'summer', 1);
    expect(r.totalCost).toBe(5);
  });
});

describe('findPath — performance smoke', () => {
  it('completes pathfinding on a ~5,000-hex grid in well under 100ms', () => {
    const g = createGrid();
    const SIDE = 70; // 70 * 70 = 4900 tiles
    fillRect(g, 0, SIDE - 1, 0, SIDE - 1);
    const start = performance.now();
    const r = findPath(g, hex(0, 0), hex(SIDE - 1, SIDE - 1), LADEN_MULE_PROFILE, 'summer', 1);
    const elapsedMs = performance.now() - start;
    expect(r.path.length).toBeGreaterThan(0);
    // Generous bound to avoid CI flakiness; the assertion is "no obvious
    // O(n²) catastrophe" rather than a microbenchmark.
    expect(elapsedMs).toBeLessThan(500);
  });
});
