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

/**
 * Per docs/08 §"Marginal-product wages with class surplus shares":
 * each labor class captures a fraction of the recipe's marginal
 * product of labor when that's above subsistence. Slaves are 0
 * (captive labor, owner captures all surplus); the more mobile a
 * class is, the higher the share.
 */
export const SURPLUS_SHARE_BY_CLASS: Readonly<
  Record<'slave' | 'freedman' | 'plebeian' | 'foreigner' | 'patrician', number>
> = {
  slave: 0,
  freedman: 0.25,
  plebeian: 0.35,
  foreigner: 0.45,
  patrician: 0.5,
};

/**
 * Per-run net margin of a recipe, valued at current local prices:
 *
 *   (sum_outputs(qty × output_price) − sum_inputs(qty × input_price))
 *
 * Output is priced at the best LOCAL BID if available (what buyers
 * actually want to pay today), falling back to `lastClearingPrice`
 * (what trade most recently cleared at). When neither side has a
 * quote we return null — the caller decides what to do.
 *
 * This is the gross margin BEFORE wages. The production phase
 * compares it against the subsistence wage bill to decide whether
 * to run the recipe; loss-making recipes are blocked instead of
 * subsidized.
 *
 * Per docs/00 Pillar 8: outputs without a quoted bid have no
 * demand; producing more of them just wastes inputs. The user's
 * directive (v1.6 pass 25): "have asks that force profitability
 * and stop producing if there is no bid."
 */
export const recipeGrossMarginPerRun = (
  recipe: RecipeDef,
  outputBids: ReadonlyMap<ResourceId, number>,
  lastClearingPrices: ReadonlyMap<ResourceId, number>,
  inputPrices: ReadonlyMap<ResourceId, number>,
  globalPrices: ReadonlyMap<ResourceId, number>,
): number | null => {
  // OUTPUT revenue uses the most recent LOCAL CLEARING PRICE - the
  // actual realized trade price, not the buyer's aspirational
  // maximum bid (which the CDA may never clear at if other sellers
  // undercut). Using bestBid would let the dairy bet on the
  // highest-willingness buyer when the real transaction clears
  // much lower. NO global fallback: per user direction "stop
  // producing if there is no bid demonstrated", we won't bet that
  // the off-map global market will absorb unsold output. If
  // nothing has cleared locally, demand isn't yet demonstrated
  // and the recipe blocks (a future caravan import / arbitrage
  // run can set the price; on the next tick production resumes).
  //
  // The `outputBids` parameter is kept on the signature for future
  // refinement (e.g. min(bid, clearing) once we trust both signals).
  void outputBids;
  let outputValue = 0;
  let anyOutputPriced = false;
  for (const [r, q] of recipe.outputs) {
    const last = lastClearingPrices.get(r);
    if (last !== undefined && last > 0) {
      outputValue += q * last;
      anyOutputPriced = true;
    }
  }
  if (!anyOutputPriced) return null;
  // INPUT cost reflects the OPPORTUNITY cost of using the input
  // instead of selling it. Prefer local clearing (what the owner
  // could get for it locally), fall back to the global reference
  // (could export it via an edge-hub caravan). NEITHER is the
  // owner's sunk-cost basis - the gate is asking "would it be
  // smarter to sell this input than to convert it." For
  // make_cheese specifically: milk has a 2-day shelf life and the
  // dairy converts it on-site (no local clearing for milk) but
  // the milk could in principle be sold to a neighboring town -
  // global fallback captures that opportunity-cost reasoning.
  let inputValue = 0;
  for (const [r, q] of recipe.inputs) {
    const local = inputPrices.get(r);
    const global = globalPrices.get(r);
    const price = local && local > 0 ? local : global && global > 0 ? global : 0;
    if (price > 0) inputValue += q * price;
  }
  return outputValue - inputValue;
};

