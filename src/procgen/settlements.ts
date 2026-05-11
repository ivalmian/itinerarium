/**
 * Settlement siting on a generated terrain grid.
 *
 * Reference: docs/07-geography.md ("Phase 1 — Procgen", steps 4–7)
 * and docs/05-settlements.md (settlement extents and population tiers).
 *
 * Pipeline:
 *   1. Score every grid hex for "city-suitability" using static features:
 *      water access, fertile catchment, defensible terrain, and a base
 *      tile multiplier (mountains/lakes/marsh are non-starters).
 *   2. Greedy-pick the top scoring hexes for cities, enforcing a minimum
 *      spacing of `clusterRadius` hexes so cities don't crowd. The
 *      highest-scoring city becomes the capital.
 *   3. For each city, allocate 2..N urban hexes contiguously around the
 *      anchor based on its estimated population.
 *   4. Site towns at lower-threshold suitable hexes; bias toward
 *      between-city positions so towns sit on the road network.
 *   5. Site villages clustered around cities (within clusterRadius),
 *      preferring fertile hexes.
 *   6. Site hamlets in remaining suitable hexes; some land in wilderness
 *      (frontier hamlets) per docs/07.
 *
 * Determinism: every random pick flows through `Rng.derive('label')` so
 * the same (seed, grid) → same layout. The grid itself is read-only here.
 *
 * Roads, ownership, and population stratification are out-of-scope and
 * left for follow-up tasks.
 */

import { createRng, type Rng } from '../sim/rng.js';
import type { HexGrid } from '../sim/world/grid.js';
import { hexDistance, hexKey, hexNeighbors, type Hex } from '../sim/world/hex.js';
import type { Terrain } from '../sim/world/terrain.js';

export type SettlementKind = 'capital' | 'city' | 'town' | 'village' | 'hamlet';

export interface SettlementSite {
  readonly kind: SettlementKind;
  readonly anchor: Hex;
  readonly urbanHexes: readonly Hex[];
  readonly estimatedPopulation: number;
}

export interface SettlementSiteOpts {
  readonly seed: string;
  readonly grid: HexGrid;
  readonly cityCount: number;
  readonly townCount: number;
  readonly villageCount: number;
  readonly hamletCount: number;
  /** Hex radius around each city within which villages cluster. Default 30. */
  readonly clusterRadiusHexes?: number;
}

/**
 * v1.5 §C9 disaggregation factors. The v1 procgen treated each requested
 * "village" entity as 2-5 real-world villages and each "hamlet" as 2-3 real
 * hamlets. Per docs/04 §"Sizing the realistic hinterland" we never aggregate;
 * each real village/hamlet is its own entity. We multiply the *requested*
 * counts by these factors so existing callers (burn-in, debug scripts)
 * continue to express "world scale" in v1 units while procgen emits the
 * realistic entity count internally.
 */
const VILLAGE_DISAGG_FACTOR = 3;
const HAMLET_DISAGG_FACTOR = 5;
/**
 * Maximum hamlets that can share an urban hex with a village (the Roman
 * *pagus* pattern: one larger village + up to 4-5 satellite hamlets on the
 * same fertile patch). Per docs/05 §"Same-hex coexistence".
 */
const MAX_SAMEHEX_HAMLETS = 5;

const isWaterTile = (t: Terrain): boolean => t === 'lake' || t === 'river';

/**
 * Tiles a settlement absolutely cannot anchor on. Mountains/dense_forest are
 * too rugged; marsh is unhealthy and waterlogged; lakes occupy the whole
 * hex (no land to build on).
 *
 * Per the user's model: rivers are SMALLER than the 1 km hex, so a
 * river hex still has plenty of riverbank land — settlements CAN
 * anchor on river hexes (cities on rivers are the norm). Passage
 * across is slow but possible.
 */
const isUninhabitable = (t: Terrain): boolean => {
  switch (t) {
    case 'mountains':
    case 'lake':
    case 'marsh':
    case 'dense_forest':
      return true;
    default:
      return false;
  }
};

/**
 * Score a single hex for "how good a city site is this?" The scoring is
 * additive over: base terrain quality, fertile catchment in radius 3,
 * water access (river/lake neighbour), and defensibility (hill or
 * river fork). Returns 0 for uninhabitable tiles so the caller can skip
 * them via a single threshold check.
 */
