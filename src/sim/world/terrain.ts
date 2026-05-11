/**
 * Per-hex terrain, climate, season, and tile structure.
 *
 * Reference: docs/07-geography.md
 *
 * Each hex is 1 km² (docs/01-simulation-frame.md). Terrain + climate together
 * determine what can be produced on a hex (yields per day per resource), what
 * herds it can carry, what fuel it demands, and whether it is passable.
 *
 * The four-season convention used here:
 *   day  0..90  → spring (planting)
 *   day 91..181 → summer (growing season; mountain passes open)
 *   day 182..272 → autumn (harvest)
 *   day 273..364 → winter (low production; passes closed)
 *
 * Year length is 365 days; each season is ~91 days. We start the year at
 * day 0 in spring (vernal-equinox convention) so day 0 of a fresh save is
 * planting time, not winter — gives the player a productive opening tick.
 */

import type { ActorId, Day, Quantity, ResourceId } from '../types.js';

export const TERRAIN_TYPES = [
  'plains',
  'fertile_valley',
  'hills',
  'mountains',
  'forest',
  'dense_forest',
  'marsh',
  'desert',
  'steppe',
  'river',
  'lake',
  'urban',
  'ruin',
] as const;
export type Terrain = (typeof TERRAIN_TYPES)[number];

export const CLIMATE_BANDS = [
  'mediterranean',
  'temperate',
  'continental',
  'arid',
  'alpine',
] as const;
export type Climate = (typeof CLIMATE_BANDS)[number];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export type RoadGrade = 'none' | 'dirt' | 'roman';

export type HiddenFeature =
  | 'abandoned_mine'
  | 'ruin'
  | 'abandoned_village'
  | 'hermit_shrine'
  | 'lost_route'
  | 'bandit_hideout';

export interface HexDeposit {
  readonly resource: ResourceId;
  readonly remaining: Quantity;
}

export interface HexTile {
  terrain: Terrain;
  climate: Climate;
  /** Metres above sea level. */
  elevation: number;
  hasRiver: boolean;
  road: RoadGrade;
  /**
   * Footfall counter that drives emergent road formation. Per docs/06
   * §"Trail wear → emergent dirt roads": each unit (caravan crew +
   * pack animals + news carrier + patrol soldier) entering this hex
   * adds wear; daily decay -1; on threshold (default 100) a 'none' hex
   * upgrades to 'dirt'; sustained low wear demotes 'dirt' back to
   * 'none'. Roman roads neither accrue wear nor decay.
   *
   * Procgen-laid dirt+roman hexes seed roadWear=100 so they don't
   * immediately decay below the downgrade threshold.
   *
   * Optional + nullable so the dozens of test fixtures that declare
   * tiles inline don't all break; when absent treat as 0.
   */
  roadWear?: number;
  /**
   * Number of consecutive quarters the governor's office failed to fund
   * maintenance for this Roman-road hex. Per docs/15 §C11. After 4
   * consecutive missed quarters (~1 year) the hex downgrades to
   * `road = 'dirt'` and joins the normal trail-wear lifecycle.
   * Optional/absent means "fully maintained / not Roman".
   */
  romanQuartersUnmaintained?: number;
  /** Settlement-level ownership; null = unowned wilderness. */
  ownerActor: ActorId | null;
  /** Mineable / extractable deposit on this hex, if any. */
  deposit?: HexDeposit;
  /** Hidden feature placed by procgen; absent on most hexes. */
  hiddenFeature?: HiddenFeature;
  /** Whether the hidden feature has been discovered by a visiting caravan. */
  hiddenFeatureDiscovered?: boolean;
}

const DAYS_PER_YEAR = 365;
const DAYS_PER_SEASON = 91;

/**
 * Whether a tile can be entered on foot (or by cart) in the given season.
 * Lakes are never passable; mountains close in winter; marshes are too wet
 * to cross in spring snowmelt. Everything else is walkable year-round.
 */
export const isPassable = (t: Terrain, season: Season): boolean => {
  switch (t) {
    case 'lake':
      return false;
    case 'mountains':
      return season !== 'winter';
    case 'marsh':
      return season !== 'spring';
    default:
      return true;
  }
};

/**
 * Heating-fuel demand multiplier vs. the mediterranean baseline (1.0).
 * Cold climates burn more wood/charcoal per adult per day in winter; we
 * roll that into an annualized per-climate scalar so callers can multiply
 * baseline fuel demand without season-by-season bookkeeping.
 */
export const fuelDemandMultiplier = (c: Climate): number => {
  switch (c) {
    case 'mediterranean':
      return 1;
    case 'arid':
      return 0.9;
    case 'temperate':
      return 1.4;
    case 'continental':
      return 2.0;
    case 'alpine':
      return 2.5;
  }
};

/**
 * Herd units per hex per year that the terrain+climate combination can
 * sustainably carry. Numbers are coarse and meant to be calibrated during
 * burn-in; the *ordering* (fertile_valley > plains > steppe > mountains)
 * is what production code can rely on today.
 */
export const pastureCarryingCapacity = (t: Terrain, c: Climate): number => {
  const base = terrainPastureBase(t);
  if (base === 0) return 0;
  return base * climatePastureFactor(c);
};

const terrainPastureBase = (t: Terrain): number => {
  switch (t) {
    case 'fertile_valley':
      return 6;
    case 'plains':
      return 4;
    case 'hills':
      return 3;
    case 'forest':
      return 2;
    case 'steppe':
      return 1.5;
    case 'marsh':
      return 1;
    case 'desert':
      return 0.5;
    case 'mountains':
      return 0.5;
    case 'dense_forest':
      return 0.3;
    case 'river':
      return 1;
    case 'ruin':
      return 0.2;
    case 'lake':
    case 'urban':
      return 0;
  }
};

const climatePastureFactor = (c: Climate): number => {
  switch (c) {
    case 'mediterranean':
      return 1;
    case 'temperate':
      return 1.1;
    case 'continental':
      return 0.9;
    case 'arid':
      return 0.5;
    case 'alpine':
      return 0.7;
  }
};

/**
 * Map a (possibly multi-year) day index to its season. Negative days wrap
 * via positive modulo so callers don't have to special-case pre-epoch
 * timestamps.
 */
export const dayOfYearToSeason = (day: Day): Season => {
  const dayOfYear = ((day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  // 0..90 spring, 91..181 summer, 182..272 autumn, 273..364 winter
  const seasonIndex = Math.min(3, Math.floor(dayOfYear / DAYS_PER_SEASON));
  // Safe: seasonIndex ∈ [0, 3] and SEASONS has 4 entries.
  return SEASONS[seasonIndex] as Season;
};
