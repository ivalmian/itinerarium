/**
 * Per-settlement market schedule builder.
 *
 * Bridges the per-resource demand/supply primitives (T12, T13) and the
 * per-settlement market clearing (T14). Given a Settlement + its stockpiles
 * + the resources to clear today, builds one (DemandSchedule, SupplySchedule)
 * pair per resource ready to hand to clearMarket.
 *
 * Reference: docs/04-population.md "Consumption per adult per day" + "Comfort
 * and status demand", docs/08-money-and-trade.md "Demand: how it forms" and
 * "Supply: how it forms", docs/11-politics-and-ownership.md (owner kinds and
 * their patience/urgency).
 *
 * v1 simplifications (documented inline so the tick-loop integration knows
 * which knobs to turn):
 *   - Per-class wealth and discretionary income are baked-in defaults below.
 *     The tick loop can override via the optional `wealthPerCapita` and
 *     `discretionaryIncomePerDay` inputs once a richer population-economics
 *     module lands. Numbers are coarse historical sanity, not tuned.
 *   - Subsistence and comfort/status mappings come straight from docs/04.
 *   - Building.capacity stands in for "recipe runnable today." We do not
 *     yet check labor availability when emitting derived-input demand —
 *     the engine (T11) will scale runs down at execution time.
 *   - Owner urgency derives from the `ownerKindByActor` lookup the caller
 *     supplies; absent kinds default to a middle-of-the-road urgency 1.
 *   - Production cost falls back to 0.8x recentLocalPrice; absent both,
 *     productionCost is 0 (the owner will sell at any price ≥ urgency-
 *     adjusted future expectation).
 *   - Storage holding days default to the resource's perishableDays (or 365
 *     for non-perishables). Spoilage urgency is wired through as the same
 *     value, since callers do not yet track per-stockpile age.
 */

import { allRecipes, type RecipeDef } from '../production/recipes.js';
import { getResource } from '../resources/catalog.js';
import { ACTOR_KINDS, type ActorKind } from '../politics/actor.js';
import type { CharacterClass } from '../population/types.js';
import type { AgeBand } from '../population/cohort.js';
import type { Settlement } from '../world/settlement.js';
import type { Season } from '../world/terrain.js';
import type { ActorId, Day, Quantity, ResourceId } from '../types.js';
import {
  aggregateDemand,
  comfortDemand,
  derivedInputDemand,
  statusDemand,
  subsistenceDemand,
  type DemandSchedule,
  type DemandSource,
} from './demand.js';
import { aggregateSupply, ownerSupply, type SupplySchedule, type SupplySource } from './supply.js';

// --- Public API -------------------------------------------------------------

export interface BuildScheduleInputs {
  readonly settlement: Settlement;
  readonly stockpilesByOwner: ReadonlyMap<ActorId, ReadonlyMap<ResourceId, Quantity>>;
  readonly resources: readonly ResourceId[];
  readonly recentLocalPrices: ReadonlyMap<ResourceId, number>;
  readonly today: Day;
  readonly season: Season;
  /**
   * Optional per-class average wealth (cash + liquidatable assets). The
   * subsistence curve uses wealth / need to find the price at which the
   * segment starts being priced out. Defaults below.
   */
  readonly wealthPerCapita?: ReadonlyMap<CharacterClass, number>;
  /**
   * Optional per-class daily discretionary spend. Drives the comfort decay
   * rate (and is the upper-bound budget for the comfort curve). Defaults below.
   */
  readonly discretionaryIncomePerDay?: ReadonlyMap<CharacterClass, number>;
  /**
   * Optional kind lookup. Used to set the owner urgency factor (patrician
   * patient vs hamlet desperate). Absent owners default to urgency = 1.
   */
  readonly ownerKindByActor?: ReadonlyMap<ActorId, ActorKind>;
}

export interface SettlementSchedules {
  readonly schedulesByResource: ReadonlyMap<
    ResourceId,
    { readonly demand: DemandSchedule; readonly supply: SupplySchedule }
  >;
}

