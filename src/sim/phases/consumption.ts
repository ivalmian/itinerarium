/**
 * Per-day consumption phase.
 *
 * Each settlement resolves subsistence calories from two sources
 * (per docs/04 §"Subsistence calories"):
 *
 *   1. **Market clearings** of grain, bread, legumes, flour during
 *      the trade phase — already credited to
 *      `SubsistenceAccessRecord.fulfilledModii` before this phase
 *      runs.
 *   2. **Fallback ration purchases** of any non-grain food
 *      stockpile still held locally after markets cleared. This
 *      keeps bread / flour / legumes / cheese / fresh fish + game
 *      usable as emergency food without double-consuming grain.
 *      Fallback rations are bought + consumed immediately; a buyer
 *      household / civic / estate actor pays coin to the seller
 *      unless the same actor owns both ends (self-provision).
 *
 * When `fulfilled < need - 5 %` for several consecutive days, the
 * settlement accrues famine pressure (`faminePressure` WeakMap) and
 * begins emitting `cohort_deaths` events scaled to the shortfall.
 * The kill order is infants → elders → adults, with a fallback to
 * working-age cohorts so a settlement of all 20-somethings can't
 * be invulnerable to famine.
 *
 * Famine pressure resets at the year boundary via `annualPhase`.
 */

import { DEFAULT_GLOBAL_PRICES } from '../caravan/edgeHub.js';
import { addCoin, getStockAt, removeStockAt, subtractCoin, type Actor } from '../politics/actor.js';
import type { Day, ResourceId } from '../types.js';
import { resourceId } from '../types.js';
import {
  faminePressure,
} from '../world/faminePressure.js';
import { recordClearingPrice, recordConsumption, type Settlement } from '../world/settlement.js';
import {
  grainEquivalentModiiPerUnit,
  rationProcessingMarkup,
  type SubsistenceAccessMap,
} from '../world/subsistence.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent, TickStats } from '../tick.js';

const GRAIN_RESOURCE = resourceId('food.grain');

const FOOD_PRIORITY: readonly ResourceId[] = [
  resourceId('food.bread'),
  GRAIN_RESOURCE,
  resourceId('food.legumes'),
  resourceId('food.flour'),
  resourceId('food.milk'),
  resourceId('food.fish'),
  resourceId('food.game'),
  resourceId('food.cheese'),
  resourceId('food.salted_meat'),
  resourceId('food.salted_fish'),
];

interface FallbackRationMarket {
  quantity: number;
  price: number;
}

const FALLBACK_RATION_BUYER_KIND_PRIORITY: readonly Actor['kind'][] = [
  'plebeian_household',
  'freedman_household',
  'foreigner_household',
  'hamlet_household',
  'free_village',
  'city_corporation',
  'patrician_family',
  'governor_office',
  'player',
];

const fallbackRationBuyers = (
  world: WorldState,
  settlement: Settlement,
  seller: Actor,
): readonly Actor[] => {
  const candidates = settlement.stockpileOwners
    .map((id) => world.actors.get(id))
    .filter((a): a is Actor => a !== undefined);
  const out: Actor[] = [];
  for (const kind of FALLBACK_RATION_BUYER_KIND_PRIORITY) {
    for (const buyer of candidates) {
      if (buyer.kind !== kind || buyer.id === seller.id) continue;
      if (!out.some((a) => a.id === buyer.id)) out.push(buyer);
    }
  }
  if (
    candidates.some((a) => a.id === seller.id) &&
    sellerCanSelfProvisionRations(settlement, seller)
  ) {
    out.push(seller);
  }
  return out;
};

const sellerCanSelfProvisionRations = (settlement: Settlement, seller: Actor): boolean => {
  switch (seller.kind) {
    case 'plebeian_household':
    case 'freedman_household':
    case 'foreigner_household':
    case 'hamlet_household':
    case 'free_village':
    case 'city_corporation':
    case 'governor_office':
    case 'player':
      return true;
    case 'patrician_family':
      return (
        settlement.population.adultEquivalentByClass('patrician') > 0 ||
        settlement.population.adultEquivalentByClass('slave') > 0
      );
    default:
      return false;
  }
};

