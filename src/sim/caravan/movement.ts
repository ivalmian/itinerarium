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
import { isPassable, type RoadGrade, type Season, type Terrain } from '../world/terrain.js';
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

const RATION_DAILY_BASE_WEAR = 0.001; // 0.1% per day baseline (docs/06)

/** A MovementProfile that turns the caravan's daily MP allowance into per-hex cost. */
const profileForCaravan = (stats: CaravanMovementStats): MovementProfile => ({
  costFor(terrain: Terrain, road: RoadGrade, season: Season, _loadFraction: number): number {
    if (!isPassable(terrain, season)) return Infinity;
    const allowance = dailyMpAllowanceWithStats(stats, terrain, road, season);
    if (!Number.isFinite(allowance) || allowance <= 0) return Infinity;
    // Crossing one hex consumes 1/allowance of a day's progress budget.
    return 1 / allowance;
  },
});

/**
 * Drain `kg` of rations from cargo, drawing from RATION_SOURCES in order.
 * Returns the kg actually consumed (may be < kg if cargo runs out).
 */
const drawRations = (c: Caravan, kg: number): number => {
  if (kg <= 0) return 0;
  let remaining = kg;
  for (const id of RATION_SOURCES) {
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
  stats: CaravanMovementStats,
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
    const tile = grid.get(next);
    if (tile === undefined) {
      out.blockedAt = next;
      break;
    }
    if (!isPassable(tile.terrain, season)) {
      out.blockedAt = next;
      break;
    }
    const allowance = dailyMpAllowanceWithStats(stats, tile.terrain, tile.road, season);
    if (allowance <= 0) {
      out.blockedAt = next;
      break;
    }
    const stepCost = 1 / allowance;
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

export const tickCaravanMovement = (inputs: CaravanTickInputs): CaravanTickResult => {
  const { caravan: c, grid, season } = inputs;
  const events: CaravanTickEvent[] = [];
  const movementStats = caravanMovementStats(c);
  const movementProfile = profileForCaravan(movementStats);

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
    } else if (grid.has(c.position) && grid.has(dest)) {
      const path = findPath(
        grid,
        c.position,
        dest,
        movementProfile,
        season,
        // The profile already holds this caravan-day's load state, so the
        // value here is documentation only.
        0,
      ).path;
      if (path.length > 1) {
        const advance = advanceAlongPath(c, grid, path, season, movementStats);
        hexesMoved = advance.hexesMoved;
        blockedAt = advance.blockedAt;
        arrived = advance.arrived;
      } else {
        // No path under current season. If a path exists in summer, the cause
        // is a seasonal closure: find the first impassable hex on the summer
        // path so the caller knows where the caravan is stuck.
        const summerResult = findPath(grid, c.position, dest, movementProfile, 'summer', 0);
        for (const h of summerResult.path) {
          const t = grid.get(h);
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

  // ---------- Daily costs ---------------------------------------------
  const rationsNeeded = dailyCrewRationKg(c);
  const rationsConsumed = drawRations(c, rationsNeeded);
  if (rationsConsumed + 1e-9 < rationsNeeded) {
    events.push({ type: 'starvation_threshold' });
    // Health drop scales with the shortfall.
    const shortfall = rationsNeeded - rationsConsumed;
    const drop = Math.min(0.05, (shortfall / Math.max(1, rationsNeeded)) * 0.05);
    c.health = Math.max(0, c.health - drop);
  }

  const fodderConsumed = dailyAnimalFodderKg(c);
  // Fodder consumption is reported but not deducted from cargo: animals graze
  // on roadside vegetation by default (docs/06). When the route lacks pasture,
  // a follow-up system can deduct from a 'fodder' cargo line.

  // Vehicle wear: based on the *current* tile (post-movement) since that's
  // where the caravan finishes the day.
  const finalTile = grid.get(c.position);
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
