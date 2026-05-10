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
 *      level → coast/lake; low-and-wet flat ground → marsh; mid elevation +
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
import {
  type Climate,
  type HexDeposit,
  type HexTile,
  type Terrain,
} from '../sim/world/terrain.js';

export interface TerrainGenOpts {
  readonly seed: string;
  readonly widthHexes: number;
  readonly heightHexes: number;
  /** % of hexes that should be water (lake/coast). Default ~10. */
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

/** Pick terrain for a single tile, ignoring rivers/coast adjacency (handled later). */
const baseTerrain = (
  elev: number,
  moist: number,
  thresholds: Thresholds,
  climate: Climate,
): Terrain => {
  if (elev <= thresholds.oceanMax) {
    // Below sea level. Differentiate coastline vs. inland depression: we treat
    // the very lowest band as 'coast' (where the ocean meets land) — but
    // because we don't render an actual ocean tile type in v1, we mark these
    // as coast tiles so caravans treat them as the shore. Lakes are placed
    // on isolated low-elevation pockets in a later pass; for now everything
    // below sea level is coast.
    return 'coast';
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
  hasCoast: boolean;
  deposit: HexDeposit | undefined;
}

const traceRivers = (
  pre: PreTile[],
  W: number,
  H: number,
  fields: SampledFields,
  rng: Rng,
): void => {
  // Find the highest few mountain hexes; from each, walk downhill to a coast/
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
  const springCount = Math.max(1, Math.floor(candidates.length * 0.05));
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
      if (tile.terrain === 'coast' || tile.terrain === 'lake') break;
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

const markCoastAdjacency = (pre: PreTile[], W: number, H: number): void => {
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const i = r * W + q;
      const t = pre[i] as PreTile;
      if (t.terrain === 'coast') {
        t.hasCoast = true;
        continue;
      }
      // A non-coast tile sets hasCoast=true if any neighbour is coast.
      const cur = hex(q, r);
      for (const n of hexNeighbors(cur)) {
        if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
        const ni = n.r * W + n.q;
        if ((pre[ni] as PreTile).terrain === 'coast') {
          t.hasCoast = true;
          break;
        }
      }
    }
  }
};

/**
 * After the threshold pass, some "coast" tiles will be inland depressions
 * surrounded by land. Reclassify those as `lake`. We do a flood-fill from any
 * tile on the grid border that is coast: all reachable coast tiles are true
 * sea-coast; the rest are landlocked → lakes.
 */
const reclassifyInlandWater = (pre: PreTile[], W: number, H: number): void => {
  const visited = new Uint8Array(W * H);
  const queue: number[] = [];
  // Seed with border coast tiles.
  const seedIfCoast = (q: number, r: number): void => {
    const i = r * W + q;
    if ((pre[i] as PreTile).terrain === 'coast' && visited[i] === 0) {
      visited[i] = 1;
      queue.push(i);
    }
  };
  for (let q = 0; q < W; q++) {
    seedIfCoast(q, 0);
    seedIfCoast(q, H - 1);
  }
  for (let r = 0; r < H; r++) {
    seedIfCoast(0, r);
    seedIfCoast(W - 1, r);
  }
  while (queue.length > 0) {
    const i = queue.shift() as number;
    const r = Math.floor(i / W);
    const q = i - r * W;
    for (const n of hexNeighbors(hex(q, r))) {
      if (n.q < 0 || n.q >= W || n.r < 0 || n.r >= H) continue;
      const ni = n.r * W + n.q;
      if (visited[ni] !== 0) continue;
      if ((pre[ni] as PreTile).terrain !== 'coast') continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }
  for (let i = 0; i < W * H; i++) {
    if ((pre[i] as PreTile).terrain === 'coast' && visited[i] === 0) {
      (pre[i] as PreTile).terrain = 'lake';
    }
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
        // Map [0,1) noise → [-50, 3000] m. Below sea level → coast/lake later.
        elevation: Math.floor(-50 + e * 3050),
        moisture: m,
        hasRiver: false,
        hasCoast: false,
        deposit: undefined,
      };
    }
  }

  // Inland depressions become lakes; true sea-touching low ground stays coast.
  reclassifyInlandWater(pre, W, H);
  // Mark hasCoast on land tiles adjacent to sea.
  markCoastAdjacency(pre, W, H);
  // Trace rivers from mountain springs downhill.
  traceRivers(pre, W, H, fields, rng.derive('rivers'));
  // Place ore deposits on mountains/hills.
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
        hasCoast: p.hasCoast,
        road: 'none',
        ownerActor: null,
        ...(p.deposit !== undefined ? { deposit: p.deposit } : {}),
      };
      grid.set(hex(q, r), tile);
    }
  }
  return grid;
};
