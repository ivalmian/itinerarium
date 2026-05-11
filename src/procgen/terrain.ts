/**
 * Procedural terrain generation for the world hex grid.
 *
 * Reference: docs/07-geography.md ("Phase 1 — Procgen", steps 1–4).
 *
 * Pipeline:
 *   1. Three independent value-noise fields (elevation, moisture, ore) derived
 *      from the seed via `Rng.derive('label')` — each is a deterministic per-hex
 *      hash into [0,1), then box-blurred over a neighbourhood to produce
 *      smoothly varying scalars. We sum a few octaves at decreasing weight to
 *      get fractal detail without a third-party noise dependency.
 *   2. Calibrate elevation thresholds so the requested ocean/mountain coverage
 *      percentages are honoured: sort sampled elevations, pick the percentile
 *      cuts. This avoids "the noise happened to be flat this seed" surprises.
 *   3. Assign terrain by elevation band + moisture: low elevation under sea
 *      level → lake; low-and-wet flat ground → marsh; mid elevation +
 *      high moisture → forest (dense_forest at the wettest); mid + low
 *      moisture → desert (warm climates) or steppe (cool); etc.
 *   4. Trace rivers from a handful of mountain springs flowing downhill to
 *      the nearest sea/lake along the elevation gradient.
 *   5. Place ore deposits in mountain (or hill) clusters using the ore-noise
 *      field; pick a resource per cluster, give each hex a finite stockpile.
 *   6. Climate band by latitude (r) + alpine override at high elevation.
 *
 * Determinism: the only randomness source is the seeded `Rng`. Calling with
 * the same opts always yields the same grid.
 */

import { createRng, type Rng } from '../sim/rng.js';
import { resourceId, type ResourceId } from '../sim/types.js';
import { hex, hexNeighbors } from '../sim/world/hex.js';
import { createGrid, type HexGrid } from '../sim/world/grid.js';
import { type Climate, type HexDeposit, type HexTile, type Terrain } from '../sim/world/terrain.js';

export interface TerrainGenOpts {
  readonly seed: string;
  readonly widthHexes: number;
  readonly heightHexes: number;
  /** % of hexes that should be water (lake). Default ~10. */
  readonly oceanCoveragePct?: number;
  /** % of hexes that should be forest or dense_forest. Default ~25. */
  readonly forestCoveragePct?: number;
  /** % of hexes that should be mountain. Default ~10. */
  readonly mountainsCoveragePct?: number;
  /** % of hexes that should be marsh. Default ~5. */
  readonly marshCoveragePct?: number;
  /** Climate of the southernmost band (r ≈ 0). Default 'mediterranean'. */
  readonly southClimate?: Climate;
  /** Climate of the northernmost band (r ≈ height-1). Default 'continental'. */
  readonly northClimate?: Climate;
}

const ORE_RESOURCES: readonly ResourceId[] = [
  resourceId('mineral.iron_ore'),
  resourceId('mineral.copper_ore'),
  resourceId('mineral.tin_ore'),
  resourceId('mineral.lead_ore'),
  resourceId('mineral.silver_ore'),
  resourceId('mineral.gold_ore'),
  resourceId('mineral.salt'),
];

/**
 * 2D value noise built from a seeded RNG. Each integer lattice point gets a
 * stable [0,1) value via a tiny xorshift mix of (q, r, salt); we bilinear-
 * interpolate between lattice corners and sum a few octaves at decreasing
 * amplitude to get fractal detail. No external noise library.
 */
class ValueNoise {
  readonly #salt: number;
  readonly #freq: number;

  constructor(rng: Rng, freq: number) {
    // Convert RNG state to a 32-bit integer salt. We pull two ints to widen.
    const a = rng.int(0, 0xffff);
    const b = rng.int(0, 0xffff);
    this.#salt = (a * 0x10000 + b) | 0;
    this.#freq = freq;
  }

  /** Hash (q, r) → [0, 1). Stable for a given salt. */
  #lattice(q: number, r: number): number {
    let h = (q * 374761393) ^ (r * 668265263) ^ this.#salt;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 0x100000) / 0x100000;
  }

  /** Smoothstep-interpolated value at (x, y). */
  #sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const v00 = this.#lattice(x0, y0);
    const v10 = this.#lattice(x0 + 1, y0);
    const v01 = this.#lattice(x0, y0 + 1);
    const v11 = this.#lattice(x0 + 1, y0 + 1);
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  }

  /** Multi-octave fractal noise at (q, r) ∈ grid coords; returns [0, 1). */
  at(q: number, r: number): number {
    let amp = 1;
    let f = this.#freq;
    let total = 0;
    let norm = 0;
    for (let octave = 0; octave < 4; octave++) {
      total += amp * this.#sample(q * f, r * f);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return total / norm;
  }
}

