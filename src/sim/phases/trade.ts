/**
 * Trade + local-trade phases (docs/06 + docs/08).
 *
 * The trade phase clears the daily continuous double-auction at
 * every settlement: for each tradable resource present locally,
 * a full microeconomic demand schedule (subsistence + comfort +
 * status + derived-input demand from procurement / capital
 * reserves / production inputs) meets a reservation-price supply
 * schedule and the clearing price is recorded. Trades transfer
 * goods seller → buyer (or direct consumption) and coin in the
 * other direction, treasury-capped per docs/15 §C21.
 *
 * The local-trade phase fires after the main market clear and
 * smooths surplus between settlements within the local-trade
 * radius. Three transport tiers (household-petty / workshop /
 * industrial) pick load + max-distance from a resource taxonomy;
 * the village-scale herd cap (`MAX_WALKING_HERD_LOCAL_TRADE_UNITS`)
 * keeps cattle/equines from teleporting in pairs across the map.
 *
 * Shared between the two phases:
 *   - market-max-price ceiling formula + strategic-input scarcity
 *     multipliers (`marketMaxPriceForResource`)
 *   - the bid/ask book-ladder bookkeeping for the price-history UI
 *   - `seededPricesForSettlement` (used by both the local-trade
 *     schedule and the trade phase via the demand source builder)
 *   - `ownerKindByActorForWorld` per-world WeakMap cache
 *
 * Originally lived inline in `src/sim/tick.ts`.
 */

import { allRecipes } from '../production/recipes.js';
import { clearMarket } from '../market/clear.js';
import type { DemandSource } from '../market/demand.js';
import {
  buildSettlementSchedules,
  isCommunityFoodPool,
  createSettlementDemandSourceBuilder,
  institutionalProcurementResourcesForBuilding,
  serviceMarketResources,
  type SettlementDemandSourceBuilder,
} from '../market/scheduleBuilder.js';
import { integerCoinClearing, wholeUnitsForTransaction } from '../market/wholeUnits.js';
import { edictPriceCapFor } from './civilUnrest.js';
import { DEFAULT_GLOBAL_PRICES } from '../caravan/edgeHub.js';
import { actorStockEntriesAt, addCoin, getStockAt, subtractCoin, type Actor } from '../politics/actor.js';
import { getResource } from '../resources/catalog.js';
import type { LaborClassContext } from '../jobs/laborEconomics.js';
import {
  buildingId,
  resourceId,
  type ActorId,
  type Day,
  type Quantity,
  type ResourceId,
} from '../types.js';
import {
  clearMarketBook,
  recordClearingPrice,
  recordConsumption,
  recordExport,
  recordImport,
  recordLastClearedDay,
  recordMarketBook,
  recordMarketBookLadder,
  type MarketBookEntry,
  type MarketBookLadder,
  type MarketBookOrder,
  type Settlement,
} from '../world/settlement.js';
import { settlementAnchorIndexForWorld } from '../world/settlementIndex.js';
import { isPassable, type Season } from '../world/terrain.js';
import {
  decreaseStockpile,
  EMPTY_RESOURCE_MAP,
  increaseStockpile,
  isServiceResource,
} from '../world/stockpileMutation.js';
import {
  grainEquivalentModiiPerUnit,
  type SubsistenceAccessMap,
} from '../world/subsistence.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent, TickStats } from '../tick.js';

// --- Phase 4: Trade ---------------------------------------------------------

/**
 * For each settlement and each tradable resource present in any owner's
 * stockpile (or demanded by population/producers/institutions), build a
 * modern microeconomic demand schedule (willingness to pay, budget limits,
 * derived input demand), build a reservation-price supply schedule, and call
 * clearMarket. Trades transfer goods from sellers to buyer actors or direct
 * consumption, and coin in the other direction, treasury-capped.
 */
const DEFAULT_MARKET_MAX_PRICE = 10_000;
const SCARCITY_PRICE_MULTIPLIER = 12;
const STRATEGIC_INPUT_SCARCITY_PRICE_MULTIPLIER = 40;
const MIN_SCARCITY_PRICE_CEILING = 5;
const MAX_LOCAL_FALLBACK_REFERENCE_PRICE = 50;

const STRATEGIC_PRODUCER_INPUTS: ReadonlySet<string> = new Set([
  'mineral.iron_ore',
  'material.charcoal',
  'metal.iron',
  'goods.tools',
]);

const scarcityPriceMultiplierForResource = (resource: ResourceId): number =>
  STRATEGIC_PRODUCER_INPUTS.has(String(resource))
    ? STRATEGIC_INPUT_SCARCITY_PRICE_MULTIPLIER
    : SCARCITY_PRICE_MULTIPLIER;

const fallbackScarcityReferencePrice = (resource: ResourceId): number => {
  const def = getResource(resource);
  const kg = Math.max(0.001, def.weightKgPerUnit);
  let coinPerKg: number;
  switch (def.category) {
    case 'food':
      coinPerKg = 1;
      break;
    case 'material':
      coinPerKg = def.tier === 0 ? 0.02 : 0.5;
      break;
    case 'mineral':
      coinPerKg = 0.2;
      break;
    case 'metal':
      coinPerKg = 2;
      break;
    case 'livestock':
      coinPerKg = 0.05;
      break;
    case 'goods':
      coinPerKg = 10;
      break;
    case 'exotic':
      coinPerKg = 50;
      break;
    case 'people':
      coinPerKg = 10;
      break;
    case 'service':
      coinPerKg = 0;
      break;
  }
  if (coinPerKg <= 0) return 0;
  return Math.min(MAX_LOCAL_FALLBACK_REFERENCE_PRICE, kg * coinPerKg);
};

const marketMaxPriceForResource = (
  resource: ResourceId,
  supplySources: readonly { readonly reservationPrice: number }[],
  recentLocalPrices: ReadonlyMap<ResourceId, number>,
): number => {
  const globalReference = DEFAULT_GLOBAL_PRICES.get(resource);
  let reference =
    globalReference !== undefined && Number.isFinite(globalReference) && globalReference > 0
      ? globalReference
      : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(reference)) {
    for (const source of supplySources) {
      const price = source.reservationPrice;
      if (Number.isFinite(price) && price > 0 && price < reference) reference = price;
    }
  }

  if (!Number.isFinite(reference)) {
    const observed = recentLocalPrices.get(resource);
    if (
      observed !== undefined &&
      Number.isFinite(observed) &&
      observed > 0 &&
      observed < DEFAULT_MARKET_MAX_PRICE
    ) {
      reference = observed;
    }
  }

  const fallback = fallbackScarcityReferencePrice(resource);
  if (globalReference === undefined && fallback > 0) {
    reference = Number.isFinite(reference) ? Math.min(reference, fallback) : fallback;
  }

  if (!Number.isFinite(reference)) return DEFAULT_MARKET_MAX_PRICE;
  const ceiling = Math.max(
    MIN_SCARCITY_PRICE_CEILING,
    reference * scarcityPriceMultiplierForResource(resource),
  );
  return Math.min(DEFAULT_MARKET_MAX_PRICE, ceiling);
};

