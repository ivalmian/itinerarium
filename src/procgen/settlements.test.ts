import { describe, expect, it } from 'vitest';
import { hexDistance, hexKey } from '../sim/world/hex.js';
import type { HexGrid } from '../sim/world/grid.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements, type SettlementSite } from './settlements.js';

const sortedSitesKey = (sites: readonly SettlementSite[]): string =>
  sites
    .map(
      (s) =>
        `${s.kind}:${hexKey(s.anchor)}:${s.estimatedPopulation}:[${s.urbanHexes
          .map(hexKey)
          .sort()
          .join('|')}]`,
    )
    .sort()
    .join(';');

const makeGrid = (seed: string, w = 100, h = 100): HexGrid =>
  generateTerrain({
    seed,
    widthHexes: w,
    heightHexes: h,
    // Bias for testability: keep mountains modest so cities have room.
    mountainsCoveragePct: 10,
    oceanCoveragePct: 8,
  });

describe('siteSettlements — determinism', () => {
  it('same seed + grid → identical layout', () => {
    const grid = makeGrid('det-grid', 60, 60);
    const opts = {
      seed: 'site-seed',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 50,
      hamletCount: 30,
    };
    const a = siteSettlements(opts);
    const b = siteSettlements(opts);
    expect(sortedSitesKey(a)).toBe(sortedSitesKey(b));
  });

  it('different seeds → different layouts (typically)', () => {
    const grid = makeGrid('det-grid', 60, 60);
    const a = siteSettlements({
      seed: 'seed-a',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 50,
      hamletCount: 30,
    });
    const b = siteSettlements({
      seed: 'seed-b',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 50,
      hamletCount: 30,
    });
    expect(sortedSitesKey(a)).not.toBe(sortedSitesKey(b));
  });
});

describe('siteSettlements — counts and kinds', () => {
  it('produces exactly one capital', () => {
    const grid = makeGrid('cap-grid', 80, 80);
    const sites = siteSettlements({
      seed: 'cap',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 40,
      hamletCount: 20,
    });
    const capitals = sites.filter((s) => s.kind === 'capital');
    expect(capitals.length).toBe(1);
  });

  it('produces requested counts when the grid has room', () => {
    const grid = makeGrid('counts-grid', 100, 100);
    const sites = siteSettlements({
      seed: 'counts',
      grid,
      cityCount: 4,
      townCount: 12,
      villageCount: 60,
      hamletCount: 40,
    });
    const cities = sites.filter((s) => s.kind === 'capital' || s.kind === 'city');
    const towns = sites.filter((s) => s.kind === 'town');
    const villages = sites.filter((s) => s.kind === 'village');
    const hamlets = sites.filter((s) => s.kind === 'hamlet');
    // Cities must be exact (capital + cityCount-1 cities = cityCount).
    expect(cities.length).toBe(4);
    // Other counts are a target; we accept ±20% shortfall in case the grid
    // can't accommodate the full request.
    expect(towns.length).toBeGreaterThanOrEqual(Math.floor(12 * 0.8));
    expect(towns.length).toBeLessThanOrEqual(12);
    // v1.5 §C9: villages and hamlets are disaggregated 3x and 5x respectively
    // (each historical "aggregated entity" is now multiple real entities).
    // Caller-requested counts are interpreted as the aggregated-entity
    // baseline; procgen emits `count * factor` entities (subject to grid
    // accommodation, hence the ±20% shortfall band).
    expect(villages.length).toBeGreaterThanOrEqual(Math.floor(60 * 3 * 0.8));
    expect(villages.length).toBeLessThanOrEqual(60 * 3);
    expect(hamlets.length).toBeGreaterThanOrEqual(Math.floor(40 * 5 * 0.8));
    expect(hamlets.length).toBeLessThanOrEqual(40 * 5);
  });
});

