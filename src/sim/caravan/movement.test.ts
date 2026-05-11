import { describe, expect, it } from 'vitest';
import { createGrid, type HexGrid } from '../world/grid.js';
import { hex, hexKey, type Hex } from '../world/hex.js';
import type { HexTile } from '../world/terrain.js';
import { actorId, caravanId, resourceId } from '../types.js';
import { createCaravan, dailyCrewRationKg, type Caravan } from './caravan.js';
import { tickCaravanMovement } from './movement.js';

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

const muleCaravan = (start: Hex, dest: Hex | null = null, mules = 10): Caravan => {
  const c = createCaravan({
    id: caravanId('test-caravan'),
    ownerActor: actorId('actor.test'),
    position: start,
    destination: dest,
    crew: [
      { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
      { kind: 'drover', count: 2, weapons: 0, armor: 0 },
    ],
    animals: { mule: mules },
    vehicles: { pack_saddle: 1 },
  });
  // Pre-load with enough grain for crew rations plus carried animal feed.
  c.cargo.set(resourceId('food.grain'), 200);
  return c;
};

describe('tickCaravanMovement — destination handling', () => {
  it('a caravan with no destination does not move', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5, { road: 'roman' });
    const c = muleCaravan(hex(2, 2), null);
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved).toEqual([]);
    expect(c.position).toEqual(hex(2, 2));
  });

  it('a caravan already at its destination emits arrived and does not move', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5, { road: 'roman' });
    const c = muleCaravan(hex(2, 2), hex(2, 2));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved).toEqual([]);
    expect(result.events.some((e) => e.type === 'arrived')).toBe(true);
  });

  it('same-hex destination is a 0-day short-circuit (docs/15 §C9 same-hex coexistence)', () => {
    // The pagus pattern: a village + multiple hamlets all share a hex. A
    // caravan trading from one same-hex settlement to another should arrive
    // within the same tick — there is no "trivial caravan walking from A
    // to B in the same hex" anti-pattern. We assert that no hexes were
    // moved, the arrived event fires, and no impassable_blocked event was
    // emitted (confirming the short-circuit ran before any pathing).
    const g = createGrid();
    fillRect(g, 0, 10, 0, 10, { road: 'roman' });
    const sharedHex = hex(5, 5);
    const c = muleCaravan(sharedHex, sharedHex);
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved).toEqual([]);
    expect(c.position).toEqual(sharedHex);
    const types = result.events.map((e) => e.type);
    expect(types).toContain('arrived');
    expect(types).not.toContain('impassable_blocked');
  });
});

describe('tickCaravanMovement — speed under different conditions', () => {
  it('a laden mule caravan on a Roman road covers ~25 hexes/day (within ±5)', () => {
    const g = createGrid();
    fillRect(g, 0, 40, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(40, 0));
    // Load to ~100% capacity so it's truly laden.
    c.cargo.set(resourceId('food.grain'), 140);
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved.length).toBeGreaterThanOrEqual(20);
    expect(result.hexesMoved.length).toBeLessThanOrEqual(30);
    expect(c.position).toEqual(result.hexesMoved.at(-1) ?? hex(0, 0));
  });

  it('off-road on hills covers ~5 hexes/day (within ±2)', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 2, { terrain: 'hills', road: 'none' });
    const c = muleCaravan(hex(0, 0), hex(20, 0));
    c.cargo.set(resourceId('food.grain'), 140);
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved.length).toBeGreaterThanOrEqual(3);
    expect(result.hexesMoved.length).toBeLessThanOrEqual(7);
  });

  it('a heavy wagon laden goes ~12/day on Roman road (within ±4)', () => {
    const g = createGrid();
    fillRect(g, 0, 25, 0, 2, { road: 'roman' });
    const c = createCaravan({
      id: caravanId('wagon'),
      ownerActor: actorId('actor.wagon'),
      position: hex(0, 0),
      destination: hex(20, 0),
      crew: [
        { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
        { kind: 'drover', count: 2, weapons: 0, armor: 0 },
      ],
      animals: { ox: 4 },
      vehicles: { heavy_wagon: 1 },
    });
    c.cargo.set(resourceId('food.grain'), 200);
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved.length).toBeGreaterThanOrEqual(8);
    expect(result.hexesMoved.length).toBeLessThanOrEqual(16);
  });
});