const clampPct = (v: number, def: number): number => {
  if (!Number.isFinite(v)) return def;
  return Math.max(0, Math.min(100, v));
};

/** Pick the value at the given quantile of a sorted ascending array. */
const quantile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i] as number;
};

interface SampledFields {
  readonly elev: Float64Array;
  readonly moist: Float64Array;
  readonly ore: Float64Array;
}

const sampleFields = (rng: Rng, W: number, H: number): SampledFields => {
  // Lower frequency → larger continuous regions. We pick frequencies tuned to
  // the natural-feature extents in docs/07: forest patches of 20–200 hexes,
  // mountain ranges of 50–500. ~15 hex period for elevation primary octave.
  const elevNoise = new ValueNoise(rng.derive('elev'), 1 / 18);
  const moistNoise = new ValueNoise(rng.derive('moist'), 1 / 14);
  const oreNoise = new ValueNoise(rng.derive('ore'), 1 / 10);
  const elev = new Float64Array(W * H);
  const moist = new Float64Array(W * H);
  const ore = new Float64Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      elev[i] = elevNoise.at(q, r);
      moist[i] = moistNoise.at(q, r);
      ore[i] = oreNoise.at(q, r);
    }
  }
  return { elev, moist, ore };
};

interface Thresholds {
  readonly oceanMax: number;
  readonly mountainMin: number;
  readonly forestMin: number;
  readonly marshMax: number;
}

const computeThresholds = (
  fields: SampledFields,
  oceanPct: number,
  mountainPct: number,
  forestPct: number,
  marshPct: number,
): Thresholds => {
  const elevSorted = Array.from(fields.elev).sort((a, b) => a - b);
  const moistSorted = Array.from(fields.moist).sort((a, b) => a - b);
  const oceanMax = quantile(elevSorted, oceanPct / 100);
  const mountainMin = quantile(elevSorted, 1 - mountainPct / 100);
  // Forest is gated on moisture in the mid-elevation band. The forest target
  // refers to *grid coverage*, not "of the eligible band", so we set the
  // moisture threshold so that the top forest% of moisture wins, then any
  // eligible mid-elevation hexes above that take forest. We over-shoot
  // slightly to account for hexes lost to deserts in arid south.
  const forestMin = quantile(moistSorted, 1 - Math.min(95, forestPct * 1.4) / 100);
  const marshMax = quantile(elevSorted, oceanPct / 100 + marshPct / 100);
  return { oceanMax, mountainMin, forestMin, marshMax };
};

const climateAtLatitude = (
  rNorm: number, // 0..1 from south to north
  southClimate: Climate,
  northClimate: Climate,
): Climate => (rNorm < 0.5 ? southClimate : northClimate);

/** Pick terrain for a single tile, ignoring river adjacency (handled later). */
const baseTerrain = (
  elev: number,
  moist: number,
  thresholds: Thresholds,
  climate: Climate,
): Terrain => {
  if (elev <= thresholds.oceanMax) {
    // Below sea level / inland depression → lake. All sub-sea-level
    // tiles are inland water bodies (sea trade is deferred per
    // docs/10).
    return 'lake';
  }
  if (elev >= thresholds.mountainMin) return 'mountains';
  // Marsh: low-lying just above sea level, with high moisture.
  if (elev <= thresholds.marshMax && moist > 0.55) return 'marsh';
  // High elevation but below mountain: hills.
  const hillMin = thresholds.mountainMin - (thresholds.mountainMin - thresholds.oceanMax) * 0.25;
  if (elev >= hillMin) return 'hills';
  // Mid elevation: choose by moisture + climate.
  if (moist >= thresholds.forestMin) {
    // Wettest forests are dense.
    return moist > thresholds.forestMin + (1 - thresholds.forestMin) * 0.5
      ? 'dense_forest'
      : 'forest';
  }
  // Dry mid: arid/mediterranean → desert; cool → steppe; otherwise plains/fertile.
  if (moist < 0.3) {
    if (climate === 'arid' || climate === 'mediterranean') return 'desert';
    return 'steppe';
  }
  // Moderately wet flat ground: fertile_valley near the moisture threshold,
  // plains otherwise.
  return moist > 0.55 ? 'fertile_valley' : 'plains';
};