export const buildSettlementSchedules = (inputs: BuildScheduleInputs): SettlementSchedules => {
  const out = new Map<
    ResourceId,
    { readonly demand: DemandSchedule; readonly supply: SupplySchedule }
  >();
  for (const resource of inputs.resources) {
    const demandSources: DemandSource[] = [
      ...subsistenceSources(resource, inputs),
      ...comfortSources(resource, inputs),
      ...statusSources(resource, inputs),
      ...derivedInputSources(resource, inputs),
    ];
    const supplySources = supplyForResource(resource, inputs);
    out.set(resource, {
      demand: aggregateDemand(demandSources),
      supply: aggregateSupply(supplySources),
    });
  }
  return { schedulesByResource: out };
};

// --- Defaults ---------------------------------------------------------------

const DEFAULT_WEALTH_PER_CAPITA: Readonly<Record<CharacterClass, number>> = Object.freeze({
  // Coin-equivalent reserve drawn on for subsistence purchase. v1 numbers
  // are coarse: a patrician keeps multiple hundreds of denarii on hand or
  // in plate; a plebeian carries a few; a freedman less. Slaves do not
  // hold coin themselves but they DO eat — docs/04: "subsistence calories
  // + minimal salt + minimal clothing only." We model that by attributing
  // a small per-slave maintenance budget that stands in for the master's
  // allocation to feeding them, since that allocation moves through the
  // local market when the master buys grain. The master's own surplus
  // wealth still counts via the patrician segment.
  patrician: 5000,
  plebeian: 30,
  freedman: 15,
  slave: 5,
  foreigner: 50,
});

const DEFAULT_DISCRETIONARY_PER_DAY: Readonly<Record<CharacterClass, number>> = Object.freeze({
  // Daily comfort budget in coin units. Patricians have plenty; plebeians a
  // little; slaves zero. Foreigners (resident merchants etc.) are between.
  patrician: 50,
  plebeian: 1,
  freedman: 0.5,
  slave: 0,
  foreigner: 2,
});

/**
 * Subsistence calorie/salt/fuel needs in resource-units per adult per day.
 * Numbers from docs/04 §"Consumption per adult per day": ~0.4 kg grain
 * equivalent (≈ 0.06 modii at ~6.7 kg/modius), ~7 g salt, ~0.7 kg fuel
 * (≈ 0.001 cord at 700 kg/cord).
 *
 * Slaves get only the calorie + salt floor per docs/04 §"Slaves: subsistence
 * calories + minimal salt + minimal clothing only".
 */
const SUBSISTENCE_NEEDS_FREE: Readonly<Record<string, number>> = Object.freeze({
  'food.grain': 0.06,
  'mineral.salt': 0.00028,
  'material.wood': 0.001,
});

const SUBSISTENCE_NEEDS_SLAVE: Readonly<Record<string, number>> = Object.freeze({
  'food.grain': 0.06,
  'mineral.salt': 0.00028,
});

/** Free populations want these comfort goods. Slaves do not. */
const COMFORT_WANTS: ReadonlySet<string> = new Set([
  'food.wine',
  'food.olive_oil',
  'food.cheese',
  'food.salted_meat',
  'food.salted_fish',
  'goods.cloth',
  'goods.clothing',
  'goods.furniture',
  'material.pottery',
]);

/** Per-adult comfort want intensity (units per day). Coarse v1 numbers. */
const COMFORT_WANT_QTY: Readonly<Record<string, number>> = Object.freeze({
  'food.wine': 0.02, // a small fraction of an amphora — each adult wants a sip a day
  'food.olive_oil': 0.005,
  'food.cheese': 0.01,
  'food.salted_meat': 0.01,
  'food.salted_fish': 0.01,
  'goods.cloth': 0.0014, // ~1 garment / 700 days; cloth/clothing roughly equivalent
  'goods.clothing': 0.0014,
  'goods.furniture': 0.0001,
  'material.pottery': 0.001,
});

/** Status goods only patricians (and the governor) want. */
const STATUS_WANTS: ReadonlySet<string> = new Set([
  'goods.luxury_textiles',
  'metal.silver',
  'metal.gold',
  'exotic.spices',
  'exotic.silk',
  'exotic.incense',
  'exotic.dyes',
]);

