/**
 * Shared production-wage helpers.
 *
 * Per docs/15 §C21, every recipe run that consumed paid worker-days
 * has to pay a wage bill split across per-class household recipients
 * in proportion to which classes did the work. Wages fall back from
 * coin → in-kind grain/flour/bread when the payer's treasury runs
 * low, so smallholder farms keep paying day labor in flour even when
 * cash is tight.
 *
 * `wagePriceSignalForSettlement` blends local clearing prices with
 * `DEFAULT_GLOBAL_PRICES` to give the wage formula a stable price
 * basket (otherwise a single missed market clear collapses wages).
 *
 * `wageAffordableCapacityForRecipe` is used by the production phase
 * to cap the runnable capacity of a recipe so wage-insolvent payers
 * never authorize more runs than they can pay for.
 *
 * Originally lived inline in `src/sim/tick.ts`; lifted here so the
 * production phase and the construction phase can both import the
 * same wage path.
 */

import { DEFAULT_GLOBAL_PRICES } from '../caravan/edgeHub.js';
import type { LaborClassContext } from '../jobs/laborEconomics.js';
import {
  wageEarningWorkerDaysByClassForLaborForOwner,
  wageEarningWorkerDaysForLaborForOwner,
} from '../jobs/laborEconomics.js';
import {
  addStockAt,
  getStockAt,
  removeStockAt,
  type Actor,
} from '../politics/actor.js';
import type { CharacterClass } from '../population/types.js';
import type { RecipeDef } from '../production/recipes.js';
import type { JobId, Quantity, ResourceId, SettlementId } from '../types.js';
import { resourceId } from '../types.js';
import type { Settlement } from './settlement.js';
import type { WorldState } from '../../procgen/seed.js';

const WAGE_RECIPIENT_KIND_PRIORITY_BY_CLASS: Readonly<
  Record<'plebeian' | 'freedman' | 'foreigner' | 'patrician', readonly Actor['kind'][]>
> = {
  plebeian: [
    'plebeian_household',
    'hamlet_household',
    'free_village',
    'city_corporation',
    'patrician_family',
    'governor_office',
    'player',
  ],
  freedman: [
    'freedman_household',
    'plebeian_household',
    'hamlet_household',
    'free_village',
    'city_corporation',
    'patrician_family',
    'governor_office',
    'player',
  ],
  foreigner: [
    'foreigner_household',
    'plebeian_household',
    'hamlet_household',
    'free_village',
    'city_corporation',
    'patrician_family',
    'governor_office',
    'player',
  ],
  patrician: [
    // Wage-earning patrician class is rare (paid skilled labor like
    // physicians, scribes-for-hire). Route to the patrician household
    // ladder first; fall back to plebeian household / city_corp.
    'patrician_family',
    'governor_office',
    'plebeian_household',
    'city_corporation',
    'player',
  ],
};

const WAGE_PRICE_SIGNAL_RESOURCES: readonly ResourceId[] = Object.freeze(
  [
    'food.bread',
    'food.flour',
    'food.grain',
    'food.cheese',
    'food.fish',
    'food.game',
    'mineral.salt',
    'material.wood',
    'material.charcoal',
    'goods.cloth',
  ].map(resourceId),
);

export const wagePriceSignalForSettlement = (
  settlement: Settlement,
): ReadonlyMap<ResourceId, number> => {
  const prices = new Map<ResourceId, number>();
  for (const resource of WAGE_PRICE_SIGNAL_RESOURCES) {
    const localPrice = settlement.market.lastClearingPrice.get(resource);
    if (localPrice !== undefined && Number.isFinite(localPrice) && localPrice > 0) {
      prices.set(resource, localPrice);
      continue;
    }
    const globalPrice = DEFAULT_GLOBAL_PRICES.get(resource);
    if (globalPrice !== undefined && Number.isFinite(globalPrice) && globalPrice > 0) {
      prices.set(resource, globalPrice);
    }
  }
  return prices;
};

const selectWageRecipientForClass = (
  world: WorldState,
  settlement: Settlement,
  payer: Actor,
  klass: 'plebeian' | 'freedman' | 'foreigner' | 'patrician',
): Actor | undefined => {
  const priority = WAGE_RECIPIENT_KIND_PRIORITY_BY_CLASS[klass];
  for (const kind of priority) {
    for (const id of settlement.stockpileOwners) {
      const candidate = world.actors.get(id);
      if (candidate === undefined) continue;
      if (candidate.kind === kind && candidate.id !== payer.id) return candidate;
    }
  }
  for (const id of settlement.stockpileOwners) {
    const candidate = world.actors.get(id);
    if (candidate !== undefined && candidate.id === payer.id) return candidate;
  }
  return undefined;
};