describe('tickCaravanMovement — impassable terrain', () => {
  it('mountain pass blocked in winter: emits impassable_blocked and stops at the pass', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile({ road: 'dirt' }));
    g.set(hex(1, 0), tile({ road: 'dirt' }));
    g.set(hex(2, 0), tile({ terrain: 'mountains' }));
    g.set(hex(3, 0), tile({ road: 'dirt' }));
    const c = muleCaravan(hex(0, 0), hex(3, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'winter', today: 0 });
    expect(result.events.some((e) => e.type === 'impassable_blocked')).toBe(true);
    // Caravan must NOT have crossed onto the mountain hex.
    expect(c.position).not.toEqual(hex(2, 0));
  });

  it('lake hex is impassable in any season', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile({ road: 'dirt' }));
    g.set(hex(1, 0), tile({ terrain: 'lake' }));
    g.set(hex(2, 0), tile({ road: 'dirt' }));
    const c = muleCaravan(hex(0, 0), hex(2, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    // Either the caravan can't find a path (no movement), or it stops before the lake.
    expect(c.position).not.toEqual(hex(1, 0));
    expect(result.hexesMoved.every((h) => h.q !== 1 || h.r !== 0)).toBe(true);
  });

  it('mountain pass open in summer is traversable', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile({ road: 'dirt' }));
    g.set(hex(1, 0), tile({ road: 'dirt' }));
    g.set(hex(2, 0), tile({ terrain: 'mountains' }));
    g.set(hex(3, 0), tile({ road: 'dirt' }));
    const c = muleCaravan(hex(0, 0), hex(3, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    // Caravan should advance at least one hex (terrain may slow but doesn't block).
    expect(result.hexesMoved.length).toBeGreaterThan(0);
  });
});

describe('tickCaravanMovement — consumption', () => {
  it('consumes daily crew rations from cargo', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0));
    c.cargo.set(resourceId('food.grain'), 50);
    const before = c.cargo.get(resourceId('food.grain')) ?? 0;
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    const after = c.cargo.get(resourceId('food.grain')) ?? 0;
    expect(result.rationsConsumed).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    // 3 crew * 0.4 kg/day → 1.2 kg expected. food.grain weight = 6.7 kg/unit, so
    // ~0.18 units consumed.
    expect(result.rationsConsumed).toBeCloseTo(1.2, 1);
  });

  it('emits starvation_threshold when rations run out', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0));
    // Wipe the cargo; no rations available.
    c.cargo.clear();
    const before = c.health;
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.events.some((e) => e.type === 'starvation_threshold')).toBe(true);
    // Health should drop a little.
    expect(c.health).toBeLessThan(before);
  });

  it('offsets missing cargo rations with limited terrain forage', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { terrain: 'plains', road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0));
    c.cargo.clear();

    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });

    expect(result.rationsConsumed).toBeGreaterThan(0);
    expect(result.rationsConsumed).toBeLessThan(dailyCrewRationKg(c));
    expect(result.events.some((e) => e.type === 'starvation_threshold')).toBe(true);
  });

  it('slowly recovers health on fully-fed days', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0));
    c.health = 0.5;
    c.cargo.set(resourceId('food.grain'), 50);
    tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(c.health).toBeCloseTo(0.51, 5);
  });

  it('reports fodder consumption from animals', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0), 5);
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    // 5 mules × 6 kg = 30 kg/day.
    expect(result.fodderConsumed).toBeCloseTo(30, 5);
  });

  it('supplements poor grazing with carried grain or legumes', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { terrain: 'urban', road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0), 5);
    c.cargo.clear();
    c.cargo.set(resourceId('food.bread'), 10);
    c.cargo.set(resourceId('food.legumes'), 20);
    const beforeLegumes = c.cargo.get(resourceId('food.legumes')) ?? 0;

    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });

    expect(result.fodderConsumed).toBeCloseTo(30, 5);
    expect(c.cargo.get(resourceId('food.legumes')) ?? 0).toBeLessThan(beforeLegumes);
    expect(result.events.some((e) => e.type === 'starvation_threshold')).toBe(false);
  });

  it('penalizes caravan health when animals cannot graze or draw carried feed', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { terrain: 'urban', road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0), 5);
    c.cargo.clear();
    c.cargo.set(resourceId('food.bread'), 10);
    const beforeHealth = c.health;

    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });

    expect(result.fodderConsumed).toBe(0);
    expect(result.events.some((e) => e.type === 'starvation_threshold')).toBe(true);
    expect(c.health).toBeLessThan(beforeHealth);
  });

  it('accrues a small amount of vehicle wear per day', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(10, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.wearAccrued).toBeGreaterThan(0);
    expect(result.wearAccrued).toBeLessThan(0.05);
  });
});

