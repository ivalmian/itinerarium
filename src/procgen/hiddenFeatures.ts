/**
 * Hidden wilderness features placement during procgen.
 *
 * Reference: docs/07-geography.md ("Hidden features for exploration (locked)").
 * Wilderness exists to be travelled and explored, not just crossed. v1
 * places ~10–30 of these per map; each is "discovered" later when a
 * caravan enters the hex (a runtime event, not procgen).
 *
 * Six kinds, each with a terrain bias and a kind-specific payload:
 *   - abandoned_mine    → mountain/hills; reactivatable, has leftover ore
 *   - ruin              → plains/hills; lore + small stockpile + coin hoard
 *   - abandoned_village → fertile valley/plains; resettleable site
 *   - hermit_shrine     → mountain/dense_forest/desert; small bonus
 *   - lost_route        → forest/hills/mountains; new road segment shortcut
 *   - bandit_hideout    → forest/dense_forest/hills NEAR a road; combat encounter
 *
 * Placement algorithm:
 *   1. Decide a count per kind from the weight mix (default uniform).
 *   2. For each kind, score every wilderness hex (excluding urban + catchment)
 *      against the kind's terrain bias; high score = good fit.
 *   3. Greedy-pick the top scoring hexes, enforcing a min-spread distance
 *      so features don't clump.
 *   4. bandit_hideout has a special bonus for "within 3 hexes of a road but
 *      not on a road" — this falls out of the scoring function when roads
 *      exist.
 *
 * Determinism: all randomness threads through `Rng.derive('label')` so
 * (seed, grid, exclusions) → same features.
 */

import { createRng, type Rng } from '../sim/rng.js';
import { resourceId, type Coin, type Quantity, type ResourceId } from '../sim/types.js';
import { hex, hexDistance, hexKey, hexNeighbors, type Hex } from '../sim/world/hex.js';
import { gridFromMap, type HexGrid } from '../sim/world/grid.js';
import type { HexTile, Terrain } from '../sim/world/terrain.js';

export type HiddenFeatureKind =
  | 'abandoned_mine'
  | 'ruin'
  | 'abandoned_village'
  | 'hermit_shrine'
  | 'lost_route'
  | 'bandit_hideout';

export type SettlementTier = 'hamlet' | 'village' | 'town';

export interface AbandonedMinePayload {
  readonly resource: ResourceId;
  readonly remainingOre: Quantity;
}

export interface RuinPayload {
  readonly stockpile: ReadonlyMap<ResourceId, Quantity>;
  readonly coinHoard: Coin;
  readonly loreId?: string;
}

export interface AbandonedVillagePayload {
  readonly suggestedTier: SettlementTier;
}

export interface HermitShrinePayload {
  readonly bonus: 'happiness' | 'information';
}

export interface LostRoutePayload {
  readonly from: Hex;
  readonly to: Hex;
}

export interface BanditHideoutPayload {
  readonly initialBanditCount: number;
  readonly hiddenStockpile: ReadonlyMap<ResourceId, Quantity>;
}

export type HiddenFeature =
  | { readonly kind: 'abandoned_mine'; readonly hex: Hex; readonly payload: AbandonedMinePayload }
  | { readonly kind: 'ruin'; readonly hex: Hex; readonly payload: RuinPayload }
  | {
      readonly kind: 'abandoned_village';
      readonly hex: Hex;
      readonly payload: AbandonedVillagePayload;
    }
  | { readonly kind: 'hermit_shrine'; readonly hex: Hex; readonly payload: HermitShrinePayload }
  | { readonly kind: 'lost_route'; readonly hex: Hex; readonly payload: LostRoutePayload }
  | { readonly kind: 'bandit_hideout'; readonly hex: Hex; readonly payload: BanditHideoutPayload };