const MIN_SHORTAGE_SIGNAL_KG = 0.25;

const isMeaningfulShortageSignal = (resource: ResourceId, unmetQuantity: number): boolean => {
  if (!Number.isFinite(unmetQuantity) || unmetQuantity <= 0) return false;
  const kgPerUnit = Math.max(0.001, getResource(resource).weightKgPerUnit);
  return unmetQuantity * kgPerUnit >= MIN_SHORTAGE_SIGNAL_KG;
};

const lowestFiniteAsk = (
  supplySources: readonly { readonly reservationPrice: number }[],
): number | null => {
  let best = Number.POSITIVE_INFINITY;
  for (const source of supplySources) {
    const price = source.reservationPrice;
    if (Number.isFinite(price) && price > 0 && price < best) best = price;
  }
  return Number.isFinite(best) ? best : null;
};

const boundedSellerOnlyAsk = (
  resource: ResourceId,
  supplySources: readonly { readonly reservationPrice: number }[],
  recentLocalPrices: ReadonlyMap<ResourceId, number>,
): number | null => {
  const ask = lowestFiniteAsk(supplySources);
  if (ask === null) return null;
  return Math.min(ask, marketMaxPriceForResource(resource, supplySources, recentLocalPrices));
};

const deleteClearingPriceIfNoRecordedOutflow = (
  settlement: Settlement,
  resource: ResourceId,
): void => {
  if ((settlement.market.recentOutflows.get(resource) ?? 0) > 0) return;
  settlement.market.lastClearingPrice.delete(resource);
  clearMarketBook(settlement, resource);
};

/**
 * Surface the residual bid-ask book from a clearing result onto the
 * settlement's MarketSnapshot. Per docs/08 §"Bid-ask book", the book is
 * derived per-tick from the residual schedules; we just persist whatever
 * the CDA emitted.
 */
const recordBookFromClearing = (
  settlement: Settlement,
  resource: ResourceId,
  result: {
    readonly bestAsk: number | null;
    readonly askDepth: number;
    readonly bestBid: number | null;
    readonly bidDepth: number;
    readonly midPrice: number | null;
    readonly spread: number | null;
  },
): void => {
  const entry: MarketBookEntry = {
    bestAsk: result.bestAsk,
    askDepth: result.askDepth,
    bestBid: result.bestBid,
    bidDepth: result.bidDepth,
    midPrice: result.midPrice,
    spread: result.spread,
  };
  recordMarketBook(settlement, resource, entry);
};

const BOOK_LADDER_MAX_ORDERS_PER_SIDE = 12;

const insertAskBookOrder = (orders: MarketBookOrder[], order: MarketBookOrder): void => {
  if (
    orders.length >= BOOK_LADDER_MAX_ORDERS_PER_SIDE &&
    order.price >= (orders[orders.length - 1]?.price ?? Infinity)
  ) {
    return;
  }
  let index = 0;
  while (index < orders.length && orders[index]!.price <= order.price) index++;
  orders.splice(index, 0, order);
  if (orders.length > BOOK_LADDER_MAX_ORDERS_PER_SIDE) orders.pop();
};

const insertBidBookOrder = (orders: MarketBookOrder[], order: MarketBookOrder): void => {
  if (
    orders.length >= BOOK_LADDER_MAX_ORDERS_PER_SIDE &&
    order.price <= (orders[orders.length - 1]?.price ?? 0)
  ) {
    return;
  }
  let index = 0;
  while (index < orders.length && orders[index]!.price >= order.price) index++;
  orders.splice(index, 0, order);
  if (orders.length > BOOK_LADDER_MAX_ORDERS_PER_SIDE) orders.pop();
};

/**
 * Per docs/15 §C19: build the per-source bid/ask ladder from the residual
 * schedules and stamp it on the settlement. Asks ascending, bids descending,
 * capped to BOOK_LADDER_MAX_ORDERS_PER_SIDE entries per side so the snapshot
 * doesn't balloon when a city has hundreds of tiny producer-input bids.
 */
const recordBookLadderFromClearing = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
  demandSources: readonly {
    readonly id: string;
    readonly curve: 'subsistence' | 'comfort' | 'status' | 'derived';
    quantityAt(price: number): number;
    readonly peakQuantity: number;
    readonly maxWillingnessToPay: number;
    readonly buyerActor?: ActorId;
    readonly buyerDisposition?: 'consume' | 'stockpile';
  }[],
  supplySources: readonly {
    readonly id: string;
    readonly ownerActor: ActorId;
    readonly reservationPrice: number;
    readonly availableToSell: number;
  }[],
  result: {
    readonly clearingPrice: number;
    readonly totalTraded: number;
    readonly trades: readonly {
      readonly buyerSourceId: string;
      readonly sellerSourceId: string;
      readonly quantity: number;
    }[];
  },
  today: Day,
): void => {
  // How much of each demand/supply source was filled today?
  let filledByBuyer: Map<string, number> | undefined;
  let filledBySeller: Map<string, number> | undefined;
  if (result.trades.length > 0) {
    filledByBuyer = new Map<string, number>();
    filledBySeller = new Map<string, number>();
    for (const trade of result.trades) {
      filledByBuyer.set(
        trade.buyerSourceId,
        (filledByBuyer.get(trade.buyerSourceId) ?? 0) + trade.quantity,
      );
      filledBySeller.set(
        trade.sellerSourceId,
        (filledBySeller.get(trade.sellerSourceId) ?? 0) + trade.quantity,
      );
    }
  }
  const evalPrice = Number.isFinite(result.clearingPrice)
    ? result.clearingPrice
    : Number.MAX_SAFE_INTEGER;
  const asks: MarketBookOrder[] = [];
  for (const s of supplySources) {
    const filled = filledBySeller?.get(s.id) ?? 0;
    const remaining = Math.max(0, s.availableToSell - filled);
    if (remaining <= 1e-6) continue;
    if (!Number.isFinite(s.reservationPrice)) continue;
    const actor = world.actors.get(s.ownerActor);
    if (actor === undefined) continue;
    insertAskBookOrder(asks, {
      actorId: s.ownerActor,
      actorKind: actor.kind,
      price: s.reservationPrice,
      quantity: remaining,
    });
  }
  const bids: MarketBookOrder[] = [];
  for (const d of demandSources) {
    const filled = filledByBuyer?.get(d.id) ?? 0;
    // Residual quantity that would still trade at the curve's max-WTP.
    // For subsistence (maxWtp = Infinity) we use quantityAt(eval) as a
    // representative current-day order size.
    const sampleQty = Number.isFinite(d.maxWillingnessToPay)
      ? d.peakQuantity
      : d.quantityAt(evalPrice);
    const remaining = Math.max(0, sampleQty - filled);
    if (remaining <= 1e-6) continue;
    if (!Number.isFinite(d.maxWillingnessToPay)) {
      // Subsistence: infinite-WTP. Show the bid at the current clearing
      // price for ladder purposes (its effective floor in this market).
      if (!Number.isFinite(result.clearingPrice) || result.clearingPrice <= 0) continue;
      const buyer = d.buyerActor !== undefined ? world.actors.get(d.buyerActor) : undefined;
      if (buyer === undefined) continue;
      insertBidBookOrder(bids, {
        actorId: d.buyerActor as ActorId,
        actorKind: buyer.kind,
        price: result.clearingPrice,
        quantity: remaining,
        curve: d.curve,
        ...(d.buyerDisposition !== undefined ? { buyerDisposition: d.buyerDisposition } : {}),
      });
      continue;
    }
    if (d.buyerActor === undefined) continue;
    const buyer = world.actors.get(d.buyerActor);
    if (buyer === undefined) continue;
    insertBidBookOrder(bids, {
      actorId: d.buyerActor,
      actorKind: buyer.kind,
      price: d.maxWillingnessToPay,
      quantity: remaining,
      curve: d.curve,
      ...(d.buyerDisposition !== undefined ? { buyerDisposition: d.buyerDisposition } : {}),
    });
  }
  const ladder: MarketBookLadder = { asks, bids };
  recordMarketBookLadder(settlement, resource, ladder, today);
};