const climateForTile = (
  elev: number,
  thresholds: Thresholds,
  rNorm: number,
  southClimate: Climate,
  northClimate: Climate,
): Climate => {
  // Anything above (mountainMin + 10%) of the upper band is alpine.
  const alpineCut = thresholds.mountainMin + (1 - thresholds.mountainMin) * 0.1;
  if (elev >= alpineCut) return 'alpine';
  return climateAtLatitude(rNorm, southClimate, northClimate);
};

interface PreTile {
  terrain: Terrain;
  climate: Climate;
  elevation: number;
  moisture: number;
  hasRiver: boolean;
  deposit: HexDeposit | undefined;
}

const traceRivers = (
  pre: PreTile[],
  W: number,
  H: number,
  fields: SampledFields,
  rng: Rng,
): void => {
  // Find the highest few mountain hexes; from each, walk downhill to a
  // lake (or until stuck), marking each step as a river hex.
  const candidates: { idx: number; q: number; r: number; e: number }[] = [];
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      if ((pre[i] as PreTile).terrain === 'mountains') {
        candidates.push({ idx: i, q, r, e: fields.elev[i] as number });
      }
    }
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.e - a.e);
  // More springs → more rivers, more tributary opportunities. Roughly 15%
  // of mountain hexes spawn a spring; this gives several rivers per
  // continent worth of mountain rather than one trickle.
  const springCount = Math.max(2, Math.floor(candidates.length * 0.15));
  const springs = rng.shuffle(candidates.slice(0, Math.min(candidates.length, springCount * 3)));
  const taken = springs.slice(0, springCount);
  const visited = new Set<number>();
  for (const spring of taken) {
    let q = spring.q;
    let r = spring.r;
    let steps = 0;
    while (steps < W + H) {
      steps++;
      const i = r * W + q;
      if (visited.has(i)) break;
      visited.add(i);
      const tile = pre[i] as PreTile;
      if (tile.terrain === 'lake') break;
      // Mark as river (skip if it's the spring mountain itself; we want river
      // to start one step downhill so mountains stay mountains).
      if (tile.terrain !== 'mountains') {
        tile.terrain = 'river';
        tile.hasRiver = true;
      }
      // Step to lowest neighbour that exists in-bounds.
      const cur = hex(q, r);
      let bestE = fields.elev[i] as number;
      let bestQ = q;
      let bestR = r;
      for (const n of hexNeighbors(cur)) {
        if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
        const ni = n.r * W + n.q;
        const e = fields.elev[ni] as number;
        if (e < bestE) {
          bestE = e;
          bestQ = n.q;
          bestR = n.r;
        }
      }
      if (bestQ === q && bestR === r) break; // local minimum
      q = bestQ;
      r = bestR;
    }
  }
};

/**
 * Iterative cleanup that prevents river-cluster pathologies. Two
 * symmetric rules per the user's spec:
 *
 *   1. River hex: at most `maxWaterNeighbors` water neighbors total
 *      (rivers + lakes), AND at most `maxLakeNeighbors` of those may
 *      be lakes. So a river can touch up to 3 other rivers, OR up
 *      to 2 rivers + 1 lake (entering/exiting a single lake), but
 *      never two separate lakes.
 *   2. Lake hex: at most `maxRiverPerLake` river neighbors. Multiple
 *      rivers entering one lake from different sides collapse the
 *      excess river hexes into more lake (the lake's surface
 *      effectively grew to swallow them).
 *
 * Without rule 1, two converging spring-traced channels produce
 * visually-jarring "river lakes". Without rule 2, lakes sprout
 * implausibly many tributary outlets.
 *
 * Iterative: each pass fixes one violation level and re-runs until
 * stable (typically one or two iterations). Converted-to-lake hexes
 * count against subsequent neighbors' budgets and can cascade.
 */