/** Per-adult status want intensity. Tiny — elite quantities are small but the wallet is deep. */
const STATUS_WANT_QTY: Readonly<Record<string, number>> = Object.freeze({
  'goods.luxury_textiles': 0.001,
  'metal.silver': 0.0005,
  'metal.gold': 0.00005,
  'exotic.spices': 0.0005,
  'exotic.silk': 0.0002,
  'exotic.incense': 0.0002,
  'exotic.dyes': 0.0001,
});

/**
 * Owner urgency by ActorKind. Patrician families and the governor's office
 * can sit on a stockpile for weeks; hamlet households need cash today;
 * caravan owners and city corporations are in between. Bandit camps are
 * desperate by definition.
 */
const URGENCY_BY_KIND: Readonly<Record<ActorKind, number>> = Object.freeze({
  patrician_family: 0,
  governor_office: 0,
  city_corporation: 0.3,
  off_map_house: 0.2,
  player: 0.5,
  caravan_owner: 0.5,
  free_village: 1.0,
  hamlet_household: 1.5,
  temple: 0.2,
  bandit_camp: 2.5,
});

const DEFAULT_OWNER_URGENCY = 1;
/** Margin floor below which the producer doesn't bother. v1: 5%. */
const DERIVED_INPUT_MARGIN = 0.05;
/** Reservation = ratio × recentLocalPrice when no productionCost is supplied. */
const DEFAULT_PRODUCTION_COST_RATIO = 0.8;

// --- Age multiplier ---------------------------------------------------------

const AGE_MULTIPLIER: Readonly<Record<AgeBand, number>> = Object.freeze({
  '0-4': 0.5,
  '5-9': 0.5,
  '10-14': 0.5,
  '15-19': 1,
  '20-24': 1,
  '25-29': 1,
  '30-34': 1,
  '35-39': 1,
  '40-44': 1,
  '45-49': 1,
  '50-54': 1,
  '55-59': 1,
  '60-64': 1,
  '65-69': 0.8,
  '70-74': 0.8,
  '75-79': 0.8,
  '80+': 0.8,
});

// --- Demand: subsistence ----------------------------------------------------

const subsistenceSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  // Aggregate effective adult-equivalent counts per class.
  const adultEquivalentByClass = adultEquivalents(inputs.settlement);
  const wealthMap = inputs.wealthPerCapita ?? toMap(DEFAULT_WEALTH_PER_CAPITA);
  for (const [klass, adultEqCount] of adultEquivalentByClass) {
    if (adultEqCount <= 0) continue;
    const needsTable = klass === 'slave' ? SUBSISTENCE_NEEDS_SLAVE : SUBSISTENCE_NEEDS_FREE;
    const perAdult = needsTable[String(resource)];
    if (perAdult === undefined) continue;
    const totalNeed = perAdult * adultEqCount;
    if (totalNeed <= 0) continue;
    const wealthPerHead = wealthMap.get(klass) ?? 0;
    // Total segment wealth = per-capita × headcount (use raw cohort heads,
    // not adult-equivalents — wealth is held per person).
    const headCount = headsOfClass(inputs.settlement, klass);
    const segmentWealth = wealthPerHead * headCount;
    out.push(
      subsistenceDemand({
        id: `subsistence:${String(inputs.settlement.id)}:${klass}:${String(resource)}`,
        needPerDay: totalNeed,
        segmentWealth,
      }),
    );
  }
  return out;
};

// --- Demand: comfort --------------------------------------------------------

const comfortSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
): readonly DemandSource[] => {
  if (!COMFORT_WANTS.has(String(resource))) return [];
  const wantPerAdult = COMFORT_WANT_QTY[String(resource)] ?? 0;
  if (wantPerAdult <= 0) return [];
  const out: DemandSource[] = [];
  const adultEqByClass = adultEquivalents(inputs.settlement);
  const budgetMap = inputs.discretionaryIncomePerDay ?? toMap(DEFAULT_DISCRETIONARY_PER_DAY);
  for (const [klass, adultEqCount] of adultEqByClass) {
    if (klass === 'slave') continue; // docs/04: no comfort demand
    if (adultEqCount <= 0) continue;
    const headCount = headsOfClass(inputs.settlement, klass);
    const totalWant = wantPerAdult * adultEqCount;
    const budgetPerHead = budgetMap.get(klass) ?? 0;
    const totalBudget = budgetPerHead * headCount;
    if (totalBudget <= 0) continue;
    out.push(
      comfortDemand({
        id: `comfort:${String(inputs.settlement.id)}:${klass}:${String(resource)}`,
        wantQuantity: totalWant,
        budget: totalBudget,
      }),
    );
  }
  return out;
};

