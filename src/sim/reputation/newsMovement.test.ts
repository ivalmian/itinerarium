import { describe, expect, it } from 'vitest';
import { hex, type Hex } from '../world/hex.js';
import { createGrid, type HexGrid } from '../world/grid.js';
import type { HexTile } from '../world/terrain.js';
import { createNewsCarrier, createNewsItem, type NewsCarrier } from './news.js';
import type { ReputationKey } from './table.js';
import { characterId, type Day } from '../types.js';
import { tickCarrierWithGrid } from './newsMovement.js';

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

const aPerpetrator = (): ReputationKey => characterId('p');
const aVictim = (): ReputationKey => characterId('v');

const makeCarrier = (spawn: Hex, dest: Hex, speed?: number): NewsCarrier => {
  const news = createNewsItem({
    id: 'news-1',
    perpetrator: aPerpetrator(),
    victim: aVictim(),
    magnitude: 'major',
    isCriminalAct: true,
    occurredAtHex: spawn,
    occurredOnDay: 0 as Day,
  });
  return createNewsCarrier({
    id: 'carrier-1',
    news,
    spawnHex: spawn,
    destination: dest,
    spawnDay: 0 as Day,
    ...(speed !== undefined ? { speed } : {}),
  });
};

describe('tickCarrierWithGrid — basic movement', () => {
  it('a carrier already at destination is no-op', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5);
    const c = makeCarrier(hex(2, 2), hex(2, 2));
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    expect(next.position).toEqual(hex(2, 2));
    expect(next.arrived).toBe(true);
  });

  it('a carrier moves toward destination through the grid', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 5, { road: 'roman' });
    const c = makeCarrier(hex(0, 0), hex(20, 0));
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    // ~20 hexes/day default refugee speed → should make most of the way.
    expect(next.position.q).toBeGreaterThan(0);
    expect(next.position.q).toBeLessThanOrEqual(20);
  });

  it('a carrier marks arrived when it reaches destination', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = makeCarrier(hex(0, 0), hex(5, 0));
    // 5 hexes at default 20 hex/day speed → arrives in one day.
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    expect(next.position).toEqual(hex(5, 0));
    expect(next.arrived).toBe(true);
  });
});

describe('tickCarrierWithGrid — terrain awareness', () => {
  it('a carrier follows the road instead of the straight line when one exists', () => {
    const g = createGrid();
    // Block the direct row with rough terrain; offer a Roman road on row r=-1.
    fillRect(g, 0, 10, 0, 0, { terrain: 'dense_forest', road: 'none' });
    fillRect(g, 0, 10, -1, -1, { road: 'roman' });
    fillRect(g, 0, 10, 1, 1, { road: 'none' });
    const c = makeCarrier(hex(0, 0), hex(10, 0));
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    // Carrier should detour via the Roman road row (r=-1) at some point.
    // We can't easily inspect the path, but check it advanced further than the
    // straight-line dense-forest cost would allow (off-road dense forest is slow).
    expect(next.position.q).toBeGreaterThan(2);
  });

  it('a carrier blocked by impassable winter pass either waits or detours', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile({ road: 'dirt' }));
    g.set(hex(1, 0), tile({ road: 'dirt' }));
    g.set(hex(2, 0), tile({ terrain: 'mountains' }));
    g.set(hex(3, 0), tile({ road: 'dirt' }));
    const c = makeCarrier(hex(0, 0), hex(3, 0));
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'winter', today: 1 as Day });
    // Either no movement (no path through winter pass) or stops before the pass.
    expect(next.position).not.toEqual(hex(2, 0));
    expect(next.arrived).toBe(false);
  });

  it('a carrier with no path to destination does not move and is not arrived', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    g.set(hex(5, 0), tile());
    // No grid hexes between them — effectively unreachable.
    const c = makeCarrier(hex(0, 0), hex(5, 0));
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    expect(next.position).toEqual(hex(0, 0));
    expect(next.arrived).toBe(false);
  });
});

describe('tickCarrierWithGrid — speed', () => {
  it('a slower carrier covers fewer hexes than a faster one in the same day', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 2, { road: 'roman' });
    const slow = makeCarrier(hex(0, 0), hex(30, 0), 10);
    const fast = makeCarrier(hex(0, 0), hex(30, 0), 30);
    const ns = tickCarrierWithGrid({ carrier: slow, grid: g, season: 'summer', today: 1 as Day });
    const nf = tickCarrierWithGrid({ carrier: fast, grid: g, season: 'summer', today: 1 as Day });
    expect(nf.position.q).toBeGreaterThan(ns.position.q);
  });
});

describe('tickCarrierWithGrid — determinism', () => {
  it('same carrier + grid + day → same result', () => {
    const buildGrid = (): HexGrid => {
      const g = createGrid();
      fillRect(g, 0, 25, 0, 4, { road: 'roman' });
      g.set(hex(10, 2), tile({ terrain: 'hills' }));
      return g;
    };
    const g1 = buildGrid();
    const g2 = buildGrid();
    const c1 = makeCarrier(hex(0, 0), hex(20, 0));
    const c2 = makeCarrier(hex(0, 0), hex(20, 0));
    const r1 = tickCarrierWithGrid({ carrier: c1, grid: g1, season: 'summer', today: 5 as Day });
    const r2 = tickCarrierWithGrid({ carrier: c2, grid: g2, season: 'summer', today: 5 as Day });
    expect(r1.position).toEqual(r2.position);
    expect(r1.arrived).toBe(r2.arrived);
  });
});

describe('tickCarrierWithGrid — preserves carrier identity', () => {
  it('returns a new NewsCarrier (immutable update; original unchanged)', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = makeCarrier(hex(0, 0), hex(5, 0));
    const before = c.position;
    const next = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    expect(c.position).toBe(before);
    expect(next).not.toBe(c);
    expect(next.id).toBe(c.id);
    expect(next.carrying).toBe(c.carrying);
  });

  it('does not regress past arrival once arrived', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 2, { road: 'roman' });
    const c = makeCarrier(hex(0, 0), hex(3, 0));
    const arrived = tickCarrierWithGrid({ carrier: c, grid: g, season: 'summer', today: 1 as Day });
    expect(arrived.arrived).toBe(true);
    const stillArrived = tickCarrierWithGrid({
      carrier: arrived,
      grid: g,
      season: 'summer',
      today: 2 as Day,
    });
    expect(stillArrived.arrived).toBe(true);
    expect(stillArrived.position).toEqual(hex(3, 0));
  });
});