const scoreCitySite = (h: Hex, grid: HexGrid): number => {
  const tile = grid.get(h);
  if (tile === undefined) return 0;
  if (isUninhabitable(tile.terrain)) return 0;

  const baseByTerrain: Record<Terrain, number> = {
    fertile_valley: 5,
    plains: 4,
    hills: 3,
    forest: 2,
    steppe: 2,
    river: 4,
    desert: 1,
    urban: 0,
    ruin: 0.5,
    mountains: 0,
    dense_forest: 0,
    marsh: 0,
    lake: 0,
  };
  let score = baseByTerrain[tile.terrain];

  // Catchment fertility: count fertile_valley/plains in radius 3.
  let fertile = 0;
  for (const [, t] of grid.withinRange(h, 3)) {
    if (t.terrain === 'fertile_valley') fertile += 2;
    else if (t.terrain === 'plains') fertile += 1;
  }
  score += fertile * 0.2;

  // Water access: any river/lake neighbour, or hasRiver on this tile.
  const hasWaterAdjacent =
    tile.hasRiver || grid.neighborsOf(h).some(([, t]) => isWaterTile(t.terrain) || t.hasRiver);
  if (hasWaterAdjacent) score += 3;

  // Defensibility: a hill anchor or surrounded by river/mountain on at least
  // two sides is harder to assault. Cheap proxy.
  const defensiveNeighbours = grid
    .neighborsOf(h)
    .filter(([, t]) => t.terrain === 'mountains' || t.terrain === 'hills' || t.hasRiver).length;
  if (tile.terrain === 'hills') score += 2;
  if (defensiveNeighbours >= 2) score += 1;

  // Transport: at least 3 passable land neighbours. Penalize if hemmed in.
  const passableNeighbours = grid
    .neighborsOf(h)
    .filter(([, t]) => !isUninhabitable(t.terrain) && t.terrain !== 'urban').length;
  if (passableNeighbours < 3) score *= 0.5;

  return score;
};

/** Lower-threshold scoring for towns/villages/hamlets. Same shape, gentler weights. */
const scoreSecondarySite = (h: Hex, grid: HexGrid): number => {
  const tile = grid.get(h);
  if (tile === undefined) return 0;
  if (isUninhabitable(tile.terrain)) return 0;
  const baseByTerrain: Record<Terrain, number> = {
    fertile_valley: 4,
    plains: 3,
    hills: 2,
    forest: 1.5,
    steppe: 1,
    river: 3,
    desert: 0.5,
    urban: 0,
    ruin: 0.5,
    mountains: 0,
    dense_forest: 0,
    marsh: 0,
    lake: 0,
  };
  let score = baseByTerrain[tile.terrain];
  const hasWater =
    tile.hasRiver || grid.neighborsOf(h).some(([, t]) => isWaterTile(t.terrain));
  if (hasWater) score += 1;
  return score;
};

/**
 * Population tier brackets. Each kind corresponds to the docs/05 tiers
 * (Hamlet 30–150, Village 150–800, Town 1k–5k, City 5k–15k, Large city
 * 15k–50k). City vs. capital is the same population tier; capital is just
 * the highest-scoring city plus a +50% population bias.
 */
const PopulationByKind = {
  hamlet: { min: 30, max: 150 },
  village: { min: 150, max: 800 },
  town: { min: 1000, max: 5000 },
  city: { min: 5000, max: 15000 },
  capital: { min: 15000, max: 50000 },
} as const;

const pickPopulation = (rng: Rng, kind: SettlementKind): number => {
  const { min, max } = PopulationByKind[kind];
  return rng.int(min, max);
};

/**
 * Decide how many urban hexes a city of the given population covers. Per
 * docs/05: small city (5k–15k) → 2–3 hexes; large city (15k+) → 3–10 hexes.
 * Towns are 1–2 hexes; villages and hamlets are always 1.
 */
const urbanHexCount = (kind: SettlementKind, population: number): number => {
  switch (kind) {
    case 'hamlet':
    case 'village':
      return 1;
    case 'town':
      return population >= 3000 ? 2 : 1;
    case 'city':
      // 5k → 2 hexes, 15k → 3 hexes (linear interp).
      return Math.max(2, Math.min(3, Math.round(2 + (population - 5000) / 10000)));
    case 'capital':
      // 15k → 3 hexes, 50k → 10 hexes.
      return Math.max(3, Math.min(10, Math.round(3 + ((population - 15000) / 35000) * 7)));
  }
};

