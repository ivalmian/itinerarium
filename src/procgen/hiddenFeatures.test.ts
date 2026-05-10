import { describe, expect, it } from 'vitest';
import { hex, hexDistance, hexKey } from '../sim/world/hex.js';
import type { HexGrid } from '../sim/world/grid.js';
import type { HexTile } from '../sim/world/terrain.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements, type SettlementSite } from './settlements.js';
import {
  applyHiddenFeaturesToGrid,
  placeHiddenFeatures,
  type HiddenFeature,
  type HiddenFeatureKind,
} from './hiddenFeatures.js';

const makeGrid = (seed: string, w = 80, h = 80): HexGrid =>
  generateTerrain({
    seed,
    widthHexes: w,
    heightHexes: h,
    mountainsCoveragePct: 12,
    oceanCoveragePct: 5,
  });

const collectExclusions = (
  sites: readonly SettlementSite[],
  grid: HexGrid,
  catchmentRadius: number,
): { urban: Set<string>; catchment: Set<string> } => {
  const urban = new Set<string>();
  const catchment = new Set<string>();
  for (const s of sites) {
    for (const h of s.urbanHexes) urban.add(hexKey(h));
    for (const [h] of grid.withinRange(s.anchor, catchmentRadius)) {
      catchment.add(hexKey(h));
    }
  }
  return { urban, catchment };
};

const featuresKey = (features: readonly HiddenFeature[]): string =>
  features
    .map((f) => `${f.kind}:${hexKey(f.hex)}`)
    .sort()
    .join(';');

describe('placeHiddenFeatures — determinism', () => {
  it('same seed + grid + exclusions → identical features', () => {
    const grid = makeGrid('det', 60, 60);
    const sites = siteSettlements({
      seed: 'sites',
      grid,
      cityCount: 3,
      townCount: 6,
      villageCount: 25,
      hamletCount: 15,
    });
    const ex = collectExclusions(sites, grid, 2);
    const a = placeHiddenFeatures({
      seed: 'feat',
      grid,
      settlementUrbanHexes: ex.urban,
      settlementCatchmentHexes: ex.catchment,
      count: 20,
    });
    const b = placeHiddenFeatures({
      seed: 'feat',
      grid,
      settlementUrbanHexes: ex.urban,
      settlementCatchmentHexes: ex.catchment,
      count: 20,
    });
    expect(featuresKey(a)).toBe(featuresKey(b));
  });

  it('different seeds → different feature layouts', () => {
    const grid = makeGrid('det', 60, 60);
    const ex = { urban: new Set<string>(), catchment: new Set<string>() };
    const a = placeHiddenFeatures({
      seed: 'feat-a',
      grid,
      settlementUrbanHexes: ex.urban,
      settlementCatchmentHexes: ex.catchment,
      count: 20,
    });
    const b = placeHiddenFeatures({
      seed: 'feat-b',
      grid,
      settlementUrbanHexes: ex.urban,
      settlementCatchmentHexes: ex.catchment,
      count: 20,
    });
    expect(featuresKey(a)).not.toBe(featuresKey(b));
  });
});

describe('placeHiddenFeatures — counts', () => {
  it('produces exactly the requested count when wilderness is plentiful', () => {
    const grid = makeGrid('count', 80, 80);
    const features = placeHiddenFeatures({
      seed: 'cnt',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 25,
    });
    expect(features.length).toBe(25);
  });

  it('default count is 20 when not specified', () => {
    const grid = makeGrid('default-count', 80, 80);
    const features = placeHiddenFeatures({
      seed: 'def',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
    });
    expect(features.length).toBe(20);
  });

  it('caps at available wilderness if asked for more than the grid offers', () => {
    // Tiny grid, almost everything excluded.
    const grid = makeGrid('tiny', 20, 20);
    const allHexes = new Set<string>();
    for (const h of grid.hexes()) allHexes.add(hexKey(h));
    // Mark most hexes as urban, leaving < 20 wilderness.
    let excluded = 0;
    const urban = new Set<string>();
    for (const k of allHexes) {
      if (excluded > 380) break;
      urban.add(k);
      excluded++;
    }
    const features = placeHiddenFeatures({
      seed: 's',
      grid,
      settlementUrbanHexes: urban,
      settlementCatchmentHexes: new Set(),
      count: 50,
    });
    expect(features.length).toBeLessThan(50);
  });
});