export const tradePhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
  stats: TickStats,
  subsistenceAccess: SubsistenceAccessMap,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): void => {
  // Per docs/08 + codex review #5: replaced the v1 8-resource hardcoded
  // "grain or comfort" model with the full demand/supply schedule
  // builder (subsistence + comfort + status + derived-input demand)
  // for every tradable resource. Without this swap, market prices
  // never moved off their hardcoded reservation values (user
  // observation #1 in the viewer: grain/flour/bread always 0.5,
  // cheese/tool/wine always 1000).
  const tradable = TRADABLE_RESOURCES;
  const ownerKindByActor = ownerKindByActorForWorld(world);

  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;

    // Stockpiles by owner — buildSettlementSchedules expects each owner's
    // slice AT THIS SETTLEMENT (docs/15 §C30 — inventory is physical).
    const stockpilesByOwner = new Map<ActorId, ReadonlyMap<ResourceId, Quantity>>();
    const actorTreasuryByActor = new Map<ActorId, number>();
    const owners: Actor[] = [];
    for (const oId of settlement.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      stockpilesByOwner.set(a.id, a.stockpile.get(settlement.id) ?? EMPTY_RESOURCE_MAP);
      actorTreasuryByActor.set(a.id, a.treasury);
      owners.push(a);
    }
    if (owners.length === 0) continue;

    // Only clear resources that are economically visible here: stock is
    // present, population wants it, or a local building can use it as an
    // input. Demand-only resources still matter because scarcity prices
    // are the signal that attracts caravans into shortages.
    const presentResources = new Set<ResourceId>();
    for (const o of owners) {
      for (const [res, qty] of actorStockEntriesAt(o, settlement.id)) {
        if (qty > 0) presentResources.add(res);
      }
    }
    const demandCandidateResources = demandCandidateResourcesForSettlement(settlement);
    const priceMemoryResources = settlement.market.lastClearingPrice;
    const localTradable = tradable.filter(
      (r) =>
        presentResources.has(r) || demandCandidateResources.has(r) || priceMemoryResources.has(r),
    );
    if (localTradable.length === 0) continue;

    // Synthesize a recentLocalPrices map. We seed *every* resource we
    // might need to reason about — not just locally-tradable ones —
    // because the marginal-cost anchor in scheduleBuilder needs to
    // look up input prices (grain, salt, wood, etc.) when computing
    // MC of a refined good, even if those inputs aren't currently in
    // someone's local stockpile. Sources, in priority order:
    //   1. Last observed local clearing price (the truest local
    //      signal).
    //   2. Off-map global price, IF this resource has one (caravans
    //      from outside the province know the empire-wide reference
    //      for grain, oil, wine, cloth, tools, weapons, silver,
    //      gold, exotics, slaves — these are the high-value
    //      long-distance goods worth shipping at scale; this is a
    //      real economic signal, not an arbitrary pin).
    //   3. Otherwise: unseeded. Local-only goods (flour, bread,
    //      charcoal, lumber, pottery, hides) have no external
    //      anchor; their price has to emerge from local marginal
    //      cost. The MC formula tolerates missing input prices
    //      (contributes 0 for that input), so the chain bootstraps
    //      itself within a few ticks: grain has a global price → MC
    //      of flour computable → flour clears → MC of bread
    //      computable → bread clears, etc.
    // Per the user: "i don't think pinning prices to some arbitrary
    // values is good, that's not what happens irl either."
    const seededPrices = seededPricesForSettlement(settlement);

    const schedules = buildSettlementSchedules({
      settlement,
      stockpilesByOwner,
      resources: localTradable,
      recentLocalPrices: seededPrices,
      today,
      season,
      ownerKindByActor,
      actorTreasuryByActor,
      laborClassContext: laborContextForSettlement(settlement),
      grid: world.grid,
    });

    for (const [resId, pair] of schedules.schedulesByResource) {
      if (pair.demand.sources.length === 0 && pair.supply.sources.length === 0) {
        deleteClearingPriceIfNoRecordedOutflow(settlement, resId);
        continue;
      }
      // Per docs/08 §"Edict price cap is a real CDA constraint": when
      // a governor edict is active on this (settlement, resource),
      // pass the cap as the CDA's maxPrice. The CDA clears at the cap
      // (or lower) and emits real unmet-demand telemetry that drives
      // the mob-looting escalation in civilUnrestPhase.
      const baseCap = marketMaxPriceForResource(resId, pair.supply.sources, seededPrices);
      const edictCap = edictPriceCapFor(settlement.id, resId);
      const maxPrice = edictCap !== null ? Math.min(baseCap, edictCap) : baseCap;
      const result = clearMarket(pair.demand, pair.supply, { maxPrice });
      // Record the residual bid-ask book regardless of whether anything cleared
      // today. Caravans, viewer panels, and dormant-market diagnostics all read
      // from it.
      recordBookFromClearing(settlement, resId, result);
      // Per docs/15 §C19: also record the full per-source ladder so the
      // viewer can show the actual book depth (who is bidding/asking, not
      // just the best quote).
      recordBookLadderFromClearing(
        world,
        settlement,
        resId,
        pair.demand.sources,
        pair.supply.sources,
        result,
        today,
      );
      if (result.totalTraded <= 0) {
        if (
          pair.demand.sources.length > 0 &&
          result.unmetDemandAtClearingPrice > 0 &&
          isMeaningfulShortageSignal(resId, result.unmetDemandAtClearingPrice) &&
          Number.isFinite(result.clearingPrice) &&
          result.clearingPrice > 0
        ) {
          recordClearingPrice(settlement, resId, result.clearingPrice);
          events.push({
            type: 'market_shortage',
            settlement: settlement.id,
            resource: resId,
            price: result.clearingPrice,
            unmetDemand: result.unmetDemandAtClearingPrice,
          });
        } else if (pair.supply.sources.length > 0) {
          const ask = boundedSellerOnlyAsk(resId, pair.supply.sources, seededPrices);
          if (ask !== null) recordClearingPrice(settlement, resId, ask);
        } else {
          deleteClearingPriceIfNoRecordedOutflow(settlement, resId);
        }
        continue;
      }
      const demandSourceById = new Map<string, DemandSource>();
      for (const source of pair.demand.sources) demandSourceById.set(source.id, source);
      const supplySourceById = new Map<string, (typeof pair.supply.sources)[number]>();
      for (const source of pair.supply.sources) supplySourceById.set(source.id, source);
      let actualTraded = 0;
      for (const trade of result.trades) {
        const sellerActorId = supplySourceById.get(trade.sellerSourceId)?.ownerActor;
        if (sellerActorId === undefined) continue;
        const seller = world.actors.get(sellerActorId);
        if (seller === undefined) continue;

        const demandSource = demandSourceById.get(trade.buyerSourceId);
        const buyerActorId = demandSource?.buyerActor;
        const buyer = buyerActorId !== undefined ? world.actors.get(buyerActorId) : undefined;
        if (buyerActorId === undefined) continue;
        if (buyer === undefined) continue;
        const concreteBuyer = buyer;
        // Per docs/04 §"Community self-provision" + docs/08
        // §"Communal subsistence pool": a plebeian/freedman/foreigner
        // household at this settlement consuming the free_village or
        // hamlet_household's stock is the village feeding its own
        // people — no coin transfer required. The trade still flows
        // through the CDA (and updates the price ladder) so the
        // subsistence demand is honest in the bid-ask book.
        const isCommunityProvision = isCommunityFoodPool(concreteBuyer.kind, seller.kind);
        const buyerPaysSeller = concreteBuyer.id !== seller.id && !isCommunityProvision;
        const maxByBuyerTreasury =
          buyerPaysSeller && trade.price > 0
            ? concreteBuyer.treasury / trade.price
            : trade.quantity;
        const qty = Math.min(trade.quantity, maxByBuyerTreasury);
        if (qty <= 1e-9) continue;
        // Note: in-settlement market clearing (this loop) stays
        // fractional. The "whole units" rule per docs/08 governs
        // transactions that physically move goods OUT of a
        // settlement — caravan buy / sell, local trade between
        // neighboring settlements, off-map export. Settlement-
        // internal clearing is an aggregate accounting step over
        // many small household trades; flooring it makes small
        // populations look like they never buy daily perishables
        // because their per-tick demand is < 1 unit.

        const coin = buyerPaysSeller ? Math.min(qty * trade.price, concreteBuyer.treasury) : 0;
        const serviceTrade = isServiceResource(resId);
        if (!serviceTrade) decreaseStockpile(seller, settlement.id, resId, qty);
        if (buyerPaysSeller) {
          if (coin > 0) {
            subtractCoin(concreteBuyer, coin);
            addCoin(seller, coin);
          }
        }
        if (demandSource?.buyerDisposition === 'stockpile' && !serviceTrade) {
          increaseStockpile(concreteBuyer, settlement.id, resId, qty);
        }
        if (demandSource?.buyerDisposition !== 'stockpile') {
          // Buyer is consuming immediately (not adding to stockpile),
          // so this is local consumption, not an export of the settlement.
          recordConsumption(settlement, resId, qty);
        }
        if (demandSource?.curve === 'subsistence') {
          const access = subsistenceAccess.get(settlement);
          if (access !== undefined)
            access.fulfilledModii += qty * grainEquivalentModiiPerUnit(resId);
        }
        actualTraded += qty;
      }
      if (actualTraded <= 1e-9) {
        const unmetDemand = Math.max(result.unmetDemandAtClearingPrice, result.totalTraded);
        if (
          pair.demand.sources.length > 0 &&
          isMeaningfulShortageSignal(resId, unmetDemand) &&
          Number.isFinite(result.clearingPrice) &&
          result.clearingPrice > 0
        ) {
          recordClearingPrice(settlement, resId, result.clearingPrice);
          events.push({
            type: 'market_shortage',
            settlement: settlement.id,
            resource: resId,
            price: result.clearingPrice,
            unmetDemand,
          });
        } else if (pair.supply.sources.length > 0) {
          const ask = boundedSellerOnlyAsk(resId, pair.supply.sources, seededPrices);
          if (ask !== null) recordClearingPrice(settlement, resId, ask);
        } else {
          deleteClearingPriceIfNoRecordedOutflow(settlement, resId);
        }
        continue;
      }
      recordClearingPrice(settlement, resId, result.clearingPrice);
      recordLastClearedDay(settlement, resId, today);
      stats.marketsCleared += 1;
      events.push({
        type: 'market_cleared',
        settlement: settlement.id,
        resource: resId,
        price: result.clearingPrice,
        volume: actualTraded,
      });
    }
  }
};

