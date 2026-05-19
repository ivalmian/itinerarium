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
 *   - Supply reservation is anchored to marginal cost where a producing
 *     recipe exists. Pure extraction with no priced inputs falls back to a
 *     physical salvage floor so raw producers do not sell at literal zero
 *     before the labor/price chain has bootstrapped.
 *   - Expected future price is discounted toward marginal cost when a seller
 *     holds more than roughly 30 days of local absorption. This keeps stale
 *     scarcity prices from surviving after inventory has actually piled up.
 *   - Storage holding days default to the resource's perishableDays (or 365
 *     for non-perishables). Spoilage urgency is wired through as the same
 *     value, since callers do not yet track per-stockpile age.
 */

import { allRecipes, type RecipeDef } from '../production/recipes.js';
import { allBuildings } from '../buildings/catalog.js';
import { getResource } from '../resources/catalog.js';
import type { ActorKind } from '../politics/actor.js';
import { CHARACTER_CLASSES, type CharacterClass } from '../population/types.js';
import {
  allocatedWorkersForJobForOwner,
  buildLaborClassContext,
  wageEarningWorkerDaysForLaborForOwner,
  type LaborClassContext,
} from '../jobs/laborEconomics.js';
import type { Settlement } from '../world/settlement.js';
import type { HexGrid } from '../world/grid.js';
import type { Season } from '../world/terrain.js';
import type { ActorId, BuildingId, Day, Quantity, ResourceId } from '../types.js';
import {
  aggregateDemand,
  comfortDemandDirect,
  derivedInputDemandDirect,
  statusDemandDirect,
  subsistenceDemandDirect,
  type DemandSchedule,
  type DemandSource,
} from './demand.js';
import {
  aggregateSupply,
  ownerSupplyDirect,
  type SupplySchedule,
  type SupplySource,
} from './supply.js';

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
  /** Optional live treasury lookup. When present, demand is cash-budgeted. */
  readonly actorTreasuryByActor?: ReadonlyMap<ActorId, number>;
  /** Optional precomputed labor context for callers already walking the settlement this tick. */
  readonly laborClassContext?: LaborClassContext;
  /** Optional terrain grid; when present, extraction demand respects deposits. */
  readonly grid?: HexGrid;
}

export interface SettlementSchedules {
  readonly schedulesByResource: ReadonlyMap<
    ResourceId,
    { readonly demand: DemandSchedule; readonly supply: SupplySchedule }
  >;
}

export interface SettlementDemandSourceBuilder {
  sourcesFor(
    resource: ResourceId,
    actorTreasuryByActor?: ReadonlyMap<ActorId, number>,
  ): readonly DemandSource[];
}

export const buildSettlementSchedules = (inputs: BuildScheduleInputs): SettlementSchedules => {
  const out = new Map<
    ResourceId,
    { readonly demand: DemandSchedule; readonly supply: SupplySchedule }
  >();
  const context = buildSettlementScheduleContext(inputs);
  // Per docs/15 §C26: precompute the set of priced resources each
  // market-maker actor will spread its treasury across — for the
  // per-resource bid sizing.
  const marketMakerDemandActors = buildMarketMakerDemandActors(inputs, context.ownerCandidates);
  for (const resource of inputs.resources) {
    const demandSources = demandSourcesForResource(
      resource,
      inputs,
      context,
      marketMakerDemandActors,
    );
    const demand = aggregateDemand(demandSources);
    const supplySources = supplyForResource(resource, inputs, context, demand);
    // MM ask remains additive — it's the +5% residual price tier above
    // concrete asks. Concrete asks sit at MC (lower); MM ask only
    // engages when demand walks up the supply ladder past MC.
    const marketMakerSupply = marketMakerSupplySources(resource, inputs, context);
    const supplyWithMM =
      marketMakerSupply.length === 0
        ? supplySources
        : appendSupplySources(supplySources, marketMakerSupply);
    out.set(resource, {
      demand,
      supply: aggregateSupply(supplyWithMM),
    });
  }
  return { schedulesByResource: out };
};

export const createSettlementDemandSourceBuilder = (
  inputs: Omit<BuildScheduleInputs, 'resources'>,
): SettlementDemandSourceBuilder => {
  const baseInputs: BuildScheduleInputs = { ...inputs, resources: [] };
  const baseContext = buildSettlementScheduleContext(baseInputs);
  return {
    sourcesFor(
      resource: ResourceId,
      actorTreasuryByActor: ReadonlyMap<ActorId, number> | undefined = inputs.actorTreasuryByActor,
    ): readonly DemandSource[] {
      const resourceInputs: BuildScheduleInputs =
        actorTreasuryByActor === inputs.actorTreasuryByActor
          ? baseInputs
          : {
              ...baseInputs,
              ...(actorTreasuryByActor !== undefined ? { actorTreasuryByActor } : {}),
            };
      const context: SettlementScheduleContext =
        actorTreasuryByActor === baseContext.actorTreasuryByActor
          ? baseContext
          : {
              ...baseContext,
              ...(actorTreasuryByActor !== undefined ? { actorTreasuryByActor } : {}),
            };
      const marketMakerDemandActors = buildSingleResourceMarketMakerActors(
        resource,
        resourceInputs,
        context.ownerCandidates,
      );
      return demandSourcesForResource(resource, resourceInputs, context, marketMakerDemandActors);
    },
  };
};

const demandSourcesForResource = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
  marketMakerDemandActors: readonly MarketMakerDemandActor[],
): DemandSource[] => {
  const resourceKey: string = resource;
  const demandSources: DemandSource[] = [];
  const sourceFlags = DEMAND_SOURCE_FLAGS_BY_RESOURCE_KEY.get(resourceKey) ?? 0;
  if ((sourceFlags & DEMAND_SOURCE_SUBSISTENCE) !== 0) {
    appendDemandSources(demandSources, subsistenceSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_COMFORT) !== 0) {
    appendDemandSources(demandSources, comfortSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_STATUS) !== 0) {
    appendDemandSources(demandSources, statusSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_SERVICE) !== 0) {
    appendDemandSources(demandSources, serviceDemandSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_INSTITUTIONAL) !== 0) {
    appendDemandSources(demandSources, institutionalSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_CONSTRUCTION_RESERVE) !== 0) {
    appendDemandSources(demandSources, constructionReserveSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_TRANSPORT_CAPITAL) !== 0) {
    appendDemandSources(demandSources, transportCapitalSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_PRODUCTIVE_CAPITAL) !== 0) {
    appendDemandSources(demandSources, productiveCapitalSources(resource, inputs, context));
  }
  if ((sourceFlags & DEMAND_SOURCE_DERIVED_INPUT) !== 0) {
    appendDemandSources(demandSources, derivedInputSources(resource, inputs, context));
  }
  const minConcreteFiniteWtp = minFiniteWtpForConcreteSources(demandSources);
  appendDemandSources(
    demandSources,
    marketMakerDemandSources(
      resource,
      inputs,
      context,
      marketMakerDemandActors,
      minConcreteFiniteWtp,
    ),
  );
  return demandSources;
};

/**
 * Per docs/15 §C27: the minimum FINITE maxWillingnessToPay among the
 * concrete (non-MM) demand sources for a resource. Subsistence has
 * `maxWillingnessToPay = +Infinity` so it's excluded from this min —
 * market-makers don't need to outbid an infinite WTP; they only need to
 * sit below other finite bids. Returns Infinity when there is no finite
 * concrete bid (i.e., only subsistence or no demand at all), in which
 * case MM bids at its full -5% offset.
 */
const minFiniteWtpForConcreteSources = (sources: readonly DemandSource[]): number => {
  let min = Number.POSITIVE_INFINITY;
  for (const src of sources) {
    const wtp = src.maxWillingnessToPay;
    if (!Number.isFinite(wtp)) continue;
    if (wtp <= 0) continue;
    if (wtp < min) min = wtp;
  }
  return min;
};

const appendDemandSources = (target: DemandSource[], sources: readonly DemandSource[]): void => {
  for (const source of sources) target.push(source);
};

const appendSupplySources = (
  target: readonly SupplySource[],
  sources: readonly SupplySource[],
): readonly SupplySource[] => {
  const mutable = target as SupplySource[];
  for (const source of sources) mutable.push(source);
  return mutable;
};

const NO_DEMAND_SOURCES: readonly DemandSource[] = Object.freeze([]);
const NO_SUPPLY_SOURCES: readonly SupplySource[] = Object.freeze([]);
const NO_MARKET_MAKER_DEMAND_ACTORS: readonly MarketMakerDemandActor[] = Object.freeze([]);

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

const DEFAULT_WEALTH_PER_CAPITA_MAP = toMap(DEFAULT_WEALTH_PER_CAPITA);

const DEFAULT_DISCRETIONARY_PER_DAY: Readonly<Record<CharacterClass, number>> = Object.freeze({
  // Daily comfort budget in coin units. Patricians have plenty; plebeians a
  // little; slaves zero. Foreigners (resident merchants etc.) are between.
  patrician: 50,
  plebeian: 1,
  freedman: 0.5,
  slave: 0,
  foreigner: 2,
});

const DEFAULT_DISCRETIONARY_PER_DAY_MAP = toMap(DEFAULT_DISCRETIONARY_PER_DAY);

/**
 * Subsistence calorie/salt/fuel needs in resource-units per adult per day.
 * Numbers from docs/04 §"Consumption per adult per day": ~0.4 kg staple
 * equivalent, ~7 g salt, ~0.7 kg fuel (≈ 0.001 cord at 700 kg/cord).
 *
 * The staple ration is deliberately mixed instead of grain-only. Grain is
 * still the backbone, but bread and legumes are direct household purchases:
 * otherwise bakeries and legume farms produce into a market with no normal
 * buyers and the price system cannot value them. Flour remains primarily a
 * producer input: households that bake at home buy grain and hand-mill it
 * rather than creating tiny flour bids in every rural market.
 *
 * Slaves get only the calorie + salt floor per docs/04 §"Slaves: subsistence
 * calories + minimal salt + minimal clothing only".
 */
const SUBSISTENCE_NEEDS_FREE: Readonly<Record<string, number>> = Object.freeze({
  'food.grain': 0.04,
  'food.bread': 0.08,
  'food.legumes': 0.008,
  'mineral.salt': 0.00028,
  'material.wood': 0.001,
});

const SUBSISTENCE_NEEDS_SLAVE: Readonly<Record<string, number>> = Object.freeze({
  'food.grain': 0.045,
  'food.bread': 0.05,
  'food.legumes': 0.008,
  'mineral.salt': 0.00028,
});

const SUBSISTENCE_RESOURCE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(SUBSISTENCE_NEEDS_FREE),
  ...Object.keys(SUBSISTENCE_NEEDS_SLAVE),
]);

const HOUSEHOLD_BAKING_SHIFT_BY_TIER: Readonly<Record<Settlement['tier'], number>> = Object.freeze({
  hamlet: 0.85,
  village: 0.65,
  town: 0.15,
  small_city: 0,
  large_city: 0,
});

const subsistenceNeedPerAdult = (
  needsTable: Readonly<Record<string, number>>,
  resourceKey: string,
  tier: Settlement['tier'],
): number => {
  const base = needsTable[resourceKey] ?? 0;
  const breadNeed = needsTable['food.bread'] ?? 0;
  if (breadNeed <= 0) return base;
  const shiftedBreadUnits = breadNeed * (HOUSEHOLD_BAKING_SHIFT_BY_TIER[tier] ?? 0);
  if (shiftedBreadUnits <= 0) return base;

  if (resourceKey === 'food.bread') return Math.max(0, base - shiftedBreadUnits);

  const shiftedBreadKg =
    shiftedBreadUnits * getResource('food.bread' as ResourceId).weightKgPerUnit;
  if (resourceKey === 'food.grain') {
    return base + shiftedBreadKg / getResource('food.grain' as ResourceId).weightKgPerUnit;
  }
  return base;
};

