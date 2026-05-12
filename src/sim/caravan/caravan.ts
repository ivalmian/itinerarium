/**
 * Caravan: the protagonists of the simulation.
 *
 * docs/06-caravans.md: a caravan is a unit with crew, animals,
 * vehicles, cargo, treasury, and route knowledge. The player has
 * one; the world has hundreds. They run on the same code.
 *
 * Movement, ration/fodder consumption, and capacity are computed
 * here from per-unit reference numbers (docs/06 §"Animal &
 * vehicle reference"). Cargo weight uses the resource catalog
 * (T1) for per-resource kg.
 *
 * Daily MP is reduced by load fraction, terrain, road grade,
 * season, and seasonally impassable terrain (mountains in winter,
 * marshes in spring, lakes always).
 */

import { drainDemographics, type Demographics } from '../population/demographics.js';
import { getResource } from '../resources/index.js';
import type { Rng } from '../rng.js';
import type { Day } from '../types.js';
import type { ActorId, CaravanId, Coin, Position, Quantity, ResourceId } from '../types.js';
import type { Goal } from './goal.js';
import { isPassable, type RoadGrade, type Season, type Terrain } from '../world/terrain.js';

// --- Animals ---------------------------------------------------------------

export type AnimalKind = 'donkey' | 'mule' | 'horse' | 'camel' | 'ox';

export const ANIMAL_KINDS = [
  'donkey',
  'mule',
  'horse',
  'camel',
  'ox',
] as const satisfies readonly AnimalKind[];

export interface AnimalSpec {
  readonly kind: AnimalKind;
  readonly carryKg: number;
  readonly fodderKgPerDay: number;
  /** Hexes per day on a Roman road, laden — pre-load-and-terrain modifiers. */
  readonly baseMpPerDay: number;
}

export const ANIMAL_SPECS: Readonly<Record<AnimalKind, AnimalSpec>> = Object.freeze({
  donkey: { kind: 'donkey', carryKg: 50, fodderKgPerDay: 3, baseMpPerDay: 20 },
  mule: { kind: 'mule', carryKg: 100, fodderKgPerDay: 6, baseMpPerDay: 25 },
  horse: { kind: 'horse', carryKg: 80, fodderKgPerDay: 7, baseMpPerDay: 30 },
  camel: { kind: 'camel', carryKg: 180, fodderKgPerDay: 3, baseMpPerDay: 22 },
  // Oxen are usually team-pulling a wagon; their carry rating is for
  // pack use without a vehicle. Fodder is per ox.
  ox: { kind: 'ox', carryKg: 100, fodderKgPerDay: 10, baseMpPerDay: 12 },
});

// --- Vehicles --------------------------------------------------------------

export type VehicleKind = 'pack_saddle' | 'light_cart' | 'ox_cart' | 'heavy_wagon';

export const VEHICLE_KINDS = [
  'pack_saddle',
  'light_cart',
  'ox_cart',
  'heavy_wagon',
] as const satisfies readonly VehicleKind[];

export interface VehicleSpec {
  readonly kind: VehicleKind;
  /** Carry kg added by the vehicle itself (over and above the animals pulling it). */
  readonly carryKg: number;
  /** Fodder for the team pulling this vehicle (in addition to listed animals). */
  readonly fodderKgPerDay: number;
  readonly baseMpPerDay: number;
  readonly needsRoad: boolean;
}

export const VEHICLE_SPECS: Readonly<Record<VehicleKind, VehicleSpec>> = Object.freeze({
  // A pack saddle is metadata; capacity is on the animal itself.
  pack_saddle: {
    kind: 'pack_saddle',
    carryKg: 0,
    fodderKgPerDay: 0,
    baseMpPerDay: 25,
    needsRoad: false,
  },
  light_cart: {
    kind: 'light_cart',
    carryKg: 200,
    fodderKgPerDay: 0,
    baseMpPerDay: 22,
    needsRoad: false,
  },
  ox_cart: {
    kind: 'ox_cart',
    carryKg: 500,
    fodderKgPerDay: 0,
    baseMpPerDay: 15,
    needsRoad: true,
  },
  heavy_wagon: {
    kind: 'heavy_wagon',
    carryKg: 1200,
    fodderKgPerDay: 0,
    baseMpPerDay: 12,
    needsRoad: true,
  },
});

// --- Crew ------------------------------------------------------------------

export type CrewKind = 'merchant' | 'drover' | 'caravan_guard' | 'soldier';

export const CREW_KINDS = [
  'merchant',
  'drover',
  'caravan_guard',
  'soldier',
] as const satisfies readonly CrewKind[];