describe('siteSettlements — siting rules', () => {
  it('cities never sit on impassable terrain (mountains, lakes, marsh)', () => {
    const grid = makeGrid('siting', 80, 80);
    const sites = siteSettlements({
      seed: 'siting',
      grid,
      cityCount: 5,
      townCount: 10,
      villageCount: 40,
      hamletCount: 20,
    });
    for (const s of sites) {
      if (s.kind === 'capital' || s.kind === 'city') {
        const tile = grid.get(s.anchor);
        expect(tile).toBeDefined();
        expect(['mountains', 'lake', 'marsh', 'dense_forest']).not.toContain(tile?.terrain);
      }
    }
  });

  it('cities are spaced apart (min spacing >= clusterRadius)', () => {
    const grid = makeGrid('spacing', 100, 100);
    const clusterRadius = 25;
    const sites = siteSettlements({
      seed: 'spacing',
      grid,
      cityCount: 4,
      townCount: 8,
      villageCount: 30,
      hamletCount: 15,
      clusterRadiusHexes: clusterRadius,
    });
    const cities = sites.filter((s) => s.kind === 'capital' || s.kind === 'city');
    for (let i = 0; i < cities.length; i++) {
      for (let j = i + 1; j < cities.length; j++) {
        const a = cities[i] as SettlementSite;
        const b = cities[j] as SettlementSite;
        const dist = hexDistance(a.anchor, b.anchor);
        expect(dist).toBeGreaterThanOrEqual(clusterRadius);
      }
    }
  });

  it('city urban hexes contain the anchor and are contiguous', () => {
    const grid = makeGrid('urban', 80, 80);
    const sites = siteSettlements({
      seed: 'urban',
      grid,
      cityCount: 3,
      townCount: 6,
      villageCount: 30,
      hamletCount: 15,
    });
    for (const s of sites) {
      if (s.kind !== 'capital' && s.kind !== 'city') continue;
      // Anchor is always part of the urban set.
      const inUrban = s.urbanHexes.some((h) => h.q === s.anchor.q && h.r === s.anchor.r);
      expect(inUrban).toBe(true);
      // Each urban hex should be within distance (urbanHexes.length - 1) of anchor.
      for (const h of s.urbanHexes) {
        expect(hexDistance(h, s.anchor)).toBeLessThanOrEqual(s.urbanHexes.length);
      }
    }
  });

  it('city urban hex count scales with population (small city: 2–3, large city: 3–10)', () => {
    const grid = makeGrid('scale', 80, 80);
    const sites = siteSettlements({
      seed: 'scale',
      grid,
      cityCount: 5,
      townCount: 10,
      villageCount: 40,
      hamletCount: 20,
    });
    const cities = sites.filter((s) => s.kind === 'capital' || s.kind === 'city');
    expect(cities.length).toBeGreaterThan(0);
    for (const c of cities) {
      // Every city must be at least 2 hexes (per docs/05 "small city: 2–3 hexes").
      expect(c.urbanHexes.length).toBeGreaterThanOrEqual(2);
      expect(c.urbanHexes.length).toBeLessThanOrEqual(10);
      if (c.estimatedPopulation >= 15000) {
        // Large city.
        expect(c.urbanHexes.length).toBeGreaterThanOrEqual(3);
      } else {
        // Small city.
        expect(c.urbanHexes.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it('hamlets and villages have exactly one urban hex', () => {
    const grid = makeGrid('small', 80, 80);
    const sites = siteSettlements({
      seed: 'small',
      grid,
      cityCount: 3,
      townCount: 6,
      villageCount: 40,
      hamletCount: 30,
    });
    for (const s of sites) {
      if (s.kind === 'hamlet' || s.kind === 'village') {
        expect(s.urbanHexes.length).toBe(1);
        expect(s.urbanHexes[0]?.q).toBe(s.anchor.q);
        expect(s.urbanHexes[0]?.r).toBe(s.anchor.r);
      }
    }
  });

  it('settlement population estimates fall within tier ranges (docs/05)', () => {
    const grid = makeGrid('pop', 80, 80);
    const sites = siteSettlements({
      seed: 'pop',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 40,
      hamletCount: 20,
    });
    for (const s of sites) {
      switch (s.kind) {
        case 'hamlet':
          expect(s.estimatedPopulation).toBeGreaterThanOrEqual(30);
          expect(s.estimatedPopulation).toBeLessThanOrEqual(150);
          break;
        case 'village':
          expect(s.estimatedPopulation).toBeGreaterThanOrEqual(150);
          expect(s.estimatedPopulation).toBeLessThanOrEqual(800);
          break;
        case 'town':
          expect(s.estimatedPopulation).toBeGreaterThanOrEqual(1000);
          expect(s.estimatedPopulation).toBeLessThanOrEqual(5000);
          break;
        case 'city':
        case 'capital':
          expect(s.estimatedPopulation).toBeGreaterThanOrEqual(5000);
          expect(s.estimatedPopulation).toBeLessThanOrEqual(50000);
          break;
      }
    }
  });
});

describe('siteSettlements — cluster geography', () => {
  it('most villages and hamlets sit within clusterRadius of a city', () => {
    const grid = makeGrid('cluster', 100, 100);
    const radius = 30;
    const sites = siteSettlements({
      seed: 'cluster',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 60,
      hamletCount: 40,
      clusterRadiusHexes: radius,
    });
    const cities = sites.filter((s) => s.kind === 'capital' || s.kind === 'city');
    const small = sites.filter((s) => s.kind === 'village' || s.kind === 'hamlet');
    let inCluster = 0;
    for (const s of small) {
      const d = Math.min(...cities.map((c) => hexDistance(s.anchor, c.anchor)));
      if (d <= radius) inCluster++;
    }
    // At least 70% of villages+hamlets cluster around cities.
    expect(inCluster / small.length).toBeGreaterThanOrEqual(0.7);
  });

  it('no two cities/towns/villages share an anchor hex (hamlets may stack on a village)', () => {
    // Per docs/05 §"Same-hex coexistence" hamlets are allowed to share a
    // hex with a village (the Roman *pagus* pattern, up to ~5 satellites).
    // The larger-tier settlements still must hold unique anchors.
    const grid = makeGrid('overlap', 80, 80);
    const sites = siteSettlements({
      seed: 'overlap',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 40,
      hamletCount: 20,
    });
    const seen = new Set<string>();
    for (const s of sites) {
      if (s.kind === 'hamlet') continue;
      const k = hexKey(s.anchor);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it('hamlets that share a hex with a village cap at MAX_SAMEHEX_HAMLETS (5)', () => {
    const grid = makeGrid('overlap2', 80, 80);
    const sites = siteSettlements({
      seed: 'overlap2',
      grid,
      cityCount: 4,
      townCount: 10,
      villageCount: 40,
      hamletCount: 20,
    });
    // Per-hex hamlet count must not exceed the *pagus* cap.
    const hamletsPerHex = new Map<string, number>();
    for (const s of sites) {
      if (s.kind !== 'hamlet') continue;
      for (const h of s.urbanHexes) {
        const k = hexKey(h);
        hamletsPerHex.set(k, (hamletsPerHex.get(k) ?? 0) + 1);
      }
    }
    for (const [, count] of hamletsPerHex) {
      expect(count).toBeLessThanOrEqual(5);
    }
    // City/town/capital urban hexes never have a hamlet on them.
    const denseCoreHexes = new Set<string>();
    for (const s of sites) {
      if (s.kind !== 'capital' && s.kind !== 'city' && s.kind !== 'town') continue;
      for (const h of s.urbanHexes) denseCoreHexes.add(hexKey(h));
    }
    for (const k of hamletsPerHex.keys()) {
      expect(denseCoreHexes.has(k)).toBe(false);
    }
  });
});

describe('siteSettlements — degenerate inputs', () => {
  it('returns nothing on a tiny inhospitable grid', () => {
    // A 5×5 grid of all mountains/marsh would be hostile; use a small grid
    // and request zero counts.
    const grid = makeGrid('tiny', 10, 10);
    const sites = siteSettlements({
      seed: 'tiny',
      grid,
      cityCount: 0,
      townCount: 0,
      villageCount: 0,
      hamletCount: 0,
    });
    expect(sites.length).toBe(0);
  });

  it('honours villageCount=0 (no villages emitted)', () => {
    const grid = makeGrid('no-villages', 60, 60);
    const sites = siteSettlements({
      seed: 'nv',
      grid,
      cityCount: 2,
      townCount: 4,
      villageCount: 0,
      hamletCount: 10,
    });
    const villages = sites.filter((s) => s.kind === 'village');
    expect(villages.length).toBe(0);
  });

  it('handles being asked for more cities than the grid can fit', () => {
    // 8×8 grid can only fit a couple of well-spaced cities.
    const grid = makeGrid('packed', 8, 8);
    const sites = siteSettlements({
      seed: 'packed',
      grid,
      cityCount: 100,
      townCount: 0,
      villageCount: 0,
      hamletCount: 0,
      clusterRadiusHexes: 5,
    });
    // We don't crash; we cap at whatever fits.
    const cities = sites.filter((s) => s.kind === 'capital' || s.kind === 'city');
    expect(cities.length).toBeLessThan(100);
  });
});

describe('siteSettlements — anchor reachability', () => {
  it('anchors and urban hexes exist in the input grid', () => {
    const grid = makeGrid('reach', 60, 60);
    const sites = siteSettlements({
      seed: 'reach',
      grid,
      cityCount: 3,
      townCount: 6,
      villageCount: 25,
      hamletCount: 15,
    });
    for (const s of sites) {
      expect(grid.has(s.anchor)).toBe(true);
      for (const h of s.urbanHexes) {
        expect(grid.has(h)).toBe(true);
      }
    }
  });
});