/** Free populations want these comfort goods. Slaves do not. */
const COMFORT_WANTS: ReadonlySet<string> = new Set([
  'food.milk',
  'food.fish',
  'food.game',
  'food.grapes',
  'food.olives',
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

/**
 * Per-adult comfort want intensity (units per day). Calibrated against
 * the historical Roman per-capita reference table in docs/04 §"Per-
 * capita consumption sanity ranges" (Garnsey, Erdkamp, Jongman).
 *
 * Pre-v1.6 numbers were ~10x too low for wine, oil, pottery and
 * caused cities to accumulate multi-year stockpiles by Q8: production
 * outran the modeled demand. The values below land inside the
 * documented ranges (low-end for the working-class default; comfort-
 * budget shares + class multipliers raise the actual spend for richer
 * actors).
 */
const COMFORT_WANT_QTY: Readonly<Record<string, number>> = Object.freeze({
  'food.milk': 0.03,                  // unchanged — rural / soldier ration
  'food.fish': 0.012,                 // 4-10 kg/yr fresh fish band, low-end
  'food.game': 0.006,                 // unchanged
  'food.grapes': 0.003,               // seasonal raw produce
  'food.olives': 0.001,               // seasonal raw produce
  'food.wine': 0.25,                  // 90 L/yr ~ low-end plebeian (docs/04: 50-150 L)
  'food.olive_oil': 0.04,             // 15 kg/yr ~ mid plebeian (docs/04: 10-25 kg)
  'food.cheese': 0.012,               // 4.4 kg/yr (docs/04: 3-6 kg)
  'food.salted_meat': 0.025,          // 9 kg/yr ~ mid plebeian (docs/04: 5-15 kg)
  'food.salted_fish': 0.015,          // 5.5 kg/yr (docs/04: 4-10 kg)
  'goods.cloth': 0.005,               // 1.8 kg/yr (docs/04: 1.5-3 kg)
  'goods.clothing': 0.004,            // ~1.5 garments/yr (docs/04: 1-2)
  'goods.furniture': 0.0003,          // 0.11 pieces/yr (docs/04: 0.05-0.15)
  'material.pottery': 0.012,          // 4.4 vessels/yr replacement (docs/04: 3-6)
});

const COMFORT_BUDGET_SHARE: Readonly<Record<string, number>> = Object.freeze({
  'food.milk': 0.05,
  'food.fish': 0.08,
  'food.game': 0.06,
  'food.grapes': 0.02,
  'food.olives': 0.02,
  'food.wine': 0.2,
  'food.olive_oil': 0.1,
  'food.cheese': 0.1,
  'food.salted_meat': 0.1,
  'food.salted_fish': 0.1,
  'goods.cloth': 0.03,
  'goods.clothing': 0.17,
  'goods.furniture': 0.05,
  'material.pottery': 0.15,
});

const COMFORT_WANT_SEASONS: Readonly<Record<string, ReadonlySet<Season>>> = Object.freeze({
  'food.grapes': new Set<Season>(['autumn']),
  'food.olives': new Set<Season>(['autumn']),
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

const STATUS_BUDGET_SHARE: Readonly<Record<string, number>> = Object.freeze({
  'goods.luxury_textiles': 0.22,
  'metal.silver': 0.18,
  'metal.gold': 0.12,
  'exotic.spices': 0.18,
  'exotic.silk': 0.14,
  'exotic.incense': 0.1,
  'exotic.dyes': 0.06,
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
  // Per docs/15 §C21 the legacy `common_household` aggregate is split into
  // three per-class household actors. Each carries the same "needs cash this
  // week" urgency profile as the old common_household did.
  plebeian_household: 1.2,
  freedman_household: 1.2,
  foreigner_household: 1.2,
  free_village: 1.0,
  hamlet_household: 1.5,
  temple: 0.2,
  bandit_camp: 2.5,
  // Merchant guilds (docs/15 §C17) hold dues + bond money; not urgent.
  merchant_guild: 0.1,
});

const CONSUMER_BUYER_KIND_PRIORITY: Readonly<Record<CharacterClass, readonly ActorKind[]>> =
  Object.freeze({
    patrician: ['patrician_family', 'governor_office', 'city_corporation', 'player'],
    // Per docs/15 §C21 each class bids primarily through its own
    // class-level household actor. Hamlet/free-village fall back to the
    // single settlement-level household; the city corp + patrician are
    // last-resort buyers (e.g., grain rations for civic relief).
    plebeian: [
      'plebeian_household',
      'hamlet_household',
      'free_village',
      'city_corporation',
      'patrician_family',
    ],
    freedman: [
      'freedman_household',
      'hamlet_household',
      'free_village',
      'city_corporation',
      'patrician_family',
    ],
    foreigner: [
      'foreigner_household',
      'hamlet_household',
      'free_village',
      'city_corporation',
      'patrician_family',
    ],
    // Slaves are owner-funded subsistence per docs/11. They bid through whoever
    // owns them: a patrician estate, the city corp, or a hamlet/free-village
    // collective. There is intentionally no slave_household actor.
    slave: ['patrician_family', 'city_corporation', 'hamlet_household', 'free_village', 'temple'],
  });

const DEFAULT_OWNER_URGENCY = 1;
/** Margin floor below which the producer doesn't bother. v1: 5%. */
const DERIVED_INPUT_MARGIN = 0.05;
/** Producers stop bidding for inputs once they hold this many days of output. */
const DEFAULT_PRODUCER_OUTPUT_STOCK_TARGET_DAYS = 14;
const PRODUCER_OUTPUT_STOCK_TARGET_DAYS_BY_RESOURCE: ReadonlyMap<string, number> = new Map([
  // Per docs/03 "Military and capital workshop outputs are even tighter":
  // weapons/armor/shields keep tiny showroom buffers unless garrisons
  // or merchant capital is actively buying. Each archetype carries the
  // same low target; the procurement side decides what actually gets
  // ordered (see INSTITUTIONAL_PROCUREMENT_BY_BUILDING below).
  ['goods.gladius', 0.05],
  ['goods.hasta', 0.05],
  ['goods.pilum', 0.05],
  ['goods.dagger', 0.05],
  ['goods.bow', 0.05],
  ['goods.arrow', 0.2],
  ['goods.sling', 0.05],
  ['goods.sling_bullet', 0.2],
  ['goods.helmet', 0.05],
  ['goods.body_armor', 0.02],
  ['goods.shield', 0.05],
  ['goods.cart', 0.1],
]);

const producerOutputStockTargetDays = (resource: ResourceId): number =>
  PRODUCER_OUTPUT_STOCK_TARGET_DAYS_BY_RESOURCE.get(resource) ??
  DEFAULT_PRODUCER_OUTPUT_STOCK_TARGET_DAYS;
/** Sellers carrying more than this many days of local absorption cut asks. */
const SELLER_INVENTORY_TARGET_DAYS = 30;
/** Keep a nonzero opportunity premium even under extreme overstock. */
const MAX_INVENTORY_PRESSURE_DISCOUNT = 0.9;
/**
 * Numerical dust filter. A treasury this small is float-arithmetic
 * residue, not real money. The integer-coin discipline (docs/08
 * §"Integer-coin prices") is enforced at the *bid quote* layer via
 * `integerCoinBid` — sub-1-coin bid WTPs floor up to 1 coin or zero
 * out cleanly. THIS constant is just the "is anything here at all"
 * gate, and stays at numerical-dust scale.
 */
const MIN_EFFECTIVE_MARKET_BUDGET = 1e-6;
/** Reservation = ratio × recentLocalPrice when no productionCost is supplied. */
const DEFAULT_PRODUCTION_COST_RATIO = 0.8;
/**
 * Minimum structural ask in coins per kg. This is not a target price; it is
 * the lowest salvage value a rational seller accepts when local price memory
 * has collapsed and MC is currently unpriced. Values are deliberately small
 * relative to normal scarcity/import ceilings.
 */
/**
 * Per-category salvage floors (coin / kg). These are the lowest
 * structural ask a rational seller accepts when MC is unpriced.
 *
 * Scaled 5× from the pre-realism-pass baseline so the integer-coin
 * quote rule (docs/08 §"Integer-coin prices") clears chains above
 * the 1-coin floor more often. Sub-1 staples (grain at historical
 * ~0.05 coin/kg) still land on the 1-coin floor after the scale +
 * integer round, but refined and manufactured chains now keep some
 * structural price gradient instead of collapsing into a flat 1.
 */
const RESERVATION_FLOOR_COIN_PER_KG = Object.freeze({
  food: 0.25,
  material_tier0: 0.025,
  material_refined: 0.1,
  livestock: 0.05,
  mineral: 0.1,
  metal: 1,
  goods: 2.5,
  exotic: 5,
  people: 2.5,
  service: 0,
} as const);

interface InstitutionalProcurementLine {
  readonly resource: ResourceId;
  readonly quantityPerCapacity: number;
  readonly maxPriceMultiplier: number;
}

const INSTITUTIONAL_PROCUREMENT_BY_BUILDING: ReadonlyMap<
  string,
  readonly InstitutionalProcurementLine[]
> = new Map([
  [
    'barracks',
    [
      // ~24 soldiers × 0.06 modii/day, plus slow equipment upkeep.
      { resource: 'food.grain' as ResourceId, quantityPerCapacity: 1.5, maxPriceMultiplier: 8 },
      { resource: 'goods.tools' as ResourceId, quantityPerCapacity: 0.03, maxPriceMultiplier: 4 },
      // Per docs/03 §"Weapon-archetype substitution policy": a garrison
      // kit is one melee + one ranged + helmet + body_armor + shield per
      // soldier, with substitution priority gladius > hasta > dagger and
      // bow > sling > pilum. Procurement targets the preferred archetype
      // for each slot at roughly 1% per capacity-unit (matching the old
      // combined goods.weapons rate of 0.01), with fallback archetypes
      // ordered at lower rates so the substitution chain has stockpiles
      // to draw from when the primary is short.
      { resource: 'goods.gladius' as ResourceId, quantityPerCapacity: 0.007, maxPriceMultiplier: 4 },
      { resource: 'goods.hasta' as ResourceId, quantityPerCapacity: 0.002, maxPriceMultiplier: 4 },
      { resource: 'goods.pilum' as ResourceId, quantityPerCapacity: 0.005, maxPriceMultiplier: 4 },
      { resource: 'goods.dagger' as ResourceId, quantityPerCapacity: 0.005, maxPriceMultiplier: 4 },
      { resource: 'goods.bow' as ResourceId, quantityPerCapacity: 0.002, maxPriceMultiplier: 4 },
      { resource: 'goods.arrow' as ResourceId, quantityPerCapacity: 0.06, maxPriceMultiplier: 4 },
      { resource: 'goods.sling' as ResourceId, quantityPerCapacity: 0.001, maxPriceMultiplier: 4 },
      {
        resource: 'goods.sling_bullet' as ResourceId,
        quantityPerCapacity: 0.05,
        maxPriceMultiplier: 4,
      },
      { resource: 'goods.helmet' as ResourceId, quantityPerCapacity: 0.005, maxPriceMultiplier: 4 },
      {
        resource: 'goods.body_armor' as ResourceId,
        quantityPerCapacity: 0.003,
        maxPriceMultiplier: 4,
      },
      {
        resource: 'goods.shield' as ResourceId,
        quantityPerCapacity: 0.008,
        maxPriceMultiplier: 4,
      },
    ],
  ],
  [
    'temple',
    [
      { resource: 'food.grain' as ResourceId, quantityPerCapacity: 0.2, maxPriceMultiplier: 6 },
      { resource: 'food.wine' as ResourceId, quantityPerCapacity: 0.08, maxPriceMultiplier: 4 },
      {
        resource: 'food.olive_oil' as ResourceId,
        quantityPerCapacity: 0.02,
        maxPriceMultiplier: 4,
      },
      {
        resource: 'exotic.incense' as ResourceId,
        quantityPerCapacity: 0.01,
        maxPriceMultiplier: 6,
      },
    ],
  ],
  [
    'forum_market',
    [
      // Rural→urban staple flow (realism pass 8): cities buy grain as a
      // civic reserve well above local clearing so villages have a
      // structurally premium counter-party. With quantityPerCapacity
      // bumped 10× and maxPriceMultiplier 12× the forum's bid sits
      // high enough on the price ladder that the local-trade pass
      // sweeps grain in from neighbouring villages within transport
      // cost — exactly the "city pays farmer a premium" mechanic.
      { resource: 'food.grain' as ResourceId, quantityPerCapacity: 2.0, maxPriceMultiplier: 12 },
      { resource: 'food.legumes' as ResourceId, quantityPerCapacity: 0.4, maxPriceMultiplier: 8 },
      { resource: 'food.cheese' as ResourceId, quantityPerCapacity: 0.2, maxPriceMultiplier: 6 },
      { resource: 'goods.tools' as ResourceId, quantityPerCapacity: 0.02, maxPriceMultiplier: 3 },
      { resource: 'goods.cloth' as ResourceId, quantityPerCapacity: 0.02, maxPriceMultiplier: 3 },
    ],
  ],
]);

const INSTITUTIONAL_PROCUREMENT_RESOURCE_KEYS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const lines of INSTITUTIONAL_PROCUREMENT_BY_BUILDING.values()) {
    for (const line of lines) out.add(String(line.resource));
  }
  return out;
})();

interface ServiceCapacityLine {
  readonly resource: ResourceId;
  readonly quantityPerCapacity: number;
  readonly reservationPrice: number;
}

const SERVICE_CAPACITY_BY_BUILDING: ReadonlyMap<string, readonly ServiceCapacityLine[]> = new Map([
  [
    'barracks',
    [
      {
        resource: 'service.garrison' as ResourceId,
        quantityPerCapacity: 0.01,
        reservationPrice: 18,
      },
    ],
  ],
  [
    'forum_market',
    [
      {
        resource: 'service.administration' as ResourceId,
        quantityPerCapacity: 0.012,
        reservationPrice: 10,
      },
      {
        resource: 'service.public_works' as ResourceId,
        quantityPerCapacity: 0.015,
        reservationPrice: 12,
      },
    ],
  ],
  [
    'temple',
    [
      {
        resource: 'service.priesthood' as ResourceId,
        quantityPerCapacity: 0.01,
        reservationPrice: 6,
      },
    ],
  ],
]);

const SERVICE_DEMAND_RESOURCES: readonly ResourceId[] = Object.freeze([
  'service.garrison' as ResourceId,
  'service.administration' as ResourceId,
  'service.priesthood' as ResourceId,
  'service.public_works' as ResourceId,
]);

const SERVICE_DEMAND_RESOURCE_IDS: ReadonlySet<ResourceId> = new Set(SERVICE_DEMAND_RESOURCES);
const SERVICE_DEMAND_RESOURCE_KEYS: ReadonlySet<string> = new Set(
  SERVICE_DEMAND_RESOURCES.map((resource) => String(resource)),
);

export const serviceMarketResources = (): readonly ResourceId[] => SERVICE_DEMAND_RESOURCES;

const SERVICE_TIER_FLOOR: Readonly<Record<Settlement['tier'], number>> = Object.freeze({
  hamlet: 0.02,
  village: 0.05,
  town: 0.12,
  small_city: 0.3,
  large_city: 0.6,
});

const SERVICE_CIVIC_BUYER_PRIORITY: readonly ActorKind[] = [
  'city_corporation',
  'governor_office',
  'free_village',
  'hamlet_household',
  'patrician_family',
];

const CONSTRUCTION_RESERVE_OWNER_KINDS: ReadonlySet<ActorKind> = new Set([
  'patrician_family',
  'city_corporation',
  'governor_office',
  'free_village',
  'hamlet_household',
]);

const TRANSPORT_CAPITAL_OWNER_KINDS: ReadonlySet<ActorKind> = new Set([
  'patrician_family',
  'caravan_owner',
  'off_map_house',
]);

const CONSTRUCTION_RESERVE_TIER_SCALE: Readonly<Record<Settlement['tier'], number>> = Object.freeze(
  {
    hamlet: 0.25,
    village: 0.5,
    town: 1,
    small_city: 1.75,
    large_city: 2.5,
  },
);

const CONSTRUCTION_RESERVE_KIND_SCALE: Readonly<Partial<Record<ActorKind, number>>> = Object.freeze(
  {
    patrician_family: 1,
    city_corporation: 1.25,
    governor_office: 1.5,
    free_village: 0.6,
    hamlet_household: 0.35,
  },
);

const CONSTRUCTION_RESERVE_TARGET_BY_RESOURCE: Readonly<Record<string, number>> = (() => {
  const totals = new Map<string, number>();
  let count = 0;
  for (const building of allBuildings()) {
    count++;
    for (const [resource, qty] of building.constructionCost) {
      totals.set(String(resource), (totals.get(String(resource)) ?? 0) + qty);
    }
  }

  const out: Record<string, number> = {};
  for (const [resource, total] of totals) {
    // A one-building-at-a-time reserve, smoothed so investors do not try to
    // hold a complete civic megaproject before any construction can start.
    out[resource] = Math.max(0.25, (total / Math.max(1, count)) * 0.75);
  }
  return Object.freeze(out);
})();

const TRANSPORT_CAPITAL_TARGET_BY_RESOURCE: Readonly<Record<string, number>> = Object.freeze({
  // One herd unit is about six horses/mules/donkeys; a replacement caravan
  // needs roughly two herd units for its starting pack animals.
  'livestock.equines': 2,
  // Carts are optional capital for merchant houses, but produced carts need
  // a real buyer and replacement caravans can use them when available.
  'goods.cart': 1,
});

const CONSTRUCTION_RESERVE_TREASURY_SHARE = 0.08;
const TRANSPORT_CAPITAL_TREASURY_SHARE = 0.25;
const PRODUCTIVE_CAPITAL_PAYBACK_DAYS = 45;

export const institutionalProcurementResourcesForBuilding = (
  buildingId: BuildingId,
): readonly ResourceId[] => {
  const lines = INSTITUTIONAL_PROCUREMENT_BY_BUILDING.get(String(buildingId));
  if (lines === undefined) return [];
  return lines.map((line) => line.resource);
};

// --- Age multiplier ---------------------------------------------------------

interface SettlementScheduleContext {
  readonly adultEquivalentByClass: ReadonlyMap<CharacterClass, number>;
  readonly adultEquivalentTotal: number;
  readonly headsByClass: ReadonlyMap<CharacterClass, number>;
  readonly buildingsByKind: ReadonlyMap<string, number>;
  readonly buildingsById: ReadonlyMap<BuildingId, ReadonlyArray<Settlement['buildings'][number]>>;
  readonly buildings: Settlement['buildings'];
  readonly wagePerWorkerDay: number;
  readonly ownerCandidates: readonly ActorId[];
  readonly ownerCandidatesByKind?: ReadonlyMap<ActorKind, readonly ActorId[]>;
  readonly stockpilesByOwner: ReadonlyMap<ActorId, ReadonlyMap<ResourceId, Quantity>>;
  readonly marketMakerStockByResource: ReadonlyMap<ResourceId, readonly MarketMakerStockEntry[]>;
  /**
   * Per docs/15 §C21 the buyer for a consumer class can be multiple actors:
   * plebeians have ONE plebeian_household per settlement, but patricians have
   * 3-7 separate `patrician_family` actors per city — each with its own
   * treasury. Slaves similarly bid through all owner actors in the
   * settlement (city corp, governor, families, temples). When there is more
   * than one buyer for a class we split demand evenly so each buyer
   * contributes its own DemandSource with its own treasury cap, producing
   * the richer per-buyer bid-ask book documented in docs/15 §C21.
   */
  readonly consumerBuyersByClass: ReadonlyMap<CharacterClass, readonly ActorId[]>;
  readonly laborClassContext: LaborClassContext;
  readonly representativeOutputByRecipe: Map<RecipeDef, ValuedOutput | undefined>;
  readonly actorTreasuryByActor?: ReadonlyMap<ActorId, number>;
  readonly grid?: HexGrid;
}

interface ValuedOutput {
  readonly resource: ResourceId;
  readonly qty: number;
  readonly price: number;
}

interface MarketMakerStockEntry {
  readonly ownerActor: ActorId;
  readonly stock: Quantity;
}

interface MarketMakerDemandActor {
  readonly actor: ActorId;
  readonly perResourceBudget: number;
}

const buildSettlementScheduleContext = (inputs: BuildScheduleInputs): SettlementScheduleContext => {
  const settlement = inputs.settlement;
  const adultEquivalentByClass = new Map<CharacterClass, number>();
  const headsByClass = new Map<CharacterClass, number>();
  let adultEquivalentTotal = 0;
  for (const cls of CHARACTER_CLASSES) {
    const adultEq = settlement.population.adultEquivalentByClass(cls);
    if (adultEq > 0) {
      adultEquivalentByClass.set(cls, adultEq);
      adultEquivalentTotal += adultEq;
    }
    const heads = settlement.population.totalByClass(cls);
    if (heads > 0) headsByClass.set(cls, heads);
  }
  const candidates = ownerCandidates(inputs);
  const candidatesByKind = ownerCandidatesByKind(inputs.ownerKindByActor, candidates);
  return {
    adultEquivalentByClass,
    adultEquivalentTotal,
    headsByClass,
    buildingsByKind: countBuildingsByKind(settlement),
    buildingsById: indexBuildingsById(settlement),
    buildings: settlement.buildings,
    wagePerWorkerDay: laborCostPerWorkerDay(inputs.recentLocalPrices),
    ownerCandidates: candidates,
    ...(candidatesByKind !== undefined ? { ownerCandidatesByKind: candidatesByKind } : {}),
    stockpilesByOwner: inputs.stockpilesByOwner,
    marketMakerStockByResource: buildMarketMakerStockByResource(inputs),
    consumerBuyersByClass: buildConsumerBuyersByClass(inputs, candidates, candidatesByKind),
    laborClassContext: inputs.laborClassContext ?? buildLaborClassContext(settlement),
    representativeOutputByRecipe: new Map(),
    ...(inputs.actorTreasuryByActor !== undefined
      ? { actorTreasuryByActor: inputs.actorTreasuryByActor }
      : {}),
    ...(inputs.grid !== undefined ? { grid: inputs.grid } : {}),
  };
};

/**
 * Per the dormant-bid investigation in §C23: comfort/status demand sources
 * were being SKIPPED entirely when the buyer's treasury was zero, even
 * though there is real non-cash wealth (household stockpile, barter,
 * in-kind transfers, savings stashed in goods). That made the bid-ask book
 * silent on every consumed good in cities where households drained — the
 * player saw no bid for olive oil despite a city with 228k units in
 * stockpile and a population that wants it daily.
 *
 * `nominalBudgetFloorFraction` provides a small fraction of the nominal
 * (population-derived) budget as a soft floor even when actor treasury is
 * zero. Models the non-cash wealth households can leverage. The cleared
 * volume that floor unlocks is real but small (default 5% of nominal); the
 * primary effect is making the bid-ask book reflect the underlying want.
 */
const budgetCapForActor = (
  context: SettlementScheduleContext,
  actor: ActorId | undefined,
  fallback: number,
  nominalBudgetFloorFraction = 0,
): number => {
  if (actor === undefined || context.actorTreasuryByActor === undefined) {
    return effectiveMarketBudget(fallback);
  }
  const treasury = Math.max(0, context.actorTreasuryByActor.get(actor) ?? 0);
  const treasuryCapped = Math.min(fallback, treasury);
  const floor = Math.max(0, fallback * nominalBudgetFloorFraction);
  const budget = Math.max(treasuryCapped, Math.min(fallback, floor));
  return effectiveMarketBudget(budget);
};

/**
 * docs/15 §C23 was REVERTED in §C27. The original 5% nominal-budget floor
 * on comfort/status demand created bids that appeared in the residual
 * book but were cash-capped to 0 at trade execution — ghost bids that
 * never cleared. The bid-book coverage of consumed goods is now provided
 * by §C26 market-making (treasury-backed, real bids) instead. The
 * constants are kept at 0 to preserve the `budgetCapForActor` signature.
 */
const COMFORT_NOMINAL_FLOOR_FRACTION = 0;
const STATUS_NOMINAL_FLOOR_FRACTION = 0;

const minedResourceForRecipe = (recipe: RecipeDef): ResourceId | undefined => {
  if (String(recipe.building) !== 'mine') return undefined;
  for (const resource of recipe.outputs.keys()) {
    if (getResource(resource).category === 'mineral') return resource;
  }
  return undefined;
};

const buildingCanRunRecipe = (
  context: SettlementScheduleContext,
  building: Settlement['buildings'][number],
  recipe: RecipeDef,
): boolean => {
  const minedResource = minedResourceForRecipe(recipe);
  if (minedResource === undefined || context.grid === undefined) return true;
  const deposit = context.grid.get(building.hex)?.deposit;
  return deposit !== undefined && deposit.resource === minedResource && deposit.remaining > 0;
};

const outputInventoryConstrainedCapacity = (
  context: SettlementScheduleContext,
  owner: ActorId,
  valuedOutput: { readonly resource: ResourceId; readonly qty: number },
  productionCapacity: number,
): number => {
  if (productionCapacity <= 0 || valuedOutput.qty <= 0) return 0;
  const currentStock = context.stockpilesByOwner.get(owner)?.get(valuedOutput.resource) ?? 0;
  const targetStock =
    productionCapacity * valuedOutput.qty * producerOutputStockTargetDays(valuedOutput.resource);
  const gap = targetStock - currentStock;
  if (gap <= 0) return 0;
  return Math.min(productionCapacity, gap / valuedOutput.qty);
};

/**
 * Buyer kinds that participate in a settlement's communal subsistence
 * pool — the urban / village wage-earning households whose food
 * security historically came from their village's collective stores
 * before any of it went to market (docs/04 §"Community self-
 * provision"). When one of these actors needs subsistence calories at
 * a settlement where a `free_village` or `hamlet_household` owns
 * stockpiles, the household's effective subsistence budget is
 * credited with the value of the village/hamlet stockpile, and the
 * resulting trade settles at zero coin transfer — the food was
 * always the community's, just held in the headman's granary.
 */
const COMMUNITY_FOOD_BENEFICIARY_KINDS: ReadonlySet<ActorKind> = new Set([
  'plebeian_household',
  'freedman_household',
  'foreigner_household',
]);

const COMMUNITY_FOOD_PROVIDER_KINDS: ReadonlySet<ActorKind> = new Set([
  'free_village',
  'hamlet_household',
]);

const RURAL_PRODUCTION_TOOL_RESERVE_MIN = 10;
const RURAL_PRODUCTION_TOOL_RESERVE_PER_ADULT_EQ = 0.2;

/**
 * True when the buyer + seller at this settlement form a community
 * subsistence pool — the village's grain feeding the village's
 * common-household residents. Used by both the bid-budget calc here
 * and the trade-execution coin-transfer bypass in src/sim/phases/trade.ts.
 */
export const isCommunityFoodPool = (
  buyerKind: ActorKind | undefined,
  sellerKind: ActorKind | undefined,
): boolean => {
  if (buyerKind === undefined || sellerKind === undefined) return false;
  return (
    COMMUNITY_FOOD_BENEFICIARY_KINDS.has(buyerKind) &&
    COMMUNITY_FOOD_PROVIDER_KINDS.has(sellerKind)
  );
};

/**
 * Per docs/04 §"Village ration discipline" + docs/08 §"Communal
 * subsistence pool": when a `free_village` or `hamlet_household`
 * actor sells subsistence goods on the market, it withholds
 * `COMMUNITY_RESERVE_DAYS` of community subsistence need from the
 * sellable pool. The village's first job is to feed its own people;
 * only the surplus above that reserve goes to external buyers
 * (caravan merchants, urban procurement, etc.).
 *
 * Without this, the village would happily sell ALL its grain to a
 * better-paying urban bidder and starve its own residents in Q5
 * winter. With it, the supply curve naturally caps export volume
 * so the Q100 equilibrium is stable.
 */
const COMMUNITY_RESERVE_DAYS = 60;

const communitySubsistenceReserve = (
  resource: ResourceId,
  context: SettlementScheduleContext,
  ownerKind: ActorKind | undefined,
  tier: Settlement['tier'],
): number => {
  if (ownerKind === undefined || !COMMUNITY_FOOD_PROVIDER_KINDS.has(ownerKind)) return 0;
  const resourceKey: string = resource;
  if (
    SUBSISTENCE_NEEDS_FREE[resourceKey] === undefined &&
    SUBSISTENCE_NEEDS_SLAVE[resourceKey] === undefined
  ) {
    return 0;
  }
  let dailyNeed = 0;
  for (const [klass, adultEqCount] of context.adultEquivalentByClass) {
    if (adultEqCount <= 0) continue;
    const needsTable = klass === 'slave' ? SUBSISTENCE_NEEDS_SLAVE : SUBSISTENCE_NEEDS_FREE;
    const perAdult = subsistenceNeedPerAdult(needsTable, resourceKey, tier);
    if (perAdult <= 0) continue;
    dailyNeed += perAdult * adultEqCount;
  }
  return dailyNeed * COMMUNITY_RESERVE_DAYS;
};

const ruralProductionToolReserve = (
  resource: ResourceId,
  context: SettlementScheduleContext,
  ownerKind: ActorKind | undefined,
): number => {
  if (String(resource) !== 'goods.tools') return 0;
  if (ownerKind === undefined || !COMMUNITY_FOOD_PROVIDER_KINDS.has(ownerKind)) return 0;
  return Math.max(
    RURAL_PRODUCTION_TOOL_RESERVE_MIN,
    context.adultEquivalentTotal * RURAL_PRODUCTION_TOOL_RESERVE_PER_ADULT_EQ,
  );
};

const subsistenceBudgetForActor = (
  context: SettlementScheduleContext,
  resource: ResourceId,
  actor: ActorId | undefined,
  fallback: number,
  prices: ReadonlyMap<ResourceId, number>,
  ownerKindByActor: ReadonlyMap<ActorId, ActorKind> | undefined,
): number => {
  if (actor === undefined || context.actorTreasuryByActor === undefined) return fallback;
  const treasury = Math.max(0, context.actorTreasuryByActor.get(actor) ?? 0);
  const ownStock = Math.max(0, context.stockpilesByOwner.get(actor)?.get(resource) ?? 0);
  // Community self-provision per docs/04 §"Community self-provision":
  // a plebeian/freedman/foreigner household at a settlement gets a
  // budget credit equal to the free_village or hamlet_household's
  // stockpile of this resource at the same settlement. The village's
  // grain IS the village's food; it doesn't require the eater to also
  // hold the coin to "buy" it back.
  let communityStock = 0;
  const buyerKind = ownerKindByActor?.get(actor);
  if (buyerKind !== undefined && COMMUNITY_FOOD_BENEFICIARY_KINDS.has(buyerKind)) {
    for (const [ownerId, stockpile] of context.stockpilesByOwner) {
      if (ownerId === actor) continue;
      const providerKind = ownerKindByActor?.get(ownerId);
      if (providerKind === undefined) continue;
      if (!COMMUNITY_FOOD_PROVIDER_KINDS.has(providerKind)) continue;
      communityStock += stockpile.get(resource) ?? 0;
    }
  }
  const referencePrice = prices.get(resource) ?? 0;
  const selfProvisionCredit =
    referencePrice > 0 ? (ownStock + communityStock) * referencePrice : 0;
  return effectiveMarketBudget(Math.min(fallback, treasury + selfProvisionCredit));
};

const effectiveMarketBudget = (value: number): number =>
  Number.isFinite(value) && value > MIN_EFFECTIVE_MARKET_BUDGET ? value : 0;

// --- Demand: subsistence ----------------------------------------------------

const subsistenceSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey: string = resource;
  if (
    SUBSISTENCE_NEEDS_FREE[resourceKey] === undefined &&
    SUBSISTENCE_NEEDS_SLAVE[resourceKey] === undefined
  ) {
    return NO_DEMAND_SOURCES;
  }
  const out: DemandSource[] = [];
  const wealthMap = inputs.wealthPerCapita ?? DEFAULT_WEALTH_PER_CAPITA_MAP;
  for (const [klass, adultEqCount] of context.adultEquivalentByClass) {
    if (adultEqCount <= 0) continue;
    const needsTable = klass === 'slave' ? SUBSISTENCE_NEEDS_SLAVE : SUBSISTENCE_NEEDS_FREE;
    const perAdult = subsistenceNeedPerAdult(needsTable, resourceKey, inputs.settlement.tier);
    if (perAdult <= 0) continue;
    const totalNeed = perAdult * adultEqCount;
    if (totalNeed <= 0) continue;
    const wealthPerHead = wealthMap.get(klass) ?? 0;
    // Total segment wealth = per-capita × headcount (use raw cohort heads,
    // not adult-equivalents — wealth is held per person).
    const headCount = context.headsByClass.get(klass) ?? 0;
    // docs/15 §C21: split demand across all buyer actors for this class.
    // Patricians have multiple families; slaves bid through multiple owner
    // kinds. Plebeian/freedman/foreigner typically have a single buyer.
    const buyers = context.consumerBuyersByClass.get(klass) ?? [];
    if (buyers.length === 0) continue;
    const perBuyerNeed = totalNeed / buyers.length;
    const perBuyerNominalWealth = (wealthPerHead * headCount) / buyers.length;
    for (let i = 0; i < buyers.length; i++) {
      const buyer = buyers[i]!;
      const segmentWealth = subsistenceBudgetForActor(
        context,
        resource,
        buyer,
        perBuyerNominalWealth,
        inputs.recentLocalPrices,
        inputs.ownerKindByActor,
      );
      if (segmentWealth <= 0) continue;
      // docs/10 §47 (v1.9): subsistence demand is deliberately NOT
      // satiation-capped on quantity. The reason: subsistence bids
      // do double duty as (a) market-trade signal AND (b) the trigger
      // for the same-tick consumption draw on stockpile. Capping the
      // quantity at 0 when communal stock is high suppresses the
      // consumption mechanism, causing famine in poorly-supplied
      // neighboring settlements that depend on the bid signal for
      // caravan dispatch. Stockpile-bloat-driven equilibrium is
      // instead enforced on the SUPPLY side: production stock-target
      // gate (see productionOutputInventoryCapacityForRecipe) caps
      // how much grain a settlement accumulates before farms idle.
      out.push(
        subsistenceDemandDirect(
          `subsistence:${String(inputs.settlement.id)}:${klass}:${i}:${resourceKey}`,
          perBuyerNeed,
          segmentWealth,
          buyer,
          'consume',
        ),
      );
    }
  }
  return out;
};

