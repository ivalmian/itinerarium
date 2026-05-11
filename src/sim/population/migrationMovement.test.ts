import { describe, expect, it } from 'vitest';
import { hex, hexDistance, type Hex } from '../world/hex.js';
import { createGrid, type HexGrid } from '../world/grid.js';
import type { HexTile } from '../world/terrain.js';
import { createRng, type Rng } from '../rng.js';
import { type Day } from '../types.js';
import { tickMigrationWithGrid, type MigrationColumnLike } from './migrationMovement.js';

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 0,
  hasRiver: false,
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

const baseColumn = (origin: Hex, dest: Hex): MigrationColumnLike => ({
  id: 'col-1',
  position: origin,
  destinationHex: dest,
  daysOnRoad: 0,
  cachedPath: undefined,
  cachedPathStaleAfterDay: undefined,
});

const tickInputs = (
  column: MigrationColumnLike,
  grid: HexGrid,
  today: Day,
  rng: Rng,
): {
  column: MigrationColumnLike;
  grid: HexGrid;
  season: 'summer' | 'winter' | 'spring' | 'autumn';
  today: Day;
  rng: Rng;
} => ({ column, grid, season: 'summer', today, rng });

describe('tickMigrationWithGrid — basic movement', () => {
  it('a column already at destination is no-op (arrived)', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5);
    const c = baseColumn(hex(2, 2), hex(2, 2));
    const r = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    expect(r.arrived).toBe(true);
    expect(r.column.position).toEqual(hex(2, 2));
  });

  it('a column moves toward destination using A* through the grid', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 5);
    const c = baseColumn(hex(0, 0), hex(20, 0));
    const r = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    expect(r.column.position.q).toBeGreaterThan(0);
    expect(r.column.daysOnRoad).toBe(1);
  });
});

describe('tickMigrationWithGrid — speed', () => {
  it('a column makes ~15 hexes/day in normal terrain (within ±5)', () => {
    const g = createGrid();
    fillRect(g, 0, 40, 0, 2);
    const c = baseColumn(hex(0, 0), hex(40, 0));
    const r = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    const moved = hexDistance(r.column.position, hex(0, 0));
    expect(moved).toBeGreaterThanOrEqual(10);
    expect(moved).toBeLessThanOrEqual(20);
  });

  it('a column is slower off-road in hills than on a Roman road on plains', () => {
    const gRoad = createGrid();
    fillRect(gRoad, 0, 40, 0, 2, { road: 'roman' });
    const gHills = createGrid();
    fillRect(gHills, 0, 40, 0, 2, { terrain: 'hills', road: 'none' });
    const cRoad = baseColumn(hex(0, 0), hex(30, 0));
    const cHills = baseColumn(hex(0, 0), hex(30, 0));
    const rRoad = tickMigrationWithGrid(tickInputs(cRoad, gRoad, 1 as Day, createRng('r')));
    const rHills = tickMigrationWithGrid(tickInputs(cHills, gHills, 1 as Day, createRng('h')));
    expect(hexDistance(rRoad.column.position, hex(0, 0))).toBeGreaterThan(
      hexDistance(rHills.column.position, hex(0, 0)),
    );
  });
});

describe('tickMigrationWithGrid — terrain awareness', () => {
  it('a column routes around an impassable lake', () => {
    const g = createGrid();
    fillRect(g, 0, 20, 0, 4);
    g.set(hex(10, 2), tile({ terrain: 'lake' }));
    const c = baseColumn(hex(0, 2), hex(20, 2));
    const r = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    // Should not have crossed the lake hex.
    expect(r.column.position.q).not.toEqual(10);
  });

  it('a column blocked by a winter mountain pass with no detour does not move', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    g.set(hex(1, 0), tile());
    g.set(hex(2, 0), tile({ terrain: 'mountains' }));
    g.set(hex(3, 0), tile());
    const c = baseColumn(hex(0, 0), hex(3, 0));
    const inputs = tickInputs(c, g, 1 as Day, createRng('s'));
    inputs.season = 'winter';
    const r = tickMigrationWithGrid(inputs);
    // Either no movement (no path under winter) or stops short of mountain.
    expect(r.column.position).not.toEqual(hex(2, 0));
  });
});

describe('tickMigrationWithGrid — path caching', () => {
  it('caches the path on the column and reuses it next day if not stale', () => {
    const g = createGrid();
    fillRect(g, 0, 60, 0, 4, { road: 'roman' });
    // Long enough route that one day of movement won't arrive.
    const c = baseColumn(hex(0, 0), hex(60, 0));
    const day1 = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    expect(day1.column.cachedPath).toBeDefined();
    expect((day1.column.cachedPath ?? []).length).toBeGreaterThan(0);
    // Tick again next day with the *cached* column. Should keep advancing.
    const day2 = tickMigrationWithGrid(tickInputs(day1.column, g, 2 as Day, createRng('s')));
    expect(day2.column.position.q).toBeGreaterThan(day1.column.position.q);
  });

  it('recomputes the path if the cache is stale (today > cachedPathStaleAfterDay)', () => {
    const g = createGrid();
    fillRect(g, 0, 80, 0, 4, { road: 'roman' });
    const c = baseColumn(hex(0, 0), hex(80, 0));
    const day1 = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    const stale = day1.column.cachedPathStaleAfterDay ?? 0;
    const startedAt = day1.column.position.q;
    // Block a hex AHEAD of the column on the original cached path so the
    // recomputed path must detour around it.
    const blockQ = startedAt + 5;
    g.set(hex(blockQ, 0), tile({ terrain: 'lake' }));
    const dayLater = tickMigrationWithGrid(
      tickInputs(day1.column, g, (stale + 50) as Day, createRng('s')),
    );
    // The recomputed path must avoid the blocked hex.
    const path = dayLater.column.cachedPath ?? [];
    for (const h of path) {
      expect(h.q === blockQ && h.r === 0).toBe(false);
    }
  });
});

describe('tickMigrationWithGrid — determinism', () => {
  it('same column + grid + day → same result', () => {
    const buildGrid = (): HexGrid => {
      const g = createGrid();
      fillRect(g, 0, 25, 0, 4, { road: 'roman' });
      return g;
    };
    const g1 = buildGrid();
    const g2 = buildGrid();
    const c1 = baseColumn(hex(0, 0), hex(20, 0));
    const c2 = baseColumn(hex(0, 0), hex(20, 0));
    const r1 = tickMigrationWithGrid(tickInputs(c1, g1, 5 as Day, createRng('det')));
    const r2 = tickMigrationWithGrid(tickInputs(c2, g2, 5 as Day, createRng('det')));
    expect(r1.column.position).toEqual(r2.column.position);
    expect(r1.arrived).toBe(r2.arrived);
  });
});

describe('tickMigrationWithGrid — preserves column shape', () => {
  it('returns a new column object (no mutation of input)', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2);
    const c = baseColumn(hex(0, 0), hex(5, 0));
    const before = c.position;
    const r = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    expect(c.position).toBe(before);
    expect(r.column).not.toBe(c);
    expect(r.column.id).toBe(c.id);
  });

  it('marks arrived when reaching the destination', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = baseColumn(hex(0, 0), hex(8, 0));
    const r = tickMigrationWithGrid(tickInputs(c, g, 1 as Day, createRng('s')));
    expect(r.column.position).toEqual(hex(8, 0));
    expect(r.arrived).toBe(true);
  });
});
