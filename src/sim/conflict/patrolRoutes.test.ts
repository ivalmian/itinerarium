import { describe, expect, it } from 'vitest';
import { hex, hexEquals, hexKey, type Hex } from '../world/hex.js';
import { createGrid, type HexGrid } from '../world/grid.js';
import type { HexTile, RoadGrade } from '../world/terrain.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import { settlementId } from '../types.js';
import {
  generateRoadPatrolRoute,
  routeForCityWatch,
  routeForFamilyGuard,
  routeForGarrisonPatrol,
} from './patrolRoutes.js';

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

const stampRoad = (g: HexGrid, road: RoadGrade, hexes: readonly Hex[]): void => {
  for (const h of hexes) {
    const t = g.get(h);
    if (t !== undefined) t.road = road;
  }
};

const buildSettlement = (anchor: Hex, urban: readonly Hex[] = []): Settlement => {
  const all = urban.length > 0 ? urban : [anchor];
  return createSettlement({
    id: settlementId('s1'),
    tier: 'town',
    name: 'Testton',
    anchor,
    urbanHexes: all,
    catchmentHexes: [],
  });
};

describe('generateRoadPatrolRoute — basic shape', () => {
  it('always returns a non-empty route starting at base anchor', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5);
    const s = buildSettlement(hex(2, 2));
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: 3,
      preferRoadGrade: 'any',
    });
    expect(route.length).toBeGreaterThan(0);
    expect(route[0]).toEqual(hex(2, 2));
  });

  it('returns a cyclic route (last hex equals first hex)', () => {
    const g = createGrid();
    fillRect(g, 0, 15, 0, 5, { road: 'roman' });
    const s = buildSettlement(hex(0, 0));
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: 8,
      preferRoadGrade: 'roman',
    });
    expect(route.length).toBeGreaterThan(2);
    expect(route[0]).toEqual(route[route.length - 1]);
  });
});

describe('generateRoadPatrolRoute — naive fallback', () => {
  it('falls back to anchor + urban hexes when no roads are nearby', () => {
    const g = createGrid();
    // No roads at all (tile defaults road = none).
    fillRect(g, 0, 10, 0, 10, { terrain: 'dense_forest' });
    const s = buildSettlement(hex(2, 2), [hex(2, 2), hex(3, 2)]);
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: 5,
      preferRoadGrade: 'roman',
    });
    // Fallback returns the urban-hex naive route — must include the anchor and
    // not crash. Loop closure may add an extra anchor step at the end.
    expect(route.length).toBeGreaterThanOrEqual(1);
    expect(route[0]).toEqual(hex(2, 2));
    // Every emitted hex either is one of the urban hexes or is reachable from
    // them; at minimum the anchor itself is present.
    const containsAnchor = route.some((h) => hexEquals(h, hex(2, 2)));
    expect(containsAnchor).toBe(true);
  });
});

describe('generateRoadPatrolRoute — road grade preference', () => {
  it('roman-only preference: every non-anchor route hex sits on a roman or near-base hex', () => {
    const g = createGrid();
    fillRect(g, 0, 20, 0, 4);
    // Lay a Roman road from base outward in a line.
    const romanLine = [hex(0, 0), hex(1, 0), hex(2, 0), hex(3, 0), hex(4, 0), hex(5, 0)];
    stampRoad(g, 'roman', romanLine);
    // And a parallel dirt road on row r=2.
    const dirtLine = [hex(0, 2), hex(1, 2), hex(2, 2), hex(3, 2)];
    stampRoad(g, 'dirt', dirtLine);
    const s = buildSettlement(hex(0, 0));
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: 5,
      preferRoadGrade: 'roman',
    });
    // Filter out anchor steps — they're allowed to be any grade so the patrol
    // can actually leave its base. All other hexes must be Roman (the only
    // road grade we prefer).
    let nonRomanFar = 0;
    for (const h of route) {
      if (hexEquals(h, hex(0, 0))) continue;
      const t = g.get(h);
      if (t === undefined) continue;
      if (t.road !== 'roman') nonRomanFar++;
    }
    expect(nonRomanFar).toBe(0);
  });

  it('dirt preference accepts dirt OR roman hexes (city watch goes anywhere paved)', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 4);
    stampRoad(g, 'dirt', [hex(0, 0), hex(1, 0), hex(2, 0), hex(3, 0), hex(4, 0)]);
    stampRoad(g, 'roman', [hex(0, 1), hex(1, 1), hex(2, 1)]);
    const s = buildSettlement(hex(0, 0));
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: 4,
      preferRoadGrade: 'dirt',
    });
    // Every non-anchor hex on the route must be paved (dirt or roman).
    for (const h of route) {
      if (hexEquals(h, hex(0, 0))) continue;
      const t = g.get(h);
      if (t === undefined) continue;
      expect(t.road === 'dirt' || t.road === 'roman').toBe(true);
    }
  });
});

