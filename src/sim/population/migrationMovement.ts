/**
 * Migration column movement integration.
 *
 * docs/04 says migration columns are slow caravans — people walking with
 * their belongings, eating as they go, vulnerable to bandits and weather.
 * The base T32 `tickMigration` walks them straight-line; this shim swaps
 * in real A* pathfinding so terrain, roads, and seasonal closures matter.
 *
 * Why this lives in a separate file and uses `MigrationColumnLike`:
 *   T32 (the migration carrier model) was still in flight when this was
 *   written. Rather than block on it landing, we depend on the structural
 *   subset of `MigrationColumn` that the movement integration actually
 *   reads/writes (position, destination, daysOnRoad, optional cached
 *   path). When T32 lands, the real `MigrationColumn` will have these
 *   plus many more fields (cohorts, rations, deaths-en-route etc.) that
 *   the rest of the migration tick handles. This shim is a pure
 *   movement-layer helper; it does not consume rations or kill people —
 *   that stays in T32's `tickMigration`.
 *
 * Path caching:
 *   Migration columns are slow (~15 hex/day) and routes can be 100+
 *   hexes — a 10-day journey would re-A* 10 times if we recomputed each
 *   tick. So we cache `cachedPath` on the column and reuse it until
 *   `cachedPathStaleAfterDay`, recomputing only after the staleness
 *   threshold or when the cached path can no longer be followed (start
 *   not on path, blocked tile, etc.).
 *
 * Movement profile:
 *   `MIGRANT_PROFILE` is calibrated so a column moves ~15 hexes/day on
 *   plains/road in summer, slower off-road in hills, and is blocked by
 *   the standard impassable-terrain rules (lakes always, mountains in
 *   winter, marshes in spring).
 */

import { findPath, type MovementProfile } from '../world/pathfinding.js';
import type { HexGrid } from '../world/grid.js';
import { hexEquals, type Hex } from '../world/hex.js';
import { isPassable, type RoadGrade, type Season, type Terrain } from '../world/terrain.js';
import type { Rng } from '../rng.js';
import type { Day } from '../types.js';

/**
 * Structural subset of `MigrationColumn` that this movement shim cares
 * about. The real T32 type will satisfy this and add cohort/ration/death
 * fields handled elsewhere.
 */
export interface MigrationColumnLike {
  readonly id: string;
  position: Hex;
  destinationHex: Hex;
  daysOnRoad: number;
  cachedPath: readonly Hex[] | undefined;
  cachedPathStaleAfterDay: Day | undefined;
}

export interface MigrationTickWithGridInputs {
  readonly column: MigrationColumnLike;
  readonly grid: HexGrid;
  readonly season: Season;
  readonly today: Day;
  readonly rng: Rng;
}

export interface MigrationTickWithGridResult {
  readonly column: MigrationColumnLike;
  readonly arrived: boolean;
  readonly hexesMoved: readonly Hex[];
}

const MIGRANT_BASE_HEXES_PER_DAY = 15;
const PATH_CACHE_DAYS = 5;

const migrantBaseCost = (terrain: Terrain): number => {
  // 1 unit = 1/15 of a day; baseline plains in summer = 1.0.
  switch (terrain) {
    case 'plains':
    case 'fertile_valley':
    case 'urban':
    case 'ruin':
    case 'coast':
    case 'steppe':
      return 1;
    case 'hills':
      return 1.6;
    case 'desert':
      return 1.8;
    case 'forest':
      return 1.6;
    case 'dense_forest':
      return 3;
    case 'river':
      return 2.5;
    case 'marsh':
      return 4;
    case 'mountains':
      return 4;
    case 'lake':
      return Infinity;
  }
};

const MIGRANT_PROFILE: MovementProfile = {
  costFor(terrain: Terrain, road: RoadGrade, season: Season, _loadFraction: number): number {
    if (!isPassable(terrain, season)) return Infinity;
    if (road === 'roman') return 0.7;
    if (road === 'dirt') return 0.85;
    return migrantBaseCost(terrain);
  },
};

