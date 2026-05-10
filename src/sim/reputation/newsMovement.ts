/**
 * News-carrier movement integration.
 *
 * docs/13 says news travels at the speed of caravans (or refugees on foot)
 * — never instantly. The base news carrier in `news.ts` walks via cube-lerp
 * straight-line stepping, which crosses lakes and ignores roads. This shim
 * replaces that with real A* pathfinding through the world hex grid.
 *
 * Design notes:
 *   - The carrier stays an immutable record. We compute the next position
 *     and return a new carrier; the input is unchanged. Same contract as
 *     the legacy `tickCarrier`.
 *   - Path is *not* cached on the carrier (see file note). News carriers
 *     have a single fixed destination and ~3-5 day journeys, so re-A*'ing
 *     once a day is cheap and avoids stale-path bugs when terrain changes
 *     under them (winter pass closing, road built, etc.). For longer-haul
 *     migrations we cache (see `population/migrationMovement.ts`).
 *   - We use the `LADEN_MULE_PROFILE` from pathfinding for routing — a
 *     news carrier on foot is structurally similar (a single person walking
 *     ~20 km/day on a road, slower off-road). The exact MP scaling is
 *     handled here, not by the profile, because the profile is calibrated
 *     for caravans; we want the carrier's `movementPointsPerDay` to be the
 *     budget, with each hex-step costing `1 / hexes_per_day_at_that_hex`.
 *
 * If `findPath` returns no path, the carrier sits in place — that's a
 * legitimate outcome (winter pass closure with no detour, e.g.). The next
 * day's tick re-tries; if the season changes the carrier may move again.
 */

import { findPath, type MovementProfile } from '../world/pathfinding.js';
import type { HexGrid } from '../world/grid.js';
import { hexEquals, type Hex } from '../world/hex.js';
import { isPassable, type RoadGrade, type Season, type Terrain } from '../world/terrain.js';
import type { Day } from '../types.js';
import type { NewsCarrier } from './news.js';

export interface NewsTickWithGridInputs {
  readonly carrier: NewsCarrier;
  readonly grid: HexGrid;
  readonly season: Season;
  readonly today: Day;
}

/**
 * Routing profile for a news carrier on foot. Costs are calibrated so a
 * carrier with `movementPointsPerDay = 20` covers ~20 hexes/day on a Roman
 * road, ~16 on dirt, ~10-12 on plains off-road, and is much slower in
 * difficult terrain. Returns Infinity for terrain that's truly impassable
 * for the carrier in the given season (lakes, winter mountains, spring
 * marshes).
 */
const refugeeBaseCost = (terrain: Terrain): number => {
  switch (terrain) {
    case 'plains':
    case 'fertile_valley':
    case 'urban':
    case 'ruin':
    case 'coast':
    case 'steppe':
      return 1.6;
    case 'hills':
      return 2.5;
    case 'desert':
      return 2.5;
    case 'forest':
      return 2.5;
    case 'dense_forest':
      return 4;
    case 'river':
      return 3;
    case 'marsh':
      return 5;
    case 'mountains':
      return 5;
    case 'lake':
      return Infinity;
  }
};

const REFUGEE_PROFILE: MovementProfile = {
  costFor(terrain: Terrain, road: RoadGrade, season: Season, _loadFraction: number): number {
    if (!isPassable(terrain, season)) return Infinity;
    if (road === 'roman') return 1;
    if (road === 'dirt') return 1.25;
    return refugeeBaseCost(terrain);
  },
};

/**
 * Walk one day's worth of MP along the path. The carrier's
 * `movementPointsPerDay` is the budget; each entered hex deducts its
 * REFUGEE_PROFILE cost. Stops at destination, on impassable hex, or when
 * the budget is exhausted.
 */
const advance = (
  start: Hex,
  path: readonly Hex[],
  budget: number,
  grid: HexGrid,
  season: Season,
): Hex => {
  if (path.length <= 1) return start;
  let pos = start;
  let mp = budget;
  for (let i = 1; i < path.length; i++) {
    const next = path[i] as Hex;
    const t = grid.get(next);
    if (t === undefined) break;
    if (!isPassable(t.terrain, season)) break;
    const cost = REFUGEE_PROFILE.costFor(t.terrain, t.road, season, 0);
    if (!Number.isFinite(cost)) break;
    if (cost > mp + 1e-9) break;
    mp -= cost;
    pos = next;
  }
  return pos;
};

export const tickCarrierWithGrid = (inputs: NewsTickWithGridInputs): NewsCarrier => {
  const { carrier, grid, season } = inputs;
  if (carrier.arrived) return carrier;
  if (hexEquals(carrier.position, carrier.destination)) {
    return { ...carrier, arrived: true };
  }
  if (!grid.has(carrier.position) || !grid.has(carrier.destination)) {
    return carrier;
  }
  const result = findPath(grid, carrier.position, carrier.destination, REFUGEE_PROFILE, season, 0);
  if (result.path.length <= 1) {
    // Unreachable today (e.g. seasonal closure with no detour). Stay put.
    return carrier;
  }
  const nextPos = advance(
    carrier.position,
    result.path,
    carrier.movementPointsPerDay,
    grid,
    season,
  );
  const arrived = hexEquals(nextPos, carrier.destination);
  return {
    ...carrier,
    position: nextPos,
    arrived,
  };
};