export interface HiddenFeatureGenOpts {
  readonly seed: string;
  readonly grid: HexGrid;
  readonly settlementUrbanHexes: ReadonlySet<string>;
  readonly settlementCatchmentHexes: ReadonlySet<string>;
  /** Default 20; sane range 10–30 per docs/07. */
  readonly count?: number;
  /** Optional weight mix; missing kinds default to weight 1. */
  readonly weights?: Partial<Record<HiddenFeatureKind, number>>;
}

const ALL_KINDS: readonly HiddenFeatureKind[] = [
  'abandoned_mine',
  'ruin',
  'abandoned_village',
  'hermit_shrine',
  'lost_route',
  'bandit_hideout',
];

const ORE_RESOURCES: readonly ResourceId[] = [
  resourceId('mineral.iron_ore'),
  resourceId('mineral.copper_ore'),
  resourceId('mineral.tin_ore'),
  resourceId('mineral.lead_ore'),
  resourceId('mineral.silver_ore'),
  resourceId('mineral.gold_ore'),
  resourceId('mineral.salt'),
];

/** Tiles where no hidden feature ever sits (water, urban-already-marked). */
const isImpassableForFeature = (t: Terrain): boolean => t === 'lake' || t === 'urban';

/**
 * Per-kind terrain affinity in [0, 1]. 0 = forbidden; 1 = ideal. Anything
 * positive is allowed but unlikely if other candidates score higher.
 */
const terrainAffinity = (kind: HiddenFeatureKind, t: Terrain): number => {
  switch (kind) {
    case 'abandoned_mine':
      if (t === 'mountains') return 1;
      if (t === 'hills') return 0.7;
      return 0;
    case 'ruin':
      if (t === 'plains') return 1;
      if (t === 'hills') return 0.8;
      if (t === 'fertile_valley') return 0.6;
      if (t === 'forest') return 0.4;
      if (t === 'steppe') return 0.4;
      if (t === 'desert') return 0.3;
      return 0.1;
    case 'abandoned_village':
      if (t === 'fertile_valley') return 1;
      if (t === 'plains') return 0.9;
      if (t === 'hills') return 0.4;
      if (t === 'forest') return 0.3;
      if (t === 'steppe') return 0.3;
      return 0;
    case 'hermit_shrine':
      if (t === 'mountains') return 1;
      if (t === 'dense_forest') return 0.9;
      if (t === 'desert') return 0.8;
      if (t === 'hills') return 0.4;
      if (t === 'forest') return 0.3;
      return 0.1;
    case 'lost_route':
      if (t === 'forest') return 1;
      if (t === 'hills') return 0.9;
      if (t === 'mountains') return 0.7;
      if (t === 'dense_forest') return 0.8;
      return 0.2;
    case 'bandit_hideout':
      if (t === 'forest') return 1;
      if (t === 'dense_forest') return 0.9;
      if (t === 'hills') return 0.7;
      return 0.2;
  }
};

/**
 * Distribute `count` features across kinds proportional to their weights.
 * Uses largest-remainder to avoid rounding-loss on small totals.
 *
 * If the caller passed an explicit `weights` object, missing kinds default
 * to 0 (you said you only want mines, you get only mines). If no weights
 * are given at all, every kind defaults to 1 (uniform mix).
 */
const allocateCounts = (
  count: number,
  weights: Partial<Record<HiddenFeatureKind, number>> | undefined,
): Map<HiddenFeatureKind, number> => {
  const explicit = weights !== undefined;
  const fallback = explicit ? 0 : 1;
  const w = weights ?? {};
  const effective: Record<HiddenFeatureKind, number> = {
    abandoned_mine: w.abandoned_mine ?? fallback,
    ruin: w.ruin ?? fallback,
    abandoned_village: w.abandoned_village ?? fallback,
    hermit_shrine: w.hermit_shrine ?? fallback,
    lost_route: w.lost_route ?? fallback,
    bandit_hideout: w.bandit_hideout ?? fallback,
  };
  const total = ALL_KINDS.reduce((s, k) => s + effective[k], 0);
  if (total <= 0) {
    // Defensive — caller passed all-zero weights. Spread uniformly.
    const each = Math.floor(count / ALL_KINDS.length);
    const out = new Map<HiddenFeatureKind, number>();
    for (const k of ALL_KINDS) out.set(k, each);
    return out;
  }
  const raw = ALL_KINDS.map((k) => ({ kind: k, share: (effective[k] / total) * count }));
  const intCounts = raw.map((r) => ({
    kind: r.kind,
    n: Math.floor(r.share),
    frac: r.share - Math.floor(r.share),
  }));
  let assigned = intCounts.reduce((s, r) => s + r.n, 0);
  // Distribute remaining count by largest-remainder.
  intCounts.sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (assigned < count) {
    const target = intCounts[i % intCounts.length];
    if (target === undefined) break;
    target.n += 1;
    assigned++;
    i++;
  }
  const out = new Map<HiddenFeatureKind, number>();
  for (const r of intCounts) out.set(r.kind, r.n);
  return out;
};

