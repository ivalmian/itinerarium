/**
 * Caravan movement integration.
 *
 * Wires the per-day movement loop: planning a path with A*, advancing the
 * caravan along it as long as today's MP allowance lasts, and applying the
 * daily costs of being on the road (rations, fodder, vehicle wear, health
 * tax when starvation hits).
 *
 * docs/06-caravans.md is the source of truth for the underlying numbers
 * (carry rates, fodder kg/day, wear, ration kg/crew/day). This file just
 * sequences them per turn.
 *
 * Per-hex MP cost. The caravan's `dailyMpAllowance(c, terrain, road,
 * season)` already encodes "how many hexes/day on this terrain." Crossing a
 * single hex therefore costs `1 / allowance` of a day's progress. We carry
 * a fractional progress accumulator across days via `mpRemainingToday`,
 * which is reset to 1.0 at the start of each tick — i.e. each day grants
 * one "day of travel" of progress.
 *
 * Pathing. We use the same A* findPath() the rest of the sim uses, with a
 * MovementProfile derived from the caravan's actual stats. This guarantees
 * that the path planning and the per-day execution agree about which hexes
 * are passable.
 */

import { findPath, type MovementProfile } from '../world/pathfinding.js';
import type { HexGrid } from '../world/grid.js';
import { hexEquals, type Hex } from '../world/hex.js';
import {
  isPassable,
  SEASONS,
  TERRAIN_TYPES,
  type RoadGrade,
  type Season,
  type Terrain,
} from '../world/terrain.js';
import { getResource } from '../resources/index.js';
import type { Day, ResourceId } from '../types.js';
import {
  dailyAnimalFodderKg,
  dailyCrewRationKg,
  dailyMpAllowanceWithStats,
  caravanMovementStats,
  type CaravanMovementStats,
  type Caravan,
} from './caravan.js';

export interface CaravanTickInputs {
  readonly caravan: Caravan;
  readonly grid: HexGrid;
  readonly season: Season;
  readonly today: Day;
}

export type CaravanTickEvent =
  | { readonly type: 'arrived'; readonly at: Hex }
  | { readonly type: 'starvation_threshold' }
  | { readonly type: 'impassable_blocked'; readonly at: Hex };

export interface CaravanTickResult {
  readonly caravan: Caravan;
  readonly hexesMoved: readonly Hex[];
  readonly rationsConsumed: number;
  readonly fodderConsumed: number;
  readonly wearAccrued: number;
  readonly events: readonly CaravanTickEvent[];
}

/** Resources we'll draw rations from, in priority order. */
const RATION_SOURCES: readonly ResourceId[] = [
  'food.bread',
  'food.flour',
  'food.grain',
  'food.legumes',
  'food.salted_meat',
  'food.salted_fish',
  'food.cheese',
] as ResourceId[];

const FODDER_SOURCES: readonly ResourceId[] = ['food.legumes', 'food.grain'] as ResourceId[];

const RATION_DAILY_BASE_WEAR = 0.001; // 0.1% per day baseline (docs/06)
const ROAD_GRADES = ['none', 'dirt', 'roman'] as const satisfies readonly RoadGrade[];
const ROAD_INDEX: Readonly<Record<RoadGrade, number>> = Object.freeze({
  none: 0,
  dirt: 1,
  roman: 2,
});
const SEASON_INDEX: Readonly<Record<Season, number>> = Object.freeze({
  spring: 0,
  summer: 1,
  autumn: 2,
  winter: 3,
});
const TERRAIN_INDEX: Readonly<Record<Terrain, number>> = Object.freeze(
  Object.fromEntries(TERRAIN_TYPES.map((terrain, index) => [terrain, index])) as Record<
    Terrain,
    number
  >,
);
const MOVEMENT_COST_TABLE_SIZE = TERRAIN_TYPES.length * ROAD_GRADES.length * SEASONS.length;