describe('placeHiddenFeatures — exclusions', () => {
  it('never places a feature on an urban or catchment hex', () => {
    const grid = makeGrid('excl', 60, 60);
    const sites = siteSettlements({
      seed: 'sites',
      grid,
      cityCount: 3,
      townCount: 6,
      villageCount: 25,
      hamletCount: 15,
    });
    const ex = collectExclusions(sites, grid, 3);
    const features = placeHiddenFeatures({
      seed: 'f',
      grid,
      settlementUrbanHexes: ex.urban,
      settlementCatchmentHexes: ex.catchment,
      count: 20,
    });
    for (const f of features) {
      const k = hexKey(f.hex);
      expect(ex.urban.has(k)).toBe(false);
      expect(ex.catchment.has(k)).toBe(false);
    }
  });

  it('never places a feature on impassable water (lake)', () => {
    const grid = makeGrid('water', 60, 60);
    const features = placeHiddenFeatures({
      seed: 'f',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 25,
    });
    for (const f of features) {
      const tile = grid.get(f.hex);
      expect(tile?.terrain).not.toBe('lake');
    }
  });

  it('does not place two features on the same hex', () => {
    const grid = makeGrid('uniq', 60, 60);
    const features = placeHiddenFeatures({
      seed: 'f',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 30,
    });
    const seen = new Set<string>();
    for (const f of features) {
      const k = hexKey(f.hex);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

describe('placeHiddenFeatures — terrain biases', () => {
  it('abandoned_mine: at least 80% on mountains/hills', () => {
    const grid = makeGrid('mine', 80, 80);
    // Force only mines via weights.
    const features = placeHiddenFeatures({
      seed: 'm',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 20,
      weights: { abandoned_mine: 1 },
    });
    expect(features.length).toBeGreaterThan(0);
    let onMountainOrHill = 0;
    for (const f of features) {
      expect(f.kind).toBe('abandoned_mine');
      const tile = grid.get(f.hex);
      if (tile?.terrain === 'mountains' || tile?.terrain === 'hills') onMountainOrHill++;
    }
    expect(onMountainOrHill / features.length).toBeGreaterThanOrEqual(0.8);
  });

  it('hermit_shrine: prefers remote terrain (mountain/dense_forest/desert)', () => {
    const grid = makeGrid('shrine', 80, 80);
    const features = placeHiddenFeatures({
      seed: 'h',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 15,
      weights: { hermit_shrine: 1 },
    });
    let remote = 0;
    for (const f of features) {
      const tile = grid.get(f.hex);
      if (
        tile?.terrain === 'mountains' ||
        tile?.terrain === 'dense_forest' ||
        tile?.terrain === 'desert'
      ) {
        remote++;
      }
    }
    expect(remote / features.length).toBeGreaterThanOrEqual(0.6);
  });

  it('abandoned_village: prefers fertile/plains terrain', () => {
    const grid = makeGrid('av', 80, 80);
    const features = placeHiddenFeatures({
      seed: 'av',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 15,
      weights: { abandoned_village: 1 },
    });
    let habitable = 0;
    for (const f of features) {
      const tile = grid.get(f.hex);
      if (tile?.terrain === 'plains' || tile?.terrain === 'fertile_valley') habitable++;
    }
    expect(habitable / features.length).toBeGreaterThanOrEqual(0.6);
  });
});

describe('placeHiddenFeatures — bandit_hideout near roads', () => {
  it('places bandit_hideout within ~3 hexes of a road when one exists', () => {
    const grid = makeGrid('roads', 60, 60);
    // Manually paint a couple of dirt roads through the middle so the
    // generator has a road network to bias toward.
    for (let q = 5; q < 55; q++) {
      const tile = grid.get(hex(q, 30));
      if (tile !== undefined) tile.road = 'dirt';
    }
    const features = placeHiddenFeatures({
      seed: 'b',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 12,
      weights: { bandit_hideout: 1 },
    });
    expect(features.length).toBeGreaterThan(0);
    let nearRoad = 0;
    for (const f of features) {
      let minDist = Infinity;
      for (const [h, t] of grid.tiles()) {
        if (t.road === 'none') continue;
        const d = hexDistance(f.hex, h);
        if (d < minDist) minDist = d;
        if (minDist <= 3) break;
      }
      if (minDist <= 3) nearRoad++;
    }
    expect(nearRoad / features.length).toBeGreaterThanOrEqual(0.7);
  });

  it('falls back gracefully when no road exists in the grid', () => {
    const grid = makeGrid('noroad', 40, 40);
    // Don't paint roads — every tile remains road='none'.
    const features = placeHiddenFeatures({
      seed: 'b2',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 5,
      weights: { bandit_hideout: 1 },
    });
    // Should still place the requested number; just won't be near a road.
    expect(features.length).toBe(5);
  });
});

describe('placeHiddenFeatures — payload shapes', () => {
  it('abandoned_mine payload has resource + remainingOre', () => {
    const grid = makeGrid('payload-mine', 60, 60);
    const features = placeHiddenFeatures({
      seed: 'pm',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 5,
      weights: { abandoned_mine: 1 },
    });
    for (const f of features) {
      expect(f.kind).toBe('abandoned_mine');
      // Discriminated union narrowing.
      if (f.kind === 'abandoned_mine') {
        expect(typeof f.payload.resource).toBe('string');
        expect(f.payload.remainingOre).toBeGreaterThan(0);
      }
    }
  });

  it('ruin payload has stockpile (Map) + coinHoard', () => {
    const grid = makeGrid('payload-ruin', 60, 60);
    const features = placeHiddenFeatures({
      seed: 'pr',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 5,
      weights: { ruin: 1 },
    });
    for (const f of features) {
      if (f.kind === 'ruin') {
        expect(f.payload.stockpile).toBeInstanceOf(Map);
        expect(f.payload.coinHoard).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('bandit_hideout payload has initialBanditCount + hiddenStockpile', () => {
    const grid = makeGrid('payload-bandit', 60, 60);
    const features = placeHiddenFeatures({
      seed: 'pb',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 5,
      weights: { bandit_hideout: 1 },
    });
    for (const f of features) {
      if (f.kind === 'bandit_hideout') {
        expect(f.payload.initialBanditCount).toBeGreaterThan(0);
        expect(f.payload.hiddenStockpile).toBeInstanceOf(Map);
      }
    }
  });

  it('lost_route payload has from + to hex coordinates that differ', () => {
    const grid = makeGrid('payload-route', 60, 60);
    const features = placeHiddenFeatures({
      seed: 'plr',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 5,
      weights: { lost_route: 1 },
    });
    for (const f of features) {
      if (f.kind === 'lost_route') {
        expect(typeof f.payload.from.q).toBe('number');
        expect(typeof f.payload.to.q).toBe('number');
        const same = f.payload.from.q === f.payload.to.q && f.payload.from.r === f.payload.to.r;
        expect(same).toBe(false);
      }
    }
  });
});

describe('placeHiddenFeatures — distribution', () => {
  it('spreads features across the map (no extreme clumping)', () => {
    const grid = makeGrid('spread', 80, 80);
    const features = placeHiddenFeatures({
      seed: 'sp',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 25,
    });
    // Pairwise minimum distance: at least 70% of features should be ≥ 3 hexes
    // from their nearest neighbour. (Allows occasional pairs but rejects bulk
    // clumping.)
    let isolated = 0;
    for (const f of features) {
      let minDist = Infinity;
      for (const g of features) {
        if (f === g) continue;
        const d = hexDistance(f.hex, g.hex);
        if (d < minDist) minDist = d;
      }
      if (minDist >= 3) isolated++;
    }
    expect(isolated / features.length).toBeGreaterThanOrEqual(0.7);
  });
});

describe('applyHiddenFeaturesToGrid', () => {
  it('writes hiddenFeature kind and hiddenFeatureDiscovered=false to each tile', () => {
    const grid = makeGrid('apply', 40, 40);
    const features = placeHiddenFeatures({
      seed: 'a',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 10,
    });
    const result = applyHiddenFeaturesToGrid(features, grid);
    for (const f of features) {
      const tile = result.get(f.hex);
      expect(tile?.hiddenFeature).toBe(f.kind);
      expect(tile?.hiddenFeatureDiscovered).toBe(false);
    }
  });

  it('does not disturb other tile fields (terrain, climate, road, deposit)', () => {
    const grid = makeGrid('preserve', 40, 40);
    // Snapshot baseline before applying.
    const before = new Map<string, HexTile>();
    for (const [h, t] of grid.tiles()) {
      before.set(hexKey(h), { ...t });
    }
    const features = placeHiddenFeatures({
      seed: 'pres',
      grid,
      settlementUrbanHexes: new Set(),
      settlementCatchmentHexes: new Set(),
      count: 8,
    });
    const result = applyHiddenFeaturesToGrid(features, grid);
    const featureKeys = new Set(features.map((f) => hexKey(f.hex)));
    for (const [h, t] of result.tiles()) {
      const k = hexKey(h);
      const orig = before.get(k);
      expect(orig).toBeDefined();
      if (orig === undefined) continue;
      expect(t.terrain).toBe(orig.terrain);
      expect(t.climate).toBe(orig.climate);
      expect(t.elevation).toBe(orig.elevation);
      expect(t.road).toBe(orig.road);
      expect(t.deposit?.resource).toBe(orig.deposit?.resource);
      // Only feature hexes should differ in hiddenFeature.
      if (!featureKeys.has(k)) {
        expect(t.hiddenFeature).toBe(orig.hiddenFeature);
      }
    }
  });
});

// Reference an unused-imported type so eslint is happy on harness-style files.
const _kindsExist: readonly HiddenFeatureKind[] = [
  'abandoned_mine',
  'ruin',
  'abandoned_village',
  'hermit_shrine',
  'lost_route',
  'bandit_hideout',
];
void _kindsExist;
