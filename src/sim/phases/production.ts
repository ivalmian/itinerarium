/**
 * Per-tick production phase.
 *
 * For each settlement, run every recipe whose building exists locally,
 * in topological order (raw inputs → refined → manufactured) so a
 * `bake_bread` later in the same tick sees the flour produced by a
 * `mill_grain` earlier in the same phase. Inputs drain from the
 * building owner's stockpile at the settlement; outputs accumulate
 * back into the same owner's stockpile (per docs/15 §C30 — inventory
 * is keyed by physical location).
 *
 * Worker-day labor comes from per-job/per-class pools derived from
 * the settlement's `LaborClassContext`, gated by ownership rules in
 * `ownerCanUseLaborClass` (a free village can't dispatch enslaved
 * labor, etc.). The wage bill for each recipe run flows through the
 * shared `payProductionWagesForWorkerDaysByClass` cascade so coin
 * + in-kind cascades stay consistent with the construction phase.
 *
 * The phase makes two passes per tick. The first pass is best-effort
 * and may abort a recipe mid-resolve when a needed input is missing;
 * the second pass picks up runs that became feasible after producers
 * earlier in the topological order materialized fresh stock.
 *
 * Mining recipes additionally consult the hex deposit registry —
 * a mine sitting on a depleted deposit blocks; a mine whose tile
 * deposit type doesn't match the recipe's mined resource emits a
 * `recipe_blocked` with reason `missing_deposit`.
 */