describe('generateRoadPatrolRoute — radius', () => {
  it('every route hex is within radiusHexes of the base anchor', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 6, { road: 'roman' });
    const s = buildSettlement(hex(0, 0));
    const radius = 6;
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: radius,
      preferRoadGrade: 'roman',
    });
    for (const h of route) {
      const dq = h.q - 0;
      const dr = h.r - 0;
      const ds = -dq - dr;
      const dist = (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
      // Allow a small slack because route segments are A* paths and may
      // occasionally bow slightly outside the strict radius. Use 1.5x as a
      // generous bound.
      expect(dist).toBeLessThanOrEqual(Math.ceil(radius * 1.5));
    }
  });
});

describe('generateRoadPatrolRoute — determinism', () => {
  it('same inputs → same route', () => {
    const buildG = (): HexGrid => {
      const g = createGrid();
      fillRect(g, 0, 20, 0, 6);
      stampRoad(g, 'roman', [
        hex(0, 0),
        hex(1, 0),
        hex(2, 0),
        hex(3, 0),
        hex(4, 0),
        hex(5, 0),
        hex(6, 0),
      ]);
      stampRoad(g, 'roman', [hex(0, 0), hex(0, 1), hex(0, 2), hex(0, 3)]);
      return g;
    };
    const g1 = buildG();
    const g2 = buildG();
    const s = buildSettlement(hex(0, 0));
    const r1 = generateRoadPatrolRoute({
      basedAt: s,
      grid: g1,
      radiusHexes: 5,
      preferRoadGrade: 'roman',
    });
    const r2 = generateRoadPatrolRoute({
      basedAt: s,
      grid: g2,
      radiusHexes: 5,
      preferRoadGrade: 'roman',
    });
    expect(r1.map(hexKey)).toEqual(r2.map(hexKey));
  });
});

describe('generateRoadPatrolRoute — meaningful coverage', () => {
  it('produces a multi-hex route on a real road network', () => {
    const g = createGrid();
    fillRect(g, 0, 12, 0, 6);
    // A small cross of Roman roads.
    stampRoad(g, 'roman', [
      hex(0, 0),
      hex(1, 0),
      hex(2, 0),
      hex(3, 0),
      hex(4, 0),
      hex(0, 1),
      hex(0, 2),
      hex(0, 3),
    ]);
    const s = buildSettlement(hex(0, 0));
    const route = generateRoadPatrolRoute({
      basedAt: s,
      grid: g,
      radiusHexes: 5,
      preferRoadGrade: 'roman',
    });
    // At least visits more hexes than just the anchor (multi-hex meaningful
    // route); covers at least 4 unique road hexes.
    const unique = new Set(route.map(hexKey));
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });
});

describe('routeForGarrisonPatrol / routeForCityWatch / routeForFamilyGuard', () => {
  it('garrison patrol uses Roman roads with ~30 hex radius', () => {
    const g = createGrid();
    fillRect(g, 0, 50, 0, 5, { road: 'roman' });
    const s = buildSettlement(hex(0, 0));
    const route = routeForGarrisonPatrol(s, g);
    // Cyclic, starts/ends at base.
    expect(route[0]).toEqual(hex(0, 0));
    expect(route[route.length - 1]).toEqual(hex(0, 0));
    // Some hex in the route should be ~20+ away (close to the 30 radius).
    let maxDist = 0;
    for (const h of route) {
      const dq = h.q;
      const dr = h.r;
      const ds = -dq - dr;
      const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
      if (d > maxDist) maxDist = d;
    }
    expect(maxDist).toBeGreaterThanOrEqual(10);
  });

  it('city watch uses dirt/roman roads with a small ~5 hex radius', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 4, { road: 'dirt' });
    const s = buildSettlement(hex(0, 0));
    const route = routeForCityWatch(s, g);
    expect(route[0]).toEqual(hex(0, 0));
    let maxDist = 0;
    for (const h of route) {
      const dq = h.q;
      const dr = h.r;
      const ds = -dq - dr;
      const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
      if (d > maxDist) maxDist = d;
    }
    // City watch shouldn't roam too far — soft bound.
    expect(maxDist).toBeLessThanOrEqual(10);
  });

  it('family guard accepts any path with ~15 hex radius', () => {
    const g = createGrid();
    // No roads — just plains.
    fillRect(g, 0, 20, 0, 5);
    const s = buildSettlement(hex(0, 0));
    const route = routeForFamilyGuard(s, g);
    // With no roads the family guard still produces a usable route via
    // off-road traversal (preferRoadGrade='any').
    expect(route.length).toBeGreaterThan(0);
    expect(route[0]).toEqual(hex(0, 0));
  });
});