const movementCostIndex = (terrain: Terrain, road: RoadGrade, season: Season): number =>
  (TERRAIN_INDEX[terrain] * ROAD_GRADES.length + ROAD_INDEX[road]) * SEASONS.length +
  SEASON_INDEX[season];

/** A MovementProfile that turns the caravan's daily MP allowance into per-hex cost. */
const profileForCaravan = (stats: CaravanMovementStats): MovementProfile => {
  const costs = new Array<number>(MOVEMENT_COST_TABLE_SIZE);
  for (const terrain of TERRAIN_TYPES) {
    for (const road of ROAD_GRADES) {
      for (const season of SEASONS) {
        let cost = Infinity;
        if (isPassable(terrain, season)) {
          const allowance = dailyMpAllowanceWithStats(stats, terrain, road, season);
          if (Number.isFinite(allowance) && allowance > 0) {
            // Crossing one hex consumes 1/allowance of a day's progress budget.
            cost = 1 / allowance;
          }
        }
        costs[movementCostIndex(terrain, road, season)] = cost;
      }
    }
  }

  return {
    costFor(terrain: Terrain, road: RoadGrade, season: Season, _loadFraction: number): number {
      return costs[movementCostIndex(terrain, road, season)] as number;
    },
  };
};

const drawCargoFoodKg = (c: Caravan, kg: number, sources: readonly ResourceId[]): number => {
  if (kg <= 0) return 0;
  let remaining = kg;
  for (const id of sources) {
    if (remaining <= 0) break;
    const have = c.cargo.get(id) ?? 0;
    if (have <= 0) continue;
    const def = getResource(id);
    const haveKg = have * def.weightKgPerUnit;
    const takeKg = Math.min(haveKg, remaining);
    const takeUnits = takeKg / def.weightKgPerUnit;
    const newQty = have - takeUnits;
    if (newQty > 0) {
      c.cargo.set(id, newQty);
    } else {
      c.cargo.delete(id);
    }
    remaining -= takeKg;
  }
  return kg - Math.max(0, remaining);
};

/**
 * Drain `kg` of rations from cargo, drawing from RATION_SOURCES in order.
 * Returns the kg actually consumed (may be < kg if cargo runs out).
 */
const drawRations = (c: Caravan, kg: number): number => drawCargoFoodKg(c, kg, RATION_SOURCES);

const drawFodder = (c: Caravan, kg: number): number => drawCargoFoodKg(c, kg, FODDER_SOURCES);

/**
 * Walk the path one hex at a time, deducting per-hex MP from the caravan's
 * daily progress budget. Stops when the budget runs out, the destination
 * is reached, or the next hex is impassable. Returns the hexes traversed
 * and any blocking event.
 */
const advanceAlongPath = (
  c: Caravan,
  grid: HexGrid,
  path: readonly Hex[],
  season: Season,
  profile: MovementProfile,
): { hexesMoved: Hex[]; blockedAt: Hex | null; arrived: boolean } => {
  const out: { hexesMoved: Hex[]; blockedAt: Hex | null; arrived: boolean } = {
    hexesMoved: [],
    blockedAt: null,
    arrived: false,
  };
  if (path.length <= 1) {
    // Already at destination (path is [start]).
    out.arrived = true;
    return out;
  }
  // Reset today's progress budget.
  c.mpRemainingToday = 1;

  // path[0] is the current position; iterate from index 1.
  for (let i = 1; i < path.length; i++) {
    const next = path[i] as Hex;
    const tile = grid.getAt(next.q, next.r);
    if (tile === undefined) {
      out.blockedAt = next;
      break;
    }
    const stepCost = profile.costFor(tile.terrain, tile.road, season, 0);
    if (!Number.isFinite(stepCost)) {
      out.blockedAt = next;
      break;
    }
    if (stepCost > c.mpRemainingToday + 1e-9) {
      // Out of MP for today; carry remainder into tomorrow's accumulator
      // (we leave mpRemainingToday so a downstream system could detect it,
      // but the next call will overwrite it anyway).
      break;
    }
    c.mpRemainingToday -= stepCost;
    c.position = { q: next.q, r: next.r };
    out.hexesMoved.push(next);
    if (i === path.length - 1) {
      out.arrived = true;
      break;
    }
  }
  return out;
};