// --- Demand: comfort --------------------------------------------------------

const comfortSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey: string = resource;
  if (!COMFORT_WANTS.has(resourceKey)) return NO_DEMAND_SOURCES;
  const allowedSeasons = COMFORT_WANT_SEASONS[resourceKey];
  if (allowedSeasons !== undefined && !allowedSeasons.has(inputs.season)) return NO_DEMAND_SOURCES;
  const wantPerAdult = COMFORT_WANT_QTY[resourceKey] ?? 0;
  if (wantPerAdult <= 0) return NO_DEMAND_SOURCES;
  const out: DemandSource[] = [];
  const budgetMap = inputs.discretionaryIncomePerDay ?? DEFAULT_DISCRETIONARY_PER_DAY_MAP;
  for (const [klass, adultEqCount] of context.adultEquivalentByClass) {
    if (klass === 'slave') continue; // docs/04: no comfort demand
    if (adultEqCount <= 0) continue;
    const headCount = context.headsByClass.get(klass) ?? 0;
    const totalWant = wantPerAdult * adultEqCount;
    const budgetPerHead = budgetMap.get(klass) ?? 0;
    const budgetShare = COMFORT_BUDGET_SHARE[resourceKey] ?? 0;
    const nominalBudget = budgetPerHead * headCount * budgetShare;
    // docs/15 §C21: split across multiple buyers when present.
    const buyers = context.consumerBuyersByClass.get(klass) ?? [];
    if (buyers.length === 0) continue;
    const perBuyerWant = totalWant / buyers.length;
    const perBuyerBudget = nominalBudget / buyers.length;
    for (let i = 0; i < buyers.length; i++) {
      const buyer = buyers[i]!;
      // docs/15 §C23: floor at 5% of nominal so cash-poor households still
      // bid for comfort goods (via non-cash wealth + barter), keeping the
      // bid-ask book reflective of underlying want even when treasuries
      // drain.
      const cap = budgetCapForActor(context, buyer, perBuyerBudget, COMFORT_NOMINAL_FLOOR_FRACTION);
      if (cap <= 0) continue;
      out.push(
        comfortDemandDirect(
          `comfort:${String(inputs.settlement.id)}:${klass}:${i}:${resourceKey}`,
          perBuyerWant,
          cap,
          1,
          20,
          buyer,
          'consume',
        ),
      );
    }
  }
  return out;
};

