/**
 * Road-wear shared state.
 *
 * Per docs/06 §"Trail wear → emergent dirt roads", every entry of a
 * caravan / news carrier / patrol onto a non-Roman hex adds wear; the
 * daily wear-tick phase decays it. When wear exceeds the upgrade
 * threshold a `none` hex promotes to `dirt`; sustained low wear on a
 * `dirt` hex demotes it back. Roman roads neither accrue nor decay
 * — they're engineered and maintained.
 *
 * Originally these constants and helpers were defined inline in
 * `src/sim/tick.ts`. Moved here so both the movement-phase code (still
 * in tick.ts) and the trail-wear-tick phase (now in
 * `src/sim/phases/trailWearTick.ts`) can share them without
 * cross-import gymnastics.
 */

import type { Caravan } from '../caravan/caravan.js';
import { ANIMAL_KINDS } from '../caravan/caravan.js';
import { HEX_DIRECTIONS, hexAdd, type Hex } from './hex.js';
import type { WorldState } from '../../procgen/seed.js';

/** Wear added by one pack animal entering a hex. */
export const WEAR_PER_PACK_ANIMAL = 0.2;
/** Wear added by one caravan crew member entering a hex. */
export const WEAR_PER_CREW = 0.05;
/** Wear added by one news carrier entering a hex. */
export const WEAR_PER_NEWS_CARRIER = 0.2;
/** Wear added by one patrol soldier entering a hex. */
export const WEAR_PER_PATROL_SOLDIER = 0.5;
/** Daily decay applied to roadWear on `none`-grade hexes. */
export const WEAR_DECAY_PER_DAY = 1.0;
/** Daily decay applied to roadWear on `dirt`-grade hexes. */
export const DIRT_ROAD_DECAY_PER_DAY = 0.75;
/** Wear threshold that promotes a `none` hex to `dirt`. */
export const DIRT_UPGRADE_THRESHOLD = 100;
/** Wear below this on a `dirt` hex demotes it back to `none`. */
export const DIRT_DOWNGRADE_THRESHOLD = 20;
/** Hard ceiling on roadWear so a single very busy day can't pile up
 *  arbitrarily large memory of footfall. */
export const MAX_ROAD_WEAR = 200;
/** Per-event cap on wear added by a single addRoadWear call. */
export const MAX_ROAD_WEAR_ADDED_PER_ENTRY = 10;

/**
 * Wear delta produced by a caravan entering one hex. Crew + pack
 * animals each contribute their per-unit constants.
 */
export const caravanTrailWear = (c: Caravan): number => {
  let crew = 0;
  for (const m of c.crew) crew += m.count;
  let animals = 0;
  for (const k of ANIMAL_KINDS) {
    animals += c.animals[k] ?? 0;
  }
  return crew * WEAR_PER_CREW + animals * WEAR_PER_PACK_ANIMAL;
};

/**
 * Add wear to a hex's `roadWear` counter. Roman hexes are skipped
 * (Roman roads don't accrue trail wear). Wear is bounded by
 * MAX_ROAD_WEAR; a single addRoadWear call is bounded by
 * MAX_ROAD_WEAR_ADDED_PER_ENTRY so a freak event doesn't single-
 * handedly promote a hex.
 */
export const addRoadWear = (world: WorldState, h: Hex, amount: number): void => {
  if (amount <= 0) return;
  const tile = world.grid.get(h);
  if (tile === undefined) return;
  if (tile.road === 'roman') return;
  const boundedAmount = Math.min(amount, MAX_ROAD_WEAR_ADDED_PER_ENTRY);
  tile.roadWear = Math.min(MAX_ROAD_WEAR, (tile.roadWear ?? 0) + boundedAmount);
};

/**
 * Count axial neighbors whose tile has any road (dirt or roman).
 * Used by the daily wear-tick to scale dirt-road decay exponentially
 * with local road density.
 */
export const countRoadNeighbors = (grid: WorldState['grid'], h: Hex): number => {
  let n = 0;
  for (const dir of HEX_DIRECTIONS) {
    const neighbor = grid.get(hexAdd(h, dir));
    if (neighbor !== undefined && neighbor.road !== 'none') n++;
  }
  return n;
};