describe('tickCaravanMovement — destination reached', () => {
  it('emits arrived when the caravan lands on its destination', () => {
    const g = createGrid();
    fillRect(g, 0, 6, 0, 2, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(5, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    // 5 hexes away on a Roman road → comfortably reachable in one day.
    expect(c.position).toEqual(hex(5, 0));
    expect(result.events.some((e) => e.type === 'arrived')).toBe(true);
  });
});

describe('tickCaravanMovement — determinism', () => {
  it('same caravan + grid + day → same result', () => {
    const buildGrid = (): HexGrid => {
      const g = createGrid();
      fillRect(g, 0, 30, 0, 5, { road: 'roman' });
      g.set(hex(15, 2), tile({ terrain: 'hills', road: 'none' }));
      return g;
    };
    const g1 = buildGrid();
    const g2 = buildGrid();
    const c1 = muleCaravan(hex(0, 0), hex(20, 0));
    const c2 = muleCaravan(hex(0, 0), hex(20, 0));
    c1.cargo.set(resourceId('food.grain'), 100);
    c2.cargo.set(resourceId('food.grain'), 100);
    const r1 = tickCaravanMovement({ caravan: c1, grid: g1, season: 'summer', today: 5 });
    const r2 = tickCaravanMovement({ caravan: c2, grid: g2, season: 'summer', today: 5 });
    expect(r1.hexesMoved.map(hexKey)).toEqual(r2.hexesMoved.map(hexKey));
    expect(c1.position).toEqual(c2.position);
    expect(r1.rationsConsumed).toBe(r2.rationsConsumed);
    expect(r1.fodderConsumed).toBe(r2.fodderConsumed);
  });
});

describe('tickCaravanMovement — degenerate inputs', () => {
  it('handles a caravan starting off-grid (no movement)', () => {
    const g = createGrid();
    fillRect(g, 0, 3, 0, 3, { road: 'roman' });
    const c = muleCaravan(hex(99, 99), hex(0, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved).toEqual([]);
  });

  it('handles a destination not in the grid (no movement)', () => {
    const g = createGrid();
    fillRect(g, 0, 3, 0, 3, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(99, 99));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.hexesMoved).toEqual([]);
  });
});

describe('tickCaravanMovement — return value identity', () => {
  it('returns the same caravan object (mutated in place)', () => {
    const g = createGrid();
    fillRect(g, 0, 3, 0, 3, { road: 'roman' });
    const c = muleCaravan(hex(0, 0), hex(2, 0));
    const result = tickCaravanMovement({ caravan: c, grid: g, season: 'summer', today: 0 });
    expect(result.caravan).toBe(c);
  });
});