// --- Demand: status ---------------------------------------------------------

const statusSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
): readonly DemandSource[] => {
  if (!STATUS_WANTS.has(String(resource))) return [];
  const wantPerAdult = STATUS_WANT_QTY[String(resource)] ?? 0;
  if (wantPerAdult <= 0) return [];
  const out: DemandSource[] = [];
  const adultEqByClass = adultEquivalents(inputs.settlement);
  const wealthMap = inputs.wealthPerCapita ?? toMap(DEFAULT_WEALTH_PER_CAPITA);
  // Status is patrician-only in v1. Governor's office demand is captured
  // separately by the patrician class for now (the governor is a patrician
  // of a specific family in docs/11).
  const adults = adultEqByClass.get('patrician') ?? 0;
  if (adults <= 0) return out;
  const heads = headsOfClass(inputs.settlement, 'patrician');
  const totalWant = wantPerAdult * adults;
  const wealthPerHead = wealthMap.get('patrician') ?? 0;
  const totalWealth = wealthPerHead * heads;
  // Threshold = wealth-per-want-unit × a generous multiplier. Patricians will
  // pay multiples of "fair" price for status goods; the step gives them a
  // ceiling that reflects their actual purse depth.
  const threshold = totalWant > 0 ? (totalWealth / totalWant) * 5 : 0;
  if (threshold <= 0) return out;
  out.push(
    statusDemand({
      id: `status:${String(inputs.settlement.id)}:patrician:${String(resource)}`,
      wantQuantity: totalWant,
      segmentWealth: totalWealth,
      veryHighThreshold: threshold,
    }),
  );
  return out;
};

// --- Demand: derived input -------------------------------------------------

const derivedInputSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  const buildingsHere = countBuildingsByKind(inputs.settlement);
  for (const recipe of allRecipes()) {
    if (!recipeUsesInput(recipe, resource)) continue;
    const buildingCap = buildingsHere.get(String(recipe.building)) ?? 0;
    if (buildingCap <= 0) continue;
    const seasonMul = recipe.seasonalMultiplier?.[inputs.season];
    if (seasonMul !== undefined && seasonMul <= 0) continue;
    // Pick a representative output to value (highest-revenue under
    // recentLocalPrices). v1 ignores joint products beyond the chosen one.
    const valued = pickRepresentativeOutput(recipe, inputs.recentLocalPrices);
    if (valued === undefined) continue;
    const inputPerOutput = (recipe.inputs.get(resource) ?? 0) / valued.qty;
    if (inputPerOutput <= 0) continue;
    const expectedRevenuePerInputUnit = valued.price / inputPerOutput;
    const otherCostsPerInputUnit = otherInputCostsPerInputUnit(
      recipe,
      resource,
      valued.qty,
      inputs.recentLocalPrices,
    );
    out.push(
      derivedInputDemand({
        id: `derived:${String(inputs.settlement.id)}:${String(recipe.id)}:${String(resource)}`,
        expectedOutputRevenuePerInputUnit: expectedRevenuePerInputUnit,
        otherCostsPerInputUnit,
        margin: DERIVED_INPUT_MARGIN,
        productionCapacity: buildingCap * (seasonMul ?? 1),
        inputPerOutput,
      }),
    );
  }
  return out;
};

const recipeUsesInput = (recipe: RecipeDef, resource: ResourceId): boolean => {
  for (const k of recipe.inputs.keys()) {
    if (String(k) === String(resource)) return true;
  }
  return false;
};

const pickRepresentativeOutput = (
  recipe: RecipeDef,
  prices: ReadonlyMap<ResourceId, number>,
): { readonly resource: ResourceId; readonly qty: number; readonly price: number } | undefined => {
  let best: { resource: ResourceId; qty: number; price: number } | undefined;
  for (const [out, qty] of recipe.outputs) {
    const price = prices.get(out);
    if (price === undefined || price <= 0 || qty <= 0) continue;
    const revenue = qty * price;
    if (best === undefined || revenue > best.qty * best.price) {
      best = { resource: out, qty, price };
    }
  }
  return best;
};