import { allBuildings } from '../buildings/catalog.js';
import { DEFAULT_GLOBAL_PRICES } from '../caravan/edgeHub.js';
import {
  isWageEarningLaborClass,
  ownerCanUseLaborClass,
  type LaborClassContext,
} from '../jobs/laborEconomics.js';
import { laborCostPerWorkerDay } from '../market/scheduleBuilder.js';
import type { CharacterClass } from '../population/types.js';
import { getStockAt, type Actor } from '../politics/actor.js';
import { planRecipeRun } from '../production/engine.js';
import { allRecipes, recipesByOutput, type RecipeDef } from '../production/recipes.js';
import { getResource } from '../resources/catalog.js';
import {
  buildingId,
  type BuildingId,
  type JobId,
  type RecipeId,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import {
  buildRecipeWageContext,
  payProductionWagesForWorkerDaysByClass,
  wageAffordableCapacityForRecipe,
  wagePriceSignalForSettlement,
} from '../world/productionWages.js';
import {
  recordConsumption,
  recordProduction,
  type Settlement,
  type SettlementBuilding,
} from '../world/settlement.js';
import {
  COIN_RESOURCE,
  EMPTY_RESOURCE_MAP,
  decreaseStockpile,
  isServiceResource,
  receiveResourceOrCoin,
} from '../world/stockpileMutation.js';
import type { Season } from '../world/terrain.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent, TickStats } from '../tick.js';

export const productionPhase = (
  world: WorldState,
  season: Season,
  events: TickEvent[],
  stats: TickStats,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): void => {
  const productionPasses = 2;
  for (const settlement of world.settlements.values()) {
    const laborClassContext = laborContextForSettlement(settlement);
    const laborPools = laborPoolsForSettlement(settlement, laborClassContext);
    const laborAvailabilityByOwnerKind = new Map<Actor['kind'], ReadonlyMap<JobId, number>>();
    const laborAvailabilityForOwnerKind = (
      ownerKind: Actor['kind'],
    ): ReadonlyMap<JobId, number> => {
      let view = laborAvailabilityByOwnerKind.get(ownerKind);
      if (view === undefined) {
        view = laborAvailabilityViewForOwner(laborPools, ownerKind);
        laborAvailabilityByOwnerKind.set(ownerKind, view);
      }
      return view;
    };
    const buildingsById = buildingsByKindForSettlement(settlement);
    const wagePriceSignal = wagePriceSignalForSettlement(settlement);
    const wagePerWorkerDay = laborCostPerWorkerDay(wagePriceSignal);
    const recipesForToday = productionOrderForSettlement(settlement, season, buildingsById);
    for (let pass = 0; pass < productionPasses; pass++) {
      const finalPass = pass === productionPasses - 1;
      for (const recipe of recipesForToday) {
        const buildings = buildingsById.get(recipe.building);
        if (buildings === undefined) continue;
        for (const b of buildings) {
          const ownerActor = world.actors.get(b.ownerActor);
          if (ownerActor === undefined) continue;
          if (b.capacity <= 0) continue;
          if (mineRecipeHasMismatchedDeposit(world, b, recipe)) continue;
          const laborForOwner = laborAvailabilityForOwnerKind(ownerActor.kind);
          const depositCapacity = mineDepositCapacityForRecipe(world, b, recipe);
          if (depositCapacity <= 0) {
            if (finalPass) {
              events.push({
                type: 'recipe_blocked',
                settlement: settlement.id,
                recipe: recipe.id,
                reason: 'missing_deposit',
              });
            }
            continue;
          }
          const inventoryCapacity = productionOutputInventoryCapacityForRecipe(
            ownerActor,
            settlement.id,
            recipe,
            buildings,
          );
          if (inventoryCapacity <= 0) continue;
          const recipeWageContext = buildRecipeWageContext(
            recipe,
            wagePriceSignal,
            wagePerWorkerDay,
          );
          const wageAffordableCapacity = wageAffordableCapacityForRecipe(
            world,
            settlement,
            recipe,
            laborClassContext,
            ownerActor,
            wagePriceSignal,
            wagePerWorkerDay,
          );
          if (wageAffordableCapacity <= 0) {
            if (finalPass) {
              events.push({
                type: 'recipe_blocked',
                settlement: settlement.id,
                recipe: recipe.id,
                reason: 'cash',
              });
            }
            continue;
          }
          const result = planRecipeRun({
            recipe,
            building: {
              id: b.buildingId,
              capacityRemaining: Math.min(
                b.capacity,
                wageAffordableCapacity,
                depositCapacity,
                inventoryCapacity,
              ),
            },
            ownerActor: b.ownerActor,
            laborAvailable: laborForOwner,
            inputStocks: ownerActor.stockpile.get(settlement.id) ?? EMPTY_RESOURCE_MAP,
            season,
          });
          if (result.shortfall !== undefined && result.ranAtFraction === 0) {
            if (finalPass) {
              events.push({
                type: 'recipe_blocked',
                settlement: settlement.id,
                recipe: recipe.id,
                reason: result.shortfall.reason,
              });
            }
            continue;
          }
          if (result.ranAtFraction > 0) {
            const fraction = result.ranAtFraction;
            // Apply the deltas to the owner's stockpile AT THIS SETTLEMENT
            // (docs/15 §C30 — inventory is keyed by physical location).
            for (const [resId, qtyPerRun] of recipe.inputs) {
              const qty = qtyPerRun * fraction;
              if (qty <= 0) continue;
              decreaseStockpile(ownerActor, settlement.id, resId, qty);
              // Recipe-input drain is local consumption: the resource was
              // used UP in this settlement to make something else.
              if (!isServiceResource(resId)) {
                recordConsumption(settlement, resId, qty);
              }
            }
            for (const [resId, qtyPerRun] of recipe.outputs) {
              const qty = qtyPerRun * fraction;
              if (qty <= 0) continue;
              if (isServiceResource(resId)) continue;
              receiveResourceOrCoin(ownerActor, settlement.id, resId, qty);
              recordProduction(settlement, resId, qty);
            }
            depleteMineDeposit(world, b, recipe, fraction);
            // Decrement the labor pool we estimated locally so subsequent
            // recipes in this phase don't double-count workers.
            const consumed = consumeLaborFromPoolsForOwner(
              laborPools,
              recipe.labor,
              fraction,
              ownerActor.kind,
            );
            const wageEconomics = payProductionWagesForWorkerDaysByClass(
              world,
              settlement,
              ownerActor,
              consumed.paidWorkerDaysByClass,
              wagePriceSignal,
              recipeWageContext,
            );
            // Decrement building capacity for the day.
            b.capacity = Math.max(0, b.capacity - result.buildingCapacityUsed);
            stats.recipeRuns += 1;
            events.push({
              type: 'recipe_ran',
              settlement: settlement.id,
              recipe: recipe.id,
              fraction: result.ranAtFraction,
            });
            // Per docs/14 §"Per-recipe economics CSV": surface the
            // output value, input value, wage paid, and the residual
            // owner take so burn-in instruments can audit where the
            // surplus is going (worker vs owner per class per recipe).
            const outputValue = recipeOutputValueAtPrices(recipe, fraction, wagePriceSignal);
            const inputValue = recipeInputValueAtPrices(recipe, fraction, wagePriceSignal);
            const wagePaidTotal =
              wageEconomics.wagePaidCoinTotal + wageEconomics.wagePaidInKindValueTotal;
            events.push({
              type: 'recipe_economics',
              settlement: settlement.id,
              recipe: recipe.id,
              owner: ownerActor.id,
              outputValue,
              inputValue,
              wagePaidCoin: wageEconomics.wagePaidCoinTotal,
              wagePaidInKindValue: wageEconomics.wagePaidInKindValueTotal,
              wagePaidTotal,
              ownerTake: outputValue - inputValue - wagePaidTotal,
              paidWorkerDays: wageEconomics.paidWorkerDaysTotal,
              subsistenceWagePerDay: wageEconomics.subsistenceWagePerDay,
              marginalProductPerWorkerDay: wageEconomics.marginalProductPerWorkerDay,
            });
          }
        }
      }
    }
    // Reset building capacity for tomorrow. Starter and completed buildings
    // keep their own installed capacity; the catalog default is only the
    // legacy fallback for older snapshots/tests.
    for (const b of settlement.buildings) {
      b.capacity = maxCapacityForBuilding(b);
    }
  }
};

/**
 * Per-settlement building-by-kind index. Cached per settlement and
 * invalidated when the building count changes. Used by both the
 * production phase here and the worker-reallocation phase elsewhere.
 */
export const buildingsByKindForSettlement = (
  settlement: Settlement,
): ReadonlyMap<BuildingId, readonly Settlement['buildings'][number][]> => {
  const cached = buildingsByKindCache.get(settlement);
  if (cached !== undefined && cached.buildingCount === settlement.buildings.length) {
    return cached.byKind;
  }
  const out = new Map<BuildingId, Settlement['buildings'][number][]>();
  for (const b of settlement.buildings) {
    let bucket = out.get(b.buildingId);
    if (bucket === undefined) {
      bucket = [];
      out.set(b.buildingId, bucket);
    }
    bucket.push(b);
  }
  buildingsByKindCache.set(settlement, { buildingCount: settlement.buildings.length, byKind: out });
  return out;
};

const buildingsByKindCache: WeakMap<
  Settlement,
  {
    readonly buildingCount: number;
    readonly byKind: ReadonlyMap<BuildingId, readonly Settlement['buildings'][number][]>;
  }
> = new WeakMap();

type LaborClassPools = Map<JobId, Map<CharacterClass, number>>;

const ALL_RECIPE_LABOR_ROLES: readonly JobId[] = (() => {
  const seen = new Set<JobId>();
  const out: JobId[] = [];
  for (const recipe of allRecipes()) {
    for (const role of recipe.labor.keys()) {
      if (seen.has(role)) continue;
      seen.add(role);
      out.push(role);
    }
  }
  return Object.freeze(out);
})();

const laborPoolsForSettlement = (
  settlement: Settlement,
  laborClassContext: LaborClassContext,
): LaborClassPools => {
  const out: LaborClassPools = new Map();

  if (laborClassContext.workersByJobAndClass.size > 0) {
    for (const [job, byClass] of laborClassContext.workersByJobAndClass) {
      const copy = new Map<CharacterClass, number>();
      for (const [klass, count] of byClass) {
        if (count > 0) copy.set(klass, count);
      }
      if (copy.size > 0) out.set(job, copy);
    }
    return out;
  }

  if (settlement.jobAllocations.size > 0) {
    // Legacy/unit fixtures can have job allocations without a population
    // pyramid. Preserve the old "paid workers exist" behavior by treating
    // those allocation-only workers as plebeian labor.
    for (const [job, count] of settlement.jobAllocations) {
      if (count > 0) out.set(job, new Map([['plebeian' as CharacterClass, count]]));
    }
    return out;
  }

  const adults = settlement.population.totalAdults();
  if (adults <= 0) return out;
  for (const role of ALL_RECIPE_LABOR_ROLES) {
    out.set(role, new Map([['plebeian' as CharacterClass, adults]]));
  }
  return out;
};

const laborAvailableForJobFromPoolsForOwner = (
  pools: LaborClassPools,
  job: JobId,
  ownerKind: Actor['kind'],
): number => {
  const byClass = pools.get(job);
  if (byClass === undefined) return 0;
  let total = 0;
  for (const [klass, count] of byClass) {
    if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
    total += count;
  }
  return total;
};

const laborAvailabilityViewForOwner = (
  pools: LaborClassPools,
  ownerKind: Actor['kind'],
): ReadonlyMap<JobId, number> =>
  ({
    get(job: JobId): number {
      return laborAvailableForJobFromPoolsForOwner(pools, job, ownerKind);
    },
  }) as ReadonlyMap<JobId, number>;

const LABOR_CONSUMPTION_CLASS_ORDER: readonly CharacterClass[] = [
  'slave',
  'plebeian',
  'freedman',
  'foreigner',
  'patrician',
];

interface ConsumedLaborByClass {
  /** Total wage-earning worker-days consumed across all classes (paid in coin). */
  readonly paidWorkerDays: number;
  /**
   * Per docs/15 §C21: how those wage-earning worker-days break down by class.
   * The wage routing splits each recipe's wage bill across the matching
   * per-class household actors using this breakdown. Slave worker-days are
   * NOT in this map — they are owner-funded upkeep, not cash wages.
   */
  readonly paidWorkerDaysByClass: ReadonlyMap<CharacterClass, number>;
}

const consumeLaborFromPoolsForOwner = (
  pools: LaborClassPools,
  laborPerRun: ReadonlyMap<JobId, number>,
  fraction: number,
  ownerKind: Actor['kind'],
): ConsumedLaborByClass => {
  let paidWorkerDays = 0;
  // Worker-days are fractional by design (a recipe at 0.4 fraction
  // consumes 0.4 × required worker-days). FRACTIONAL_LABOR_EPS guards
  // against float subtraction residue creating a phantom 1e-15
  // "remaining" entry that loops forever. NOT the same as the
  // integer-coin or whole-unit boundaries above; this is internal
  // accounting only.
  const FRACTIONAL_LABOR_EPS = 1e-9;
  const paidWorkerDaysByClass = new Map<CharacterClass, number>();
  for (const [job, requiredPerRun] of laborPerRun) {
    let remaining = requiredPerRun * fraction;
    if (remaining <= 0) continue;
    const byClass = pools.get(job);
    if (byClass === undefined) continue;
    for (const klass of LABOR_CONSUMPTION_CLASS_ORDER) {
      if (remaining <= FRACTIONAL_LABOR_EPS) break;
      if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
      const available = byClass.get(klass) ?? 0;
      if (available <= 0) continue;
      const used = Math.min(available, remaining);
      const next = available - used;
      if (next > FRACTIONAL_LABOR_EPS) byClass.set(klass, next);
      else byClass.delete(klass);
      if (isWageEarningLaborClass(klass)) {
        paidWorkerDays += used;
        paidWorkerDaysByClass.set(klass, (paidWorkerDaysByClass.get(klass) ?? 0) + used);
      }
      remaining -= used;
    }
  }
  return { paidWorkerDays, paidWorkerDaysByClass };
};

/**
 * Topologically sort recipes so producers run before consumers within the
 * same tick. We approximate with: a recipe whose inputs include the output
 * of recipe X must run after X. With cycles (none in docs/03 v1), the order
 * is undefined.
 */
const topoSortedRecipes = (): readonly ReturnType<typeof allRecipes>[number][] => {
  const recipes = allRecipes();
  // Build dependency: recipeA depends on recipeB if any of A's inputs is in
  // B's outputs.
  const idToRecipe = new Map(recipes.map((r) => [r.id, r] as const));
  const out: (typeof recipes)[number][] = [];
  const visited = new Set<RecipeId>();
  const visiting = new Set<RecipeId>();

  const visit = (r: (typeof recipes)[number]): void => {
    if (visited.has(r.id)) return;
    if (visiting.has(r.id)) return; // cycle guard
    visiting.add(r.id);
    for (const input of r.inputs.keys()) {
      const producers = recipesByOutput(input);
      for (const p of producers) {
        const pr = idToRecipe.get(p.id);
        if (pr === undefined) continue;
        if (pr.id === r.id) continue;
        visit(pr);
      }
    }
    visiting.delete(r.id);
    visited.add(r.id);
    out.push(r);
  };
  for (const r of recipes) visit(r);
  return out;
};

const RECIPES_IN_TOPO_ORDER = topoSortedRecipes();
const RECIPE_TOPO_INDEX: ReadonlyMap<RecipeId, number> = (() => {
  const m = new Map<RecipeId, number>();
  RECIPES_IN_TOPO_ORDER.forEach((recipe, index) => m.set(recipe.id, index));
  return m;
})();

const MINE_BUILDING_ID = buildingId('mine');

const minedResourceForRecipe = (recipe: RecipeDef): ResourceId | undefined => {
  if (recipe.building !== MINE_BUILDING_ID) return undefined;
  for (const resource of recipe.outputs.keys()) {
    if (getResource(resource).category === 'mineral') return resource;
  }
  return undefined;
};

const mineDepositCapacityForRecipe = (
  world: WorldState,
  building: SettlementBuilding,
  recipe: RecipeDef,
): number => {
  const minedResource = minedResourceForRecipe(recipe);
  if (minedResource === undefined) return Infinity;
  const deposit = world.grid.get(building.hex)?.deposit;
  if (
    deposit === undefined ||
    deposit.resource !== minedResource ||
    !Number.isFinite(deposit.remaining) ||
    deposit.remaining <= 0
  ) {
    return 0;
  }
  const outputPerRun = recipe.outputs.get(minedResource) ?? 0;
  if (outputPerRun <= 0) return 0;
  return Math.max(0, deposit.remaining / outputPerRun);
};

export const mineRecipeHasMismatchedDeposit = (
  world: WorldState,
  building: SettlementBuilding,
  recipe: RecipeDef,
): boolean => {
  const minedResource = minedResourceForRecipe(recipe);
  if (minedResource === undefined) return false;
  const deposit = world.grid.get(building.hex)?.deposit;
  return deposit !== undefined && deposit.remaining > 0 && deposit.resource !== minedResource;
};

const depleteMineDeposit = (
  world: WorldState,
  building: SettlementBuilding,
  recipe: RecipeDef,
  fraction: number,
): void => {
  const minedResource = minedResourceForRecipe(recipe);
  if (minedResource === undefined) return;
  const outputQty = (recipe.outputs.get(minedResource) ?? 0) * fraction;
  if (outputQty <= 0) return;
  const tile = world.grid.get(building.hex);
  const deposit = tile?.deposit;
  if (tile === undefined || deposit === undefined || deposit.resource !== minedResource) return;
  const remaining = deposit.remaining - outputQty;
  // Deposit remaining is fractional (kg of ore extracted gradually).
  // Below 1 unit, treat as depleted; the deposit is gone.
  if (remaining < 1) {
    delete tile.deposit;
  } else {
    tile.deposit = { resource: minedResource, remaining };
  }
};

const recipeSeasonalMultiplier = (recipe: RecipeDef, season: Season): number => {
  if (recipe.seasonalMultiplier === undefined) return 1;
  return recipe.seasonalMultiplier[season] ?? 0;
};

const productionSignalPrice = (settlement: Settlement, resource: ResourceId): number => {
  const local = settlement.market.lastClearingPrice.get(resource);
  if (local !== undefined && Number.isFinite(local) && local > 0) return local;
  const global = DEFAULT_GLOBAL_PRICES.get(resource);
  if (global !== undefined && Number.isFinite(global) && global > 0) return global;
  return 0;
};

const resourceMapValue = (
  settlement: Settlement,
  resources: ReadonlyMap<ResourceId, number>,
): number => {
  let total = 0;
  for (const [resource, qty] of resources) {
    if (qty <= 0) continue;
    total += qty * productionSignalPrice(settlement, resource);
  }
  return total;
};

const LABOR_DAYS_BY_RECIPE: ReadonlyMap<RecipeId, number> = (() => {
  const out = new Map<RecipeId, number>();
  for (const recipe of allRecipes()) {
    let total = 0;
    for (const qty of recipe.labor.values()) total += Math.max(0, qty);
    out.set(recipe.id, total);
  }
  return out;
})();

export const productionPriority = (
  settlement: Settlement,
  recipe: RecipeDef,
  season: Season,
): number => {
  const seasonMul = recipeSeasonalMultiplier(recipe, season);
  if (seasonMul <= 0) return Number.NEGATIVE_INFINITY;
  const outputValue = resourceMapValue(settlement, recipe.outputs);
  const inputCost = resourceMapValue(settlement, recipe.inputs);
  const margin = outputValue - inputCost;
  const laborDays = Math.max(0.1, LABOR_DAYS_BY_RECIPE.get(recipe.id) ?? 0);
  // Producers react to observed marginal prices: high-value downstream
  // goods should get scarce labor before low-price intermediates. A small
  // gross-output term keeps extraction running early in a save before input
  // prices have formed.
  return ((margin * 2 + outputValue * 0.05) * seasonMul) / laborDays;
};

const productionOrderForSettlement = (
  settlement: Settlement,
  season: Season,
  buildingsById: ReadonlyMap<BuildingId, readonly Settlement['buildings'][number][]>,
): readonly RecipeDef[] => {
  const ranked: { readonly recipe: RecipeDef; readonly priority: number; readonly topo: number }[] =
    [];
  for (const recipe of RECIPES_IN_TOPO_ORDER) {
    if (!buildingsById.has(recipe.building)) continue;
    const priority = productionPriority(settlement, recipe, season);
    if (priority === Number.NEGATIVE_INFINITY) continue;
    ranked.push({
      recipe,
      priority,
      topo: RECIPE_TOPO_INDEX.get(recipe.id) ?? 0,
    });
  }
  ranked.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.topo - b.topo;
  });
  return ranked.map((entry) => entry.recipe);
};