export interface CrewMember {
  readonly kind: CrewKind;
  count: number;
  /** 0..1 weapon equipment level (used by future battle system). */
  weapons: number;
  /** 0..1 armor equipment level. */
  armor: number;
  /**
   * Per-(sex, age band) split of these `count` people. Optional so existing
   * fixtures (~60 tests) don't all need updating in one shot. When present,
   * `sum(demographics) === count` should hold; the seeder enforces this and
   * the casualty path drains demographics in proportion to crew deaths.
   *
   * docs/06-caravans.md §"Crew demographics"
   */
  demographics?: Demographics;
}

const RATION_KG_PER_CREW_PER_DAY = 0.4;

// --- Caravan ---------------------------------------------------------------

export interface PriceObservation {
  /**
   * Back-compat scalar price. For side-aware book observations this is the
   * mid/last-trade quote; route planning prefers askPrice at origin and
   * bidPrice at destination when those side quotes are present.
   */
  readonly price: number;
  /** Highest visible bid at the observed settlement/hex. */
  readonly bidPrice?: number;
  /** Lowest visible ask at the observed settlement/hex. */
  readonly askPrice?: number;
  /** Residual quantity behind the best bid. */
  readonly bidDepth?: Quantity;
  /** Residual quantity behind the best ask. */
  readonly askDepth?: Quantity;
  readonly observedOnDay: Day;
}

export interface Caravan {
  readonly id: CaravanId;
  ownerActor: ActorId;
  position: Position;
  destination: Position | null;
  crew: CrewMember[];
  animals: Partial<Record<AnimalKind, number>>;
  vehicles: Partial<Record<VehicleKind, number>>;
  cargo: Map<ResourceId, Quantity>;
  treasury: Coin;
  /** Hexes available to spend today. Recomputed at start of each day. */
  mpRemainingToday: number;
  /** Recent local prices observed: hexKey → resource → observation. */
  priceBook: Map<ResourceId, Map<string, PriceObservation>>;
  /** 0..1 average crew/animal health (rations, fatigue, infection erode it). */
  health: number;
  /**
   * Persistent goal stack (docs/15 §C18 + docs/06 §"Goal-bearing units").
   * The per-tick AI peeks the top, advances it; pops when complete.
   * For backwards compat the field is optional — caravans without an
   * explicit stack use the legacy single-`destination` re-planning path
   * in tick.ts caravanReplanPhase. New caravans (NPC trade routes,
   * tax shipments, edge-hub imports/exports) push goals at creation.
   */
  goalStack?: Goal[];
  /**
   * Per docs/15 §C25: rolling counter of consecutive ticks the planner
   * could not find a profitable route above the minimum-margin floor.
   * Reset to 0 whenever a profitable plan is found. When this exceeds
   * the disband threshold (default 45 days), the caravan disbands —
   * its crew / animals / vehicles return to the owner stockpile or the
   * local population pool. Without this counter the world accumulated
   * zombie caravans that walked aimlessly between settlements with
   * 0%-margin trades, draining their owner's treasury on rations.
   */
  noProfitableRouteDays?: number;
}

export interface CreateCaravanInput {
  readonly id: CaravanId;
  readonly ownerActor: ActorId;
  readonly position: Position;
  readonly crew: readonly CrewMember[];
  readonly animals: Partial<Record<AnimalKind, number>>;
  readonly vehicles: Partial<Record<VehicleKind, number>>;
  readonly destination?: Position | null;
  readonly treasury?: Coin;
}

const validateAnimals = (animals: Partial<Record<AnimalKind, number>>): void => {
  for (const k of Object.keys(animals) as AnimalKind[]) {
    const n = animals[k];
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Caravan animals[${k}] must be non-negative, got ${n}`);
    }
  }
};

const validateVehicles = (vehicles: Partial<Record<VehicleKind, number>>): void => {
  for (const k of Object.keys(vehicles) as VehicleKind[]) {
    const n = vehicles[k];
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Caravan vehicles[${k}] must be non-negative, got ${n}`);
    }
  }
};

const validateCrew = (crew: readonly CrewMember[]): void => {
  if (crew.length === 0) {
    throw new Error('Caravan must have at least one crew entry');
  }
  for (const m of crew) {
    if (!Number.isFinite(m.count) || m.count <= 0) {
      throw new Error(`Caravan crew ${m.kind} count must be positive, got ${m.count}`);
    }
  }
};

