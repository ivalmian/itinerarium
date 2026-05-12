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
  /** Optional live treasury lookup. When present, demand is cash-budgeted. */
  readonly actorTreasuryByActor?: ReadonlyMap<ActorId, number>;
  /** Optional terrain grid; when present, extraction demand respects deposits. */
  readonly grid?: HexGrid;
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
  const context = buildSettlementScheduleContext(inputs);
  for (const resource of inputs.resources) {
    const demandSources: DemandSource[] = [
      ...subsistenceSources(resource, inputs, context),
      ...comfortSources(resource, inputs, context),
      ...statusSources(resource, inputs, context),
      ...serviceDemandSources(resource, inputs, context),
      ...institutionalSources(resource, inputs, context),
      ...constructionReserveSources(resource, inputs, context),
      ...transportCapitalSources(resource, inputs, context),
      ...productiveCapitalSources(resource, inputs, context),
      ...derivedInputSources(resource, inputs, context),
    ];
    const demand = aggregateDemand(demandSources);
    const supplySources = supplyForResource(resource, inputs, context, demand);
    out.set(resource, {
      demand,
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

/** Per-adult comfort want intensity (units per day). Coarse v1 numbers. */
const COMFORT_WANT_QTY: Readonly<Record<string, number>> = Object.freeze({
  'food.milk': 0.03,
  'food.fish': 0.01,
  'food.game': 0.006,
  'food.grapes': 0.003,
  'food.olives': 0.001,
  'food.wine': 0.02, // a small fraction of an amphora — each adult wants a sip a day
  'food.olive_oil': 0.005,
  'food.cheese': 0.01,
  'food.salted_meat': 0.01,
  'food.salted_fish': 0.01,
  'goods.cloth': 0.00025, // households mostly replace finished clothing; cloth remains a smaller direct want
  'goods.clothing': 0.0014,
  'goods.furniture': 0.0001,
  'material.pottery': 0.001,
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
  ['goods.weapons', 0.05],
  ['goods.armor', 0.02],
  ['goods.shields', 0.05],
  ['goods.cart', 0.1],
]);

const producerOutputStockTargetDays = (resource: ResourceId): number =>
  PRODUCER_OUTPUT_STOCK_TARGET_DAYS_BY_RESOURCE.get(String(resource)) ??
  DEFAULT_PRODUCER_OUTPUT_STOCK_TARGET_DAYS;
/** Sellers carrying more than this many days of local absorption cut asks. */
const SELLER_INVENTORY_TARGET_DAYS = 30;
/** Keep a nonzero opportunity premium even under extreme overstock. */
const MAX_INVENTORY_PRESSURE_DISCOUNT = 0.9;
/** Numerical dust: budgets below this are not spendable economic demand. */
const MIN_EFFECTIVE_MARKET_BUDGET = 1e-6;
/** Reservation = ratio × recentLocalPrice when no productionCost is supplied. */
const DEFAULT_PRODUCTION_COST_RATIO = 0.8;
/**
 * Minimum structural ask in coins per kg. This is not a target price; it is
 * the lowest salvage value a rational seller accepts when local price memory
 * has collapsed and MC is currently unpriced. Values are deliberately small
 * relative to normal scarcity/import ceilings.
 */
const RESERVATION_FLOOR_COIN_PER_KG = Object.freeze({
  food: 0.05,
  material_tier0: 0.005,
  material_refined: 0.02,
  livestock: 0.01,
  mineral: 0.02,
  metal: 0.2,
  goods: 0.5,
  exotic: 1,
  people: 0.5,
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
      { resource: 'goods.weapons' as ResourceId, quantityPerCapacity: 0.01, maxPriceMultiplier: 4 },
      { resource: 'goods.armor' as ResourceId, quantityPerCapacity: 0.003, maxPriceMultiplier: 4 },
      {
        resource: 'goods.shields' as ResourceId,
        quantityPerCapacity: 0.012,
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
      { resource: 'food.grain' as ResourceId, quantityPerCapacity: 0.2, maxPriceMultiplier: 5 },
      { resource: 'goods.tools' as ResourceId, quantityPerCapacity: 0.02, maxPriceMultiplier: 3 },
      { resource: 'goods.cloth' as ResourceId, quantityPerCapacity: 0.02, maxPriceMultiplier: 3 },
    ],
  ],
]);

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
  readonly headsByClass: ReadonlyMap<CharacterClass, number>;
  readonly buildingsByKind: ReadonlyMap<string, number>;
  readonly buildings: Settlement['buildings'];
  readonly stockpilesByOwner: ReadonlyMap<ActorId, ReadonlyMap<ResourceId, Quantity>>;
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
  readonly actorTreasuryByActor?: ReadonlyMap<ActorId, number>;
  readonly grid?: HexGrid;
}

const buildSettlementScheduleContext = (inputs: BuildScheduleInputs): SettlementScheduleContext => {
  const settlement = inputs.settlement;
  const adultEquivalentByClass = new Map<CharacterClass, number>();
  const headsByClass = new Map<CharacterClass, number>();
  for (const cls of CHARACTER_CLASSES) {
    const adultEq = settlement.population.adultEquivalentByClass(cls);
    if (adultEq > 0) adultEquivalentByClass.set(cls, adultEq);
    const heads = settlement.population.totalByClass(cls);
    if (heads > 0) headsByClass.set(cls, heads);
  }
  return {
    adultEquivalentByClass,
    headsByClass,
    buildingsByKind: countBuildingsByKind(settlement),
    buildings: settlement.buildings,
    stockpilesByOwner: inputs.stockpilesByOwner,
    consumerBuyersByClass: buildConsumerBuyersByClass(inputs),
    laborClassContext: buildLaborClassContext(settlement),
    ...(inputs.actorTreasuryByActor !== undefined
      ? { actorTreasuryByActor: inputs.actorTreasuryByActor }
      : {}),
    ...(inputs.grid !== undefined ? { grid: inputs.grid } : {}),
  };
};

const budgetCapForActor = (
  context: SettlementScheduleContext,
  actor: ActorId | undefined,
  fallback: number,
): number => {
  const budget =
    actor === undefined || context.actorTreasuryByActor === undefined
      ? fallback
      : Math.min(fallback, Math.max(0, context.actorTreasuryByActor.get(actor) ?? 0));
  return effectiveMarketBudget(budget);
};

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

const subsistenceBudgetForActor = (
  context: SettlementScheduleContext,
  resource: ResourceId,
  actor: ActorId | undefined,
  fallback: number,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  if (actor === undefined || context.actorTreasuryByActor === undefined) return fallback;
  const treasury = Math.max(0, context.actorTreasuryByActor.get(actor) ?? 0);
  const ownStock = Math.max(0, context.stockpilesByOwner.get(actor)?.get(resource) ?? 0);
  const referencePrice = prices.get(resource) ?? 0;
  const selfProvisionCredit = referencePrice > 0 ? ownStock * referencePrice : 0;
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
  const out: DemandSource[] = [];
  const resourceKey = String(resource);
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
      );
      if (segmentWealth <= 0) continue;
      out.push(
        subsistenceDemand({
          id: `subsistence:${String(inputs.settlement.id)}:${klass}:${i}:${resourceKey}`,
          needPerDay: perBuyerNeed,
          segmentWealth,
          ...consumerBuyerFieldsFor(buyer),
        }),
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
  const resourceKey = String(resource);
  if (!COMFORT_WANTS.has(resourceKey)) return [];
  const allowedSeasons = COMFORT_WANT_SEASONS[resourceKey];
  if (allowedSeasons !== undefined && !allowedSeasons.has(inputs.season)) return [];
  const wantPerAdult = COMFORT_WANT_QTY[resourceKey] ?? 0;
  if (wantPerAdult <= 0) return [];
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
      const cap = budgetCapForActor(context, buyer, perBuyerBudget);
      if (cap <= 0) continue;
      out.push(
        comfortDemand({
          id: `comfort:${String(inputs.settlement.id)}:${klass}:${i}:${resourceKey}`,
          wantQuantity: perBuyerWant,
          budget: cap,
          ...consumerBuyerFieldsFor(buyer),
        }),
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
  const resourceKey = String(resource);
  if (!STATUS_WANTS.has(resourceKey)) return [];
  const wantPerAdult = STATUS_WANT_QTY[resourceKey] ?? 0;
  if (wantPerAdult <= 0) return [];
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
    const cap = budgetCapForActor(context, buyer, perBuyerNominalWealth);
    // Threshold = wealth-per-want-unit × generous multiplier. Patricians
    // pay multiples of "fair" price for status goods; the step gives them
    // a ceiling reflecting actual purse depth.
    const threshold = perBuyerWant > 0 ? (cap / perBuyerWant) * 5 : 0;
    if (threshold <= 0) continue;
    out.push(
      statusDemand({
        id: `status:${String(inputs.settlement.id)}:patrician:${i}:${resourceKey}`,
        wantQuantity: perBuyerWant,
        segmentWealth: cap,
        veryHighThreshold: threshold,
        ...consumerBuyerFieldsFor(buyer),
      }),
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
  const resourceKey = String(resource);
  if (resourceKey === 'service.priesthood') {
    return priesthoodServiceDemandSources(resource, inputs, context);
  }
  if (resourceKey === 'service.public_works') {
    return publicWorksServiceDemandSources(resource, inputs, context);
  }
  if (resourceKey !== 'service.garrison' && resourceKey !== 'service.administration') return [];
  const adultEq = Array.from(context.adultEquivalentByClass.values()).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (adultEq <= 0) return [];
  const buyer = chooseServiceBuyerActor(inputs, SERVICE_CIVIC_BUYER_PRIORITY);
  if (buyer === undefined) return [];
  const tierFloor = SERVICE_TIER_FLOOR[inputs.settlement.tier] ?? 0.05;
  const wantQuantity =
    resourceKey === 'service.garrison'
      ? tierFloor + adultEq / 2_000
      : tierFloor + adultEq / 3_000 + context.buildings.length * 0.015;
  const treasuryShare = resourceKey === 'service.garrison' ? 0.04 : 0.025;
  const budget = reserveBudgetForActor(context, buyer, treasuryShare);
  if (wantQuantity <= 0 || budget <= 0) return [];
  return [
    comfortDemand({
      id: `service:${String(inputs.settlement.id)}:${String(buyer)}:${resourceKey}`,
      wantQuantity,
      budget,
      decayScale: 1.5,
      cutoffMultiplier: 8,
      buyerActor: buyer,
      buyerDisposition: 'consume',
    }),
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
        comfortDemand({
          id: `service:${String(inputs.settlement.id)}:${klass}:${i}:${String(resource)}`,
          wantQuantity: perBuyerWant,
          budget: cap,
          decayScale: 1.25,
          cutoffMultiplier: 8,
          ...consumerBuyerFieldsFor(buyer),
        }),
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
      comfortDemand({
        id: `service:${String(inputs.settlement.id)}:public_works:${index}:${String(resource)}`,
        wantQuantity,
        budget,
        decayScale: 1.2,
        cutoffMultiplier: 8,
        buyerActor: pending.ownerActor,
        buyerDisposition: 'consume',
      }),
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
  const resourceKey = String(resource);
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
      const budget = budgetCapForActor(context, building.ownerActor, wantQuantity * threshold);
      if (budget <= 0) continue;
      out.push(
        statusDemand({
          id:
            `institutional:${String(inputs.settlement.id)}:${String(building.buildingId)}:` +
            `${buildingIndex}:${resourceKey}`,
          wantQuantity,
          segmentWealth: budget,
          veryHighThreshold: threshold,
          buyerActor: building.ownerActor,
          buyerDisposition: 'consume',
        }),
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
  const baseTarget = CONSTRUCTION_RESERVE_TARGET_BY_RESOURCE[String(resource)] ?? 0;
  if (baseTarget <= 0) return [];
  const tierScale = CONSTRUCTION_RESERVE_TIER_SCALE[inputs.settlement.tier] ?? 1;
  const out: DemandSource[] = [];

  for (const actor of ownerCandidates(inputs)) {
    const kind = inputs.ownerKindByActor?.get(actor);
    if (kind === undefined || !CONSTRUCTION_RESERVE_OWNER_KINDS.has(kind)) continue;
    const kindScale = CONSTRUCTION_RESERVE_KIND_SCALE[kind] ?? 1;
    const target = baseTarget * tierScale * kindScale;
    const gap = reserveStockGap(context, actor, resource, target);
    if (gap <= 0) continue;
    const budget = reserveBudgetForActor(context, actor, CONSTRUCTION_RESERVE_TREASURY_SHARE);
    if (budget <= 0) continue;
    out.push(
      comfortDemand({
        id: `construction_reserve:${String(inputs.settlement.id)}:${String(actor)}:${String(resource)}`,
        wantQuantity: gap,
        budget,
        decayScale: 2,
        cutoffMultiplier: 10,
        buyerActor: actor,
        buyerDisposition: 'stockpile',
      }),
    );
  }
  return out;
};

const transportCapitalSources = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const baseTarget = TRANSPORT_CAPITAL_TARGET_BY_RESOURCE[String(resource)] ?? 0;
  if (baseTarget <= 0) return [];
  const out: DemandSource[] = [];
  for (const actor of ownerCandidates(inputs)) {
    const kind = inputs.ownerKindByActor?.get(actor);
    if (kind === undefined || !TRANSPORT_CAPITAL_OWNER_KINDS.has(kind)) continue;
    const gap = reserveStockGap(context, actor, resource, baseTarget);
    if (gap <= 0) continue;
    const budget = reserveBudgetForActor(context, actor, TRANSPORT_CAPITAL_TREASURY_SHARE);
    if (budget <= 0) continue;
    out.push(
      comfortDemand({
        id: `transport_capital:${String(inputs.settlement.id)}:${String(actor)}:${String(resource)}`,
        wantQuantity: gap,
        budget,
        decayScale: 1.25,
        cutoffMultiplier: 10,
        buyerActor: actor,
        buyerDisposition: 'stockpile',
      }),
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
  const recipes = RECIPES_BY_INPUT.get(String(resource)) ?? [];
  for (const recipe of recipes) {
    const seasonMul = recipe.seasonalMultiplier?.[inputs.season];
    if (seasonMul !== undefined && seasonMul <= 0) continue;
    // Pick a representative output to value (highest-revenue under
    // recentLocalPrices). v1 ignores joint products beyond the chosen one.
    const valued = pickRepresentativeOutput(recipe, inputs.recentLocalPrices);
    if (valued === undefined) continue;
    const inputPerRun = recipe.inputs.get(resource) ?? 0;
    const inputPerOutput = inputPerRun / valued.qty;
    if (inputPerOutput <= 0) continue;
    const expectedRevenuePerInputUnit = valued.price / inputPerOutput;
    let buildingIndex = 0;
    for (const building of context.buildings) {
      if (building.buildingId !== recipe.building) continue;
      if (!buildingCanRunRecipe(context, building, recipe)) continue;
      if (building.capacity <= 0) continue;
      const ownerKind = inputs.ownerKindByActor?.get(building.ownerActor);
      const otherCostsPerInputUnit = otherInputCostsPerInputUnit(
        recipe,
        resource,
        valued.qty,
        inputs.recentLocalPrices,
        context.laborClassContext,
        ownerKind,
      );
      const productionCapacity = Math.min(
        building.capacity * (seasonMul ?? 1),
        laborCapacityForRecipe(recipe, context.laborClassContext, ownerKind),
      );
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
        derivedInputDemand({
          id:
            `derived:${String(inputs.settlement.id)}:${String(recipe.id)}:` +
            `${buildingIndex}:${String(resource)}`,
          expectedOutputRevenuePerInputUnit: expectedRevenuePerInputUnit,
          otherCostsPerInputUnit,
          margin: DERIVED_INPUT_MARGIN,
          productionCapacity: inputConstrainedCapacity * valued.qty,
          inputPerOutput,
          buyerActor: building.ownerActor,
          buyerDisposition: 'stockpile',
        }),
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
  const recipes = RECIPES_BY_REQUIREMENT.get(String(resource)) ?? [];
  for (const recipe of recipes) {
    const requiredPerRun = recipe.requires.get(resource) ?? 0;
    if (requiredPerRun <= 0) continue;
    const seasonMul = recipe.seasonalMultiplier?.[inputs.season];
    if (seasonMul !== undefined && seasonMul <= 0) continue;
    const outputRevenuePerRun = outputRevenueForRecipe(recipe, inputs.recentLocalPrices);
    if (outputRevenuePerRun <= 0) continue;

    let buildingIndex = 0;
    for (const building of context.buildings) {
      if (building.buildingId !== recipe.building) continue;
      if (!buildingCanRunRecipe(context, building, recipe)) continue;
      if (building.capacity <= 0) continue;
      const ownerKind = inputs.ownerKindByActor?.get(building.ownerActor);
      const productionCapacity = Math.min(
        building.capacity * (seasonMul ?? 1),
        laborCapacityForRecipe(recipe, context.laborClassContext, ownerKind),
      );
      if (productionCapacity <= 0) continue;

      const desiredStock = productionCapacity * requiredPerRun;
      const currentStock = Math.max(
        0,
        context.stockpilesByOwner.get(building.ownerActor)?.get(resource) ?? 0,
      );
      const stockGap = Math.max(0, desiredStock - currentStock);
      if (stockGap <= 0) continue;

      const inputAndLaborCostPerRun = inputAndLaborCostForRecipe(
        recipe,
        inputs.recentLocalPrices,
        context.laborClassContext,
        ownerKind,
      );
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
        statusDemand({
          id:
            `productive_capital:${String(inputs.settlement.id)}:${String(recipe.id)}:` +
            `${buildingIndex}:${String(resource)}`,
          wantQuantity: budgetedStockGap,
          segmentWealth: buyerBudget,
          veryHighThreshold: maxPricePerRequiredUnit,
          buyerActor: building.ownerActor,
          buyerDisposition: 'stockpile',
        }),
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

const consumerBuyerFieldsFor = (
  buyerActor: ActorId | undefined,
):
  | { readonly buyerActor: ActorId; readonly buyerDisposition: 'consume' }
  | Record<string, never> => {
  return buyerActor !== undefined ? { buyerActor, buyerDisposition: 'consume' } : {};
};

const buildConsumerBuyersByClass = (
  inputs: BuildScheduleInputs,
): ReadonlyMap<CharacterClass, readonly ActorId[]> => {
  const candidates = ownerCandidates(inputs);
  if (candidates.length === 0) return new Map();
  const out = new Map<CharacterClass, readonly ActorId[]>();
  for (const klass of CHARACTER_CLASSES) {
    const buyers = chooseConsumerBuyerActors(inputs, klass, candidates);
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
): readonly ActorId[] => {
  const ownerKindByActor = inputs.ownerKindByActor;
  if (ownerKindByActor !== undefined) {
    const priority = CONSUMER_BUYER_KIND_PRIORITY[klass];
    for (const kind of priority) {
      const matches: ActorId[] = [];
      for (const actorId of candidates) {
        if (ownerKindByActor.get(actorId) === kind) matches.push(actorId);
      }
      if (matches.length > 0) return matches;
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

const chooseServiceBuyerActor = (
  inputs: BuildScheduleInputs,
  priority: readonly ActorKind[],
): ActorId | undefined => {
  const candidates = ownerCandidates(inputs);
  const ownerKindByActor = inputs.ownerKindByActor;
  if (ownerKindByActor !== undefined) {
    for (const kind of priority) {
      for (const actorId of candidates) {
        if (ownerKindByActor.get(actorId) === kind) return actorId;
      }
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
  for (const item of SUBSISTENCE_BASKET) {
    let cheapest = Infinity;
    for (const sub of item.substitutes) {
      const p = prices.get(sub.resource) ?? 0;
      if (p <= 0) continue;
      const units = sub.qtyKg / Math.max(1e-9, getResource(sub.resource).weightKgPerUnit);
      const cost = units * p;
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
  ownerKind?: ActorKind,
): number => {
  const recipes = RECIPES_BY_OUTPUT.get(String(resource));
  if (recipes === undefined || recipes.length === 0) return 0;
  const wage = laborCostPerWorkerDay(prices);
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
  ownerKind?: ActorKind,
): number => {
  let cost = 0;
  for (const [resource, qty] of recipe.inputs) {
    if (qty <= 0) continue;
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    cost += qty * price;
  }
  const wage = laborCostPerWorkerDay(prices);
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
  ownerKind?: ActorKind,
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
  const wage = laborCostPerWorkerDay(prices);
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

// --- Supply ----------------------------------------------------------------

const supplyForResource = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
  demand: DemandSchedule,
): readonly SupplySource[] => {
  if (getResource(resource).category === 'service') {
    return serviceSupplyForResource(resource, inputs, context);
  }
  const out: SupplySource[] = [];
  const recentPrice = inputs.recentLocalPrices.get(resource) ?? 0;
  const def = getResource(resource);
  const storageHoldingDays = def.perishableDays ?? 365;
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
    const marginalCost = marginalCostFor(
      resource,
      inputs.recentLocalPrices,
      context.laborClassContext,
      kind,
    );
    const urgency = kind !== undefined ? URGENCY_BY_KIND[kind] : DEFAULT_OWNER_URGENCY;
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
      localDailyAbsorption: demand.totalAt(0),
      productionCost,
      salvageFloor: reservationFloorForResource(resource),
      recentPrice,
    });
    out.push(
      ownerSupply({
        id: `supply:${String(inputs.settlement.id)}:${String(ownerActor)}:${String(resource)}`,
        ownerActor,
        stockpile: qty,
        reservedForOwnUse: 0,
        productionCost,
        minimumReservationPrice: reservationFloorForResource(resource),
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

const serviceSupplyForResource = (
  resource: ResourceId,
  inputs: BuildScheduleInputs,
  context: SettlementScheduleContext,
): readonly SupplySource[] => {
  const out: SupplySource[] = [];
  const resourceKey = String(resource);
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
        ownerSupply({
          id:
            `service_supply:${String(inputs.settlement.id)}:${String(building.buildingId)}:` +
            `${buildingIndex}:${lineIndex}:${resourceKey}`,
          ownerActor: building.ownerActor,
          stockpile: capacity,
          reservedForOwnUse: 0,
          productionCost: line.reservationPrice,
          minimumReservationPrice: line.reservationPrice,
          expectedFuturePrice,
          ownerUrgencyFactor: urgency,
          storageHoldingDays: 1,
        }),
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

function toMap<K extends string, V>(rec: Readonly<Record<K, V>>): ReadonlyMap<K, V> {
  const m = new Map<K, V>();
  for (const k of Object.keys(rec) as K[]) {
    m.set(k, rec[k]);
  }
  return m;
}