const enforceWaterAdjacencyRules = (
  pre: PreTile[],
  W: number,
  H: number,
  maxWaterNeighbors: number,
  maxLakeNeighbors: number,
  maxRiverPerLake: number,
): void => {
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        const i = r * W + q;
        const tile = pre[i] as PreTile;
        if (tile.terrain !== 'river' && tile.terrain !== 'lake') continue;
        let riverN = 0;
        let lakeN = 0;
        for (const n of hexNeighbors(hex(q, r))) {
          if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
          const ni = n.r * W + n.q;
          const nt = (pre[ni] as PreTile).terrain;
          if (nt === 'river') riverN++;
          else if (nt === 'lake') lakeN++;
        }
        if (tile.terrain === 'river') {
          if (riverN + lakeN > maxWaterNeighbors || lakeN > maxLakeNeighbors) {
            // The basin IS a lake; spring tracing was too aggressive.
            tile.terrain = 'lake';
            tile.hasRiver = false;
            changed = true;
          }
        } else if (tile.terrain === 'lake') {
          if (riverN > maxRiverPerLake) {
            // Too many rivers feed/leave this lake. Demote one of the
            // excess river neighbors into more lake so the shoreline
            // keeps a single canonical outlet. Pick the river neighbor
            // with the most lake neighbors of its own (the one most
            // already part of the basin) to keep the demotion local.
            let bestNi = -1;
            let bestScore = -1;
            for (const n of hexNeighbors(hex(q, r))) {
              if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
              const ni = n.r * W + n.q;
              if ((pre[ni] as PreTile).terrain !== 'river') continue;
              let nLakeN = 0;
              for (const nn of hexNeighbors(n)) {
                if (nn.q < 0 || nn.q >= W || nn.r < 0 || nn.r >= H) continue;
                const nni = nn.r * W + nn.q;
                if ((pre[nni] as PreTile).terrain === 'lake') nLakeN++;
              }
              if (nLakeN > bestScore) {
                bestScore = nLakeN;
                bestNi = ni;
              }
            }
            if (bestNi >= 0) {
              const victim = pre[bestNi] as PreTile;
              victim.terrain = 'lake';
              victim.hasRiver = false;
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
};

/**
 * Forest cohesion smoothing (one majority-vote pass): a hex flips INTO
 * forest if ≥4 of its 6 neighbours are forest, and OUT of forest if ≤1
 * are. Removes single-hex forest specks in deserts and single-hex
 * desert/plains specks inside large forests. Per docs/07 §"Realism rules".
 */
const smoothForest = (pre: PreTile[], W: number, H: number): void => {
  const isForest = (t: Terrain): boolean => t === 'forest' || t === 'dense_forest';
  // Snapshot to read neighbour state without seeing in-pass changes.
  const snapshot: Terrain[] = pre.map((p) => p.terrain);
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      const cur = snapshot[i] as Terrain;
      // Don't mess with water, mountains, marsh — only flat-land flips.
      if (
        cur === 'lake' ||
        cur === 'river' ||
        cur === 'mountains' ||
        cur === 'marsh' ||
        cur === 'urban' ||
        cur === 'ruin'
      ) {
        continue;
      }
      let forestNeighbours = 0;
      let totalLandNeighbours = 0;
      for (const n of hexNeighbors(hex(q, r))) {
        if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
        const ni = n.r * W + n.q;
        const nt = snapshot[ni] as Terrain;
        if (nt === 'lake' || nt === 'river') continue;
        totalLandNeighbours++;
        if (isForest(nt)) forestNeighbours++;
      }
      if (totalLandNeighbours === 0) continue;
      if (isForest(cur)) {
        if (forestNeighbours <= 1) {
          // Eject — become whatever the majority is around (default plains).
          (pre[i] as PreTile).terrain = 'plains';
        }
      } else {
        if (forestNeighbours >= 4) {
          (pre[i] as PreTile).terrain = 'forest';
        }
      }
    }
  }
};

/**
 * Lake puddle cleanup (one pass): a `lake` hex with ≥5 land
 * neighbours and ≤1 lake neighbour flips to `plains` (no isolated
 * single-hex puddles in the middle of land). We don't run a
 * "thin peninsula → water" rule any more — peninsulas just stay
 * as whatever land they were (plains / hills / etc.). Sea trade is
 * deferred and there is no `coast` terrain.
 */
const smoothLakePuddles = (pre: PreTile[], W: number, H: number): void => {
  const snapshot: Terrain[] = pre.map((p) => p.terrain);
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      const cur = snapshot[i] as Terrain;
      if (cur !== 'lake') continue;
      let lakeNeighbours = 0;
      let totalNeighbours = 0;
      for (const n of hexNeighbors(hex(q, r))) {
        if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
        const ni = n.r * W + n.q;
        if ((snapshot[ni] as Terrain) === 'lake') lakeNeighbours++;
        totalNeighbours++;
      }
      if (totalNeighbours < 5) continue;
      if (lakeNeighbours <= 1) {
        (pre[i] as PreTile).terrain = 'plains';
      }
    }
  }
};

/**
 * Mark hexes adjacent to a river as `fertile_valley` if they were plains.
 * Rivers irrigate; fertile valleys cluster along them. Per docs/07 §"Plains–
 * fertile_valley distinction".
 */
const fertileValleyAlongRivers = (pre: PreTile[], W: number, H: number): void => {
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      const t = pre[i] as PreTile;
      if (t.terrain !== 'plains') continue;
      for (const n of hexNeighbors(hex(q, r))) {
        if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
        const ni = n.r * W + n.q;
        if ((pre[ni] as PreTile).terrain === 'river') {
          t.terrain = 'fertile_valley';
          break;
        }
      }
    }
  }
};