export const createCaravan = (input: CreateCaravanInput): Caravan => {
  validateCrew(input.crew);
  validateAnimals(input.animals);
  validateVehicles(input.vehicles);
  return {
    id: input.id,
    ownerActor: input.ownerActor,
    position: { q: input.position.q, r: input.position.r },
    destination:
      input.destination !== undefined && input.destination !== null
        ? { q: input.destination.q, r: input.destination.r }
        : null,
    crew: input.crew.map((m) => ({
      ...m,
      // Defensive copy of the demographics map so callers can't mutate
      // the caravan's split via their original reference.
      ...(m.demographics !== undefined ? { demographics: new Map(m.demographics) } : {}),
    })),
    animals: { ...input.animals },
    vehicles: { ...input.vehicles },
    cargo: new Map(),
    treasury: input.treasury ?? 0,
    mpRemainingToday: 0,
    priceBook: new Map(),
    health: 1,
  };
};

// --- Capacity --------------------------------------------------------------

export const totalCarryKg = (c: Caravan): number => {
  let kg = 0;
  for (const k of ANIMAL_KINDS) {
    const n = c.animals[k] ?? 0;
    kg += n * ANIMAL_SPECS[k].carryKg;
  }
  for (const k of VEHICLE_KINDS) {
    const n = c.vehicles[k] ?? 0;
    kg += n * VEHICLE_SPECS[k].carryKg;
  }
  return kg;
};

export const totalCargoWeightKg = (c: Caravan): number => {
  let kg = 0;
  for (const [res, qty] of c.cargo) {
    const def = getResource(res);
    kg += def.weightKgPerUnit * qty;
  }
  return kg;
};

export const loadFraction = (c: Caravan): number => {
  const cap = totalCarryKg(c);
  if (cap <= 0) return 0;
  const w = totalCargoWeightKg(c);
  if (w <= 0) return 0;
  return Math.min(1, w / cap);
};

export const totalCrewCount = (c: Caravan): number => {
  let n = 0;
  for (const m of c.crew) n += m.count;
  return n;
};

// --- Consumption -----------------------------------------------------------

export const dailyCrewRationKg = (c: Caravan): number => {
  return totalCrewCount(c) * RATION_KG_PER_CREW_PER_DAY;
};

export const dailyAnimalFodderKg = (c: Caravan): number => {
  let kg = 0;
  for (const k of ANIMAL_KINDS) {
    const n = c.animals[k] ?? 0;
    kg += n * ANIMAL_SPECS[k].fodderKgPerDay;
  }
  for (const k of VEHICLE_KINDS) {
    const n = c.vehicles[k] ?? 0;
    kg += n * VEHICLE_SPECS[k].fodderKgPerDay;
  }
  return kg;
};

/**
 * Carried feed reserve for route planning/provisioning. Animals still graze
 * when the terrain allows it; this is the portion a prudent caravan carries
 * as grain/legumes for poor forage days, urban stops, winter, and detours.
 */
export const CARRIED_FODDER_RESERVE_SHARE = 0.35;

export const dailyCarriedFoodReserveKg = (c: Caravan): number =>
  dailyCrewRationKg(c) + dailyAnimalFodderKg(c) * CARRIED_FODDER_RESERVE_SHARE;

// --- Movement --------------------------------------------------------------

/**
 * Slowest base MP across the caravan's animals and vehicles. The
 * caravan moves only as fast as its slowest unit. If a vehicle
 * needs a road and the current hex has none, that vehicle's
 * effective MP collapses (factored in by the road multiplier).
 */
const slowestBaseMp = (c: Caravan): number => {
  let slowest = Number.POSITIVE_INFINITY;
  for (const k of ANIMAL_KINDS) {
    if ((c.animals[k] ?? 0) > 0) {
      slowest = Math.min(slowest, ANIMAL_SPECS[k].baseMpPerDay);
    }
  }
  for (const k of VEHICLE_KINDS) {
    if ((c.vehicles[k] ?? 0) > 0) {
      slowest = Math.min(slowest, VEHICLE_SPECS[k].baseMpPerDay);
    }
  }
  return Number.isFinite(slowest) ? slowest : 0;
};

const hasRoadDependentVehicle = (c: Caravan): boolean => {
  for (const k of VEHICLE_KINDS) {
    if ((c.vehicles[k] ?? 0) > 0 && VEHICLE_SPECS[k].needsRoad) return true;
  }
  return false;
};

const roadMultiplier = (road: RoadGrade): number => {
  switch (road) {
    case 'roman':
      return 1;
    case 'dirt':
      return 0.8;
    case 'none':
      // Off-road is deliberately harsh: roads should dominate route choice,
      // and unroaded rough terrain should be a fallback rather than a peer.
      return 0.25;
  }
};