/**
 * Allocate `count` contiguous urban hexes for a city anchored at `anchor`.
 * Greedy: BFS outward from anchor; at each step, claim the highest-scoring
 * inhabitable neighbour that hasn't been claimed by another settlement and
 * isn't already in this city's urban set.
 */
const allocateUrbanHexes = (
  anchor: Hex,
  count: number,
  grid: HexGrid,
  used: Set<string>,
): Hex[] => {
  const out: Hex[] = [anchor];
  used.add(hexKey(anchor));
  if (count <= 1) return out;
  const frontier: Hex[] = [anchor];
  while (out.length < count && frontier.length > 0) {
    // Find best neighbour across all current urban hexes.
    let bestScore = -Infinity;
    let bestHex: Hex | undefined;
    for (const u of out) {
      for (const n of hexNeighbors(u)) {
        const k = hexKey(n);
        if (used.has(k)) continue;
        const tile = grid.get(n);
        if (tile === undefined) continue;
        if (isUninhabitable(tile.terrain)) continue;
        const s = scoreSecondarySite(n, grid);
        if (s > bestScore) {
          bestScore = s;
          bestHex = n;
        }
      }
    }
    if (bestHex === undefined) break;
    out.push(bestHex);
    used.add(hexKey(bestHex));
    frontier.push(bestHex);
  }
  return out;
};

/**
 * Greedy pick `count` candidates from `pool` (sorted descending by score)
 * such that every pick is ≥ `minSpacing` hexes from previously chosen picks
 * and from any hex in `forbidden`.
 */