// --- Demand: status ---------------------------------------------------------

const statusSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey: string = resource;
  if (!STATUS_WANTS.has(resourceKey)) return NO_DEMAND_SOURCES;
  const wantPerAdult = STATUS_WANT_QTY[resourceKey] ?? 0;
  if (wantPerAdult <= 0) return NO_DEMAND_SOURCES;
  const out: DemandSource[] = [];
  const wealthMap = inputs.wealthPerCapita ?? DEFAULT_WEALTH_PER_CAPITA_MAP;
  // Status is patrician-only in v1. Governor's office demand is captured
  // separately by the patrician class for now (the governor is a patrician
  // of a specific family in docs/11).
  const adults = context.adultEquivalentByClass.get('patrician') ?? 0;
  if (adults <= 0) return out;
  const heads = context.headsByClass.get('patrician') ?? 0;
  const totalWant = wantPerAdult * adults;
  const wealthPerHead = wealthMap.get('patrician') ?? 0;
  const budgetShare = STATUS_BUDGET_SHARE[resourceKey] ?? 0;
  const nominalWealth = wealthPerHead * heads * budgetShare;
  // docs/15 §C21: split across all patrician_family actors. Each family
  // bids its 1/N share of the city's patrician status demand, capped by
  // its OWN treasury — so a wealthy family can bid for silks that a broke
  // family can't, producing real per-family entries in the residual book.
  const buyers = context.consumerBuyersByClass.get('patrician') ?? [];
  if (buyers.length === 0) return out;
  const perBuyerWant = totalWant / buyers.length;
  const perBuyerNominalWealth = nominalWealth / buyers.length;
  for (let i = 0; i < buyers.length; i++) {
    const buyer = buyers[i]!;
    // docs/15 §C23: 5% nominal-wealth floor so cash-strapped patrician
    // families still bid for status goods via credit / lineage / reputation
    // wealth. Keeps the luxury book live across all family treasuries.
    const cap = budgetCapForActor(
      context,
      buyer,
      perBuyerNominalWealth,
      STATUS_NOMINAL_FLOOR_FRACTION,
    );
    // Threshold = wealth-per-want-unit × generous multiplier. Patricians
    // pay multiples of "fair" price for status goods; the step gives them
    // a ceiling reflecting actual purse depth.
    const threshold = perBuyerWant > 0 ? (cap / perBuyerWant) * 5 : 0;
    if (threshold <= 0) continue;
    out.push(
      statusDemandDirect(
        `status:${String(inputs.settlement.id)}:patrician:${i}:${resourceKey}`,
        perBuyerWant,
        cap,
        threshold,
        buyer,
        'consume',
      ),
    );
  }
  return out;
};

// --- Demand: local services -------------------------------------------------

const serviceDemandSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey: string = resource;
  if (resourceKey === 'service.priesthood') {
    return priesthoodServiceDemandSources(resource, inputs, context);
  }
  if (resourceKey === 'service.public_works') {
    return publicWorksServiceDemandSources(resource, inputs, context);
  }
  if (resourceKey !== 'service.garrison' && resourceKey !== 'service.administration') {
    return NO_DEMAND_SOURCES;
  }
  const adultEq = context.adultEquivalentTotal;
  if (adultEq <= 0) return NO_DEMAND_SOURCES;
  const buyer = chooseServiceBuyerActor(inputs, context, SERVICE_CIVIC_BUYER_PRIORITY);
  if (buyer === undefined) return NO_DEMAND_SOURCES;
  const tierFloor = SERVICE_TIER_FLOOR[inputs.settlement.tier] ?? 0.05;
  const wantQuantity =
    resourceKey === 'service.garrison'
      ? tierFloor + adultEq / 2_000
      : tierFloor + adultEq / 3_000 + context.buildings.length * 0.015;
  const treasuryShare = resourceKey === 'service.garrison' ? 0.04 : 0.025;
  const budget = reserveBudgetForActor(context, buyer, treasuryShare);
  if (wantQuantity <= 0 || budget <= 0) return NO_DEMAND_SOURCES;
  return [
    comfortDemandDirect(
      `service:${String(inputs.settlement.id)}:${String(buyer)}:${resourceKey}`,
      wantQuantity,
      budget,
      1.5,
      8,
      buyer,
      'consume',
    ),
  ];
};

const priesthoodServiceDemandSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  const budgetMap = inputs.discretionaryIncomePerDay ?? DEFAULT_DISCRETIONARY_PER_DAY_MAP;
  for (const [klass, adultEqCount] of context.adultEquivalentByClass) {
    if (klass === 'slave' || adultEqCount <= 0) continue;
    const headCount = context.headsByClass.get(klass) ?? 0;
    const budgetPerHead = budgetMap.get(klass) ?? 0;
    const nominalBudget = budgetPerHead * headCount * 0.035;
    // docs/15 §C21: split across multiple buyers when present.
    const buyers = context.consumerBuyersByClass.get(klass) ?? [];
    if (buyers.length === 0) continue;
    const perBuyerWant = adultEqCount / 2_500 / buyers.length;
    const perBuyerNominal = nominalBudget / buyers.length;
    for (let i = 0; i < buyers.length; i++) {
      const buyer = buyers[i]!;
      const cap = budgetCapForActor(context, buyer, perBuyerNominal);
      if (cap <= 0) continue;
      out.push(
        comfortDemandDirect(
          `service:${String(inputs.settlement.id)}:${klass}:${i}:${String(resource)}`,
          perBuyerWant,
          cap,
          1.25,
          8,
          buyer,
          'consume',
        ),
      );
    }
  }
  return out;
};

const PUBLIC_WORKS_SERVICE_PER_WORKER_DAY_REMAINING = 0.001;
const PUBLIC_WORKS_TREASURY_SHARE = 0.03;

const publicWorksServiceDemandSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  inputs.settlement.pendingBuildings.forEach((pending, index) => {
    const remaining = Math.max(0, pending.workerDaysRemaining);
    if (remaining <= 0) return;
    const wantQuantity = Math.max(
      0.01,
      Math.min(0.5, remaining * PUBLIC_WORKS_SERVICE_PER_WORKER_DAY_REMAINING),
    );
    const budget = reserveBudgetForActor(context, pending.ownerActor, PUBLIC_WORKS_TREASURY_SHARE);
    if (budget <= 0) return;
    out.push(
      comfortDemandDirect(
        `service:${String(inputs.settlement.id)}:public_works:${index}:${String(resource)}`,
        wantQuantity,
        budget,
        1.2,
        8,
        pending.ownerActor,
        'consume',
      ),
    );
  });
  return out;
};

// --- Demand: institutional procurement ------------------------------------

const institutionalSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  const resourceKey: string = resource;
  const referencePrice = inputs.recentLocalPrices.get(resource) ?? 0;
  if (referencePrice <= 0) return out;

  let buildingIndex = 0;
  for (const building of context.buildings) {
    const lines = INSTITUTIONAL_PROCUREMENT_BY_BUILDING.get(String(building.buildingId));
    if (lines === undefined) continue;
    const capacity = Math.max(0, building.capacity);
    if (capacity <= 0) continue;
    for (const line of lines) {
      if (String(line.resource) !== resourceKey) continue;
      const wantQuantity = line.quantityPerCapacity * capacity;
      if (wantQuantity <= 0) continue;
      const threshold = referencePrice * line.maxPriceMultiplier;
      if (threshold <= 0) continue;
      // Institutional procurement always carries at least 1 coin of
      // structural demand per docs/08 §"Integer-coin prices": a
      // barracks needing 0.008 shields/day at 100-coin threshold
      // sums to 0.8 coin/day of nominal demand, which would round
      // down to 0 under direct integer-coin filtering. Civic
      // procurement is a long-running standing order — bump it to
      // the 1-coin floor so the bid persists in the book.
      const rawBudget = Math.max(1, wantQuantity * threshold);
      const budget = budgetCapForActor(context, building.ownerActor, rawBudget);
      if (budget <= 0) continue;
      out.push(
        statusDemandDirect(
          `institutional:${String(inputs.settlement.id)}:${String(building.buildingId)}:` +
            `${buildingIndex}:${resourceKey}`,
          wantQuantity,
          budget,
          threshold,
          building.ownerActor,
          'consume',
        ),
      );
    }
    buildingIndex++;
  }
  return out;
};

// --- Demand: buffer-stock capital -----------------------------------------

const constructionReserveSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey: string = resource;
  const baseTarget = CONSTRUCTION_RESERVE_TARGET_BY_RESOURCE[resourceKey] ?? 0;
  if (baseTarget <= 0) return NO_DEMAND_SOURCES;
  const tierScale = CONSTRUCTION_RESERVE_TIER_SCALE[inputs.settlement.tier] ?? 1;
  const out: DemandSource[] = [];

  for (const actor of context.ownerCandidates) {
    const kind = inputs.ownerKindByActor?.get(actor);
    if (kind === undefined || !CONSTRUCTION_RESERVE_OWNER_KINDS.has(kind)) continue;
    const kindScale = CONSTRUCTION_RESERVE_KIND_SCALE[kind] ?? 1;
    const target = baseTarget * tierScale * kindScale;
    const gap = reserveStockGap(context, actor, resource, target);
    if (gap <= 0) continue;
    const budget = reserveBudgetForActor(context, actor, CONSTRUCTION_RESERVE_TREASURY_SHARE);
    if (budget <= 0) continue;
    out.push(
      comfortDemandDirect(
        `construction_reserve:${String(inputs.settlement.id)}:${String(actor)}:${String(resource)}`,
        gap,
        budget,
        2,
        10,
        actor,
        'stockpile',
      ),
    );
  }
  return out;
};

const transportCapitalSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey: string = resource;
  const baseTarget = TRANSPORT_CAPITAL_TARGET_BY_RESOURCE[resourceKey] ?? 0;
  if (baseTarget <= 0) return NO_DEMAND_SOURCES;
  const out: DemandSource[] = [];
  for (const actor of context.ownerCandidates) {
    const kind = inputs.ownerKindByActor?.get(actor);
    if (kind === undefined || !TRANSPORT_CAPITAL_OWNER_KINDS.has(kind)) continue;
    const gap = reserveStockGap(context, actor, resource, baseTarget);
    if (gap <= 0) continue;
    const budget = reserveBudgetForActor(context, actor, TRANSPORT_CAPITAL_TREASURY_SHARE);
    if (budget <= 0) continue;
    out.push(
      comfortDemandDirect(
        `transport_capital:${String(inputs.settlement.id)}:${String(actor)}:${String(resource)}`,
        gap,
        budget,
        1.25,
        10,
        actor,
        'stockpile',
      ),
    );
  }
  return out;
};

const reserveStockGap = (
  context: SettlementScheduleContext,
  actor: ActorId,
  resource: ResourceId,
  target: number,
): number => {
  const current = Math.max(0, context.stockpilesByOwner.get(actor)?.get(resource) ?? 0);
  return Math.max(0, target - current);
};

const reserveBudgetForActor = (
  context: SettlementScheduleContext,
  actor: ActorId,
  treasuryShare: number,
): number => {
  if (context.actorTreasuryByActor === undefined) return 0;
  const treasury = Math.max(0, context.actorTreasuryByActor.get(actor) ?? 0);
  return effectiveMarketBudget(treasury * treasuryShare);
};

// --- Demand: derived input -------------------------------------------------

const derivedInputSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  const recipes = RECIPES_BY_INPUT.get(resource) ?? [];
  for (const recipe of recipes) {
    const seasonMul = recipe.seasonalMultiplier?.[inputs.season];
    if (seasonMul !== undefined && seasonMul <= 0) continue;
    // Pick a representative output to value (highest-revenue under
    // recentLocalPrices). v1 ignores joint products beyond the chosen one.
    const valued = representativeOutputForRecipe(context, recipe, inputs.recentLocalPrices);
    if (valued === undefined) continue;
    const inputPerRun = recipe.inputs.get(resource) ?? 0;
    const inputPerOutput = inputPerRun / valued.qty;
    if (inputPerOutput <= 0) continue;
    const expectedRevenuePerInputUnit = valued.price / inputPerOutput;
    const buildings = context.buildingsById.get(recipe.building);
    if (buildings === undefined) continue;
    const cacheLaborCapacityByOwnerKind = buildings.length > 1;
    let laborCapacityByOwnerKind: Map<ActorKind | 'none', number> | undefined;
    let buildingIndex = 0;
    for (const building of buildings) {
      if (!buildingCanRunRecipe(context, building, recipe)) continue;
      if (building.capacity <= 0) continue;
      const ownerKind = inputs.ownerKindByActor?.get(building.ownerActor);
      let laborCapacity: number;
      if (cacheLaborCapacityByOwnerKind) {
        const laborCapacityKey = ownerKind ?? 'none';
        laborCapacityByOwnerKind ??= new Map<ActorKind | 'none', number>();
        const cached = laborCapacityByOwnerKind.get(laborCapacityKey);
        if (cached !== undefined) {
          laborCapacity = cached;
        } else {
          laborCapacity = laborCapacityForRecipe(recipe, context.laborClassContext, ownerKind);
          laborCapacityByOwnerKind.set(laborCapacityKey, laborCapacity);
        }
      } else {
        laborCapacity = laborCapacityForRecipe(recipe, context.laborClassContext, ownerKind);
      }
      const otherCostsPerInputUnit = otherInputCostsPerInputUnit(
        recipe,
        resource,
        valued.qty,
        inputs.recentLocalPrices,
        context.laborClassContext,
        context.wagePerWorkerDay,
        ownerKind,
      );
      const productionCapacity = Math.min(building.capacity * (seasonMul ?? 1), laborCapacity);
      if (productionCapacity <= 0) continue;
      const inventoryCapacity = outputInventoryConstrainedCapacity(
        context,
        building.ownerActor,
        valued,
        productionCapacity,
      );
      if (inventoryCapacity <= 0) continue;
      const maxPricePerInput =
        expectedRevenuePerInputUnit - otherCostsPerInputUnit - DERIVED_INPUT_MARGIN;
      if (maxPricePerInput <= 0) continue;
      const buyerBudget = budgetCapForActor(
        context,
        building.ownerActor,
        inventoryCapacity * inputPerRun * maxPricePerInput,
      );
      if (buyerBudget <= 0) continue;
      const budgetedCapacity = Math.min(
        inventoryCapacity,
        buyerBudget / maxPricePerInput / inputPerRun,
      );
      if (budgetedCapacity <= 0) continue;
      const desiredInputQty = budgetedCapacity * inputPerRun;
      const currentInputStock = Math.max(
        0,
        context.stockpilesByOwner.get(building.ownerActor)?.get(resource) ?? 0,
      );
      const inputGap = Math.max(0, desiredInputQty - currentInputStock);
      if (inputGap <= 0) continue;
      const inputConstrainedCapacity = Math.min(budgetedCapacity, inputGap / inputPerRun);
      if (inputConstrainedCapacity <= 0) continue;
      out.push(
        derivedInputDemandDirect(
          `derived:${String(inputs.settlement.id)}:${String(recipe.id)}:` +
            `${buildingIndex}:${String(resource)}`,
          expectedRevenuePerInputUnit,
          otherCostsPerInputUnit,
          DERIVED_INPUT_MARGIN,
          inputConstrainedCapacity * valued.qty,
          inputPerOutput,
          building.ownerActor,
          'stockpile',
        ),
      );
      buildingIndex++;
    }
  }
  return out;
};

// --- Demand: productive capital --------------------------------------------

const productiveCapitalSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  const recipes = RECIPES_BY_REQUIREMENT.get(resource) ?? [];
  for (const recipe of recipes) {
    const requiredPerRun = recipe.requires.get(resource) ?? 0;
    if (requiredPerRun <= 0) continue;
    const seasonMul = recipe.seasonalMultiplier?.[inputs.season];
    if (seasonMul !== undefined && seasonMul <= 0) continue;
    const outputRevenuePerRun = outputRevenueForRecipe(recipe, inputs.recentLocalPrices);
    if (outputRevenuePerRun <= 0) continue;

    const buildings = context.buildingsById.get(recipe.building);
    if (buildings === undefined) continue;
    const cacheByOwnerKind = buildings.length > 1;
    let laborCapacityByOwnerKind: Map<ActorKind | 'none', number> | undefined;
    let inputAndLaborCostByOwnerKind: Map<ActorKind | 'none', number> | undefined;
    let buildingIndex = 0;
    for (const building of buildings) {
      if (!buildingCanRunRecipe(context, building, recipe)) continue;
      if (building.capacity <= 0) continue;
      const ownerKind = inputs.ownerKindByActor?.get(building.ownerActor);
      const ownerKindKey = ownerKind ?? 'none';
      let laborCapacity: number;
      if (cacheByOwnerKind) {
        laborCapacityByOwnerKind ??= new Map<ActorKind | 'none', number>();
        const cached = laborCapacityByOwnerKind.get(ownerKindKey);
        if (cached !== undefined) {
          laborCapacity = cached;
        } else {
          laborCapacity = laborCapacityForRecipe(recipe, context.laborClassContext, ownerKind);
          laborCapacityByOwnerKind.set(ownerKindKey, laborCapacity);
        }
      } else {
        laborCapacity = laborCapacityForRecipe(recipe, context.laborClassContext, ownerKind);
      }
      const productionCapacity = Math.min(building.capacity * (seasonMul ?? 1), laborCapacity);
      if (productionCapacity <= 0) continue;

      const desiredStock = productionCapacity * requiredPerRun;
      const currentStock = Math.max(
        0,
        context.stockpilesByOwner.get(building.ownerActor)?.get(resource) ?? 0,
      );
      const stockGap = Math.max(0, desiredStock - currentStock);
      if (stockGap <= 0) continue;

      let inputAndLaborCostPerRun: number;
      if (cacheByOwnerKind) {
        inputAndLaborCostByOwnerKind ??= new Map<ActorKind | 'none', number>();
        const cached = inputAndLaborCostByOwnerKind.get(ownerKindKey);
        if (cached !== undefined) {
          inputAndLaborCostPerRun = cached;
        } else {
          inputAndLaborCostPerRun = inputAndLaborCostForRecipe(
            recipe,
            inputs.recentLocalPrices,
            context.laborClassContext,
            context.wagePerWorkerDay,
            ownerKind,
          );
          inputAndLaborCostByOwnerKind.set(ownerKindKey, inputAndLaborCostPerRun);
        }
      } else {
        inputAndLaborCostPerRun = inputAndLaborCostForRecipe(
          recipe,
          inputs.recentLocalPrices,
          context.laborClassContext,
          context.wagePerWorkerDay,
          ownerKind,
        );
      }
      const netPerRun = outputRevenuePerRun - inputAndLaborCostPerRun;
      if (netPerRun <= 0) continue;

      const maxPricePerRequiredUnit =
        (netPerRun / requiredPerRun) * PRODUCTIVE_CAPITAL_PAYBACK_DAYS;
      if (maxPricePerRequiredUnit <= 0) continue;
      const buyerBudget = budgetCapForActor(
        context,
        building.ownerActor,
        stockGap * maxPricePerRequiredUnit,
      );
      if (buyerBudget <= 0) continue;
      const budgetedStockGap = Math.min(stockGap, buyerBudget / maxPricePerRequiredUnit);
      if (budgetedStockGap <= 0) continue;

      out.push(
        statusDemandDirect(
          `productive_capital:${String(inputs.settlement.id)}:${String(recipe.id)}:` +
            `${buildingIndex}:${String(resource)}`,
          budgetedStockGap,
          buyerBudget,
          maxPricePerRequiredUnit,
          building.ownerActor,
          'stockpile',
        ),
      );
      buildingIndex++;
    }
  }
  return out;
};

const RECIPES_BY_INPUT: ReadonlyMap<string, readonly RecipeDef[]> = (() => {
  const out = new Map<string, RecipeDef[]>();
  for (const recipe of allRecipes()) {
    for (const input of recipe.inputs.keys()) {
      const k = String(input);
      let bucket = out.get(k);
      if (bucket === undefined) {
        bucket = [];
        out.set(k, bucket);
      }
      bucket.push(recipe);
    }
  }
  return out;
})();

const RECIPES_BY_REQUIREMENT: ReadonlyMap<string, readonly RecipeDef[]> = (() => {
  const out = new Map<string, RecipeDef[]>();
  for (const recipe of allRecipes()) {
    for (const requirement of recipe.requires.keys()) {
      const k = String(requirement);
      let bucket = out.get(k);
      if (bucket === undefined) {
        bucket = [];
        out.set(k, bucket);
      }
      bucket.push(recipe);
    }
  }
  return out;
})();

const DEMAND_SOURCE_SUBSISTENCE = 1 << 0;
const DEMAND_SOURCE_COMFORT = 1 << 1;
const DEMAND_SOURCE_STATUS = 1 << 2;
const DEMAND_SOURCE_SERVICE = 1 << 3;
const DEMAND_SOURCE_INSTITUTIONAL = 1 << 4;
const DEMAND_SOURCE_CONSTRUCTION_RESERVE = 1 << 5;
const DEMAND_SOURCE_TRANSPORT_CAPITAL = 1 << 6;
const DEMAND_SOURCE_PRODUCTIVE_CAPITAL = 1 << 7;
const DEMAND_SOURCE_DERIVED_INPUT = 1 << 8;

const DEMAND_SOURCE_FLAGS_BY_RESOURCE_KEY: ReadonlyMap<string, number> = (() => {
  const out = new Map<string, number>();
  const add = (resourceKey: string, flag: number): void => {
    out.set(resourceKey, (out.get(resourceKey) ?? 0) | flag);
  };
  for (const resourceKey of SUBSISTENCE_RESOURCE_KEYS) add(resourceKey, DEMAND_SOURCE_SUBSISTENCE);
  for (const resourceKey of COMFORT_WANTS) add(resourceKey, DEMAND_SOURCE_COMFORT);
  for (const resourceKey of STATUS_WANTS) add(resourceKey, DEMAND_SOURCE_STATUS);
  for (const resourceKey of SERVICE_DEMAND_RESOURCE_KEYS) add(resourceKey, DEMAND_SOURCE_SERVICE);
  for (const resourceKey of INSTITUTIONAL_PROCUREMENT_RESOURCE_KEYS) {
    add(resourceKey, DEMAND_SOURCE_INSTITUTIONAL);
  }
  for (const [resourceKey, target] of Object.entries(CONSTRUCTION_RESERVE_TARGET_BY_RESOURCE)) {
    if (target > 0) add(resourceKey, DEMAND_SOURCE_CONSTRUCTION_RESERVE);
  }
  for (const [resourceKey, target] of Object.entries(TRANSPORT_CAPITAL_TARGET_BY_RESOURCE)) {
    if (target > 0) add(resourceKey, DEMAND_SOURCE_TRANSPORT_CAPITAL);
  }
  for (const resourceKey of RECIPES_BY_REQUIREMENT.keys()) {
    add(resourceKey, DEMAND_SOURCE_PRODUCTIVE_CAPITAL);
  }
  for (const resourceKey of RECIPES_BY_INPUT.keys()) add(resourceKey, DEMAND_SOURCE_DERIVED_INPUT);
  return out;
})();

const RECIPES_BY_OUTPUT: ReadonlyMap<string, readonly RecipeDef[]> = (() => {
  const out = new Map<string, RecipeDef[]>();
  for (const recipe of allRecipes()) {
    for (const output of recipe.outputs.keys()) {
      const k = String(output);
      let bucket = out.get(k);
      if (bucket === undefined) {
        bucket = [];
        out.set(k, bucket);
      }
      bucket.push(recipe);
    }
  }
  return out;
})();

const buildConsumerBuyersByClass = (
  inputs: BuildScheduleInputs,
  candidates: readonly ActorId[],
  candidatesByKind: ReadonlyMap<ActorKind, readonly ActorId[]> | undefined,
): ReadonlyMap<CharacterClass, readonly ActorId[]> => {
  if (candidates.length === 0) return new Map();
  const out = new Map<CharacterClass, readonly ActorId[]>();
  for (const klass of CHARACTER_CLASSES) {
    const buyers = chooseConsumerBuyerActors(inputs, klass, candidates, candidatesByKind);
    if (buyers.length > 0) out.set(klass, buyers);
  }
  return out;
};

/**
 * Per docs/15 §C21: return ALL buyer actors for a class, not just the first
 * priority match. Patricians have multiple `patrician_family` actors per
 * city; slaves bid through whoever owns them. Plebeian/freedman/foreigner
 * typically have one household actor per settlement.
 *
 * The list is collected in priority order: for each kind in
 * `CONSUMER_BUYER_KIND_PRIORITY[klass]`, take every candidate matching that
 * kind. Stop after the first kind that yielded any matches — we don't want a
 * plebeian household to share demand with a fallback hamlet_household when
 * both exist. But within a single matching kind, we return all matches so a
 * city with 3 patrician families has 3 entries.
 */
const chooseConsumerBuyerActors = (
  inputs: BuildScheduleInputs,
  klass: CharacterClass,
  candidates: readonly ActorId[],
  candidatesByKind: ReadonlyMap<ActorKind, readonly ActorId[]> | undefined,
): readonly ActorId[] => {
  const ownerKindByActor = inputs.ownerKindByActor;
  if (ownerKindByActor !== undefined) {
    const priority = CONSUMER_BUYER_KIND_PRIORITY[klass];
    for (const kind of priority) {
      const matches = candidatesByKind?.get(kind);
      if (matches !== undefined && matches.length > 0) return matches;
    }
    return [];
  }
  // No ownerKind lookup available — return the first candidate as a fallback.
  return candidates.length > 0 ? [candidates[0]!] : [];
};

const ownerCandidates = (inputs: BuildScheduleInputs): readonly ActorId[] => {
  const out: ActorId[] = [];
  const seen = new Set<ActorId>();
  const add = (actorId: ActorId): void => {
    if (seen.has(actorId)) return;
    seen.add(actorId);
    out.push(actorId);
  };

  for (const actorId of inputs.stockpilesByOwner.keys()) add(actorId);
  for (const actorId of inputs.settlement.stockpileOwners) add(actorId);
  return out;
};

const ownerCandidatesByKind = (
  ownerKindByActor: ReadonlyMap<ActorId, ActorKind> | undefined,
  candidates: readonly ActorId[],
): ReadonlyMap<ActorKind, readonly ActorId[]> | undefined => {
  if (ownerKindByActor === undefined) return undefined;
  const out = new Map<ActorKind, ActorId[]>();
  for (const actorId of candidates) {
    const kind = ownerKindByActor.get(actorId);
    if (kind === undefined) continue;
    let bucket = out.get(kind);
    if (bucket === undefined) {
      bucket = [];
      out.set(kind, bucket);
    }
    bucket.push(actorId);
  }
  return out;
};

const chooseServiceBuyerActor = (
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
  priority: readonly ActorKind[],
): ActorId | undefined => {
  const candidates = context.ownerCandidates;
  const ownerKindByActor = inputs.ownerKindByActor;
  if (ownerKindByActor !== undefined) {
    for (const kind of priority) {
      const matches = context.ownerCandidatesByKind?.get(kind);
      if (matches !== undefined && matches.length > 0) return matches[0];
    }
  }
  return candidates[0];
};

/**
 * Daily subsistence basket per working adult, valued at local prices
 * to produce a real wage. Per docs/04 §"Consumption per adult per
 * day" — the worker must eat, salt their food, heat their dwelling,
 * and replace clothing over time. These are the things wages have to
 * cover. (Per the user: "we should have labor costs, presumably
 * labor buys goods they consume. eg a farmer buys bread.")
 *
 * Quantities are per docs/04. The basket deliberately mixes a
 * staple (grain), a dietary necessity (salt), a fuel (wood), and a
 * slow-burn manufactured good (cloth) so the wage tracks the
 * full subsistence shopping list, not just one number.
 *
 * For the wage calculation we use a *substitutable food* convention:
 * if no grain price has been observed yet, fall back to bread or
 * cheese; if there's no fuel price we substitute charcoal at the
 * documented heat ratio. Only items with a positive local price
 * contribute — missing markets count as zero (the worker just
 * doesn't get to buy that item) rather than crashing the wage.
 */