const terrainMultiplier = (t: Terrain): number => {
  switch (t) {
    case 'urban':
    case 'plains':
    case 'fertile_valley':
    case 'steppe':
      return 1;
    case 'forest':
      return 0.85;
    case 'hills':
      return 0.75;
    case 'desert':
      return 0.7;
    case 'dense_forest':
      return 0.5;
    case 'marsh':
      return 0.5;
    case 'mountains':
      return 0.4;
    // Crossing a river hex without a bridge means fording — slow but
    // possible. Future bridge construction will restore normal speed.
    case 'river':
      return 0.35;
    case 'ruin':
      return 0.8;
    case 'lake':
      return 0;
  }
};

const seasonMultiplier = (t: Terrain, season: Season): number => {
  if (t === 'mountains') {
    if (season === 'winter') return 0.05;
    if (season === 'autumn' || season === 'spring') return 0.7;
    return 1;
  }
  if (t === 'marsh' && season === 'spring') return 0.4;
  if (season === 'winter') return 0.85;
  return 1;
};

export interface CaravanMovementStats {
  readonly baseMp: number;
  readonly hasRoadDependentVehicle: boolean;
  readonly loadMult: number;
}

export const caravanMovementStats = (c: Caravan): CaravanMovementStats => ({
  baseMp: slowestBaseMp(c),
  hasRoadDependentVehicle: hasRoadDependentVehicle(c),
  loadMult: 1.2 - 0.2 * loadFraction(c),
});

/**
 * MP allowance for one day. Multiplies slowest-unit base MP by
 * load factor (1.0 empty → ~0.7 fully laden), road grade,
 * terrain, and season. Returns 0 for impassable terrain (lake,
 * mountains in winter, marsh in spring) and for road-dependent
 * vehicles off any road.
 */
export const dailyMpAllowance = (
  c: Caravan,
  terrain: Terrain,
  road: RoadGrade,
  season: Season,
): number => {
  return dailyMpAllowanceWithStats(caravanMovementStats(c), terrain, road, season);
};

export const dailyMpAllowanceWithStats = (
  stats: CaravanMovementStats,
  terrain: Terrain,
  road: RoadGrade,
  season: Season,
): number => {
  if (!isPassable(terrain, season)) return 0;

  // A road-only vehicle on an unroaded hex is effectively stuck.
  if (stats.hasRoadDependentVehicle && road === 'none') {
    if (terrain !== 'plains' && terrain !== 'fertile_valley') return 0;
    // On hard plains an ox-cart can creep along, but very slowly.
  }

  const base = stats.baseMp;
  if (base <= 0) return 0;

  const mp =
    base *
    stats.loadMult *
    roadMultiplier(road) *
    terrainMultiplier(terrain) *
    seasonMultiplier(terrain, season);
  return Math.max(0, mp);
};

// --- Casualties ------------------------------------------------------------

/**
 * Apply `totalDeaths` crew casualties to a caravan, in walk order across
 * its `crew[]` (matching the existing tick-layer convention). When a
 * crew entry has demographics, the same proportion of its bucket counts
 * is removed and returned for downstream cohort accounting (e.g., the
 * settlement at home losing the wives/sons of the dead).
 *
 * Returns the per-crew-kind drain map (kind → removed demographics)
 * suitable for forwarding to a settlement's PopulationPool.
 *
 * Mutates `caravan.crew` in place. Crew entries that drop to count==0
 * are removed (matching tick.ts's existing filter).
 *
 * docs/06-caravans.md §"Crew demographics" — casualty accounting.
 */
export const applyCrewCasualties = (
  caravan: Caravan,
  totalDeaths: number,
  rng: Rng,
): ReadonlyMap<CrewKind, ReadonlyMap<string, number>> => {
  const removed = new Map<CrewKind, ReadonlyMap<string, number>>();
  if (!Number.isInteger(totalDeaths) || totalDeaths <= 0) return removed;
  let remaining = totalDeaths;
  for (const m of caravan.crew) {
    if (remaining <= 0) break;
    const take = Math.min(m.count, remaining);
    if (take <= 0) continue;
    m.count -= take;
    remaining -= take;
    if (m.demographics !== undefined) {
      const mut = new Map(m.demographics);
      const drained = drainDemographics(mut, take, rng.derive(`drain-${m.kind}`));
      m.demographics = mut;
      removed.set(m.kind, drained);
    }
  }
  caravan.crew = caravan.crew.filter((m) => m.count > 0);
  return removed;
};
