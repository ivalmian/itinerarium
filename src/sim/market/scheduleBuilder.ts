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
import type { ActorKind } from '../politics/actor.js';
import { CHARACTER_CLASSES, type CharacterClass } from '../population/types.js';
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
  const context = buildSettlementScheduleContext(inputs.settlement);
  for (const resource of inputs.resources) {
    const demandSources: DemandSource[] = [
      ...subsistenceSources(resource, inputs, context),
      ...comfortSources(resource, inputs, context),
      ...statusSources(resource, inputs, context),
      ...derivedInputSources(resource, inputs, context),
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
  // Merchant guilds (docs/15 §C17) hold dues + bond money; not urgent.
  merchant_guild: 0.1,
});

const DEFAULT_OWNER_URGENCY = 1;
/** Margin floor below which the producer doesn't bother. v1: 5%. */
const DERIVED_INPUT_MARGIN = 0.05;
/** Reservation = ratio × recentLocalPrice when no productionCost is supplied. */
const DEFAULT_PRODUCTION_COST_RATIO = 0.8;

// --- Age multiplier ---------------------------------------------------------

interface SettlementScheduleContext {
  readonly adultEquivalentByClass: ReadonlyMap<CharacterClass, number>;
  readonly headsByClass: ReadonlyMap<CharacterClass, number>;
  readonly buildingsByKind: ReadonlyMap<string, number>;
}

const buildSettlementScheduleContext = (settlement: Settlement): SettlementScheduleContext => {
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
  };
};

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
    const perAdult = needsTable[resourceKey];
    if (perAdult === undefined) continue;
    const totalNeed = perAdult * adultEqCount;
    if (totalNeed <= 0) continue;
    const wealthPerHead = wealthMap.get(klass) ?? 0;
    // Total segment wealth = per-capita × headcount (use raw cohort heads,
    // not adult-equivalents — wealth is held per person).
    const headCount = context.headsByClass.get(klass) ?? 0;
    const segmentWealth = wealthPerHead * headCount;
    out.push(
      subsistenceDemand({
        id: `subsistence:${String(inputs.settlement.id)}:${klass}:${resourceKey}`,
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
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const resourceKey = String(resource);
  if (!COMFORT_WANTS.has(resourceKey)) return [];
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
    const totalBudget = budgetPerHead * headCount;
    if (totalBudget <= 0) continue;
    out.push(
      comfortDemand({
        id: `comfort:${String(inputs.settlement.id)}:${klass}:${resourceKey}`,
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
  const totalWealth = wealthPerHead * heads;
  // Threshold = wealth-per-want-unit × a generous multiplier. Patricians will
  // pay multiples of "fair" price for status goods; the step gives them a
  // ceiling that reflects their actual purse depth.
  const threshold = totalWant > 0 ? (totalWealth / totalWant) * 5 : 0;
  if (threshold <= 0) return out;
  out.push(
    statusDemand({
      id: `status:${String(inputs.settlement.id)}:patrician:${resourceKey}`,
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
  context: SettlementScheduleContext,
): readonly DemandSource[] => {
  const out: DemandSource[] = [];
  const recipes = RECIPES_BY_INPUT.get(String(resource)) ?? [];
  for (const recipe of recipes) {
    const buildingCap = context.buildingsByKind.get(String(recipe.building)) ?? 0;
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
 * Imputed wage per worker-day, in coins, computed as the cost of a
 * real subsistence basket at local recent prices. For each basket
 * item we pick the cheapest available substitute that has a positive
 * local price; items where none of the substitutes have any local
 * price contribute 0 (the worker just doesn't get to buy that item
 * yet — but the rest of the basket still has cost). This anchors
 * labor cost endogenously to local prices, so:
 *   - When grain becomes scarce and pricey, wages rise → every
 *     labor-intensive good gets more expensive (cost-push wage
 *     inflation, the classic "price of bread" mechanism).
 *   - When grain is cheap, wages fall and labor-intensive goods
 *     follow.
 *   - When local prices for everything in the basket are unknown,
 *     wage = 0 and MC reduces to its input-cost component (which
 *     itself is anchored by globally-priced resources at the start).
 */
const laborCostPerWorkerDay = (prices: ReadonlyMap<ResourceId, number>): number => {
  let total = 0;
  for (const item of SUBSISTENCE_BASKET) {
    let cheapest = Infinity;
    for (const sub of item.substitutes) {
      const p = prices.get(sub.resource) ?? 0;
      if (p <= 0) continue;
      const cost = sub.qtyKg * p;
      if (cost < cheapest) cheapest = cost;
    }
    if (Number.isFinite(cheapest)) total += cheapest;
  }
  return total;
};

/**
 * Marginal cost of producing one unit of `resource`, computed against
 * `prices` for the inputs and the labor cost imputed from the local
 * grain price. Per docs/08 §"Why marginal cost is the supply floor":
 * this is the classical P = MC anchor for the supply curve. We take
 * the cheapest available recipe; if the resource has no producing
 * recipe (purely extracted with nominal inputs only), MC reduces to
 * the labor component.
 *
 * Missing input prices contribute 0 rather than disqualifying the
 * recipe — partial information is better than 0 cost. The labor term
 * is always included, so even a fully-unpriced recipe still has an
 * MC floor equal to wage × labor.
 *
 * Returns 0 only if no recipe produces the resource AND there is no
 * grain-price signal (the very first day before any clearing).
 */
const marginalCostFor = (
  resource: ResourceId,
  prices: ReadonlyMap<ResourceId, number>,
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
    let totalLabor = 0;
    for (const [, headcount] of recipe.labor) totalLabor += headcount;
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
  const def = getResource(resource);
  const storageHoldingDays = def.perishableDays ?? 365;
  // Per docs/08 §"Why marginal cost is the supply floor": the
  // classical P = MC anchor. Producers won't (rationally) sell below
  // marginal cost — at P < MC every unit loses money. We compute MC
  // from the cheapest recipe that produces this resource, valued at
  // recent local input prices. The earlier formulation used 0.8 ×
  // recent_output_price, which had no anchor to inputs and produced
  // a downward death-spiral whenever supply briefly exceeded demand.
  const marginalCost = marginalCostFor(resource, inputs.recentLocalPrices);
  for (const [ownerActor, byResource] of inputs.stockpilesByOwner) {
    const qty = byResource.get(resource);
    if (qty === undefined || qty <= 0) continue;
    const kind = inputs.ownerKindByActor?.get(ownerActor);
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
    const expectedFuturePrice = recentPrice;
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