const SUBSISTENCE_BASKET: ReadonlyArray<{
  readonly substitutes: readonly { readonly resource: ResourceId; readonly qtyKg: number }[];
}> = Object.freeze([
  // Calories — ~0.4 kg grain-equivalent per day, substitutable.
  {
    substitutes: [
      { resource: 'food.bread' as ResourceId, qtyKg: 0.5 }, // bread is heavier per kcal
      { resource: 'food.flour' as ResourceId, qtyKg: 0.4 },
      { resource: 'food.grain' as ResourceId, qtyKg: 0.4 },
      { resource: 'food.cheese' as ResourceId, qtyKg: 0.2 },
      { resource: 'food.fish' as ResourceId, qtyKg: 0.4 },
      { resource: 'food.game' as ResourceId, qtyKg: 0.4 },
    ],
  },
  // Salt — 7 g/day, no substitute. Required.
  {
    substitutes: [{ resource: 'mineral.salt' as ResourceId, qtyKg: 0.007 }],
  },
  // Fuel — 0.7 kg wood/day, charcoal substitutes at 4× heat density.
  {
    substitutes: [
      { resource: 'material.wood' as ResourceId, qtyKg: 0.7 },
      { resource: 'material.charcoal' as ResourceId, qtyKg: 0.175 },
    ],
  },
  // Clothing — 1 garment per 700 days, ≈ 0.001 unit/day of cloth.
  {
    substitutes: [{ resource: 'goods.cloth' as ResourceId, qtyKg: 0.001 }],
  },
]);

const SUBSISTENCE_BASKET_UNITS: ReadonlyArray<{
  readonly substitutes: readonly { readonly resource: ResourceId; readonly units: number }[];
}> = Object.freeze(
  SUBSISTENCE_BASKET.map((item) => ({
    substitutes: Object.freeze(
      item.substitutes.map((sub) => ({
        resource: sub.resource,
        units: sub.qtyKg / Math.max(1e-9, getResource(sub.resource).weightKgPerUnit),
      })),
    ),
  })),
);

/**
 * Imputed wage per paid worker-day, in coins, computed as the cost of a
 * real subsistence basket at local recent prices. For each basket
 * item we pick the cheapest available substitute that has a positive
 * local price. Basket quantities are physical kg/day while market prices
 * are per resource unit, so each substitute is converted through the
 * resource catalog's kg/unit. Items where none of the substitutes have any
 * local price contribute 0 (the worker just doesn't get to buy that item
 * yet — but the rest of the basket still has cost). This anchors
 * paid labor cost endogenously to local prices, so:
 *   - When grain becomes scarce and pricey, wages rise → every
 *     labor-intensive good gets more expensive (cost-push wage
 *     inflation, the classic "price of bread" mechanism).
 *   - When grain is cheap, wages fall and labor-intensive goods
 *     follow.
 *   - When local prices for everything in the basket are unknown,
 *     wage = 0 and MC reduces to its input-cost component (which
 *     itself is anchored by globally-priced resources at the start).
 */
export const laborCostPerWorkerDay = (prices: ReadonlyMap<ResourceId, number>): number => {
  let total = 0;
  for (const item of SUBSISTENCE_BASKET_UNITS) {
    let cheapest = Infinity;
    for (const sub of item.substitutes) {
      const p = prices.get(sub.resource) ?? 0;
      if (p <= 0) continue;
      const cost = sub.units * p;
      if (cost < cheapest) cheapest = cost;
    }
    if (Number.isFinite(cheapest)) total += cheapest;
  }
  return total;
};

/**
 * Marginal cost of producing one unit of `resource`, computed against
 * `prices` for the inputs and the paid labor cost imputed from the local
 * subsistence basket. Per docs/08 §"Modern microeconomic pricing":
 * competitive suppliers set reservation supply against marginal cost,
 * so P = MC at the margin in equilibrium. We take the cheapest available
 * recipe; if the resource has no producing recipe (purely extracted with
 * nominal inputs only), MC reduces to the labor component.
 *
 * Missing input prices contribute 0 rather than disqualifying the
 * recipe — partial information is better than 0 cost. The labor term
 * is included only for wage-earning worker-days. Enslaved worker-days
 * still consume upkeep through owner-funded subsistence demand, but do
 * not create a cash wage bill.
 *
 * Returns 0 only if no recipe produces the resource AND there is no
 * grain-price signal (the very first day before any clearing).
 */
const marginalCostFor = (
  resource: ResourceId,
  prices: ReadonlyMap<ResourceId, number>,
  laborClassContext: LaborClassContext,
  wagePerWorkerDay: number,
  ownerKind?: ActorKind,
): number => {
  const recipes = RECIPES_BY_OUTPUT.get(resource);
  if (recipes === undefined || recipes.length === 0) return 0;
  const wage = wagePerWorkerDay;
  let cheapest = Infinity;
  for (const recipe of recipes) {
    const outQty = recipe.outputs.get(resource) ?? 0;
    if (outQty <= 0) continue;
    let inputCost = 0;
    for (const [inRes, inQty] of recipe.inputs) {
      const p = prices.get(inRes) ?? 0;
      if (p <= 0) continue;
      inputCost += (inQty * p) / outQty;
    }
    const totalLabor = wageEarningWorkerDaysForLaborForOwner(
      laborClassContext,
      recipe.labor,
      ownerKind,
    );
    const laborCostPerOutput = (totalLabor * wage) / outQty;
    const cost = inputCost + laborCostPerOutput;
    if (cost < cheapest) cheapest = cost;
  }
  return Number.isFinite(cheapest) ? cheapest : 0;
};

const pickRepresentativeOutput = (
  recipe: RecipeDef,
  prices: ReadonlyMap<ResourceId, number>,
): ValuedOutput | undefined => {
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

const representativeOutputForRecipe = (
  context: SettlementScheduleContext,
  recipe: RecipeDef,
  prices: ReadonlyMap<ResourceId, number>,
): ValuedOutput | undefined => {
  if (context.representativeOutputByRecipe.has(recipe)) {
    return context.representativeOutputByRecipe.get(recipe);
  }
  const valued = pickRepresentativeOutput(recipe, prices);
  context.representativeOutputByRecipe.set(recipe, valued);
  return valued;
};

const outputRevenueForRecipe = (
  recipe: RecipeDef,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  let revenue = 0;
  for (const [resource, qty] of recipe.outputs) {
    if (qty <= 0) continue;
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    revenue += qty * price;
  }
  return revenue;
};

const inputAndLaborCostForRecipe = (
  recipe: RecipeDef,
  prices: ReadonlyMap<ResourceId, number>,
  laborClassContext: LaborClassContext,
  wagePerWorkerDay: number,
  ownerKind?: ActorKind,
): number => {
  let cost = 0;
  for (const [resource, qty] of recipe.inputs) {
    if (qty <= 0) continue;
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    cost += qty * price;
  }
  const wage = wagePerWorkerDay;
  if (wage > 0) {
    cost +=
      wageEarningWorkerDaysForLaborForOwner(laborClassContext, recipe.labor, ownerKind) * wage;
  }
  return cost;
};

const laborCapacityForRecipe = (
  recipe: RecipeDef,
  laborClassContext: LaborClassContext,
  ownerKind?: ActorKind,
): number => {
  if (recipe.labor.size === 0) return Infinity;
  let capacity = Infinity;
  for (const [job, workerDaysPerRun] of recipe.labor) {
    if (workerDaysPerRun <= 0) continue;
    const available = allocatedWorkersForJobForOwner(laborClassContext, job, ownerKind);
    capacity = Math.min(capacity, available / workerDaysPerRun);
  }
  return Number.isFinite(capacity) ? Math.max(0, capacity) : Infinity;
};

const otherInputCostsPerInputUnit = (
  recipe: RecipeDef,
  primary: ResourceId,
  outputQty: number,
  prices: ReadonlyMap<ResourceId, number>,
  laborClassContext: LaborClassContext,
  wagePerWorkerDay: number,
  ownerKind?: ActorKind,
): number => {
  // Sum the cost of every non-primary input per unit of output, then divide
  // through by the input-per-output ratio so it is comparable to the
  // expectedRevenuePerInputUnit term.
  let perOutputCost = 0;
  for (const [r, qty] of recipe.inputs) {
    if (r === primary) continue;
    const price = prices.get(r) ?? 0;
    if (price <= 0 || qty <= 0) continue;
    perOutputCost += (qty / outputQty) * price;
  }
  const wage = wagePerWorkerDay;
  if (wage > 0) {
    const wageEarningLabor = wageEarningWorkerDaysForLaborForOwner(
      laborClassContext,
      recipe.labor,
      ownerKind,
    );
    if (wageEarningLabor > 0) perOutputCost += (wageEarningLabor * wage) / outputQty;
  }
  const primaryQty = recipe.inputs.get(primary) ?? 0;
  if (primaryQty <= 0) return 0;
  // perOutputCost is cost per 1 unit of output. inputPerOutput = primaryQty / outputQty.
  // We want cost per 1 unit of *primary input*, i.e., perOutputCost / inputPerOutput.
  const inputPerOutput = primaryQty / outputQty;
  return inputPerOutput > 0 ? perOutputCost / inputPerOutput : 0;
};

// --- Market making (docs/15 §C26) -----------------------------------------

/**
 * Per docs/15 §C26: actors that act as market makers — providing a
 * standing bid + ask on goods they touch, even when no concrete
 * concrete buyer/seller has a tighter price today.
 */
const MARKET_MAKER_KINDS: ReadonlySet<ActorKind> = new Set([
  'patrician_family',
  'city_corporation',
  'governor_office',
]);

/** Fraction of inventory listed at +5% above last clearing price. */
const PASSIVE_INVENTORY_LIST_FRACTION = 0.05;
/** Fraction of treasury reserved for passive bidding across all priced goods. */
const PASSIVE_TREASURY_BID_FRACTION = 0.1;
/** Spread above last price for the passive ask. */
const PASSIVE_ASK_MARKUP = 0.05;
/** Spread below last price for the passive bid. */
const PASSIVE_BID_DISCOUNT = 0.05;
/** Minimum quote size in resource units — sub-eps quantities are dropped. */
const MARKET_MAKER_MIN_QUOTE_UNITS = 1e-3;

const isMarketMakerActor = (
  kind: ActorKind | undefined,
): kind is 'patrician_family' | 'city_corporation' | 'governor_office' => {
  return kind !== undefined && MARKET_MAKER_KINDS.has(kind);
};

const buildMarketMakerStockByResource = (
  inputs: BuildScheduleInputs,
): ReadonlyMap<ResourceId, readonly MarketMakerStockEntry[]> => {
  const out = new Map<ResourceId, MarketMakerStockEntry[]>();
  for (const [ownerActor, byResource] of inputs.stockpilesByOwner) {
    const kind = inputs.ownerKindByActor?.get(ownerActor);
    if (!isMarketMakerActor(kind)) continue;
    for (const [resource, stock] of byResource) {
      if (stock <= 0) continue;
      let bucket = out.get(resource);
      if (bucket === undefined) {
        bucket = [];
        out.set(resource, bucket);
      }
      bucket.push({ ownerActor, stock });
    }
  }
  return out;
};

/**
 * For each market-making actor at the settlement, precompute the per-resource
 * treasury slice they will bid with. The resource count is fixed for this
 * schedule, so the per-resource demand pass does not need to re-read treasury
 * or divide the same budget for every resource.
 *
 * The bid is sized per-resource by:
 * `treasury × PASSIVE_TREASURY_BID_FRACTION / pricedResourceCount`.
 */
const buildMarketMakerDemandActors = (
  inputs: BuildScheduleInputs,
  candidates: readonly ActorId[],
): readonly MarketMakerDemandActor[] => {
  const resourceKeys = marketMakerResourceKeys(inputs.resources, inputs.recentLocalPrices);
  if (resourceKeys.size === 0) return NO_MARKET_MAKER_DEMAND_ACTORS;
  const out: MarketMakerDemandActor[] = [];
  for (const actor of candidates) {
    const kind = inputs.ownerKindByActor?.get(actor);
    if (!isMarketMakerActor(kind)) continue;
    const treasury = inputs.actorTreasuryByActor?.get(actor) ?? 0;
    if (treasury <= 0) continue;
    const perResourceBudget =
      (treasury * PASSIVE_TREASURY_BID_FRACTION) / Math.max(1, resourceKeys.size);
    if (perResourceBudget <= 0) continue;
    out.push({ actor, perResourceBudget });
  }
  return out;
};

const marketMakerResourceKeys = (
  resources: readonly ResourceId[],
  recentLocalPrices: ReadonlyMap<ResourceId, number>,
): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const resource of resources) {
    const recent = recentLocalPrices.get(resource);
    if (recent === undefined || recent <= 0 || !Number.isFinite(recent)) continue;
    // Service resources don't have a stockpile shape; skip.
    if (SERVICE_DEMAND_RESOURCE_IDS.has(resource)) continue;
    out.add(resource);
  }
  return out;
};

const buildSingleResourceMarketMakerActors = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  candidates: readonly ActorId[],
): readonly MarketMakerDemandActor[] => {
  if (SERVICE_DEMAND_RESOURCE_IDS.has(resource)) return NO_MARKET_MAKER_DEMAND_ACTORS;
  const recent = inputs.recentLocalPrices.get(resource);
  if (recent === undefined || recent <= 0 || !Number.isFinite(recent)) {
    return NO_MARKET_MAKER_DEMAND_ACTORS;
  }
  const out: MarketMakerDemandActor[] = [];
  for (const actor of candidates) {
    const kind = inputs.ownerKindByActor?.get(actor);
    if (!isMarketMakerActor(kind)) continue;
    const treasury = inputs.actorTreasuryByActor?.get(actor) ?? 0;
    if (treasury <= 0) continue;
    const perResourceBudget = treasury * PASSIVE_TREASURY_BID_FRACTION;
    if (perResourceBudget <= 0) continue;
    out.push({ actor, perResourceBudget });
  }
  return out;
};

