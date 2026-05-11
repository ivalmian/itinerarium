import { describe, expect, it } from 'vitest';
import { hex, hexKey, hexNeighbors } from '../sim/world/hex.js';
import type { HexTile, Terrain } from '../sim/world/terrain.js';
import { generateTerrain } from './terrain.js';

const collectTerrains = (tiles: Iterable<readonly [unknown, HexTile]>): Map<Terrain, number> => {
  const counts = new Map<Terrain, number>();
  for (const [, tile] of tiles) {
    counts.set(tile.terrain, (counts.get(tile.terrain) ?? 0) + 1);
  }
  return counts;
};

const fractionOf = (counts: Map<Terrain, number>, t: Terrain, total: number): number =>
  (counts.get(t) ?? 0) / total;

describe('generateTerrain — determinism', () => {
  it('same seed + opts → identical grid', () => {
    const a = generateTerrain({ seed: 'alpha', widthHexes: 40, heightHexes: 40 });
    const b = generateTerrain({ seed: 'alpha', widthHexes: 40, heightHexes: 40 });
    const aTiles = Array.from(a.tiles()).sort(([h1], [h2]) => hexKey(h1).localeCompare(hexKey(h2)));
    const bTiles = Array.from(b.tiles()).sort(([h1], [h2]) => hexKey(h1).localeCompare(hexKey(h2)));
    expect(aTiles.length).toBe(bTiles.length);
    for (let i = 0; i < aTiles.length; i++) {
      const [aHex, aTile] = aTiles[i] as readonly [unknown, HexTile];
      const [bHex, bTile] = bTiles[i] as readonly [unknown, HexTile];
      expect(hexKey(aHex as { q: number; r: number })).toBe(
        hexKey(bHex as { q: number; r: number }),
      );
      expect(aTile.terrain).toBe(bTile.terrain);
      expect(aTile.climate).toBe(bTile.climate);
      expect(aTile.elevation).toBe(bTile.elevation);
      expect(aTile.hasRiver).toBe(bTile.hasRiver);
      expect(aTile.deposit?.resource).toBe(bTile.deposit?.resource);
      expect(aTile.deposit?.remaining).toBe(bTile.deposit?.remaining);
    }
  });

  it('different seeds → different grids', () => {
    const a = generateTerrain({ seed: 'alpha', widthHexes: 40, heightHexes: 40 });
    const b = generateTerrain({ seed: 'beta', widthHexes: 40, heightHexes: 40 });
    let differences = 0;
    for (const [h, ta] of a.tiles()) {
      const tb = b.get(h);
      if (tb === undefined || tb.terrain !== ta.terrain) differences++;
    }
    expect(differences).toBeGreaterThan(0);
  });
});

describe('generateTerrain — basic shape', () => {
  it('fills exactly width × height hexes', () => {
    const g = generateTerrain({ seed: 's', widthHexes: 30, heightHexes: 25 });
    expect(g.size()).toBe(30 * 25);
  });

  it('every tile has a terrain, climate, elevation, and ownerActor=null', () => {
    const g = generateTerrain({ seed: 's', widthHexes: 20, heightHexes: 20 });
    for (const [, tile] of g.tiles()) {
      expect(typeof tile.terrain).toBe('string');
      expect(typeof tile.climate).toBe('string');
      expect(Number.isFinite(tile.elevation)).toBe(true);
      expect(tile.ownerActor).toBeNull();
      expect(tile.road).toBe('none');
    }
  });

  it('lays out tiles on contiguous axial coordinates from (0,0)', () => {
    const W = 12;
    const H = 8;
    const g = generateTerrain({ seed: 's', widthHexes: W, heightHexes: H });
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        expect(g.has(hex(q, r))).toBe(true);
      }
    }
  });
});