interface OwnerKindCache {
  readonly actorCount: number;
  readonly ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>;
}

const ownerKindCache: WeakMap<WorldState, OwnerKindCache> = new WeakMap();

const ownerKindByActorForWorld = (world: WorldState): ReadonlyMap<ActorId, Actor['kind']> => {
  const cached = ownerKindCache.get(world);
  if (cached !== undefined && cached.actorCount === world.actors.size) {
    return cached.ownerKindByActor;
  }
  const ownerKindByActor = new Map<ActorId, Actor['kind']>();
  for (const a of world.actors.values()) ownerKindByActor.set(a.id, a.kind);
  ownerKindCache.set(world, { actorCount: world.actors.size, ownerKindByActor });
  return ownerKindByActor;
};

const POPULATION_DEMAND_RESOURCES: readonly ResourceId[] = Object.freeze(
  [
    'food.grain',
    'food.bread',
    'food.legumes',
    'mineral.salt',
    'material.wood',
    'food.milk',
    'food.fish',
    'food.game',
    'food.wine',
    'food.olive_oil',
    'food.cheese',
    'food.salted_meat',
    'food.salted_fish',
    'goods.cloth',
    'goods.clothing',
    'goods.furniture',
    'material.pottery',
    'goods.luxury_textiles',
    'metal.silver',
    'metal.gold',
    'exotic.spices',
    'exotic.silk',
    'exotic.incense',
    'exotic.dyes',
  ].map(resourceId),
);

const CAPITAL_RESERVE_DEMAND_RESOURCES: readonly ResourceId[] = Object.freeze(
  [
    'material.lumber',
    'material.cut_stone',
    'material.brick_tile',
    'material.stone',
    'material.amphora',
    'material.pottery',
    'material.linen_fiber',
    'goods.tools',
    'livestock.equines',
    'goods.cart',
  ].map(resourceId),
);

const SERVICE_MARKET_RESOURCES: readonly ResourceId[] = serviceMarketResources();

const RECIPE_NEEDED_RESOURCES_BY_BUILDING: ReadonlyMap<string, readonly ResourceId[]> = (() => {
  const tmp = new Map<string, Map<string, ResourceId>>();
  for (const recipe of allRecipes()) {
    const buildingKey = String(recipe.building);
    let bucket = tmp.get(buildingKey);
    if (bucket === undefined) {
      bucket = new Map<string, ResourceId>();
      tmp.set(buildingKey, bucket);
    }
    for (const input of recipe.inputs.keys()) {
      bucket.set(String(input), input);
    }
    for (const requirement of recipe.requires.keys()) {
      bucket.set(String(requirement), requirement);
    }
  }

  const out = new Map<string, readonly ResourceId[]>();
  for (const [buildingKey, byResource] of tmp) {
    out.set(buildingKey, Object.freeze(Array.from(byResource.values())));
  }
  return out;
})();