const placeDeposits = (pre: PreTile[], W: number, H: number, fields: SampledFields): void => {
  // For each mountain/hill hex with high ore-noise (top quartile of ore field
  // among eligible hexes), assign a deposit. Resource is determined by the
  // ore-noise *value* hashed into the resource list, so spatially nearby
  // high-noise pockets pick the same resource — producing 1–10 hex clusters.
  const eligible: number[] = [];
  for (let i = 0; i < W * H; i++) {
    const t = (pre[i] as PreTile).terrain;
    if (t === 'mountains' || t === 'hills') eligible.push(i);
  }
  if (eligible.length === 0) return;
  const sortedOre = eligible.map((i) => fields.ore[i] as number).sort((a, b) => a - b);
  const cutoff = quantile(sortedOre, 0.75);
  for (const i of eligible) {
    const oreVal = fields.ore[i] as number;
    if (oreVal < cutoff) continue;
    // Resource selection: bucket by oreVal so spatially correlated noise picks
    // the same resource for adjacent hexes (this is what makes them cluster
    // by *ore type* per the spec).
    const bucket = Math.floor(oreVal * ORE_RESOURCES.length * 7) % ORE_RESOURCES.length;
    const resource = ORE_RESOURCES[bucket] as ResourceId;
    // Remaining: 200 + up to 800 units, scaled by oreVal; deeper deposits last
    // longer. Numbers are coarse; balance pass tunes them.
    const remaining = Math.floor(200 + oreVal * 800);
    (pre[i] as PreTile).deposit = { resource, remaining };
  }
};

export const generateTerrain = (opts: TerrainGenOpts): HexGrid => {
  const W = Math.max(1, Math.floor(opts.widthHexes));
  const H = Math.max(1, Math.floor(opts.heightHexes));
  const oceanPct = clampPct(opts.oceanCoveragePct ?? 10, 10);
  const forestPct = clampPct(opts.forestCoveragePct ?? 25, 25);
  const mountainPct = clampPct(opts.mountainsCoveragePct ?? 10, 10);
  const marshPct = clampPct(opts.marshCoveragePct ?? 5, 5);
  const southClimate: Climate = opts.southClimate ?? 'mediterranean';
  const northClimate: Climate = opts.northClimate ?? 'continental';

  const rng = createRng(opts.seed);
  const fields = sampleFields(rng.derive('fields'), W, H);
  const thresholds = computeThresholds(fields, oceanPct, mountainPct, forestPct, marshPct);

  // First pass: per-tile assignment.
  const pre: PreTile[] = new Array<PreTile>(W * H);
  for (let r = 0; r < H; r++) {
    const rNorm = H > 1 ? r / (H - 1) : 0;
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      const e = fields.elev[i] as number;
      const m = fields.moist[i] as number;
      const climate = climateForTile(e, thresholds, rNorm, southClimate, northClimate);
      const terrain = baseTerrain(e, m, thresholds, climate);
      pre[i] = {
        terrain,
        climate,
        // Map [0,1) noise → [-50, 3000] m. Below sea level → lake later.
        elevation: Math.floor(-50 + e * 3050),
        moisture: m,
        hasRiver: false,
        deposit: undefined,
      };
    }
  }

  // Realism passes (per docs/07 §"Realism rules"):
  //   1. Forest cohesion smoothing — kills isolated forest specks and fills
  //      tiny clearings inside large forests.
  //   2. Lake puddle cleanup — fills tiny single-hex puddles in land.
  //   3. River tracing from multiple springs (tributaries).
  //   4. Water adjacency enforcement — collapses river-lakes + caps
  //      lake outflows.
  //   5. Fertile valleys along rivers.
  //   6. Ore deposits.
  smoothForest(pre, W, H);
  smoothLakePuddles(pre, W, H);
  traceRivers(pre, W, H, fields, rng.derive('rivers'));
  enforceWaterAdjacencyRules(pre, W, H, 3, 1, 1);
  fertileValleyAlongRivers(pre, W, H);
  placeDeposits(pre, W, H, fields);

  // Materialize into a HexGrid.
  const grid = createGrid();
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      const p = pre[i] as PreTile;
      const tile: HexTile = {
        terrain: p.terrain,
        climate: p.climate,
        elevation: p.elevation,
        hasRiver: p.hasRiver,
        road: 'none',
        ownerActor: null,
        ...(p.deposit !== undefined ? { deposit: p.deposit } : {}),
      };
      grid.set(hex(q, r), tile);
    }
  }
  return grid;
};