describe('generateTerrain — coverage targets', () => {
  it('forest coverage is within ±5% of target on a 100×100 grid', () => {
    const W = 100;
    const H = 100;
    const target = 25;
    const g = generateTerrain({
      seed: 'forest-coverage',
      widthHexes: W,
      heightHexes: H,
      forestCoveragePct: target,
    });
    const counts = collectTerrains(g.tiles());
    const total = W * H;
    const forestFrac =
      fractionOf(counts, 'forest', total) + fractionOf(counts, 'dense_forest', total);
    expect(forestFrac).toBeGreaterThanOrEqual(target / 100 - 0.05);
    expect(forestFrac).toBeLessThanOrEqual(target / 100 + 0.05);
  });

  it('mountains coverage is within ±5% of target', () => {
    const W = 100;
    const H = 100;
    const target = 15;
    const g = generateTerrain({
      seed: 'mountain-coverage',
      widthHexes: W,
      heightHexes: H,
      mountainsCoveragePct: target,
    });
    const counts = collectTerrains(g.tiles());
    const total = W * H;
    const mtnFrac = fractionOf(counts, 'mountains', total);
    expect(mtnFrac).toBeGreaterThanOrEqual(target / 100 - 0.05);
    expect(mtnFrac).toBeLessThanOrEqual(target / 100 + 0.05);
  });

  it('produces a non-trivial mix of terrain types', () => {
    const g = generateTerrain({ seed: 'mix', widthHexes: 60, heightHexes: 60 });
    const counts = collectTerrains(g.tiles());
    // At least 5 distinct terrains in any reasonable map.
    expect(counts.size).toBeGreaterThanOrEqual(5);
  });
});

describe('generateTerrain — clustering', () => {
  it('forests form contiguous patches (avg cluster size > 5 on a 100×100 grid)', () => {
    const W = 100;
    const H = 100;
    const g = generateTerrain({
      seed: 'forest-clustering',
      widthHexes: W,
      heightHexes: H,
      forestCoveragePct: 25,
    });
    const isForest = (h: { q: number; r: number }): boolean => {
      const t = g.get(h);
      return t !== undefined && (t.terrain === 'forest' || t.terrain === 'dense_forest');
    };
    const visited = new Set<string>();
    const clusterSizes: number[] = [];
    for (const [h] of g.tiles()) {
      const key = hexKey(h);
      if (visited.has(key) || !isForest(h)) continue;
      // BFS over forest hexes.
      let size = 0;
      const queue: { q: number; r: number }[] = [h];
      visited.add(key);
      while (queue.length > 0) {
        const cur = queue.shift() as { q: number; r: number };
        size++;
        for (const n of hexNeighbors(cur)) {
          const nk = hexKey(n);
          if (visited.has(nk)) continue;
          if (!isForest(n)) continue;
          visited.add(nk);
          queue.push(n);
        }
      }
      clusterSizes.push(size);
    }
    expect(clusterSizes.length).toBeGreaterThan(0);
    const avg = clusterSizes.reduce((a, b) => a + b, 0) / clusterSizes.length;
    expect(avg).toBeGreaterThan(5);
  });

  it('mountains form ranges — most mountain hexes have at least one mountain neighbour', () => {
    const W = 100;
    const H = 100;
    const g = generateTerrain({
      seed: 'mountain-range',
      widthHexes: W,
      heightHexes: H,
      mountainsCoveragePct: 15,
    });
    let mountainCount = 0;
    let isolated = 0;
    for (const [h, t] of g.tiles()) {
      if (t.terrain !== 'mountains') continue;
      mountainCount++;
      const hasMountainNeighbour = hexNeighbors(h).some((n) => g.get(n)?.terrain === 'mountains');
      if (!hasMountainNeighbour) isolated++;
    }
    expect(mountainCount).toBeGreaterThan(0);
    // No more than 10% of mountain hexes should be isolated.
    expect(isolated / mountainCount).toBeLessThan(0.1);
  });
});