const pickSpaced = (
  pool: readonly { hex: Hex; score: number }[],
  count: number,
  minSpacing: number,
  forbidden: readonly Hex[],
  used: ReadonlySet<string>,
): Hex[] => {
  const picked: Hex[] = [];
  for (const candidate of pool) {
    if (picked.length >= count) break;
    if (used.has(hexKey(candidate.hex))) continue;
    let ok = true;
    for (const p of picked) {
      if (hexDistance(candidate.hex, p) < minSpacing) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const f of forbidden) {
      if (hexDistance(candidate.hex, f) < minSpacing) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    picked.push(candidate.hex);
  }
  return picked;
};

const allHexes = (grid: HexGrid): Hex[] => {
  const out: Hex[] = [];
  for (const h of grid.hexes()) out.push(h);
  return out;
};

export const siteSettlements = (opts: SettlementSiteOpts): readonly SettlementSite[] => {
  const grid = opts.grid;
  const clusterRadius = Math.max(1, Math.floor(opts.clusterRadiusHexes ?? 30));
  const rng = createRng(opts.seed);

  if (
    opts.cityCount <= 0 &&
    opts.townCount <= 0 &&
    opts.villageCount <= 0 &&
    opts.hamletCount <= 0
  ) {
    return [];
  }

  const hexes = allHexes(grid);
  if (hexes.length === 0) return [];

  // Used hex set (anchors and urban hexes) to prevent overlap for the larger
  // tiers (cities, towns, villages). Hamlets are allowed to share a hex per
  // docs/05 §"Same-hex coexistence" and tracked separately via `hamletShare`.
  const used = new Set<string>();
  // Counts how many hamlets currently sit on each hex. A hex with a village
  // (or city/town) on it can host up to MAX_SAMEHEX_HAMLETS hamlets; an
  // empty hex can also host that many hamlets clustered together.
  const hamletShare = new Map<string, number>();
  const sites: SettlementSite[] = [];

  // Apply v1.5 §C9 disaggregation factors so caller-requested counts
  // (which historically were "aggregated entities") translate to one
  // entity per real village + one per real hamlet.
  const targetVillages = Math.max(0, Math.floor(opts.villageCount * VILLAGE_DISAGG_FACTOR));
  const targetHamlets = Math.max(0, Math.floor(opts.hamletCount * HAMLET_DISAGG_FACTOR));

  // ----- Cities -----
  const cityScores = hexes
    .map((h) => ({ hex: h, score: scoreCitySite(h, grid) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const cityAnchors = pickSpaced(
    cityScores,
    Math.max(0, Math.floor(opts.cityCount)),
    clusterRadius,
    [],
    used,
  );

  // The first picked (highest-scoring) is the capital.
  const cityRng = rng.derive('cities');
  for (let i = 0; i < cityAnchors.length; i++) {
    const anchor = cityAnchors[i] as Hex;
    const isCapital = i === 0;
    const kind: SettlementKind = isCapital ? 'capital' : 'city';
    const pop = pickPopulation(cityRng.derive(`pop-${i}`), kind);
    const urbanCount = urbanHexCount(kind, pop);
    const urban = allocateUrbanHexes(anchor, urbanCount, grid, used);
    sites.push({ kind, anchor, urbanHexes: urban, estimatedPopulation: pop });
  }

  // ----- Towns -----
  // Towns prefer secondary spots either inside clusters (along the road) or
  // between clusters (frontier-towns). We just take the next-best scored
  // hexes outside the city footprint, with min spacing of clusterRadius / 3.
  const townSpacing = Math.max(2, Math.floor(clusterRadius / 3));
  const townScores = hexes
    .map((h) => ({ hex: h, score: scoreSecondarySite(h, grid) }))
    .filter((c) => c.score > 0 && !used.has(hexKey(c.hex)))
    .sort((a, b) => b.score - a.score);
  const townAnchors = pickSpaced(
    townScores,
    Math.max(0, Math.floor(opts.townCount)),
    townSpacing,
    cityAnchors,
    used,
  );
  const townRng = rng.derive('towns');
  for (let i = 0; i < townAnchors.length; i++) {
    const anchor = townAnchors[i] as Hex;
    const pop = pickPopulation(townRng.derive(`pop-${i}`), 'town');
    const urbanCount = urbanHexCount('town', pop);
    const urban = allocateUrbanHexes(anchor, urbanCount, grid, used);
    sites.push({
      kind: 'town',
      anchor,
      urbanHexes: urban,
      estimatedPopulation: pop,
    });
  }

  // ----- Villages -----
  // Villages are clustered: for each city, gather candidate hexes within
  // clusterRadius, score them, and pick a target slice. We round-robin across
  // cities so cluster sizes stay balanced. Per v1.5 §C9 we lift the village
  // density (no more 2-5 real-villages-per-entity collapsing); we also relax
  // the inter-village spacing so the realistic count fits in the cluster.
  const villageSpacing = 2;
  const villageRng = rng.derive('villages');
  const cityCount = cityAnchors.length;
  if (targetVillages > 0 && cityCount > 0) {
    const perCity = Math.ceil(targetVillages / cityCount);
    // Pre-score each cluster.
    const clusterCandidates: { hex: Hex; score: number }[][] = cityAnchors.map((anchor) => {
      const cands: { hex: Hex; score: number }[] = [];
      for (const [h, t] of grid.withinRange(anchor, clusterRadius)) {
        if (used.has(hexKey(h))) continue;
        if (isUninhabitable(t.terrain)) continue;
        const s = scoreSecondarySite(h, grid);
        if (s > 0) cands.push({ hex: h, score: s });
      }
      cands.sort((a, b) => b.score - a.score);
      return cands;
    });
    let placed = 0;
    let pass = 0;
    while (placed < targetVillages && pass < perCity) {
      let progress = false;
      for (let c = 0; c < cityCount && placed < targetVillages; c++) {
        const list = clusterCandidates[c];
        if (list === undefined) continue;
        // Find the next candidate that respects min-spacing from other anchors.
        while (list.length > 0) {
          const next = list.shift() as { hex: Hex; score: number };
          if (used.has(hexKey(next.hex))) continue;
          // Min-spacing check against all settlement anchors so far.
          let okSpacing = true;
          for (const s of sites) {
            // Only enforce spacing against villages/hamlets/towns; city anchors
            // are typically far away by the time we reach this point.
            if (s.kind === 'capital' || s.kind === 'city') {
              if (hexDistance(next.hex, s.anchor) < 2) {
                okSpacing = false;
                break;
              }
              continue;
            }
            // Hamlets are allowed to coexist with villages on the same hex per
            // docs/05; spacing checks only apply to other villages/towns.
            if (s.kind === 'hamlet') continue;
            if (hexDistance(next.hex, s.anchor) < villageSpacing) {
              okSpacing = false;
              break;
            }
          }
          if (!okSpacing) continue;
          const pop = pickPopulation(villageRng.derive(`pop-${placed}`), 'village');
          used.add(hexKey(next.hex));
          sites.push({
            kind: 'village',
            anchor: next.hex,
            urbanHexes: [next.hex],
            estimatedPopulation: pop,
          });
          placed++;
          progress = true;
          break;
        }
      }
      if (!progress) break;
      pass++;
    }
  }

  // ----- Hamlets -----
  // Hamlets fill the remaining suitable hexes. Per docs/05 §"Same-hex
  // coexistence" they may share a hex with a village (the Roman *pagus*
  // pattern: one larger village + up to ~4 satellite hamlets) or sit on an
  // empty fertile patch. Most cluster around cities (ride the road network
  // for trade); a minority land in wilderness as frontier hamlets per
  // docs/07. Scoring biases for: nearby city, on-or-adjacent-to a village.
  const hamletRng = rng.derive('hamlets');
  if (targetHamlets > 0) {
    // Index existing village hexes for the *pagus* bonus.
    const villageHexKeys = new Set<string>();
    const villageNeighbors = new Set<string>();
    for (const s of sites) {
      if (s.kind !== 'village') continue;
      villageHexKeys.add(hexKey(s.anchor));
      for (const n of hexNeighbors(s.anchor)) villageNeighbors.add(hexKey(n));
    }
    const hamletScores = hexes
      .map((h) => {
        const base = scoreSecondarySite(h, grid);
        if (base <= 0) return { hex: h, score: 0 };
        let score = base;
        // City-distance bonus.
        if (cityAnchors.length > 0) {
          const d = Math.min(...cityAnchors.map((c) => hexDistance(h, c)));
          const bonus =
            d <= clusterRadius ? 3 : Math.max(0, 3 * (1 - (d - clusterRadius) / clusterRadius));
          score += bonus;
        }
        const k = hexKey(h);
        // Pagus bonus: same hex as a village is the strongest preference,
        // adjacent hex is second-strongest. Without this hamlets disperse
        // across all suitable terrain instead of clustering around villages.
        if (villageHexKeys.has(k)) score += 5;
        else if (villageNeighbors.has(k)) score += 2;
        return { hex: h, score };
      })
      // Don't filter by `used` — we want to consider hexes already occupied
      // by a village (same-hex hamlet) and apply the same-hex limit below.
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    let placed = 0;
    for (const cand of hamletScores) {
      if (placed >= targetHamlets) break;
      const k = hexKey(cand.hex);
      // Same-hex coexistence: a hex can host at most one village + up to
      // MAX_SAMEHEX_HAMLETS hamlets. We allow stacking on village hexes
      // (or empty hexes) but not on city/town/capital urban hexes — those
      // are the dense built-up cores and don't host satellite hamlets.
      const occupants = sites.filter((s) =>
        s.urbanHexes.some((u) => hexKey(u) === k),
      );
      const blocked = occupants.some(
        (s) => s.kind === 'capital' || s.kind === 'city' || s.kind === 'town',
      );
      if (blocked) continue;
      const existingHamlets = hamletShare.get(k) ?? 0;
      if (existingHamlets >= MAX_SAMEHEX_HAMLETS) continue;
      // Spacing against city/town anchors only — same-hex hamlets next to
      // a village are explicitly allowed; hamlets near other hamlets are
      // also fine because they're often dependent on the same fertile patch.
      let okSpacing = true;
      for (const s of sites) {
        if (s.kind !== 'capital' && s.kind !== 'city' && s.kind !== 'town') continue;
        if (hexDistance(cand.hex, s.anchor) < 2) {
          okSpacing = false;
          break;
        }
      }
      if (!okSpacing) continue;
      const pop = pickPopulation(hamletRng.derive(`pop-${placed}`), 'hamlet');
      hamletShare.set(k, existingHamlets + 1);
      // Don't mark `used` for hamlets — additional hamlets / a village could
      // still share this hex (though village placement runs *before* this
      // pass, so in practice village-hex hamlets land on already-used hexes).
      sites.push({
        kind: 'hamlet',
        anchor: cand.hex,
        urbanHexes: [cand.hex],
        estimatedPopulation: pop,
      });
      placed++;
    }
  }

  return sites;
};