/**
 * Standing market-making ASK from each patrician_family / city_corp /
 * governor that holds the resource — 5% of stockpile listed at +5% above
 * the last clearing price. Returns an empty array when no actor matches
 * or no recent price exists to anchor against.
 */
const marketMakerSupplySources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly SupplySource[] => {
  if (SERVICE_DEMAND_RESOURCE_IDS.has(resource)) return NO_SUPPLY_SOURCES;
  const recentPrice = inputs.recentLocalPrices.get(resource);
  if (recentPrice === undefined || recentPrice <= 0 || !Number.isFinite(recentPrice)) {
    return NO_SUPPLY_SOURCES;
  }
  const entries = context.marketMakerStockByResource.get(resource);
  if (entries === undefined) return NO_SUPPLY_SOURCES;
  const out: SupplySource[] = [];
  for (const { ownerActor, stock } of entries) {
    // Per docs/15 §C26: MM ask is ADDITIVE — a higher-price residual
    // tier layered above the actor's base supply (anchored at MC).
    // The 5% premium is well above typical MC, so the two tiers don't
    // double-count: the base supply clears first at the lower price; MM
    // ask only catches demand willing to pay the 5% premium.
    const listed = stock * PASSIVE_INVENTORY_LIST_FRACTION;
    if (listed < MARKET_MAKER_MIN_QUOTE_UNITS) continue;
    const askPrice = recentPrice * (1 + PASSIVE_ASK_MARKUP);
    // Use ownerSupply directly with the maker's reservation = askPrice
    // and an inventory-priced expectedFuturePrice. Patient maker urgency
    // matches the actor's normal urgency profile.
    out.push(
      ownerSupplyDirect(
        `mm-supply:${String(inputs.settlement.id)}:${String(ownerActor)}:${String(resource)}`,
        ownerActor,
        listed,
        0,
        askPrice,
        askPrice,
        askPrice,
        undefined,
        0,
        365,
      ),
    );
  }
  return out;
};

/**
 * Standing market-making BID from each patrician_family / city_corp /
 * governor with treasury — 10% of treasury split across the resources
 * they price-track, each bid at -5% of last clearing price. Modeled as
 * a status-style step source (bids at a single threshold price).
 */
/** Minimum gap below concrete WTP so MM is strictly outranked in CDA matching. */
const MM_WTP_GAP_BELOW_CONCRETE = 1e-3;

const marketMakerDemandSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  _context: SettlementScheduleContext,
  demandActors: readonly MarketMakerDemandActor[],
  minConcreteFiniteWtp: number,
): readonly DemandSource[] => {
  if (SERVICE_DEMAND_RESOURCE_IDS.has(resource)) return NO_DEMAND_SOURCES;
  const recentPrice = inputs.recentLocalPrices.get(resource);
  if (recentPrice === undefined || recentPrice <= 0 || !Number.isFinite(recentPrice)) {
    return NO_DEMAND_SOURCES;
  }
  const nominalBidPrice = recentPrice * (1 - PASSIVE_BID_DISCOUNT);
  // Per docs/15 §C27: clamp MM bid strictly below the lowest concrete-bid
  // WTP for this resource so concrete buyers (subsistence/comfort/etc.)
  // always fill first in the CDA. If there is no finite concrete WTP, MM
  // bids at its full -5% offset (the book had no other finite bidders
  // anyway).
  let bidPrice = nominalBidPrice;
  if (Number.isFinite(minConcreteFiniteWtp) && minConcreteFiniteWtp > 0) {
    bidPrice = Math.min(bidPrice, minConcreteFiniteWtp - MM_WTP_GAP_BELOW_CONCRETE);
  }
  if (bidPrice <= 0) return NO_DEMAND_SOURCES;
  const resourceKey: string = resource;
  const out: DemandSource[] = [];
  for (const { actor, perResourceBudget } of demandActors) {
    if (perResourceBudget <= 0) continue;
    const quantity = perResourceBudget / bidPrice;
    if (quantity < MARKET_MAKER_MIN_QUOTE_UNITS) continue;
    out.push(
      statusDemandDirect(
        `mm-demand:${String(inputs.settlement.id)}:${String(actor)}:${resourceKey}`,
        quantity,
        perResourceBudget,
        bidPrice,
        actor,
        'stockpile',
      ),
    );
  }
  return out;
};

// --- Supply ----------------------------------------------------------------

const supplyForResource = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
  demand: DemandSchedule,
): readonly SupplySource[] => {
  if (SERVICE_DEMAND_RESOURCE_IDS.has(resource)) {
    return serviceSupplyForResource(resource, inputs, context);
  }
  const out: SupplySource[] = [];
  const recentPrice = inputs.recentLocalPrices.get(resource) ?? 0;
  const def = getResource(resource);
  const storageHoldingDays = def.perishableDays ?? 365;
  const localDailyAbsorption = peakDemandQuantity(demand.sources);
  const reservationFloor = reservationFloorForResource(resource);
  let marginalCostByKind: Map<ActorKind | 'none', number> | undefined;
  // Per docs/08 §"Modern microeconomic pricing": competitive suppliers
  // price from reservation value, with marginal production cost as the
  // lower bound. At P < MC every marginal unit loses money. We compute
  // MC from the cheapest recipe that produces this resource, valued at
  // recent local input prices. The earlier formulation used 0.8 ×
  // recent_output_price, which had no anchor to inputs and produced
  // a downward death-spiral whenever supply briefly exceeded demand.
  for (const [ownerActor, byResource] of inputs.stockpilesByOwner) {
    const qty = byResource.get(resource);
    if (qty === undefined || qty <= 0) continue;
    const kind = inputs.ownerKindByActor?.get(ownerActor);
    const marginalCostKey = kind ?? 'none';
    let marginalCost = marginalCostByKind?.get(marginalCostKey);
    if (marginalCost === undefined) {
      marginalCost = marginalCostFor(
        resource,
        inputs.recentLocalPrices,
        context.laborClassContext,
        context.wagePerWorkerDay,
        kind,
      );
      if (marginalCostByKind === undefined) marginalCostByKind = new Map();
      marginalCostByKind.set(marginalCostKey, marginalCost);
    }
    const urgency = kind !== undefined ? URGENCY_BY_KIND[kind] : DEFAULT_OWNER_URGENCY;
    // Per docs/04 §"Village ration discipline": free_village +
    // hamlet_household actors withhold 60 days of community
    // subsistence need from market sales. The village feeds itself
    // first; only the surplus above the reserve is sellable.
    const communityReserve = communitySubsistenceReserve(
      resource,
      context,
      kind,
      inputs.settlement.tier,
    );
    const productionToolReserve = ruralProductionToolReserve(resource, context, kind);
    // For resources with a real producing recipe: MC is the floor.
    // For purely-extracted resources (timber, ore, raw fish) the
    // recipe has nominal/zero priced inputs, so MC ≈ 0; fall back to
    // a light fraction of the recent observed price to keep the
    // supply curve sloping (extractors don't sell at literally 0).
    const productionCost =
      marginalCost > 0
        ? marginalCost
        : recentPrice > 0
          ? recentPrice * DEFAULT_PRODUCTION_COST_RATIO
          : 0;
    const expectedFuturePrice = inventoryAdjustedExpectedFuturePrice({
      stockpile: qty,
      localDailyAbsorption,
      productionCost,
      salvageFloor: reservationFloor,
      recentPrice,
    });
    out.push(
      ownerSupplyDirect(
        `supply:${String(inputs.settlement.id)}:${String(ownerActor)}:${String(resource)}`,
        ownerActor,
        qty,
        Math.max(communityReserve, productionToolReserve),
        productionCost,
        reservationFloor,
        expectedFuturePrice,
        // We do not yet track per-stockpile age. When the storage subsystem
        // lands, perishables can fill in spoilageDaysRemaining here.
        def.perishableDays,
        urgency,
        storageHoldingDays,
      ),
    );
  }
  return out;
};

const peakDemandQuantity = (sources: DemandSchedule['sources']): number => {
  let total = 0;
  for (const source of sources) total += source.peakQuantity;
  return total;
};

const serviceSupplyForResource = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly SupplySource[] => {
  const out: SupplySource[] = [];
  const resourceKey: string = resource;
  const recentPrice = inputs.recentLocalPrices.get(resource) ?? 0;
  let buildingIndex = 0;
  for (const building of context.buildings) {
    const lines = SERVICE_CAPACITY_BY_BUILDING.get(String(building.buildingId));
    if (lines === undefined) {
      buildingIndex++;
      continue;
    }
    let lineIndex = 0;
    for (const line of lines) {
      if (String(line.resource) !== resourceKey) {
        lineIndex++;
        continue;
      }
      const capacity = Math.max(0, building.capacity) * line.quantityPerCapacity;
      if (capacity <= 0) {
        lineIndex++;
        continue;
      }
      const kind = inputs.ownerKindByActor?.get(building.ownerActor);
      const urgency = kind !== undefined ? URGENCY_BY_KIND[kind] : DEFAULT_OWNER_URGENCY;
      const expectedFuturePrice =
        recentPrice > 0 ? Math.max(recentPrice, line.reservationPrice) : line.reservationPrice;
      out.push(
        ownerSupplyDirect(
          `service_supply:${String(inputs.settlement.id)}:${String(building.buildingId)}:` +
            `${buildingIndex}:${lineIndex}:${resourceKey}`,
          building.ownerActor,
          capacity,
          0,
          line.reservationPrice,
          line.reservationPrice,
          expectedFuturePrice,
          undefined,
          urgency,
          1,
        ),
      );
      lineIndex++;
    }
    buildingIndex++;
  }
  return out;
};

// --- Helpers ---------------------------------------------------------------

interface InventoryAdjustedPriceInputs {
  readonly stockpile: Quantity;
  readonly localDailyAbsorption: Quantity;
  readonly productionCost: number;
  readonly salvageFloor: number;
  readonly recentPrice: number;
}

const inventoryAdjustedExpectedFuturePrice = (inputs: InventoryAdjustedPriceInputs): number => {
  if (inputs.recentPrice <= 0) return 0;
  if (inputs.stockpile <= 0) return inputs.recentPrice;

  const floor = Math.max(0, inputs.productionCost, inputs.salvageFloor);
  if (inputs.recentPrice <= floor) return inputs.recentPrice;

  // No current buyer means the old scarcity quote is a stale option value,
  // not today's opportunity cost. Keep a small premium for patient sellers,
  // but force the ask back toward what the good costs or salvages for.
  if (inputs.localDailyAbsorption <= 0) {
    return floor + (inputs.recentPrice - floor) * (1 - MAX_INVENTORY_PRESSURE_DISCOUNT);
  }

  const targetStock = inputs.localDailyAbsorption * SELLER_INVENTORY_TARGET_DAYS;
  if (targetStock <= 0 || inputs.stockpile <= targetStock) return inputs.recentPrice;

  const rawPressure = 1 - targetStock / inputs.stockpile;
  const pressure = Math.max(0, Math.min(MAX_INVENTORY_PRESSURE_DISCOUNT, rawPressure));
  return floor + (inputs.recentPrice - floor) * (1 - pressure);
};

const reservationFloorForResource = (resource: ResourceId): number => {
  const def = getResource(resource);
  const kg = Math.max(0.001, def.weightKgPerUnit);
  switch (def.category) {
    case 'food':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.food;
    case 'material':
      return (
        kg *
        (def.tier === 0
          ? RESERVATION_FLOOR_COIN_PER_KG.material_tier0
          : RESERVATION_FLOOR_COIN_PER_KG.material_refined)
      );
    case 'livestock':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.livestock;
    case 'mineral':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.mineral;
    case 'metal':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.metal;
    case 'goods':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.goods;
    case 'exotic':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.exotic;
    case 'people':
      return kg * RESERVATION_FLOOR_COIN_PER_KG.people;
    case 'service':
      return RESERVATION_FLOOR_COIN_PER_KG.service;
  }
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

const indexBuildingsById = (
  settlement: Settlement,
): ReadonlyMap<BuildingId, ReadonlyArray<Settlement['buildings'][number]>> => {
  const out = new Map<BuildingId, Settlement['buildings'][number][]>();
  for (const building of settlement.buildings) {
    let bucket = out.get(building.buildingId);
    if (bucket === undefined) {
      bucket = [];
      out.set(building.buildingId, bucket);
    }
    bucket.push(building);
  }
  return out;
};

function toMap<K extends string, V>(rec: Readonly<Record<K, V>>): ReadonlyMap<K, V> {
  const m = new Map<K, V>();
  for (const k of Object.keys(rec) as K[]) {
    m.set(k, rec[k]);
  }
  return m;
}
