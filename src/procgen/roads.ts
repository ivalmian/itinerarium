/**
 * Road network generation.
 *
 * Reference: docs/07-geography.md ("Phase 1 — Procgen", step 8). The Roman
 * provincial road network has two grades:
 *   - Roman roads link the provincial capital to every secondary city. These
 *     are the arterial routes — paved, maintained, fast for caravans.
 *   - Dirt roads link each city/town to its surrounding villages and
 *     hamlets, plus city↔town connections inside a cluster.
 *
 * Routing: we use the same A* pathfinder real caravans use (src/sim/world/
 * pathfinding.ts), but with a road-builder-tuned MovementProfile that
 * prefers easy terrain regardless of season — engineers chose routes that
 * worked in summer; winter mountain closures don't dictate where the road
 * is *physically built*, only how usable it is later.
 *
 * Upgrade rule: a hex on multiple routes ends up with the higher grade
 * (roman > dirt > none). Dirt assignments never downgrade an existing
 * roman tile. This is what produces realistic local-feeder + arterial
 * topology where a village's dirt approach merges into the Roman road that
 * passes through.
 *
 * Determinism: settlements are sorted by hexKey before iteration so the
 * order in which we lay roads is reproducible from (seed, settlements).
 * The seed is also threaded into a derive() so future tie-breakers (e.g.
 * picking among equal-cost paths) can stay stable.
 */

import { createRng } from '../sim/rng.js';
import { hexKey, type Hex } from '../sim/world/hex.js';
import type { HexGrid } from '../sim/world/grid.js';
import type { MovementProfile, PathResult } from '../sim/world/pathfinding.js';
import { findPath } from '../sim/world/pathfinding.js';
import type { RoadGrade, Season, Terrain } from '../sim/world/terrain.js';
import type { SettlementSite } from './settlements.js';

export interface RoadGenOpts {
  readonly seed: string;
  /** Mutated in place: tile.road is upgraded to dirt or roman along routes. */
  readonly grid: HexGrid;
  readonly settlements: readonly SettlementSite[];
  /**
   * Hex radius around each city within which villages and towns are wired
   * via dirt roads. Default 30 (matches docs/07 cluster-radius guidance).
   */
  readonly clusterRadiusHexes?: number;
}

/**
 * Movement profile used for ROUTING — not for caravan travel. Engineers built
 * roads where they could be built: avoiding lakes, marshes, sticking to flat
 * ground, willing to ascend hills but not crossing impassable mountains.
 * Season is fixed to 'summer' so winter closures don't reshape the network.
 */
const ROAD_BUILDER_PROFILE: MovementProfile = {
  costFor(terrain: Terrain, road: RoadGrade, _season: Season, _loadFraction: number): number {
    // Re-use whatever's already paved: routes naturally consolidate onto
    // existing roads, so adding the second city's link reinforces the first.
    if (road === 'roman') return 0.5;
    if (road === 'dirt') return 0.7;
    switch (terrain) {
      case 'plains':
      case 'fertile_valley':
      case 'urban':
      case 'ruin':
      case 'coast':
      case 'steppe':
        return 1;
      case 'hills':
        return 1.8;
      case 'desert':
        return 2;
      case 'forest':
        return 2.2;
      case 'dense_forest':
        return 4;
      case 'river':
        // A road along a river is fine; crossing is harder but the pathfinder
        // doesn't model bridges yet, so a single river hex on the route just
        // costs more.
        return 3;
      case 'marsh':
        return 6;
      case 'mountains':
        return 8;
      case 'lake':
        return Infinity;
    }
  },
};

/** Roman > dirt > none: never downgrade. */
const upgradeRoad = (current: RoadGrade, proposed: RoadGrade): RoadGrade => {
  if (current === 'roman') return 'roman';
  if (proposed === 'roman') return 'roman';
  if (current === 'dirt' || proposed === 'dirt') return 'dirt';
  return 'none';
};

const paintRoute = (grid: HexGrid, path: readonly Hex[], grade: RoadGrade): void => {
  for (const h of path) {
    const tile = grid.get(h);
    if (tile === undefined) continue;
    tile.road = upgradeRoad(tile.road, grade);
    // Seed wear above downgrade threshold so docs/06 §"Trail wear"'s
    // daily decay doesn't reclaim procgen-laid roads in the first
    // post-procgen month before traffic accumulates.
    tile.roadWear = Math.max(tile.roadWear ?? 0, 100);
  }
};