describe('generateTerrain — climate gradient', () => {
  it('southern band tilts toward the south climate, northern toward the north', () => {
    const W = 80;
    const H = 80;
    const g = generateTerrain({
      seed: 'climate',
      widthHexes: W,
      heightHexes: H,
      southClimate: 'mediterranean',
      northClimate: 'continental',
      // Suppress alpine peaks for this test by lowering mountains.
      mountainsCoveragePct: 5,
    });
    let southMed = 0;
    let southCont = 0;
    let northMed = 0;
    let northCont = 0;
    for (const [h, t] of g.tiles()) {
      // We treat r=0 as "south" and r=H-1 as "north".
      if (h.r < H * 0.2) {
        if (t.climate === 'mediterranean') southMed++;
        if (t.climate === 'continental') southCont++;
      } else if (h.r > H * 0.8) {
        if (t.climate === 'mediterranean') northMed++;
        if (t.climate === 'continental') northCont++;
      }
    }
    expect(southMed).toBeGreaterThan(southCont);
    expect(northCont).toBeGreaterThan(northMed);
  });

  it('alpine climate appears at high elevations (mountains)', () => {
    const g = generateTerrain({
      seed: 'alpine',
      widthHexes: 80,
      heightHexes: 80,
      mountainsCoveragePct: 20,
    });
    let mountainsAlpine = 0;
    let mountainsTotal = 0;
    for (const [, t] of g.tiles()) {
      if (t.terrain === 'mountains') {
        mountainsTotal++;
        if (t.climate === 'alpine') mountainsAlpine++;
      }
    }
    expect(mountainsTotal).toBeGreaterThan(0);
    // A meaningful fraction of mountain hexes should be alpine.
    expect(mountainsAlpine / mountainsTotal).toBeGreaterThan(0.2);
  });
});

describe('generateTerrain — water features', () => {
  it('river hexes set hasRiver=true', () => {
    const g = generateTerrain({ seed: 'rivers', widthHexes: 60, heightHexes: 60 });
    let riverHexes = 0;
    for (const [, t] of g.tiles()) {
      if (t.terrain === 'river') {
        expect(t.hasRiver).toBe(true);
        riverHexes++;
      }
    }
    // We expect at least some rivers to have been placed.
    expect(riverHexes).toBeGreaterThan(0);
  });
});

describe('generateTerrain — deposits', () => {
  it('places ore deposits only on mountains/hills', () => {
    const g = generateTerrain({
      seed: 'deposits',
      widthHexes: 60,
      heightHexes: 60,
      mountainsCoveragePct: 15,
    });
    let depositCount = 0;
    for (const [, t] of g.tiles()) {
      if (t.deposit !== undefined) {
        depositCount++;
        expect(['mountains', 'hills']).toContain(t.terrain);
        expect(t.deposit.remaining).toBeGreaterThan(0);
      }
    }
    expect(depositCount).toBeGreaterThan(0);
  });

  it('ore deposits cluster (a deposit hex has at least one same-resource neighbour or is in a small mountain cluster)', () => {
    const g = generateTerrain({
      seed: 'deposit-cluster',
      widthHexes: 80,
      heightHexes: 80,
      mountainsCoveragePct: 15,
    });
    // Group deposit hexes by resource and check that for each resource, most
    // deposit hexes have at least one same-resource neighbour (i.e. clusters
    // of size >= 2 dominate).
    const byResource = new Map<string, { q: number; r: number }[]>();
    for (const [h, t] of g.tiles()) {
      if (t.deposit !== undefined) {
        const arr = byResource.get(t.deposit.resource) ?? [];
        arr.push(h);
        byResource.set(t.deposit.resource, arr);
      }
    }
    expect(byResource.size).toBeGreaterThan(0);
    let clustered = 0;
    let total = 0;
    for (const [resource, hexes] of byResource) {
      const set = new Set(hexes.map((h) => hexKey(h)));
      for (const h of hexes) {
        total++;
        const hasSameNeighbour = hexNeighbors(h).some((n) => {
          const nk = hexKey(n);
          if (!set.has(nk)) return false;
          return g.get(n)?.deposit?.resource === resource;
        });
        if (hasSameNeighbour) clustered++;
      }
    }
    // At least half of all deposits should be in a cluster of size >= 2.
    expect(clustered / total).toBeGreaterThanOrEqual(0.5);
  });
});

describe('generateTerrain — performance smoke', () => {
  it('100×100 generation completes in under 2 seconds', () => {
    const start = Date.now();
    const g = generateTerrain({ seed: 'perf', widthHexes: 100, heightHexes: 100 });
    const elapsedMs = Date.now() - start;
    expect(g.size()).toBe(100 * 100);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