const demandCandidateResourcesForSettlement = (settlement: Settlement): ReadonlySet<ResourceId> => {
  const out = new Set<ResourceId>();
  if (settlement.population.total() > 0) {
    for (const r of POPULATION_DEMAND_RESOURCES) out.add(r);
  }
  if (settlement.stockpileOwners.length > 0) {
    for (const r of CAPITAL_RESERVE_DEMAND_RESOURCES) out.add(r);
    for (const r of SERVICE_MARKET_RESOURCES) out.add(r);
  }
  for (const building of settlement.buildings) {
    if (building.capacity <= 0) continue;
    const neededResources = RECIPE_NEEDED_RESOURCES_BY_BUILDING.get(String(building.buildingId));
    if (neededResources !== undefined) {
      for (const r of neededResources) out.add(r);
    }
    for (const r of institutionalProcurementResourcesForBuilding(building.buildingId)) {
      out.add(r);
    }
  }
  return out;
};

/**
 * The full set of resources cleared each tick. Built once at module load
 * from resources that appear in recipes, population demand, local services,
 * or off-map global trade. We exclude `people.*` because slave/migrant flows
 * are handled by separate population/cargo systems.
 */
const TRADABLE_RESOURCES: readonly ResourceId[] = (() => {
  const seen = new Set<string>();
  const out: ResourceId[] = [];
  const add = (id: ResourceId): void => {
    const k = String(id);
    if (seen.has(k)) return;
    if (k.startsWith('people.')) return;
    seen.add(k);
    out.push(id);
  };
  for (const r of allRecipes()) {
    for (const id of r.inputs.keys()) add(id);
    for (const id of r.outputs.keys()) add(id);
  }
  for (const id of POPULATION_DEMAND_RESOURCES) add(id);
  for (const id of CAPITAL_RESERVE_DEMAND_RESOURCES) add(id);
  for (const id of SERVICE_MARKET_RESOURCES) add(id);
  for (const id of DEFAULT_GLOBAL_PRICES.keys()) add(id);
  for (const resources of RECIPE_NEEDED_RESOURCES_BY_BUILDING.values()) {
    for (const id of resources) add(id);
  }
  for (const building of ['barracks', 'temple', 'forum_market']) {
    for (const id of institutionalProcurementResourcesForBuilding(buildingId(building))) add(id);
  }
  return Object.freeze(out);
})();

const TRADABLE_RESOURCE_KEYS: ReadonlySet<string> = new Set(TRADABLE_RESOURCES.map(String));

const DEFAULT_GLOBAL_TRADABLE_PRICE_ENTRIES: readonly (readonly [ResourceId, number])[] =
  Object.freeze(
    Array.from(DEFAULT_GLOBAL_PRICES.entries()).filter(([resource, price]) => {
      return TRADABLE_RESOURCE_KEYS.has(String(resource)) && price > 0;
    }),
  );

// --- Phase 4b: Local trade (regional smoothing) -----------------------------

/**
 * Petty merchants and villager pickup carts that walk between nearby
 * settlements every day, arbitraging local price spreads with small loads.
 * Household goods use the classic ≤3-hex petty radius. Workshop and bulky
 * industrial inputs use ≤6-hex cartage so mine/charcoal/bloomery/smithy
 * clusters can feed each other without promoting every sack of grain to
 * regional teleportation. Per docs/06 §"Local trade between nearby
 * settlements" and docs/08 §"Per-settlement markets, regional smoothing".
 *
 * For each unordered settlement pair (A, B) within the resource's local
 * cartage radius whose anchors are both on passable terrain in the current
 * season:
 *   - For each tradable resource R for which BOTH settlements have observed
 *     a clearing price:
 *       - Add a transport-cost surcharge per the docs/06 distance table.
 *       - If the spread (after transport cost) is positive, pick the cheaper
 *         settlement as seller and the dearer as buyer.
 *       - Find any seller-side actor with stock>0 and any buyer-side actor
 *         with treasury>0; move a resource-appropriate load from seller to
 *         buyer at the midpoint price (split the spread). Household goods use
 *         basket loads; industrial inputs use cartage loads so mine/charcoal/
 *         bloomery clusters can actually feed each other.
 *       - The petty merchant takes a 5% cut on the spread; in v1.5 we just
 *         absorb it (no separate merchant household ledger; tracked as a
 *         follow-up).
 *
 * Determinism: settlements are visited in insertion order; pairs are formed
 * with seller.id < buyer.id (lexicographic) so each unordered pair is
 * visited at most once per tick. Within a pair, owners are scanned in their
 * current `stockpileOwners` order (the same order all other phases use).
 *
 * Performance: a hex-keyed spatial index of settlement anchors is built once
 * per phase; each settlement enumerates only its bounded local-cartage
 * neighborhood instead of comparing against all N settlements (an O(N²) walk
 * is unacceptable at the future-state ~8000-settlement scale).
 *
 * Same-hex (distance 0) is supported with zero transport cost — that is the
 * canonical pagus + dependent-hamlets case from docs/05 §"Same-hex
 * coexistence".
 */
export const localTradePhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
  subsistenceAccess: SubsistenceAccessMap,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): void => {
  const localTradePairs = settlementAnchorIndexForWorld(world).localTradePairs;
  const ownerKindByActor = ownerKindByActorForWorld(world);
  const demandCache: LocalTradeDemandCache = new Map();
  const pricedResourceCache = new Map<Settlement, PricedLocalTradeResources>();
  const scheduleBaseCache = new Map<Settlement, LocalTradeScheduleBase>();

  // Cache anchor passability per phase. v1 approximation: a pair is feasible
  // if both anchors are on passable terrain this season. Real path
  // reachability across intervening hexes would require an A* call per pair
  // and is deferred to v1.5+ when long-haul caravan AI consolidation lands.
  const passableAtAnchor = new Map<Settlement, boolean>();
  const isAnchorPassable = (s: Settlement): boolean => {
    const cached = passableAtAnchor.get(s);
    if (cached !== undefined) return cached;
    const tile = world.grid.get(s.anchor);
    // If the tile isn't in the grid (test stub), treat as passable so unit
    // tests don't have to populate every hex with terrain just to exercise
    // local trade.
    const ok = tile === undefined ? true : isPassable(tile.terrain, season);
    passableAtAnchor.set(s, ok);
    return ok;
  };

  for (const pair of localTradePairs) {
    const { a, b, dist } = pair;
    // v1.6 Phase 24c (docs/10 decision 43): the abstract localTrade
    // daily-pass is deleted for distance >= 1. Inter-settlement trade
    // at 1+ hex distance goes through real Caravan units (standing
    // merchants, villager carts, replacement caravans) that walk the
    // route, consume rations, and risk ambush. Only same-hex
    // coexistence (pagus + dependent hamlets sharing one literal hex)
    // clears at the 0-tick intra-hex market step, because there is no
    // road to walk and no ambush exposure.
    if (dist > 0) continue;
    if (!isAnchorPassable(a)) continue;
    if (!isAnchorPassable(b)) continue;
    // Per docs/06 §"Distance and cost", the table is in coin/kg, not
    // coin/unit. tryLocalTrade scales by the resource's weightKgPerUnit
    // before comparing prices.
    const transportCostPerKg = TRANSPORT_COST_BY_DISTANCE[dist];
    if (transportCostPerKg === undefined) continue;
    const aResources = pricedLocalTradeResourcesForSettlement(a, pricedResourceCache);
    const bResources = pricedLocalTradeResourcesForSettlement(b, pricedResourceCache);
    const smaller =
      aResources.resources.length <= bResources.resources.length ? aResources : bResources;
    const other = smaller === aResources ? bResources.resourcesById : aResources.resourcesById;
    for (const resId of smaller.resources) {
      if (!other.has(resId)) continue;
      if (dist > localTradeMaxHexDistanceForResource(resId)) continue;
      tryLocalTrade(
        world,
        a,
        b,
        resId,
        transportCostPerKg,
        season,
        today,
        ownerKindByActor,
        demandCache,
        scheduleBaseCache,
        laborContextForSettlement,
        subsistenceAccess,
        events,
      );
    }
  }
};