const paveUrbanFootprint = (grid: HexGrid, settlement: SettlementSite): void => {
  const grade: RoadGrade =
    settlement.kind === 'capital' || settlement.kind === 'city' ? 'roman' : 'dirt';
  for (const h of settlement.urbanHexes) {
    const tile = grid.get(h);
    if (tile === undefined) continue;
    tile.road = upgradeRoad(tile.road, grade);
    tile.roadWear = Math.max(tile.roadWear ?? 0, 100);
  }
};

/**
 * A* between two settlement anchors using the road-builder profile, then
 * paint each hex of the resulting path at the requested grade. If no path
 * exists (anchor surrounded by lakes etc.), silently skip — connectivity
 * gets enforced at a higher level via spanning over the cluster anchors.
 */
const drawRoute = (grid: HexGrid, start: Hex, goal: Hex, grade: RoadGrade): PathResult => {
  // findPath returns an empty path / Infinity cost if unreachable.
  const result = findPath(grid, start, goal, ROAD_BUILDER_PROFILE, 'summer', 1);
  if (result.path.length > 0) {
    paintRoute(grid, result.path, grade);
  }
  return result;
};

const settlementSortKey = (s: SettlementSite): string => `${s.kind}|${hexKey(s.anchor)}`;

/**
 * Find the closest city anchor (by raw hex distance) for routing villages /
 * hamlets / towns into their cluster. Cities and the capital both count as
 * cluster centres. Returns undefined if there are none.
 */
const closestCity = (
  s: SettlementSite,
  cities: readonly SettlementSite[],
): SettlementSite | undefined => {
  let best: SettlementSite | undefined;
  let bestD = Infinity;
  for (const c of cities) {
    const dq = s.anchor.q - c.anchor.q;
    const dr = s.anchor.r - c.anchor.r;
    const ds = -dq - dr;
    const d = (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
};

export const generateRoads = (opts: RoadGenOpts): HexGrid => {
  const { grid, settlements } = opts;
  // Touch the rng so the seed is part of our determinism contract; future
  // tie-breakers will pull from it.
  createRng(opts.seed).derive('roads');

  if (settlements.length === 0) return grid;

  // Sort once for deterministic iteration order.
  const sorted = settlements.slice().sort((a, b) => {
    const ka = settlementSortKey(a);
    const kb = settlementSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Pave every settlement's urban footprint first so subsequent A* runs
  // naturally route in/out of paved hexes.
  for (const s of sorted) {
    paveUrbanFootprint(grid, s);
  }

  const capital = sorted.find((s) => s.kind === 'capital');
  const cities = sorted.filter((s) => s.kind === 'capital' || s.kind === 'city');
  const towns = sorted.filter((s) => s.kind === 'town');
  const villages = sorted.filter((s) => s.kind === 'village');
  const hamlets = sorted.filter((s) => s.kind === 'hamlet');

  // ----- Roman roads: capital ↔ each other city ----------------------------
  if (capital !== undefined) {
    for (const city of cities) {
      if (city === capital) continue;
      drawRoute(grid, capital.anchor, city.anchor, 'roman');
    }
  } else if (cities.length >= 2) {
    // No capital: still build a Roman backbone among cities by linking the
    // first sorted city to each of the rest.
    const head = cities[0] as SettlementSite;
    for (let i = 1; i < cities.length; i++) {
      const c = cities[i] as SettlementSite;
      drawRoute(grid, head.anchor, c.anchor, 'roman');
    }
  }

  // ----- Dirt roads: every town/village/hamlet → its closest city ----------
  for (const t of towns) {
    const home = closestCity(t, cities);
    if (home === undefined) continue;
    drawRoute(grid, t.anchor, home.anchor, 'dirt');
  }
  for (const v of villages) {
    const home = closestCity(v, cities);
    if (home === undefined) continue;
    drawRoute(grid, v.anchor, home.anchor, 'dirt');
  }
  for (const h of hamlets) {
    const home = closestCity(h, cities);
    if (home === undefined) continue;
    drawRoute(grid, h.anchor, home.anchor, 'dirt');
  }

  return grid;
};