interface CandidateHex {
  readonly hex: Hex;
  score: number;
}

const MIN_SPREAD = 3;

/**
 * Find hexes adjacent to (but not on) a road. Used to give bandit_hideouts
 * a "near-road" bonus. If the grid has no roads at all, returns null and
 * the caller falls back to plain terrain scoring.
 */
const computeRoadProximity = (grid: HexGrid): Map<string, number> | null => {
  const roads: Hex[] = [];
  for (const [h, t] of grid.tiles()) {
    if (t.road !== 'none') roads.push(h);
  }
  if (roads.length === 0) return null;
  // BFS expansion up to radius 6 from each road hex; min distance per hex.
  const dist = new Map<string, number>();
  const queue: { h: Hex; d: number }[] = [];
  for (const h of roads) {
    const k = hexKey(h);
    dist.set(k, 0);
    queue.push({ h, d: 0 });
  }
  while (queue.length > 0) {
    const cur = queue.shift() as { h: Hex; d: number };
    if (cur.d >= 6) continue;
    for (const n of hexNeighbors(cur.h)) {
      const nk = hexKey(n);
      if (!grid.has(n)) continue;
      const existing = dist.get(nk);
      const newD = cur.d + 1;
      if (existing === undefined || newD < existing) {
        dist.set(nk, newD);
        queue.push({ h: n, d: newD });
      }
    }
  }
  return dist;
};

/**
 * Build candidate scores for a single feature kind. Combines terrain
 * affinity, kind-specific bonuses (e.g. road proximity for bandits), and a
 * deterministic per-hex jitter so equally good hexes spread across the map.
 */
const scoreCandidates = (
  kind: HiddenFeatureKind,
  grid: HexGrid,
  excluded: ReadonlySet<string>,
  rng: Rng,
  roadDist: ReadonlyMap<string, number> | null,
): CandidateHex[] => {
  const out: CandidateHex[] = [];
  for (const [h, tile] of grid.tiles()) {
    const k = hexKey(h);
    if (excluded.has(k)) continue;
    if (isImpassableForFeature(tile.terrain)) continue;
    const aff = terrainAffinity(kind, tile.terrain);
    if (aff <= 0) continue;
    // Square the affinity so ideal hexes (1.0) dominate marginal ones
    // (0.3 → 0.09). Otherwise low-affinity terrain wins by sheer count.
    let score = aff * aff;
    if (kind === 'bandit_hideout' && roadDist !== null) {
      const d = roadDist.get(k);
      if (d === undefined) {
        // Far from any road → unattractive for a bandit hideout.
        score *= 0.05;
      } else if (d === 0) {
        // On a road — exposed; bandits don't camp on the highway.
        score *= 0.2;
      } else if (d <= 3) {
        // Sweet spot — strong bonus.
        score *= 4;
      } else {
        score *= 0.4;
      }
    }
    // Deterministic jitter per (kind, hex) — breaks ties without seed-dependence
    // beyond what's already in `rng`. Tiny relative to squared affinity.
    const jitter = rng.float(0, 0.0001);
    out.push({ hex: h, score: score + jitter });
  }
  return out;
};