const wearForToday = (terrain: Terrain, road: RoadGrade, season: Season): number => {
  let mult = 1;
  if (road === 'none') mult *= 1.5;
  if (terrain === 'mountains') mult *= 2;
  if (terrain === 'marsh') mult *= 2;
  if (season === 'winter') mult *= 1.3;
  return RATION_DAILY_BASE_WEAR * mult;
};

const forageRationsKg = (terrain: Terrain, season: Season, rationNeedKg: number): number => {
  if (rationNeedKg <= 0) return 0;
  let kgPerCrewEquivalent = 0;
  switch (terrain) {
    case 'fertile_valley':
      kgPerCrewEquivalent = 0.32;
      break;
    case 'plains':
    case 'forest':
    case 'steppe':
    case 'river':
      kgPerCrewEquivalent = 0.24;
      break;
    case 'hills':
    case 'dense_forest':
    case 'marsh':
      kgPerCrewEquivalent = 0.16;
      break;
    case 'urban':
    case 'ruin':
      kgPerCrewEquivalent = 0.12;
      break;
    case 'mountains':
      kgPerCrewEquivalent = 0.05;
      break;
    case 'desert':
    case 'lake':
      kgPerCrewEquivalent = 0;
      break;
  }
  const seasonMult = season === 'winter' ? 0.35 : season === 'spring' ? 0.75 : 1;
  const crewEquivalent = rationNeedKg / 0.4;
  const forageKg = kgPerCrewEquivalent * crewEquivalent * seasonMult;
  const maxShare = season === 'winter' ? 0.25 : 0.8;
  return Math.min(rationNeedKg * maxShare, Math.max(0, forageKg));
};

const forageFodderKg = (
  terrain: Terrain,
  road: RoadGrade,
  season: Season,
  fodderNeedKg: number,
): number => {
  if (fodderNeedKg <= 0) return 0;
  let share = 0;
  switch (terrain) {
    case 'fertile_valley':
    case 'plains':
    case 'steppe':
    case 'river':
      share = 0.85;
      break;
    case 'forest':
    case 'hills':
      share = 0.65;
      break;
    case 'dense_forest':
    case 'marsh':
      share = 0.45;
      break;
    case 'mountains':
      share = 0.25;
      break;
    case 'desert':
      share = 0.08;
      break;
    case 'urban':
    case 'ruin':
    case 'lake':
      share = 0;
      break;
  }
  if (road !== 'none' && share > 0) share = Math.min(0.9, share + 0.05);
  const seasonMult =
    season === 'winter' ? 0.2 : season === 'spring' ? 0.75 : season === 'autumn' ? 0.8 : 1;
  return fodderNeedKg * Math.max(0, Math.min(0.9, share * seasonMult));
};