/**
 * The recipe's per-worker-day marginal product, valued at current
 * local prices:
 *
 *   (sum_outputs(qty × price) − sum_inputs(qty × price)) / labor_days
 *
 * Clamped to ≥ 0 (a loss-making recipe doesn't pay negative wages —
 * its workers still get at least the subsistence floor).
 */
export const marginalProductPerWorkerDay = (
  recipe: RecipeDef,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  let laborDays = 0;
  for (const days of recipe.labor.values()) laborDays += days;
  if (laborDays <= 0) return 0;
  let outputValue = 0;
  for (const [r, q] of recipe.outputs) {
    const p = prices.get(r) ?? 0;
    if (p > 0) outputValue += q * p;
  }
  let inputValue = 0;
  for (const [r, q] of recipe.inputs) {
    const p = prices.get(r) ?? 0;
    if (p > 0) inputValue += q * p;
  }
  const mp = (outputValue - inputValue) / laborDays;
  return Math.max(0, mp);
};

/**
 * The wage a single class gets per worker-day, per docs/08
 * §"Marginal-product wages":
 *
 *   wage(class) = max(subsistence, mp_per_worker_day × share[class])
 *
 * Quoted as an integer ≥ 1 coin per docs/08 §"Integer-coin prices"
 * (the per-day price of labor is itself a per-unit price). Ceilinged
 * rather than rounded so worker take-home never falls below the
 * fractional subsistence-basket computation: a sub-1-coin basket cost
 * still pays the worker 1 coin/day.
 *
 * Slaves return 0 (no cash wage; their owner funds subsistence
 * through the consumption market instead).
 */
export const wagePerWorkerDayForClass = (
  klass: CharacterClass,
  subsistenceWagePerDay: number,
  marginalProductOfLabor: number,
): number => {
  if (klass === 'slave') return 0;
  const share = SURPLUS_SHARE_BY_CLASS[klass] ?? 0;
  const productiveWage = Math.max(0, marginalProductOfLabor) * share;
  const raw = Math.max(subsistenceWagePerDay, productiveWage);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1, Math.ceil(raw));
};

/**
 * Conservative upper-bound wage used to gate recipe affordability
 * before the class mix is known. Uses the largest class share (patrician
 * 0.5) so the affordability check never authorizes a run the owner
 * can't actually pay for once the labor pool resolves.
 */
const CONSERVATIVE_AFFORDABILITY_SHARE = 0.5;

export const conservativeWagePerWorkerDay = (
  subsistenceWagePerDay: number,
  marginalProductOfLabor: number,
): number => {
  const raw = Math.max(
    subsistenceWagePerDay,
    Math.max(0, marginalProductOfLabor) * CONSERVATIVE_AFFORDABILITY_SHARE,
  );
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.ceil(raw));
};

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

/**
 * Recipe-level wage context. Captures the local subsistence basket
 * cost AND the recipe's marginal product per worker-day, so the wage
 * payer can compute per-class wages = max(subsistence, mp × share).
 *
 * Per docs/08 §"Marginal-product wages with class surplus shares".
 */
export interface RecipeWageContext {
  readonly subsistenceWagePerDay: number;
  readonly marginalProductPerWorkerDay: number;
}

/**
 * Build a recipe's wage context.
 *
 * `subsistenceWagePerDay` is computed from the wage basket (bread,
 * salt, fuel, etc.) — that's the wage floor.
 *
 * `marginalProductPrices` should be the FULL local market price map
 * (settlement.market.lastClearingPrice), not just the basket. The
 * basket alone reports 0 for any output not in the basket (luxury
 * textiles, equines, etc.), so weavers and equine herders would see
 * mp = 0 and get only subsistence even when their recipe is
 * extremely profitable.
 */
export const buildRecipeWageContext = (
  recipe: RecipeDef,
  marginalProductPrices: ReadonlyMap<ResourceId, number>,
  subsistenceWagePerDay: number,
): RecipeWageContext => ({
  subsistenceWagePerDay,
  marginalProductPerWorkerDay: marginalProductPerWorkerDay(recipe, marginalProductPrices),
});