/**
 * Per-resource fallback ration unit price. Tries the local clearing
 * price, then the global default, finally a synthetic grain-anchored
 * staple price scaled by grain-equivalent + processing markup.
 *
 * Exported because the caravan-trade `localRationSellerQuotes` (used
 * by the not-yet-extracted caravan replan + assembly phases) also
 * consumes it.
 */
export const fallbackRationUnitPrice = (
  settlement: Settlement,
  resource: ResourceId,
): number => {
  const local = settlement.market.lastClearingPrice.get(resource);
  if (local !== undefined && Number.isFinite(local) && local > 0) return local;
  const global = DEFAULT_GLOBAL_PRICES.get(resource);
  if (global !== undefined && Number.isFinite(global) && global > 0) return global;
  const grainPrice = settlement.market.lastClearingPrice.get(GRAIN_RESOURCE);
  const staple =
    grainPrice !== undefined && Number.isFinite(grainPrice) && grainPrice > 0
      ? grainPrice
      : (DEFAULT_GLOBAL_PRICES.get(GRAIN_RESOURCE) ?? 1.5);
  return Math.max(
    0.01,
    staple * grainEquivalentModiiPerUnit(resource) * rationProcessingMarkup(resource),
  );
};

const buyFallbackRationsFromOwner = (
  world: WorldState,
  settlement: Settlement,
  seller: Actor,
  wantModii: number,
  fallbackMarkets: Map<ResourceId, FallbackRationMarket>,
): number => {
  if (wantModii <= 0) return 0;
  let remaining = wantModii;
  for (const id of FOOD_PRIORITY) {
    if (remaining <= 0) break;
    const have = getStockAt(seller, settlement.id, id);
    if (have <= 0) continue;
    const grainEqPerUnit = grainEquivalentModiiPerUnit(id);
    if (grainEqPerUnit <= 0) continue;
    const wantUnits = remaining / grainEqPerUnit;
    let takeUnits = Math.min(have, wantUnits);
    let takeAsModii = takeUnits * grainEqPerUnit;
    if (takeAsModii <= 1e-9) continue;
    // Recompute takeUnits since takeAsModii may have been bumped by floor.
    takeUnits = takeAsModii / Math.max(1e-9, grainEqPerUnit);
    const price = fallbackRationUnitPrice(settlement, id);
    const buyers = fallbackRationBuyers(world, settlement, seller);
    if (buyers.length === 0) continue;

    let unitsRemainingForThisResource = takeUnits;
    let unitsConsumed = 0;
    let modiiConsumed = 0;
    for (const buyer of buyers) {
      if (unitsRemainingForThisResource <= 1e-9) break;
      const buyerPaysSeller = buyer.id !== seller.id;
      const maxByTreasury =
        buyerPaysSeller && price > 0 ? buyer.treasury / price : unitsRemainingForThisResource;
      const buyerUnits = Math.min(unitsRemainingForThisResource, maxByTreasury);
      if (buyerUnits <= 1e-9) continue;
      if (buyerPaysSeller) {
        const coin = buyerUnits * price;
        if (coin > 0) {
          subtractCoin(buyer, coin);
          addCoin(seller, coin);
        }
      }
      unitsConsumed += buyerUnits;
      modiiConsumed += buyerUnits * grainEqPerUnit;
      unitsRemainingForThisResource -= buyerUnits;
    }
    if (unitsConsumed <= 1e-9) continue;

    takeUnits = unitsConsumed;
    takeAsModii = modiiConsumed;
    removeStockAt(seller, settlement.id, id, takeUnits);
    const prev = fallbackMarkets.get(id);
    if (prev === undefined) {
      fallbackMarkets.set(id, { quantity: takeUnits, price });
    } else {
      prev.quantity += takeUnits;
      prev.price = price;
    }
    remaining -= takeAsModii;
  }
  return wantModii - Math.max(0, remaining);
};

/**
 * Famine deaths scale with the shortfall fraction. Priority order:
 * infants → elders → working-age adults (fallback so settlements
 * of only working-age can't be invulnerable, which would be wrong).
 */