// SettlementAnchorIndex helpers moved to src/sim/world/settlementIndex.ts.

interface PricedLocalTradeResources {
  readonly resources: readonly ResourceId[];
  readonly resourcesById: ReadonlySet<ResourceId>;
}

const pricedLocalTradeResourcesForSettlement = (
  settlement: Settlement,
  cache: Map<Settlement, PricedLocalTradeResources>,
): PricedLocalTradeResources => {
  const cached = cache.get(settlement);
  if (cached !== undefined) return cached;
  const resources: ResourceId[] = [];
  const resourcesById = new Set<ResourceId>();
  for (const resId of LOCAL_TRADE_RESOURCES) {
    const price = settlement.market.lastClearingPrice.get(resId);
    if (price === undefined || price <= 0) continue;
    resources.push(resId);
    resourcesById.add(resId);
  }
  const priced = { resources, resourcesById };
  cache.set(settlement, priced);
  return priced;
};

const tryLocalTrade = (
  world: WorldState,
  a: Settlement,
  b: Settlement,
  resId: ResourceId,
  transportCostPerKg: number,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  demandCache: LocalTradeDemandCache,
  scheduleBaseCache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
  subsistenceAccess: SubsistenceAccessMap,
  events: TickEvent[],
): void => {
  const priceA = a.market.lastClearingPrice.get(resId);
  const priceB = b.market.lastClearingPrice.get(resId);
  if (priceA === undefined || priceB === undefined) return;
  if (priceA <= 0 || priceB <= 0) return;

  // Per docs/06 §"Distance and cost", transport is a coin/kg surcharge.
  // Convert to coin/unit using the resource's weight before comparing
  // prices (which are themselves coin/unit). Heavy goods like grain
  // (~6.7 kg/modius) eat a meaningful chunk of any price spread; tiny
  // luxuries like spices barely notice.
  const weightKgPerUnit =
    LOCAL_TRADE_WEIGHT_KG_BY_RESOURCE.get(resId) ?? getResource(resId).weightKgPerUnit;
  if (weightKgPerUnit <= 0) return;
  const transportCostPerUnit = transportCostPerKg * weightKgPerUnit;

  // Pick seller = cheaper, buyer = dearer; only fire if spread covers
  // transport. The PETTY_MERCHANT_CUT is also netted out so we don't trade
  // away the merchant's livelihood.
  let seller: Settlement;
  let buyer: Settlement;
  let sellerPrice: number;
  let buyerPrice: number;
  if (priceA + transportCostPerUnit < priceB) {
    seller = a;
    buyer = b;
    sellerPrice = priceA;
    buyerPrice = priceB;
  } else if (priceB + transportCostPerUnit < priceA) {
    seller = b;
    buyer = a;
    sellerPrice = priceB;
    buyerPrice = priceA;
  } else {
    return;
  }
  const spread = buyerPrice - sellerPrice - transportCostPerUnit;
  if (spread <= 0) return;
  // Petty merchant absorbs a small cut of the spread; if the residual
  // spread is non-positive, no trade is attractive enough to walk.
  const netSpread = spread * (1 - PETTY_MERCHANT_CUT);
  if (netSpread <= 0) return;

  // Settle at the midpoint price (split the spread). The buyer pays
  // mid; the seller receives mid. Transport cost is implicit in the
  // gap between sellerPrice + transportCostPerUnit ≤ mid ≤ buyerPrice.
  const midPrice = (sellerPrice + buyerPrice) / 2;
  if (midPrice <= 0) return;

  const sellerActor = pickSellerActor(world, seller, resId);
  if (sellerActor === null) return;
  const buyerIntent = pickLocalTradeBuyer(
    world,
    buyer,
    resId,
    midPrice,
    season,
    today,
    ownerKindByActor,
    demandCache,
    scheduleBaseCache,
    laborContextForSettlement,
  );
  if (buyerIntent === null) return;
  const buyerActor = buyerIntent.actor;
  if (buyerActor.id === sellerActor.id) return;

  const sellerStock = getStockAt(sellerActor, seller.id, resId);
  if (sellerStock <= 0) return;
  const maxByLoad = localTradeLoadKgForResource(resId) / weightKgPerUnit;
  const maxByTreasury = buyerActor.treasury / midPrice;
  let maxByDemand = buyerIntent.quantityDemanded;
  if (buyerIntent.curve === 'subsistence') {
    const access = subsistenceAccess.get(buyer);
    const modiiPerUnit = grainEquivalentModiiPerUnit(resId);
    if (access !== undefined && modiiPerUnit > 0) {
      const remainingModii = Math.max(0, access.needModii - access.fulfilledModii);
      maxByDemand = Math.min(maxByDemand, remainingModii / modiiPerUnit);
    }
  }
  // Tangible goods cross ownership in whole units only (docs/08
  // §"Whole-unit transactions"). Services pass through unrounded.
  // Local trade excludes services upstream, so this is effectively a
  // floor — kept as `wholeUnitsForTransaction` for symmetry with the
  // other transaction sites.
  const qty = wholeUnitsForTransaction(
    resId,
    Math.min(maxByLoad, sellerStock, maxByTreasury, maxByDemand),
  );
  if (qty <= 0) return;

  const coinPaid = qty * midPrice;
  // Apply the transfer. Per docs/15 §C30 the seller's slice is at THEIR
  // settlement and the buyer's slice is at THEIR settlement — local
  // trade physically moves the goods between settlements.
  decreaseStockpile(sellerActor, seller.id, resId, qty);
  if (buyerIntent.disposition === 'stockpile') {
    increaseStockpile(buyerActor, buyer.id, resId, qty);
  }
  addCoin(sellerActor, coinPaid);
  subtractCoin(buyerActor, coinPaid);
  // Local trade between two settlements: seller exports, buyer imports.
  recordExport(seller, resId, qty);
  recordImport(buyer, resId, qty);
  // Per docs/08 §"Transaction observability": the trade's actual
  // per-unit price (integer-coin per docs/08 §"Integer-coin prices")
  // is written into both settlements' price ladders so tomorrow's
  // CDA + caravan AI react to today's real trade, not stale memory.
  // Without this, the marketClearedAtAllSettlements invariant flags
  // hundreds of "traded but no clearing price" warnings per year.
  const tradePricePerUnit = integerCoinClearing(midPrice);
  recordClearingPrice(seller, resId, tradePricePerUnit);
  recordClearingPrice(buyer, resId, tradePricePerUnit);
  if (buyerIntent.disposition === 'consume') {
    // Buyer's intent was to consume on arrival — record consumption
    // (the goods went from one stockpile to immediate use).
    recordConsumption(buyer, resId, qty);
    if (buyerIntent.curve === 'subsistence') {
      const access = subsistenceAccess.get(buyer);
      if (access !== undefined) {
        access.fulfilledModii += qty * grainEquivalentModiiPerUnit(resId);
      }
    }
  }

  events.push({
    type: 'local_trade',
    fromSettlement: seller.id,
    toSettlement: buyer.id,
    resource: resId,
    quantity: qty,
    coinPaid,
  });
};

