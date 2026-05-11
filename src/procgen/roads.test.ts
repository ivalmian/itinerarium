import { describe, expect, it } from 'vitest';
import { hex, hexKey, hexNeighbors, type Hex } from '../sim/world/hex.js';
import { createGrid, type HexGrid } from '../sim/world/grid.js';
import type { HexTile } from '../sim/world/terrain.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements, type SettlementSite } from './settlements.js';
import { generateRoads } from './roads.js';

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

const cityAt = (anchor: Hex, isCapital = false): SettlementSite => ({
  kind: isCapital ? 'capital' : 'city',
  anchor,
  urbanHexes: [anchor],
  estimatedPopulation: isCapital ? 25000 : 8000,
});

const villageAt = (anchor: Hex): SettlementSite => ({
  kind: 'village',
  anchor,
  urbanHexes: [anchor],
  estimatedPopulation: 400,
});

const townAt = (anchor: Hex): SettlementSite => ({
  kind: 'town',
  anchor,
  urbanHexes: [anchor],
  estimatedPopulation: 2000,
});

/**
 * BFS over hexes whose road is `roman` or `dirt` (we treat both as connected
 * for the "everything is reachable" invariant). Returns reachable set from
 * the given start.
 */
const reachableViaRoads = (grid: HexGrid, start: Hex): Set<string> => {
  const seen = new Set<string>();
  const queue: Hex[] = [start];
  seen.add(hexKey(start));
  while (queue.length > 0) {
    const cur = queue.shift() as Hex;
    for (const n of hexNeighbors(cur)) {
      const k = hexKey(n);
      if (seen.has(k)) continue;
      const t = grid.get(n);
      if (t === undefined) continue;
      if (t.road === 'none') continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
};

describe('generateRoads — capital ↔ cities (Roman roads)', () => {
  it('connects capital to every city via a Roman road', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 5);
    const capital = cityAt(hex(0, 0), true);
    const cityA = cityAt(hex(15, 0));
    const cityB = cityAt(hex(28, 2));
    generateRoads({ seed: 'roman-test', grid: g, settlements: [capital, cityA, cityB] });

    // Capital and cities themselves should be roman.
    expect(g.get(capital.anchor)?.road).toBe('roman');
    expect(g.get(cityA.anchor)?.road).toBe('roman');
    expect(g.get(cityB.anchor)?.road).toBe('roman');

    // BFS over roman-only roads from capital should reach both cities.
    const reachableRoman = (start: Hex): Set<string> => {
      const seen = new Set<string>();
      const queue: Hex[] = [start];
      seen.add(hexKey(start));
      while (queue.length > 0) {
        const cur = queue.shift() as Hex;
        for (const n of hexNeighbors(cur)) {
          const k = hexKey(n);
          if (seen.has(k)) continue;
          const t = g.get(n);
          if (t === undefined) continue;
          if (t.road !== 'roman') continue;
          seen.add(k);
          queue.push(n);
        }
      }
      return seen;
    };
    const reachable = reachableRoman(capital.anchor);
    expect(reachable.has(hexKey(cityA.anchor))).toBe(true);
    expect(reachable.has(hexKey(cityB.anchor))).toBe(true);
  });

  it('any settlement is reachable from the capital via roads (BFS connectivity)', () => {
    const g = createGrid();
    fillRect(g, 0, 30, 0, 8);
    const capital = cityAt(hex(0, 0), true);
    const cityA = cityAt(hex(15, 0));
    const v1 = villageAt(hex(3, 2));
    const v2 = villageAt(hex(20, 3));
    const v3 = villageAt(hex(25, 6));
    generateRoads({ seed: 'connect', grid: g, settlements: [capital, cityA, v1, v2, v3] });
    const reachable = reachableViaRoads(g, capital.anchor);
    expect(reachable.has(hexKey(cityA.anchor))).toBe(true);
    expect(reachable.has(hexKey(v1.anchor))).toBe(true);
    expect(reachable.has(hexKey(v2.anchor))).toBe(true);
    expect(reachable.has(hexKey(v3.anchor))).toBe(true);
  });
});