/**
 * Sum the value (at current local prices) of one fractional recipe
 * run's outputs. Used to emit the recipe_economics event so burn-in
 * can audit owner-vs-worker surplus split per recipe.
 */
const recipeOutputValueAtPrices = (
  recipe: RecipeDef,
  fraction: number,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  let value = 0;
  for (const [r, qPerRun] of recipe.outputs) {
    if (isServiceResource(r)) continue;
    const p = prices.get(r) ?? 0;
    if (p > 0) value += qPerRun * fraction * p;
  }
  return value;
};

const recipeInputValueAtPrices = (
  recipe: RecipeDef,
  fraction: number,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  let value = 0;
  for (const [r, qPerRun] of recipe.inputs) {
    const p = prices.get(r) ?? 0;
    if (p > 0) value += qPerRun * fraction * p;
  }
  return value;
};

const DEFAULT_PRODUCTION_OUTPUT_STOCK_TARGET_DAYS = 30;
const PRODUCTION_OUTPUT_STOCK_TARGET_DAYS_BY_RESOURCE: ReadonlyMap<string, number> = new Map([
  ['food.grain', 180],
  ['food.legumes', 120],
  ['food.flour', 14],
  ['food.salted_fish', 180],
  ['food.salted_meat', 180],
  // Military/capital goods are procurement-buffer outputs, not broad
  // household inventory. Keep their speculative stock target tight so
  // scarce iron flows to tools unless barracks/cart buyers are active.
  // Per docs/03 §"Weapon-archetype substitution policy": each archetype
  // keeps its own tiny target; ammunition (arrows, sling bullets) gets a
  // slightly higher target because they're consumed in bulk per battle.
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

const productionOutputStockTargetDays = (resource: ResourceId): number => {
  const explicit = PRODUCTION_OUTPUT_STOCK_TARGET_DAYS_BY_RESOURCE.get(String(resource));
  if (explicit !== undefined) return explicit;
  const perishableDays = getResource(resource).perishableDays;
  if (perishableDays !== undefined && perishableDays > 0) return perishableDays;
  return DEFAULT_PRODUCTION_OUTPUT_STOCK_TARGET_DAYS;
};

const productionOutputInventoryCapacityForRecipe = (
  ownerActor: Actor,
  settlement: SettlementId,
  recipe: RecipeDef,
  buildingsForRecipe: readonly SettlementBuilding[],
): number => {
  let capacity = Infinity;
  const ownerInstalledCapacity = buildingsForRecipe.reduce(
    (sum, building) =>
      sum + (building.ownerActor === ownerActor.id ? Math.max(0, building.capacity) : 0),
    0,
  );
  if (ownerInstalledCapacity <= 0) return 0;

  for (const [resource, qtyPerRun] of recipe.outputs) {
    if (qtyPerRun <= 0 || isServiceResource(resource)) continue;
    const targetStock =
      ownerInstalledCapacity * qtyPerRun * productionOutputStockTargetDays(resource);
    const currentStock =
      resource === COIN_RESOURCE
        ? ownerActor.treasury
        : getStockAt(ownerActor, settlement, resource);
    const gap = targetStock - currentStock;
    if (gap <= 0) return 0;
    capacity = Math.min(capacity, gap / qtyPerRun);
  }

  return Number.isFinite(capacity) ? Math.max(0, capacity) : Infinity;
};

// Default capacity-by-id table, computed once at module load. Individual
// buildings may have a larger installed capacity, especially procgen starter
// buildings that represent many farms/workshops under one logical building.
const _capacityCache: ReadonlyMap<BuildingId, number> = (() => {
  const m = new Map<BuildingId, number>();
  for (const b of allBuildings()) m.set(b.id, b.capacityUnits);
  return m;
})();
const capacityForBuilding = (id: BuildingId): number => _capacityCache.get(id) ?? 1;

const maxCapacityForBuilding = (building: SettlementBuilding): number => {
  const installed = building.maxCapacity ?? capacityForBuilding(building.buildingId);
  return Number.isFinite(installed) ? Math.max(0, installed) : 0;
};