/**
 * `wageBasketPrices` — used to value in-kind staple wage payments.
 * `marginalProductPrices` — used to compute the recipe's per-day
 * marginal product so high-margin recipes are gated on a realistic
 * affordability ceiling, not the wage-basket subset that returns 0
 * for non-basket outputs like luxury textiles or equines.
 */
export const wageAffordableCapacityForRecipe = (
  world: WorldState,
  settlement: Settlement,
  recipe: RecipeDef,
  laborClassContext: LaborClassContext,
  payer: Actor,
  wageBasketPrices: ReadonlyMap<ResourceId, number>,
  marginalProductPrices: ReadonlyMap<ResourceId, number>,
  subsistenceWagePerDay: number,
): number => {
  if (subsistenceWagePerDay <= 0) return Infinity;
  const paidWorkerDaysPerRun = wageEarningWorkerDaysForLaborForOwner(
    laborClassContext,
    recipe.labor,
    payer.kind,
  );
  if (paidWorkerDaysPerRun <= 0) return Infinity;
  if (!hasAnyWageRecipient(world, settlement, payer)) return Infinity;
  // Conservative cap: assume the highest class-share applies so the
  // owner doesn't authorize more runs than they can pay for once the
  // class mix is resolved.
  const mp = marginalProductPerWorkerDay(recipe, marginalProductPrices);
  const expectedWage = conservativeWagePerWorkerDay(subsistenceWagePerDay, mp);
  if (expectedWage <= 0) return Infinity;
  const liquidBudget = payer.treasury + inKindWageBudget(payer, settlement.id, wageBasketPrices);
  return Math.max(0, liquidBudget / (paidWorkerDaysPerRun * expectedWage));
};

/**
 * Aggregate economics for one recipe run's wage payment. Surfaced so
 * burn-in instruments can attribute output/input/wage/owner-take per
 * recipe per settlement (docs/14 §"Per-recipe economics CSV").
 */
export interface RecipeRunEconomics {
  readonly subsistenceWagePerDay: number;
  readonly marginalProductPerWorkerDay: number;
  readonly wagePaidCoinTotal: number;
  readonly wagePaidInKindValueTotal: number;
  readonly paidWorkerDaysTotal: number;
  readonly perClassWageBill: ReadonlyMap<CharacterClass, number>;
}

const ZERO_ECONOMICS: RecipeRunEconomics = {
  subsistenceWagePerDay: 0,
  marginalProductPerWorkerDay: 0,
  wagePaidCoinTotal: 0,
  wagePaidInKindValueTotal: 0,
  paidWorkerDaysTotal: 0,
  perClassWageBill: new Map(),
};

export const payProductionWages = (
  world: WorldState,
  settlement: Settlement,
  laborClassContext: LaborClassContext,
  payer: Actor,
  laborUsed: ReadonlyMap<JobId, number>,
  prices: ReadonlyMap<ResourceId, number>,
  wageContext: RecipeWageContext,
): RecipeRunEconomics => {
  const byClass = wageEarningWorkerDaysByClassForLaborForOwner(
    laborClassContext,
    laborUsed,
    payer.kind,
  );
  return payProductionWagesForWorkerDaysByClass(
    world,
    settlement,
    payer,
    byClass,
    prices,
    wageContext,
  );
};

/**
 * Per docs/15 §C21 + docs/08 §"Marginal-product wages": pay the wage
 * bill for a recipe run. Each class's wage rate is computed as
 * `max(subsistence, mp_per_worker_day × share[class])`, and the
 * coin → in-kind cascade pays from the owner's treasury then their
 * staple stockpile.
 *
 * Returns aggregate economics for the run so burn-in instruments can
 * attribute output/input/wage/owner-take per recipe per settlement.
 */