const otherInputCostsPerInputUnit = (
  recipe: RecipeDef,
  primary: ResourceId,
  outputQty: number,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  // Sum the cost of every non-primary input per unit of output, then divide
  // through by the input-per-output ratio so it is comparable to the
  // expectedRevenuePerInputUnit term.
  let perOutputCost = 0;
  for (const [r, qty] of recipe.inputs) {
    if (String(r) === String(primary)) continue;
    const price = prices.get(r) ?? 0;
    if (price <= 0 || qty <= 0) continue;
    perOutputCost += (qty / outputQty) * price;
  }
  const primaryQty = recipe.inputs.get(primary) ?? 0;
  if (primaryQty <= 0) return 0;
  // perOutputCost is cost per 1 unit of output. inputPerOutput = primaryQty / outputQty.
  // We want cost per 1 unit of *primary input*, i.e., perOutputCost / inputPerOutput.
  const inputPerOutput = primaryQty / outputQty;
  return inputPerOutput > 0 ? perOutputCost / inputPerOutput : 0;
};

// --- Supply ----------------------------------------------------------------

const supplyForResource = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
): readonly SupplySource[] => {
  const out: SupplySource[] = [];
  const recentPrice = inputs.recentLocalPrices.get(resource) ?? 0;
  for (const [ownerActor, byResource] of inputs.stockpilesByOwner) {
    const qty = byResource.get(resource);
    if (qty === undefined || qty <= 0) continue;
    const kind = inputs.ownerKindByActor?.get(ownerActor);
    const urgency =
      kind !== undefined && (ACTOR_KINDS as readonly ActorKind[]).includes(kind)
        ? URGENCY_BY_KIND[kind]
        : DEFAULT_OWNER_URGENCY;
    const productionCost = recentPrice > 0 ? recentPrice * DEFAULT_PRODUCTION_COST_RATIO : 0;
    const expectedFuturePrice = recentPrice;
    const def = getResource(resource);
    const storageHoldingDays = def.perishableDays ?? 365;
    out.push(
      ownerSupply({
        id: `supply:${String(inputs.settlement.id)}:${String(ownerActor)}:${String(resource)}`,
        ownerActor,
        stockpile: qty,
        reservedForOwnUse: 0,
        productionCost,
        expectedFuturePrice,
        ownerUrgencyFactor: urgency,
        storageHoldingDays,
        // We do not yet track per-stockpile age. When the storage subsystem
        // lands, perishables can fill in spoilageDaysRemaining here.
        ...(def.perishableDays !== undefined ? { spoilageDaysRemaining: def.perishableDays } : {}),
      }),
    );
  }
  return out;
};

// --- Helpers ---------------------------------------------------------------

const adultEquivalents = (settlement: Settlement): Map<CharacterClass, number> => {
  const out = new Map<CharacterClass, number>();
  for (const [key, count] of settlement.population.cohorts()) {
    const mul = AGE_MULTIPLIER[key.age] ?? 1;
    const adultEq = count * mul;
    out.set(key.class, (out.get(key.class) ?? 0) + adultEq);
  }
  return out;
};

const headsOfClass = (settlement: Settlement, klass: CharacterClass): number => {
  let total = 0;
  for (const [key, count] of settlement.population.cohorts()) {
    if (key.class === klass) total += count;
  }
  return total;
};

const countBuildingsByKind = (settlement: Settlement): Map<string, number> => {
  // Sum capacity across all instances of each building type.
  const out = new Map<string, number>();
  for (const b of settlement.buildings) {
    if (b.capacity <= 0) continue;
    const k = String(b.buildingId);
    out.set(k, (out.get(k) ?? 0) + b.capacity);
  }
  return out;
};

const toMap = <K extends string, V>(rec: Readonly<Record<K, V>>): ReadonlyMap<K, V> => {
  const m = new Map<K, V>();
  for (const k of Object.keys(rec) as K[]) {
    m.set(k, rec[k]);
  }
  return m;
};