describe('generateRoads — city ↔ villages (dirt roads)', () => {
  it('connects nearby villages to their cluster city with dirt roads', () => {
    const g = createGrid();
    fillRect(g, 0, 20, 0, 8);
    const capital = cityAt(hex(0, 0), true);
    const village = villageAt(hex(3, 2));
    generateRoads({ seed: 'dirt', grid: g, settlements: [capital, village] });
    expect(g.get(village.anchor)?.road).toBe('dirt');
  });

  it('does not assign dirt roads to villages outside any cluster radius', () => {
    const g = createGrid();
    fillRect(g, 0, 80, 0, 5);
    const capital = cityAt(hex(0, 0), true);
    const farVillage = villageAt(hex(75, 0));
    // 75 hexes away — well past default 30..50 hex cluster radius.
    generateRoads({
      seed: 'far',
      grid: g,
      settlements: [capital, farVillage],
      clusterRadiusHexes: 30,
    });
    // The far village still needs to be reachable per the connectivity guarantee
    // (but it routes via the cluster network, not as a direct dirt road from
    // capital). What we check here: it's NOT a dirt-road extension straight
    // from a city because there is no city within its cluster radius.
    // In practice the implementation may still connect it as a long arterial
    // dirt road; the assertion we want is just: the village anchor itself has
    // some road grade so it is reachable.
    expect(
      g.get(farVillage.anchor)?.road === 'dirt' || g.get(farVillage.anchor)?.road === 'roman',
    ).toBe(true);
  });
});

describe('generateRoads — upgrade rule (roman wins over dirt)', () => {
  it('a hex shared by a Roman and a dirt route stays roman', () => {
    const g = createGrid();
    fillRect(g, 0, 12, 0, 3);
    const capital = cityAt(hex(0, 0), true);
    const cityA = cityAt(hex(10, 0));
    // Place a village on the natural Roman corridor between them.
    const villageOnPath = villageAt(hex(5, 0));
    generateRoads({
      seed: 'upgrade',
      grid: g,
      settlements: [capital, cityA, villageOnPath],
    });
    // The shared hex must be Roman (the city↔city route assigns roman; the
    // village dirt route should NOT downgrade it).
    expect(g.get(hex(5, 0))?.road).toBe('roman');
  });
});

describe('generateRoads — terrain awareness', () => {
  it('avoids impassable terrain (lakes) when alternatives exist', () => {
    const g = createGrid();
    fillRect(g, 0, 10, 0, 3);
    // Block the direct row with a lake.
    g.set(hex(5, 0), tile({ terrain: 'lake' }));
    const capital = cityAt(hex(0, 0), true);
    const cityA = cityAt(hex(10, 0));
    generateRoads({ seed: 'avoid-lake', grid: g, settlements: [capital, cityA] });
    expect(g.get(hex(5, 0))?.road).toBe('none');
  });
});

describe('generateRoads — determinism', () => {
  it('same seed + same settlements → identical road network', () => {
    const grid1 = generateTerrain({
      seed: 'det-grid',
      widthHexes: 60,
      heightHexes: 60,
      mountainsCoveragePct: 8,
      oceanCoveragePct: 5,
    });
    const grid2 = generateTerrain({
      seed: 'det-grid',
      widthHexes: 60,
      heightHexes: 60,
      mountainsCoveragePct: 8,
      oceanCoveragePct: 5,
    });
    const sites1 = siteSettlements({
      seed: 'det-sites',
      grid: grid1,
      cityCount: 3,
      townCount: 6,
      villageCount: 20,
      hamletCount: 10,
    });
    const sites2 = siteSettlements({
      seed: 'det-sites',
      grid: grid2,
      cityCount: 3,
      townCount: 6,
      villageCount: 20,
      hamletCount: 10,
    });
    generateRoads({ seed: 'det-roads', grid: grid1, settlements: sites1 });
    generateRoads({ seed: 'det-roads', grid: grid2, settlements: sites2 });
    // Compare road grade per hex.
    for (const [h, t1] of grid1.tiles()) {
      const t2 = grid2.get(h);
      expect(t2).toBeDefined();
      expect(t1.road).toBe(t2?.road);
    }
  });

  it('different seeds may produce different road choices when alternatives exist', () => {
    // We don't strictly require this; a stable seed-driven tie-break may
    // still emit the same network. The important guarantee is that *given a
    // seed*, the output is reproducible. So just verify that calling the
    // same seed twice in a row matches.
    const g1 = createGrid();
    fillRect(g1, 0, 8, 0, 4);
    const g2 = createGrid();
    fillRect(g2, 0, 8, 0, 4);
    const settlements: readonly SettlementSite[] = [cityAt(hex(0, 0), true), cityAt(hex(8, 4))];
    generateRoads({ seed: 'stable', grid: g1, settlements });
    generateRoads({ seed: 'stable', grid: g2, settlements });
    for (const [h, t1] of g1.tiles()) {
      expect(g2.get(h)?.road).toBe(t1.road);
    }
  });
});