export const tickCaravanMovement = (inputs: CaravanTickInputs): CaravanTickResult => {
  const { caravan: c, grid, season } = inputs;
  const events: CaravanTickEvent[] = [];
  let movementStats: CaravanMovementStats | undefined;
  let movementProfile: MovementProfile | undefined;
  const getMovementProfile = (): MovementProfile => {
    if (movementProfile === undefined) {
      movementStats = caravanMovementStats(c);
      movementProfile = profileForCaravan(movementStats);
    }
    return movementProfile;
  };

  // ---------- Plan -----------------------------------------------------
  let hexesMoved: readonly Hex[] = [];
  let blockedAt: Hex | null = null;
  let arrived = false;

  if (c.destination !== null) {
    const dest = c.destination;
    if (hexEquals(c.position, dest)) {
      // Already there; no movement, but emit arrived so callers can react
      // (e.g. begin trading at the market). This also implements the
      // docs/05 §"Same-hex coexistence" 0-day short-circuit: a caravan
      // trading between two settlements that share a hex (the Roman *pagus*
      // pattern) arrives in the same tick — no trivial "walk from A to B
      // within the hex" leg.
      arrived = true;
    } else if (grid.hasAt(c.position.q, c.position.r) && grid.hasAt(dest.q, dest.r)) {
      const profile = getMovementProfile();
      const path = findPath(
        grid,
        c.position,
        dest,
        profile,
        season,
        // The profile already holds this caravan-day's load state, so the
        // value here is documentation only.
        0,
      ).path;
      if (path.length > 1) {
        const advance = advanceAlongPath(c, grid, path, season, profile);
        hexesMoved = advance.hexesMoved;
        blockedAt = advance.blockedAt;
        arrived = advance.arrived;
      } else {
        // No path under current season. If a path exists in summer, the cause
        // is a seasonal closure: find the first impassable hex on the summer
        // path so the caller knows where the caravan is stuck.
        const summerResult = findPath(grid, c.position, dest, profile, 'summer', 0);
        for (const h of summerResult.path) {
          const t = grid.getAt(h.q, h.r);
          if (t !== undefined && !isPassable(t.terrain, season)) {
            blockedAt = h;
            break;
          }
        }
      }
    }
  }

  if (blockedAt !== null) {
    events.push({ type: 'impassable_blocked', at: blockedAt });
  }
  if (arrived) {
    events.push({ type: 'arrived', at: c.position });
  }

  const finalTile = grid.getAt(c.position.q, c.position.r);

  // ---------- Daily costs ---------------------------------------------
  const rationsNeeded = dailyCrewRationKg(c);
  const cargoRationsConsumed = drawRations(c, rationsNeeded);
  const forageConsumed =
    cargoRationsConsumed < rationsNeeded && finalTile !== undefined
      ? Math.min(
          rationsNeeded - cargoRationsConsumed,
          forageRationsKg(finalTile.terrain, season, rationsNeeded),
        )
      : 0;
  const rationsConsumed = cargoRationsConsumed + forageConsumed;

  const fodderNeeded = dailyAnimalFodderKg(c);
  const forageFodder =
    fodderNeeded > 0 && finalTile !== undefined
      ? forageFodderKg(finalTile.terrain, finalTile.road, season, fodderNeeded)
      : 0;
  const cargoFodderConsumed = drawFodder(c, Math.max(0, fodderNeeded - forageFodder));
  const fodderConsumed = forageFodder + cargoFodderConsumed;

  const rationShortfall = Math.max(0, rationsNeeded - rationsConsumed);
  const fodderShortfall = Math.max(0, fodderNeeded - fodderConsumed);
  if (rationShortfall > 1e-9 || fodderShortfall > 1e-9) {
    events.push({ type: 'starvation_threshold' });
    // Health drop scales with crew hunger and animal-feed shortfall.
    const rationDrop =
      rationsNeeded > 0 ? (rationShortfall / Math.max(1, rationsNeeded)) * 0.05 : 0;
    const fodderDrop = fodderNeeded > 0 ? (fodderShortfall / Math.max(1, fodderNeeded)) * 0.03 : 0;
    const drop = Math.min(0.08, rationDrop + fodderDrop);
    c.health = Math.max(0, c.health - drop);
  } else if ((rationsNeeded > 0 || fodderNeeded > 0) && c.health < 1) {
    // A caravan that has enough food and a functioning camp routine should
    // slowly recover from prior hunger/fatigue instead of carrying that damage
    // forever. Recovery is deliberately slow: a badly depleted caravan needs
    // weeks of adequately supplied travel or rest to return to full health.
    c.health = Math.min(1, c.health + 0.01);
  }

  // Vehicle wear: based on the *current* tile (post-movement) since that's
  // where the caravan finishes the day.
  const wearAccrued =
    finalTile !== undefined
      ? wearForToday(finalTile.terrain, finalTile.road, season)
      : RATION_DAILY_BASE_WEAR;

  return {
    caravan: c,
    hexesMoved,
    rationsConsumed,
    fodderConsumed,
    wearAccrued,
    events,
  };
};