/** Greedy pick `n` candidates respecting min-spread distance from earlier picks. */
const greedyPick = (
  candidates: CandidateHex[],
  n: number,
  used: Set<string>,
  minSpread: number,
): Hex[] => {
  candidates.sort((a, b) => b.score - a.score);
  const picked: Hex[] = [];
  for (const c of candidates) {
    if (picked.length >= n) break;
    const k = hexKey(c.hex);
    if (used.has(k)) continue;
    let okSpread = true;
    for (const p of picked) {
      if (hexDistance(c.hex, p) < minSpread) {
        okSpread = false;
        break;
      }
    }
    if (!okSpread) continue;
    picked.push(c.hex);
    used.add(k);
  }
  // If we couldn't fill via spread, relax it for any remaining.
  if (picked.length < n) {
    for (const c of candidates) {
      if (picked.length >= n) break;
      const k = hexKey(c.hex);
      if (used.has(k)) continue;
      picked.push(c.hex);
      used.add(k);
    }
  }
  return picked;
};

const buildPayload = (
  kind: HiddenFeatureKind,
  h: Hex,
  grid: HexGrid,
  rng: Rng,
): HiddenFeature['payload'] => {
  switch (kind) {
    case 'abandoned_mine': {
      // Resource: prefer the ore deposit on the same hex if any; else random.
      const tile = grid.get(h);
      const resource = tile?.deposit?.resource ?? (rng.pick(ORE_RESOURCES) as ResourceId);
      const remainingOre = rng.int(80, 400);
      return { resource, remainingOre } satisfies AbandonedMinePayload;
    }
    case 'ruin': {
      const stockpile = new Map<ResourceId, Quantity>();
      // 1–3 small piles of random resources from the stash list.
      const stashable: ResourceId[] = [
        resourceId('material.cloth'),
        resourceId('mineral.salt'),
        resourceId('material.timber'),
      ];
      const piles = rng.int(0, 3);
      for (let i = 0; i < piles; i++) {
        const r = rng.pick(stashable) as ResourceId;
        stockpile.set(r, (stockpile.get(r) ?? 0) + rng.int(2, 12));
      }
      return {
        stockpile,
        coinHoard: rng.int(0, 50),
        loreId: `lore.ruin.${rng.int(1, 16)}`,
      } satisfies RuinPayload;
    }
    case 'abandoned_village': {
      // Suggested tier biased to hamlet/village; large abandoned settlements
      // are rare. We never suggest "town" unless lots of fertile catchment.
      const fertileNearby = grid
        .withinRange(h, 2)
        .filter(([, t]) => t.terrain === 'fertile_valley' || t.terrain === 'plains').length;
      let suggestedTier: SettlementTier = 'hamlet';
      if (fertileNearby >= 5) suggestedTier = 'village';
      if (fertileNearby >= 10 && rng.chance(0.3)) suggestedTier = 'town';
      return { suggestedTier } satisfies AbandonedVillagePayload;
    }
    case 'hermit_shrine': {
      // 70% happiness, 30% information shrines.
      const bonus: 'happiness' | 'information' = rng.chance(0.7) ? 'happiness' : 'information';
      return { bonus } satisfies HermitShrinePayload;
    }
    case 'lost_route': {
      // Pick a destination 3–8 hexes away in a random direction.
      const distance = rng.int(3, 8);
      const angle = rng.int(0, 5);
      let to = h;
      for (let i = 0; i < distance; i++) {
        const neighbours = hexNeighbors(to);
        const next = neighbours[(angle + i) % 6];
        if (next === undefined) break;
        to = next;
      }
      // Ensure to differs from from.
      if (to.q === h.q && to.r === h.r) {
        const fallback = hexNeighbors(h)[0];
        if (fallback !== undefined) to = fallback;
      }
      return { from: h, to } satisfies LostRoutePayload;
    }
    case 'bandit_hideout': {
      const initialBanditCount = rng.int(4, 14);
      const hiddenStockpile = new Map<ResourceId, Quantity>();
      // Bandit stockpile: stolen wine, weapons proxy (iron), coin (handled by
      // separate coin field elsewhere).
      const stealable: ResourceId[] = [
        resourceId('food.wine'),
        resourceId('mineral.iron_ore'),
        resourceId('material.cloth'),
      ];
      const piles = rng.int(1, 3);
      for (let i = 0; i < piles; i++) {
        const r = rng.pick(stealable) as ResourceId;
        hiddenStockpile.set(r, (hiddenStockpile.get(r) ?? 0) + rng.int(3, 20));
      }
      return { initialBanditCount, hiddenStockpile } satisfies BanditHideoutPayload;
    }
  }
};