interface LocalTradeBuyerIntent {
  readonly actor: Actor;
  readonly disposition: 'consume' | 'stockpile';
  readonly curve: DemandSource['curve'] | 'fallback';
  readonly quantityDemanded: number;
}

type LocalTradeDemandCache = Map<Settlement, Map<ResourceId, readonly DemandSource[]>>;

const seededPricesForSettlement = (settlement: Settlement): Map<ResourceId, number> => {
  const seededPrices = new Map<ResourceId, number>(DEFAULT_GLOBAL_TRADABLE_PRICE_ENTRIES);
  for (const [resource, observed] of settlement.market.lastClearingPrice) {
    if (observed <= 0) continue;
    if (!TRADABLE_RESOURCE_KEYS.has(String(resource))) continue;
    seededPrices.set(resource, observed);
  }
  return seededPrices;
};

interface LocalTradeScheduleBase {
  readonly owners: readonly Actor[];
  readonly demandBuilder: SettlementDemandSourceBuilder;
  readonly actorTreasuryByActor: Map<ActorId, number>;
}

const localTradeScheduleBaseForSettlement = (
  world: WorldState,
  settlement: Settlement,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  cache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): LocalTradeScheduleBase => {
  const cached = cache.get(settlement);
  if (cached !== undefined) return cached;
  const owners: Actor[] = [];
  const stockpilesByOwner = new Map<ActorId, ReadonlyMap<ResourceId, Quantity>>();
  for (const ownerId of settlement.stockpileOwners) {
    const actor = world.actors.get(ownerId);
    if (actor === undefined) continue;
    owners.push(actor);
    // Per docs/15 §C30: schedule sees only the owner's slice AT this
    // settlement, not their full cross-settlement pool.
    stockpilesByOwner.set(actor.id, actor.stockpile.get(settlement.id) ?? EMPTY_RESOURCE_MAP);
  }
  const base = {
    owners,
    actorTreasuryByActor: new Map<ActorId, number>(),
    demandBuilder: createSettlementDemandSourceBuilder({
      settlement,
      stockpilesByOwner,
      recentLocalPrices: seededPricesForSettlement(settlement),
      today,
      season,
      ownerKindByActor,
      laborClassContext: laborContextForSettlement(settlement),
      grid: world.grid,
    }),
  };
  cache.set(settlement, base);
  return base;
};

const localTradeDemandSourcesFor = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  demandCache: LocalTradeDemandCache,
  scheduleBaseCache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): readonly DemandSource[] => {
  let cacheByResource = demandCache.get(settlement);
  if (cacheByResource === undefined) {
    cacheByResource = new Map<ResourceId, readonly DemandSource[]>();
    demandCache.set(settlement, cacheByResource);
  }
  const cached = cacheByResource.get(resource);
  if (cached !== undefined) return cached;

  const base = localTradeScheduleBaseForSettlement(
    world,
    settlement,
    season,
    today,
    ownerKindByActor,
    scheduleBaseCache,
    laborContextForSettlement,
  );
  if (base.owners.length === 0) {
    cacheByResource.set(resource, []);
    return [];
  }
  const actorTreasuryByActor = base.actorTreasuryByActor;
  actorTreasuryByActor.clear();
  for (const actor of base.owners) actorTreasuryByActor.set(actor.id, actor.treasury);

  const sources = base.demandBuilder.sourcesFor(resource, actorTreasuryByActor);
  cacheByResource.set(resource, sources);
  return sources;
};

const pickDemandBackedLocalBuyer = (
  world: WorldState,
  sources: readonly DemandSource[],
  price: number,
): LocalTradeBuyerIntent | null => {
  let best: {
    readonly source: DemandSource;
    readonly actor: Actor;
    readonly quantityDemanded: number;
  } | null = null;

  for (const source of sources) {
    if (source.buyerActor === undefined || source.buyerDisposition === undefined) continue;
    const quantityDemanded = source.quantityAt(price);
    if (!Number.isFinite(quantityDemanded) || quantityDemanded <= 1e-9) continue;
    const actor = world.actors.get(source.buyerActor);
    if (actor === undefined || actor.treasury <= 0) continue;
    if (
      best === null ||
      source.maxWillingnessToPay > best.source.maxWillingnessToPay ||
      (source.maxWillingnessToPay === best.source.maxWillingnessToPay &&
        quantityDemanded > best.quantityDemanded) ||
      (source.maxWillingnessToPay === best.source.maxWillingnessToPay &&
        quantityDemanded === best.quantityDemanded &&
        String(source.id) < String(best.source.id))
    ) {
      best = { source, actor, quantityDemanded };
    }
  }

  if (best === null) return null;
  // buyerDisposition is guaranteed defined by the `source.buyerDisposition === undefined`
  // continue guard above; the TS narrow is lost across the `best = …` assignment.
  return {
    actor: best.actor,
    disposition: best.source.buyerDisposition!,
    curve: best.source.curve,
    quantityDemanded: best.quantityDemanded,
  };
};

const pickLocalTradeBuyer = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
  price: number,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  demandCache: LocalTradeDemandCache,
  scheduleBaseCache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): LocalTradeBuyerIntent | null => {
  const sources = localTradeDemandSourcesFor(
    world,
    settlement,
    resource,
    season,
    today,
    ownerKindByActor,
    demandCache,
    scheduleBaseCache,
    laborContextForSettlement,
  );
  // Pass 1: prefer a real demand-backed buyer (subsistence/comfort/derived).
  // We still check `sources.length > 0` because some fixtures populate no
  // sources at all and want the legacy fallback below; but per docs/15
  // §C26 the market-making sources only contribute at their threshold
  // price, so when the local-trade price is above that they correctly
  // return 0 — in which case we still fall through to the legacy fallback
  // instead of refusing the trade.
  if (sources.length > 0) {
    const matched = pickDemandBackedLocalBuyer(world, sources, price);
    if (matched !== null) return matched;
  }

  // Legacy fallback for sparse/debug worlds and post-§C26: when no
  // demand source bid at the requested price, a price spread can still
  // move stock to a market factor / city corp with treasury. Without this
  // fallback, market-making sources that don't clear at the local-trade
  // midprice block the trade entirely even when there's a willing buyer
  // in the settlement.
  const fallback = pickBuyerActor(world, settlement);
  if (fallback === null) return null;
  return {
    actor: fallback,
    disposition: 'stockpile',
    curve: 'fallback',
    quantityDemanded: Number.POSITIVE_INFINITY,
  };
};