export const payProductionWagesForWorkerDaysByClass = (
  world: WorldState,
  settlement: Settlement,
  payer: Actor,
  workerDaysByClass: ReadonlyMap<CharacterClass, number>,
  prices: ReadonlyMap<ResourceId, number>,
  wageContext: RecipeWageContext,
): RecipeRunEconomics => {
  if (workerDaysByClass.size === 0) return ZERO_ECONOMICS;
  if (wageContext.subsistenceWagePerDay <= 0 && wageContext.marginalProductPerWorkerDay <= 0) {
    return ZERO_ECONOMICS;
  }
  let wagePaidCoinTotal = 0;
  let wagePaidInKindValueTotal = 0;
  let paidWorkerDaysTotal = 0;
  const perClassWageBill = new Map<CharacterClass, number>();
  for (const [klass, workerDays] of workerDaysByClass) {
    if (workerDays <= 0) continue;
    if (klass === 'slave') continue; // no cash wages for slave labor
    const wagePerDay = wagePerWorkerDayForClass(
      klass,
      wageContext.subsistenceWagePerDay,
      wageContext.marginalProductPerWorkerDay,
    );
    if (wagePerDay <= 0) continue;
    const recipient = selectWageRecipientForClass(
      world,
      settlement,
      payer,
      klass as 'plebeian' | 'freedman' | 'foreigner' | 'patrician',
    );
    if (recipient === undefined || recipient.id === payer.id) continue;
    // Round the wage bill to integer coin per docs/08 §"Integer-coin
    // prices": no fractional coin ever moves between treasuries. The
    // recipe-fraction × wage-per-day might be 0.4 × 5 = 2 coin (clean)
    // or 0.4 × 3 = 1.2 → 1 coin. Workers get whole coin; rounding
    // residue stays with the owner. This is the integer-coin discipline
    // applied uniformly at every transfer site.
    const wageBill = Math.round(workerDays * wagePerDay);
    if (wageBill <= 0) continue;
    perClassWageBill.set(klass, wageBill);
    paidWorkerDaysTotal += workerDays;
    let remaining = wageBill;
    const paidCoin = Math.min(remaining, payer.treasury);
    if (paidCoin > 0) {
      payer.treasury -= paidCoin;
      recipient.treasury += paidCoin;
      remaining -= paidCoin;
      wagePaidCoinTotal += paidCoin;
    }
    if (remaining > 0) {
      const inKindPaid = payInKindWages(payer, recipient, settlement.id, remaining, prices);
      wagePaidInKindValueTotal += inKindPaid;
    }
  }
  return {
    subsistenceWagePerDay: wageContext.subsistenceWagePerDay,
    marginalProductPerWorkerDay: wageContext.marginalProductPerWorkerDay,
    wagePaidCoinTotal,
    wagePaidInKindValueTotal,
    paidWorkerDaysTotal,
    perClassWageBill,
  };
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

/**
 * Minimum fractional staple quantity considered worth transferring as
 * in-kind wages. In-kind staples (grain in modii, flour in sacks,
 * bread in loaves) accumulate fractionally in stockpiles — half a
 * modius of grain is a real quantity — so we keep a fractional ε for
 * this site rather than rounding to whole units. The integer-coin
 * rule governs the COIN side of wages (above); this is the food side.
 */
const STAPLE_FRACTIONAL_EPS = 1e-9;

const payInKindWages = (
  payer: Actor,
  recipient: Actor,
  settlement: SettlementId,
  targetValue: number,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  let remainingValue = targetValue;
  let valuePaid = 0;
  for (const resource of WAGE_IN_KIND_RESOURCES) {
    if (remainingValue <= 0) break;
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    const stock = getStockAt(payer, settlement, resource);
    if (stock <= STAPLE_FRACTIONAL_EPS) continue;
    const units = Math.min(stock, remainingValue / price);
    if (units <= STAPLE_FRACTIONAL_EPS) continue;
    removeStockAt(payer, settlement, resource, units as Quantity);
    addStockAt(recipient, settlement, resource, units as Quantity);
    const transferred = units * price;
    // Track the actual coin-value transferred; downstream telemetry
    // sums coin + in-kind value to surface total worker take-home.
    remainingValue -= transferred;
    valuePaid += transferred;
  }
  return valuePaid;
};