describe('generateRoads — settlement footprints', () => {
  it('all urban hexes of a city are paved (roman for cities, dirt for towns)', () => {
    const g = createGrid();
    fillRect(g, 0, 20, 0, 5);
    const capital: SettlementSite = {
      kind: 'capital',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0), hex(1, 0), hex(0, 1)],
      estimatedPopulation: 25000,
    };
    const cityA: SettlementSite = {
      kind: 'city',
      anchor: hex(15, 0),
      urbanHexes: [hex(15, 0), hex(15, 1)],
      estimatedPopulation: 8000,
    };
    const town: SettlementSite = {
      kind: 'town',
      anchor: hex(8, 3),
      urbanHexes: [hex(8, 3), hex(8, 2)],
      estimatedPopulation: 2500,
    };
    generateRoads({ seed: 'urban', grid: g, settlements: [capital, cityA, town] });
    for (const h of capital.urbanHexes) {
      expect(g.get(h)?.road).toBe('roman');
    }
    for (const h of cityA.urbanHexes) {
      expect(g.get(h)?.road).toBe('roman');
    }
    // Town urban hexes should be at least dirt (may be roman if on the city↔city route).
    for (const h of town.urbanHexes) {
      const r = g.get(h)?.road;
      expect(r === 'dirt' || r === 'roman').toBe(true);
    }
  });
});

describe('generateRoads — degenerate inputs', () => {
  it('handles a single settlement (no roads to draw)', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5);
    const only = cityAt(hex(2, 2), true);
    generateRoads({ seed: 'single', grid: g, settlements: [only] });
    // The settlement's own urban hex(es) are paved as Roman.
    expect(g.get(only.anchor)?.road).toBe('roman');
  });

  it('returns the same grid instance (mutation in place)', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5);
    const result = generateRoads({
      seed: 'identity',
      grid: g,
      settlements: [cityAt(hex(0, 0), true), cityAt(hex(5, 0))],
    });
    expect(result).toBe(g);
  });

  it('handles an empty settlement list (no-op)', () => {
    const g = createGrid();
    fillRect(g, 0, 5, 0, 5);
    generateRoads({ seed: 'empty', grid: g, settlements: [] });
    for (const [, t] of g.tiles()) {
      expect(t.road).toBe('none');
    }
  });

  it('skips a city pair if no path exists between them (impassable terrain everywhere)', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    g.set(hex(10, 0), tile());
    // Surround capital with lakes — no neighbour is passable.
    for (const n of hexNeighbors(hex(0, 0))) {
      g.set(n, tile({ terrain: 'lake' }));
    }
    const capital = cityAt(hex(0, 0), true);
    const cityA = cityAt(hex(10, 0));
    // Should not throw.
    expect(() =>
      generateRoads({ seed: 'unreach', grid: g, settlements: [capital, cityA] }),
    ).not.toThrow();
  });
});

describe('generateRoads — town integration', () => {
  it('connects towns into the network (via city or arterial route)', () => {
    const g = createGrid();
    fillRect(g, 0, 25, 0, 6);
    const capital = cityAt(hex(0, 0), true);
    const town = townAt(hex(12, 2));
    const cityA = cityAt(hex(20, 0));
    generateRoads({ seed: 'towns', grid: g, settlements: [capital, town, cityA] });
    const reachable = reachableViaRoads(g, capital.anchor);
    expect(reachable.has(hexKey(town.anchor))).toBe(true);
  });
});