/**
 * Walk one day's worth of MP along the path. The column's daily budget is
 * normalized to `MIGRANT_BASE_HEXES_PER_DAY` (= 15) hex-cost units, since a
 * plains/no-road tile costs 1 unit each. Each tile entered deducts its
 * profile cost.
 */
const advance = (
  start: Hex,
  path: readonly Hex[],
  budget: number,
  grid: HexGrid,
  season: Season,
): { pos: Hex; hexesMoved: Hex[]; consumedPathIndex: number } => {
  if (path.length <= 1) return { pos: start, hexesMoved: [], consumedPathIndex: 0 };
  // Find the carrier's position in the path. If not present, treat the
  // path as starting at index 0 and walk from start.
  let i = 0;
  for (let k = 0; k < path.length; k++) {
    const h = path[k] as Hex;
    if (hexEquals(h, start)) {
      i = k;
      break;
    }
  }
  let pos = start;
  let mp = budget;
  const moved: Hex[] = [];
  for (let k = i + 1; k < path.length; k++) {
    const next = path[k] as Hex;
    const t = grid.get(next);
    if (t === undefined) break;
    if (!isPassable(t.terrain, season)) break;
    const cost = MIGRANT_PROFILE.costFor(t.terrain, t.road, season, 0);
    if (!Number.isFinite(cost)) break;
    if (cost > mp + 1e-9) break;
    mp -= cost;
    pos = next;
    moved.push(next);
  }
  return { pos, hexesMoved: moved, consumedPathIndex: i + moved.length };
};

const pathStillUsable = (
  column: MigrationColumnLike,
  today: Day,
  grid: HexGrid,
  season: Season,
): boolean => {
  if (column.cachedPath === undefined || column.cachedPath.length < 2) return false;
  if (column.cachedPathStaleAfterDay !== undefined && today > column.cachedPathStaleAfterDay) {
    return false;
  }
  // The cached path must still pass through the column's current position.
  let onPath = false;
  for (const h of column.cachedPath) {
    if (hexEquals(h, column.position)) {
      onPath = true;
      break;
    }
  }
  if (!onPath) return false;
  // Quick passability check on the cached path — if any hex became impassable
  // (e.g. season changed, terrain edited), invalidate.
  for (const h of column.cachedPath) {
    const t = grid.get(h);
    if (t === undefined || !isPassable(t.terrain, season)) return false;
  }
  return true;
};

export const tickMigrationWithGrid = (
  inputs: MigrationTickWithGridInputs,
): MigrationTickWithGridResult => {
  const { column, grid, season, today } = inputs;
  if (hexEquals(column.position, column.destinationHex)) {
    return {
      column: { ...column, daysOnRoad: column.daysOnRoad },
      arrived: true,
      hexesMoved: [],
    };
  }
  if (!grid.has(column.position) || !grid.has(column.destinationHex)) {
    return {
      column: { ...column, daysOnRoad: column.daysOnRoad + 1 },
      arrived: false,
      hexesMoved: [],
    };
  }

  let path: readonly Hex[] | undefined = column.cachedPath;
  let staleAfterDay: Day | undefined = column.cachedPathStaleAfterDay;
  if (!pathStillUsable(column, today, grid, season)) {
    const result = findPath(
      grid,
      column.position,
      column.destinationHex,
      MIGRANT_PROFILE,
      season,
      0,
    );
    path = result.path.length > 0 ? result.path : undefined;
    staleAfterDay = (today + PATH_CACHE_DAYS) as Day;
  }

  if (path === undefined || path.length <= 1) {
    return {
      column: {
        ...column,
        daysOnRoad: column.daysOnRoad + 1,
        cachedPath: undefined,
        cachedPathStaleAfterDay: undefined,
      },
      arrived: false,
      hexesMoved: [],
    };
  }

  const { pos, hexesMoved } = advance(
    column.position,
    path,
    MIGRANT_BASE_HEXES_PER_DAY,
    grid,
    season,
  );
  const arrived = hexEquals(pos, column.destinationHex);
  return {
    column: {
      ...column,
      position: pos,
      daysOnRoad: column.daysOnRoad + 1,
      cachedPath: path,
      cachedPathStaleAfterDay: staleAfterDay,
    },
    arrived,
    hexesMoved,
  };
};