const buildFeature = (kind: HiddenFeatureKind, h: Hex, grid: HexGrid, rng: Rng): HiddenFeature => {
  const payload = buildPayload(kind, h, grid, rng);
  switch (kind) {
    case 'abandoned_mine':
      return { kind, hex: h, payload: payload as AbandonedMinePayload };
    case 'ruin':
      return { kind, hex: h, payload: payload as RuinPayload };
    case 'abandoned_village':
      return { kind, hex: h, payload: payload as AbandonedVillagePayload };
    case 'hermit_shrine':
      return { kind, hex: h, payload: payload as HermitShrinePayload };
    case 'lost_route':
      return { kind, hex: h, payload: payload as LostRoutePayload };
    case 'bandit_hideout':
      return { kind, hex: h, payload: payload as BanditHideoutPayload };
  }
};

export const placeHiddenFeatures = (opts: HiddenFeatureGenOpts): readonly HiddenFeature[] => {
  const count = Math.max(0, Math.floor(opts.count ?? 20));
  if (count === 0) return [];
  const rng = createRng(opts.seed);
  const allocations = allocateCounts(count, opts.weights);
  const roadDist = computeRoadProximity(opts.grid);

  // Combined exclusion set (urban + catchment).
  const excluded = new Set<string>();
  for (const k of opts.settlementUrbanHexes) excluded.add(k);
  for (const k of opts.settlementCatchmentHexes) excluded.add(k);

  const used = new Set<string>(); // anchors taken by previously placed features
  const features: HiddenFeature[] = [];

  // Iterate kinds in a stable order so determinism doesn't depend on Map insertion order.
  for (const kind of ALL_KINDS) {
    const want = allocations.get(kind) ?? 0;
    if (want <= 0) continue;
    const kindRng = rng.derive(`kind.${kind}`);
    const candidates = scoreCandidates(
      kind,
      opts.grid,
      excluded,
      kindRng.derive('score'),
      roadDist,
    );
    const merged = new Set<string>(used);
    const picked = greedyPick(candidates, want, merged, MIN_SPREAD);
    // Sync `used` with anything `picked` added.
    for (const p of picked) used.add(hexKey(p));
    const payloadRng = kindRng.derive('payload');
    for (const p of picked) {
      features.push(buildFeature(kind, p, opts.grid, payloadRng));
    }
  }
  return features;
};

/**
 * Apply the placed features to the grid by setting `tile.hiddenFeature` and
 * `tile.hiddenFeatureDiscovered = false`. Returns a NEW grid (input grid
 * untouched) so callers can keep a procgen snapshot for replay.
 */
export const applyHiddenFeaturesToGrid = (
  features: readonly HiddenFeature[],
  grid: HexGrid,
): HexGrid => {
  const next = new Map<string, HexTile>();
  for (const [h, t] of grid.tiles()) {
    next.set(hexKey(h), { ...t });
  }
  for (const f of features) {
    const k = hexKey(f.hex);
    const tile = next.get(k);
    if (tile === undefined) continue;
    next.set(k, {
      ...tile,
      hiddenFeature: f.kind,
      hiddenFeatureDiscovered: false,
    });
  }
  return gridFromMap(next);
};

// `hex` re-exported indirectly by tests; pin so prettier doesn't confuse.
void hex;