const pickSellerActor = (
  world: WorldState,
  settlement: Settlement,
  resId: ResourceId,
): Actor | null => {
  for (const id of settlement.stockpileOwners) {
    const actor = world.actors.get(id);
    if (actor === undefined) continue;
    const stock = getStockAt(actor, settlement.id, resId);
    if (stock > 0) return actor;
  }
  return null;
};

const pickBuyerActor = (world: WorldState, settlement: Settlement): Actor | null => {
  for (const id of settlement.stockpileOwners) {
    const actor = world.actors.get(id);
    if (actor === undefined) continue;
    if (actor.treasury > 0) return actor;
  }
  return null;
};

// LOCAL_TRADE_MAX_HEX_DISTANCE moved to src/sim/world/settlementIndex.ts.
const HOUSEHOLD_LOCAL_TRADE_MAX_HEX_DISTANCE = 3;
const INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE = 6;

/**
 * Per-pair, per-day, per-resource caps. Household goods use a single
 * villager/donkey basket. Strategic workshop goods use a pickup-wagon sized
 * lot, and bulky industrial inputs use local cartage because mine/charcoal/
 * bloomery clusters are deliberately local and need ton-scale material
 * movement before long-haul caravans get involved.
 * docs/06 §"Local trade between nearby settlements".
 */
const MAX_HOUSEHOLD_PETTY_LOAD_KG = 50;
const MAX_WORKSHOP_CARTAGE_LOAD_KG = 500;
const MAX_INDUSTRIAL_CARTAGE_LOAD_KG = 3_000;
/**
 * Per-trade cap on herd capital moved between neighboring settlements
 * by foot. Originally 0.1 herd-unit ("a handful of sheep walking
 * across to the next village") — but under the whole-unit
 * transactions rule (docs/08) every trade is floored to an integer
 * number of units, so a 0.1 cap forced zero-quantity trades and the
 * pathway never activated. Set to 1 herd-unit (~30 sheep / 10 cattle
 * / etc.) which is the smallest whole transaction the unit basis
 * supports. Bigger transfers go via caravan.
 */
const MAX_WALKING_HERD_LOCAL_TRADE_UNITS = 1;

const WORKSHOP_CARTAGE_RESOURCES: ReadonlySet<string> = new Set([
  'goods.tools',
  // Weapon archetypes (docs/02 + docs/03). Each travels as a workshop
  // cartage good — small wagon-lot batches over short distances.
  'goods.gladius',
  'goods.hasta',
  'goods.pilum',
  'goods.dagger',
  'goods.bow',
  'goods.arrow',
  'goods.sling',
  'goods.sling_bullet',
  'goods.helmet',
  'goods.body_armor',
  'goods.shield',
  'goods.cart',
]);

const INDUSTRIAL_CARTAGE_RESOURCES: ReadonlySet<string> = new Set([
  'material.charcoal',
  'material.wood',
  'material.lumber',
  'material.clay',
  'material.stone',
  'material.cut_stone',
  'material.brick_tile',
]);

const computeLocalTradeLoadKgForResource = (resource: ResourceId): number => {
  const def = getResource(resource);
  if (def.category === 'livestock') {
    return def.weightKgPerUnit * MAX_WALKING_HERD_LOCAL_TRADE_UNITS;
  }
  if (def.category === 'mineral' || def.category === 'metal') {
    return MAX_INDUSTRIAL_CARTAGE_LOAD_KG;
  }
  if (WORKSHOP_CARTAGE_RESOURCES.has(String(resource))) {
    return MAX_WORKSHOP_CARTAGE_LOAD_KG;
  }
  if (INDUSTRIAL_CARTAGE_RESOURCES.has(String(resource))) {
    return MAX_INDUSTRIAL_CARTAGE_LOAD_KG;
  }
  return MAX_HOUSEHOLD_PETTY_LOAD_KG;
};

const computeLocalTradeMaxHexDistanceForResource = (resource: ResourceId): number => {
  const def = getResource(resource);
  if (def.category === 'livestock') {
    return HOUSEHOLD_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  if (def.category === 'mineral' || def.category === 'metal') {
    return INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  if (WORKSHOP_CARTAGE_RESOURCES.has(String(resource))) {
    return INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  if (INDUSTRIAL_CARTAGE_RESOURCES.has(String(resource))) {
    return INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  return HOUSEHOLD_LOCAL_TRADE_MAX_HEX_DISTANCE;
};

/**
 * Petty-merchant cut on the spread. v1.5 just absorbs this (no separate
 * merchant household actor); deferred follow-up tracks merchant
 * household ledgers so the cut accrues somewhere.
 */
const PETTY_MERCHANT_CUT = 0.05;

/**
 * Coin-per-kg surcharge for moving petty cargo across the pair distance.
 * Tabled by hex distance per docs/06 §"Distance and cost".
 */
const TRANSPORT_COST_BY_DISTANCE: Readonly<Record<number, number>> = {
  0: 0,
  1: 0.005,
  2: 0.01,
  3: 0.02,
  4: 0.035,
  5: 0.055,
  6: 0.08,
};

/**
 * Resources eligible for the local-trade pass. This is derived from the full
 * tradable set so new physical goods do not silently get prices without local
 * arbitrage. Services are local capacities with coin-only settlement, people
 * move through population/cargo systems, and coin itself is the payment rail.
 */
const LOCAL_TRADE_RESOURCES: readonly ResourceId[] = Object.freeze(
  TRADABLE_RESOURCES.filter((id) => {
    const key = String(id);
    if (key === 'goods.coin') return false;
    const category = getResource(id).category;
    return category !== 'service' && category !== 'people';
  }),
);

const LOCAL_TRADE_WEIGHT_KG_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, getResource(id).weightKgPerUnit] as const),
);
const LOCAL_TRADE_LOAD_KG_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, computeLocalTradeLoadKgForResource(id)] as const),
);
const LOCAL_TRADE_MAX_DISTANCE_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, computeLocalTradeMaxHexDistanceForResource(id)] as const),
);

const localTradeLoadKgForResource = (resource: ResourceId): number =>
  LOCAL_TRADE_LOAD_KG_BY_RESOURCE.get(resource) ?? computeLocalTradeLoadKgForResource(resource);

const localTradeMaxHexDistanceForResource = (resource: ResourceId): number =>
  LOCAL_TRADE_MAX_DISTANCE_BY_RESOURCE.get(resource) ??
  computeLocalTradeMaxHexDistanceForResource(resource);