/**
 * Find any wage recipient available at the settlement, used by
 * `wageAffordableCapacityForRecipe` which only needs to know whether *some*
 * recipient is available before authorizing a recipe run. The actual class
 * split happens later in `payProductionWagesForWorkerDaysByClass`.
 */
const hasAnyWageRecipient = (world: WorldState, settlement: Settlement, payer: Actor): boolean => {
  for (const oId of settlement.stockpileOwners) {
    const candidate = world.actors.get(oId);
    if (candidate === undefined) continue;
    if (candidate.id === payer.id) continue;
    return true;
  }
  return false;
};

export const wageAffordableCapacityForRecipe = (
  world: WorldState,
  settlement: Settlement,
  recipe: RecipeDef,
  laborClassContext: LaborClassContext,
  payer: Actor,
  prices: ReadonlyMap<ResourceId, number>,
  wagePerDay: number,
): number => {
  if (wagePerDay <= 0) return Infinity;
  const paidWorkerDaysPerRun = wageEarningWorkerDaysForLaborForOwner(
    laborClassContext,
    recipe.labor,
    payer.kind,
  );
  if (paidWorkerDaysPerRun <= 0) return Infinity;
  if (!hasAnyWageRecipient(world, settlement, payer)) return Infinity;
  const liquidBudget = payer.treasury + inKindWageBudget(payer, settlement.id, prices);
  return Math.max(0, liquidBudget / (paidWorkerDaysPerRun * wagePerDay));
};

export const payProductionWages = (
  world: WorldState,
  settlement: Settlement,
  laborClassContext: LaborClassContext,
  payer: Actor,
  laborUsed: ReadonlyMap<JobId, number>,
  prices: ReadonlyMap<ResourceId, number>,
  wagePerDay: number,
): void => {
  const byClass = wageEarningWorkerDaysByClassForLaborForOwner(
    laborClassContext,
    laborUsed,
    payer.kind,
  );
  payProductionWagesForWorkerDaysByClass(world, settlement, payer, byClass, prices, wagePerDay);
};

/**
 * Per docs/15 §C21: pay the wage bill for a recipe run, splitting the
 * total across per-class household recipients in proportion to which
 * classes did the work. Each class's wage portion follows the same
 * coin-then-in-kind cascade as before.
 */
export const payProductionWagesForWorkerDaysByClass = (
  world: WorldState,
  settlement: Settlement,
  payer: Actor,
  workerDaysByClass: ReadonlyMap<CharacterClass, number>,
  prices: ReadonlyMap<ResourceId, number>,
  wagePerDay: number,
): void => {
  if (workerDaysByClass.size === 0) return;
  if (wagePerDay <= 0) return;
  for (const [klass, workerDays] of workerDaysByClass) {
    if (workerDays <= 0) continue;
    if (klass === 'slave') continue; // no cash wages for slave labor
    const recipient = selectWageRecipientForClass(
      world,
      settlement,
      payer,
      klass as 'plebeian' | 'freedman' | 'foreigner' | 'patrician',
    );
    if (recipient === undefined || recipient.id === payer.id) continue;
    const wageBill = workerDays * wagePerDay;
    let remaining = wageBill;
    const paidCoin = Math.min(remaining, payer.treasury);
    if (paidCoin > 0) {
      payer.treasury -= paidCoin;
      recipient.treasury += paidCoin;
      remaining -= paidCoin;
    }
    if (remaining > 1e-9) payInKindWages(payer, recipient, settlement.id, remaining, prices);
  }
};

const WAGE_IN_KIND_RESOURCES: readonly ResourceId[] = [
  resourceId('food.grain'),
  resourceId('food.flour'),
  resourceId('food.bread'),
];

const inKindWageBudget = (
  payer: Actor,
  settlement: SettlementId,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  let value = 0;
  for (const resource of WAGE_IN_KIND_RESOURCES) {
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    value += getStockAt(payer, settlement, resource) * price;
  }
  return value;
};

const payInKindWages = (
  payer: Actor,
  recipient: Actor,
  settlement: SettlementId,
  targetValue: number,
  prices: ReadonlyMap<ResourceId, number>,
): void => {
  let remainingValue = targetValue;
  for (const resource of WAGE_IN_KIND_RESOURCES) {
    if (remainingValue <= 1e-9) break;
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    const stock = getStockAt(payer, settlement, resource);
    if (stock <= 0) continue;
    const units = Math.min(stock, remainingValue / price);
    if (units <= 1e-9) continue;
    removeStockAt(payer, settlement, resource, units as Quantity);
    addStockAt(recipient, settlement, resource, units as Quantity);
    remainingValue -= units * price;
  }
};