const computeFamineDeaths = (settlement: Settlement, shortfallFrac: number): number => {
  const total = settlement.population.total();
  if (total === 0) return 0;
  // Coarse: 0.5% of population dies per day at 100% shortfall, scaled.
  const baseRate = 0.005 * Math.min(1, shortfallFrac);
  const target = Math.max(1, Math.floor(total * baseRate));
  let remaining = target;
  let actuallyKilled = 0;
  const priority: readonly string[] = ['0-4', '80+', '5-9', '75-79', '70-74'];
  const fallback: readonly string[] = [
    '15-19',
    '20-24',
    '25-29',
    '30-34',
    '35-39',
    '40-44',
    '45-49',
    '50-54',
    '55-59',
    '60-64',
    '65-69',
    '10-14',
  ];
  const order: readonly string[] = [...priority, ...fallback];
  for (const ageStr of order) {
    if (remaining <= 0) break;
    const age = ageStr as unknown as Parameters<Settlement['population']['totalByAgeBand']>[0];
    const inBand = settlement.population.totalByAgeBand(age);
    if (inBand <= 0) continue;
    const take = Math.min(remaining, inBand);
    let drained = 0;
    const snapshot: Array<[Parameters<Settlement['population']['set']>[0], number]> = [];
    settlement.population.forEachCohort((key, count) => {
      if (key.age === age && count > 0) snapshot.push([key, count]);
    });
    for (const [key, count] of snapshot) {
      if (drained >= take) break;
      const share = Math.max(1, Math.round((count / inBand) * take));
      const kill = Math.min(share, count, take - drained);
      if (kill <= 0) continue;
      settlement.population.set(key, count - kill);
      drained += kill;
      actuallyKilled += kill;
    }
    remaining -= drained;
  }
  return actuallyKilled;
};

export const consumptionPhase = (
  world: WorldState,
  today: Day,
  events: TickEvent[],
  stats: TickStats,
  accessBySettlement: SubsistenceAccessMap,
): void => {
  for (const settlement of world.settlements.values()) {
    const access = accessBySettlement.get(settlement);
    if (access === undefined || access.needModii <= 0) continue;

    let drawn = 0;
    const fallbackMarkets = new Map<ResourceId, FallbackRationMarket>();
    for (const ownerId of settlement.stockpileOwners) {
      const o = world.actors.get(ownerId);
      if (o === undefined) continue;
      const remainingNeed = access.needModii - access.fulfilledModii - drawn;
      if (remainingNeed <= 0) break;
      drawn += buyFallbackRationsFromOwner(world, settlement, o, remainingNeed, fallbackMarkets);
    }
    if (drawn > 0) {
      access.fulfilledModii += drawn;
      for (const [resource, market] of fallbackMarkets) {
        recordConsumption(settlement, resource, market.quantity);
        recordClearingPrice(settlement, resource, market.price);
        stats.marketsCleared += 1;
        events.push({
          type: 'market_cleared',
          settlement: settlement.id,
          resource,
          price: market.price,
          volume: market.quantity,
        });
      }
    }
    const shortfall = access.needModii - access.fulfilledModii;
    const rec = faminePressure.get(settlement) ?? {
      consecutiveShortageDays: 0,
      lastShortageDay: -1,
    };
    if (shortfall > 0.05 * access.needModii) {
      rec.consecutiveShortageDays =
        rec.lastShortageDay === today - 1 ? rec.consecutiveShortageDays + 1 : 1;
      rec.lastShortageDay = today;
      if (rec.consecutiveShortageDays >= 5) {
        const deaths = computeFamineDeaths(settlement, shortfall / Math.max(1, access.needModii));
        if (deaths > 0) {
          stats.famineDeaths += deaths;
          events.push({
            type: 'cohort_deaths',
            settlement: settlement.id,
            deaths,
            cause: 'famine',
          });
        }
      }
    } else {
      rec.consecutiveShortageDays = 0;
    }
    faminePressure.set(settlement, rec);
  }
};
