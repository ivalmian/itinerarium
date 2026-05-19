/**
 * Caravan trade + assembly + replan cluster.
 *
 * Bundles the helpers and three phases that together implement the
 * caravan layer (docs/06 + docs/15 §C17, §C18, §C31):
 *
 *   - **Caravan-trade helpers** — ration accounting, sell/buy
 *     against local markets, off-map export/import completion,
 *     tax-shipment completion, and the standing-caravan home
 *     remittance.
 *
 *   - **merchantCaravanAssemblyPhase** — every 7 days, eligible
 *     patrician families / caravan-owner firms replace lost long-haul
 *     caravans up to a per-world target derived from settlement count.
 *
 *   - **villagerCaravanAssemblyPhase** (docs/15 §C31) — every 3
 *     days, free villages / hamlet households with sellable surplus,
 *     home-learned import demand, or hard-times staple needs dispatch
 *     low-capacity caravans when they can fund the trip.
 *
 *   - **caravanReplanPhase** — every tick, NPC caravans sitting at
 *     their destination observe local prices, restock their price
 *     book, and pick a new destination via the NPC AI; without this
 *     pass trade circulates exactly zero after the seeded caravans
 *     complete their first leg.
 *
 * Also includes the small `goalDestination` GoalStack lookup used by
 * goal-bearing caravan movement.
 *
 * Originally lived inline in `src/sim/tick.ts`.
 */

import { DEFAULT_GLOBAL_PRICES } from '../caravan/edgeHub.js';
import {
  EDGE_HUB_EXPORT_CARAVAN_PREFIX,
  EDGE_HUB_IMPORT_CARAVAN_PREFIX,
  computeEdgeHexes,
  edgeHubHomeGateForCaravan,
  isEdgeHubImportCaravan,
} from './edgeHub.js';
import { fallbackRationUnitPrice } from './consumption.js';
import { drawDemographicsFromPool, ROLE_BIASES } from '../population/demographics.js';
import {
  createCaravan,
  dailyCarriedFoodReserveKg,
  totalCargoWeightKg,
  totalCarryKg,
  type Caravan,
  type PriceObservation,
} from '../caravan/caravan.js';
import { expectedRiskOnApproximatePath, planCaravanRoute, travelCost } from '../caravan/ai.js';
import { isGoalComplete, peekGoal, popGoal, type Goal } from '../caravan/goal.js';
import { wholeUnitsForTransaction } from '../market/wholeUnits.js';
import { syncCaravanWithLocalGuild } from '../politics/guildLedger.js';
import { iterFreshKnownPrices } from '../politics/knownPrices.js';
import { addCoin, getStockAt, subtractCoin, type Actor } from '../politics/actor.js';
import { getResource } from '../resources/catalog.js';
import type { Rng } from '../rng.js';
import {
  caravanId as makeCaravanIdLocal,
  resourceId,
  type ActorId,
  type CaravanId,
  type Day,
  type Quantity,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { hexDistance, hexEquals, hexKey, hexesWithinRange, type Hex } from '../world/hex.js';
import {
  recordClearingPrice,
  recordConsumption,
  recordExport,
  recordImport,
  type Settlement,
} from '../world/settlement.js';
import { settlementAnchorIndexForWorld } from '../world/settlementIndex.js';
import {
  decreaseStockpile,
  increaseStockpile,
  receiveResourceOrCoin,
} from '../world/stockpileMutation.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

// --- GoalStack helpers (docs/15 §C18) ----------------------------------

const goalDestination = (
  goal: Goal,
  settlementAnchorByCity: ReadonlyMap<SettlementId, Hex>,
): Hex | null => {
  switch (goal.type) {
    case 'move_to':
      return { q: goal.hex.q, r: goal.hex.r };
    case 'return_home':
      return { q: goal.home.q, r: goal.home.r };
    case 'flee_to':
      return { q: goal.safe.q, r: goal.safe.r };
    case 'trade_at': {
      const a = settlementAnchorByCity.get(goal.settlement);
      return a === undefined ? null : { q: a.q, r: a.r };
    }
    case 'escort':
    case 'patrol':
      // Engine-driven: the patrol/escort layer sets destinations
      // based on target/route. Caravan AI doesn't override.
      return null;
  }
};

const CARAVAN_RATION_RESERVE_DAYS = 21;

const CARAVAN_RATION_RESOURCES: ReadonlySet<string> = new Set([
  'food.bread',
  'food.flour',
  'food.grain',
  'food.legumes',
  'food.salted_meat',
  'food.salted_fish',
  'food.cheese',
]);

const caravanRationCargoKg = (c: Caravan): number => {
  let total = 0;
  for (const [resource, qty] of c.cargo) {
    if (!CARAVAN_RATION_RESOURCES.has(String(resource))) continue;
    total += Math.max(0, qty) * getResource(resource).weightKgPerUnit;
  }
  return total;
};

const caravanRationReserveKg = (c: Caravan): number =>
  dailyCarriedFoodReserveKg(c) * CARAVAN_RATION_RESERVE_DAYS;

const caravanMissingRationReserveKg = (c: Caravan): number =>
  Math.max(0, caravanRationReserveKg(c) - caravanRationCargoKg(c));

const caravanRationDays = (c: Caravan): number => {
  const dailyKg = dailyCarriedFoodReserveKg(c);
  if (dailyKg <= 0) return Number.POSITIVE_INFINITY;
  return caravanRationCargoKg(c) / dailyKg;
};

const caravanTradeCargoCapacityRemainingKg = (c: Caravan): number =>
  Math.max(0, totalCarryKg(c) - totalCargoWeightKg(c) - caravanMissingRationReserveKg(c));

const caravanSellableQuantity = (c: Caravan, resource: ResourceId, qty: number): number => {
  if (qty <= 0) return 0;
  if (!CARAVAN_RATION_RESOURCES.has(String(resource))) return qty;
  const surplusKg = caravanRationCargoKg(c) - caravanRationReserveKg(c);
  if (surplusKg <= 0) return 0;
  const weightKg = getResource(resource).weightKgPerUnit;
  if (weightKg <= 0) return qty;
  return Math.min(qty, surplusKg / weightKg);
};

const caravanHasMarketCargo = (c: Caravan): boolean => {
  for (const [resource, qty] of c.cargo) {
    // Whole-unit trade boundary (docs/08): sub-1-unit residues aren't
    // sellable, so they don't count as market cargo either.
    if (caravanSellableQuantity(c, resource, qty) >= 1) return true;
  }
  return false;
};

const MERCHANT_CARAVAN_HOME_OPERATING_RESERVE_COIN = 1_000;
const MERCHANT_CARAVAN_HOME_REMITTANCE_RATE = 0.5;

interface LocalBuyerQuote {
  readonly settlement: Settlement;
  readonly actor: Actor;
  readonly price: number;
  readonly quantity?: number;
  readonly disposition?: 'consume' | 'stockpile';
}

interface LocalSellerQuote {
  readonly settlement: Settlement;
  readonly actor: Actor;
  readonly price: number;
  readonly stock: number;
}

const localSellerQuotes = (
  world: WorldState,
  settlements: readonly Settlement[],
  resource: ResourceId,
): LocalSellerQuote[] => {
  const quotes: LocalSellerQuote[] = [];
  let sawBook = false;
  for (const settlement of settlements) {
    const ladder = settlement.market.bookLadder.get(resource);
    if (
      ladder !== undefined ||
      settlement.market.lastBookSampleDay.has(resource) ||
      settlement.market.bestAsk.has(resource) ||
      settlement.market.bestBid.has(resource)
    ) {
      sawBook = true;
    }
    if (ladder !== undefined && ladder.asks.length > 0) {
      for (const ask of ladder.asks) {
        const actor = world.actors.get(ask.actorId);
        if (actor === undefined) continue;
        const stock = Math.min(getStockAt(actor, settlement.id, resource), ask.quantity);
        if (stock <= 0) continue;
        quotes.push({ settlement, actor, price: ask.price, stock });
      }
      continue;
    }
  }
  if (sawBook) {
    quotes.sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      if (b.stock !== a.stock) return b.stock - a.stock;
      return String(a.actor.id).localeCompare(String(b.actor.id));
    });
    return quotes;
  }
  for (const settlement of settlements) {
    const price = settlement.market.lastClearingPrice.get(resource);
    if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
    for (const ownerId of settlement.stockpileOwners) {
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const stock = getStockAt(actor, settlement.id, resource);
      if (stock <= 0) continue;
      quotes.push({ settlement, actor, price, stock });
    }
  }
  quotes.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    if (b.stock !== a.stock) return b.stock - a.stock;
    return String(a.actor.id).localeCompare(String(b.actor.id));
  });
  return quotes;
};

const localRationSellerQuotes = (
  world: WorldState,
  settlements: readonly Settlement[],
  resource: ResourceId,
  buyerOwnerActor: ActorId,
): LocalSellerQuote[] => {
  const quotes: LocalSellerQuote[] = [];
  const seen = new Set<string>();
  for (const settlement of settlements) {
    const price = fallbackRationUnitPrice(settlement, resource);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ownerIds = new Set<ActorId>(settlement.stockpileOwners);
    const buyerOwner = world.actors.get(buyerOwnerActor);
    if (buyerOwner?.homeSettlement === settlement.id) ownerIds.add(buyerOwnerActor);
    for (const ownerId of ownerIds) {
      const key = `${String(settlement.id)}|${String(ownerId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const stock = getStockAt(actor, settlement.id, resource);
      if (stock <= 0) continue;
      quotes.push({ settlement, actor, price, stock });
    }
  }
  quotes.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    if (b.stock !== a.stock) return b.stock - a.stock;
    return String(a.actor.id).localeCompare(String(b.actor.id));
  });
  return quotes;
};

const destinationBidDepthFromPriceBook = (
  priceBook: Caravan['priceBook'],
): ReadonlyMap<string, ReadonlyMap<ResourceId, Quantity>> => {
  const out = new Map<string, Map<ResourceId, Quantity>>();
  for (const [resource, perHex] of priceBook) {
    for (const [hexK, obs] of perHex) {
      if (obs.bidDepth === undefined || obs.bidDepth <= 0) continue;
      let byResource = out.get(hexK);
      if (byResource === undefined) {
        byResource = new Map<ResourceId, Quantity>();
        out.set(hexK, byResource);
      }
      byResource.set(resource, obs.bidDepth);
    }
  }
  return out;
};

const copyActorKnownPricesToCaravan = (
  world: WorldState,
  actor: Actor,
  caravan: Caravan,
  today: Day,
): void => {
  for (const [settlementId, obs] of iterFreshKnownPrices(actor, today)) {
    const settlement = world.settlements.get(settlementId);
    if (settlement === undefined) continue;
    const key = hexKey(settlement.anchor);
    for (const [resource, quote] of obs.quotes) {
      const ask = quote.bestAsk;
      const bid = quote.bestBid;
      if (!Number.isFinite(ask) || ask <= 0 || !Number.isFinite(bid) || bid <= 0) continue;
      let perHex = caravan.priceBook.get(resource);
      if (perHex === undefined) {
        perHex = new Map<string, PriceObservation>();
        caravan.priceBook.set(resource, perHex);
      }
      perHex.set(key, {
        price: (ask + bid) / 2,
        askPrice: ask,
        bidPrice: bid,
        observedOnDay: obs.observedDay,
      });
    }
  }
};

const localSupplyAvailabilityByResource = (
  world: WorldState,
  settlements: readonly Settlement[],
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  for (const settlement of settlements) {
    for (const resource of settlement.market.lastClearingPrice.keys()) {
      const price = settlement.market.lastClearingPrice.get(resource);
      if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
      let total = 0;
      for (const ownerId of settlement.stockpileOwners) {
        const actor = world.actors.get(ownerId);
        if (actor === undefined) continue;
        total += Math.max(0, getStockAt(actor, settlement.id, resource));
      }
      if (total > 0) out.set(resource, (out.get(resource) ?? 0) + total);
    }
  }
  return out;
};

const bestLocalBuyer = (
  world: WorldState,
  settlements: readonly Settlement[],
  caravan: Caravan,
  resource: ResourceId,
): LocalBuyerQuote | null => {
  let best: LocalBuyerQuote | null = null;
  let sawBook = false;
  for (const settlement of settlements) {
    const ladder = settlement.market.bookLadder.get(resource);
    if (
      ladder !== undefined ||
      settlement.market.lastBookSampleDay.has(resource) ||
      settlement.market.bestAsk.has(resource) ||
      settlement.market.bestBid.has(resource)
    ) {
      sawBook = true;
    }
    if (ladder !== undefined && ladder.bids.length > 0) {
      for (const bid of ladder.bids) {
        if (bid.actorId === caravan.ownerActor) continue;
        const actor = world.actors.get(bid.actorId);
        if (actor === undefined || actor.treasury <= 0 || bid.quantity <= 0) continue;
        if (
          best === null ||
          bid.price > best.price ||
          (bid.price === best.price && actor.treasury > best.actor.treasury)
        ) {
          best = {
            settlement,
            actor,
            price: bid.price,
            quantity: bid.quantity,
            ...(bid.buyerDisposition !== undefined ? { disposition: bid.buyerDisposition } : {}),
          };
        }
      }
      continue;
    }
  }
  if (sawBook) return best;
  for (const settlement of settlements) {
    const price = settlement.market.lastClearingPrice.get(resource);
    if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
    for (const ownerId of settlement.stockpileOwners) {
      if (ownerId === caravan.ownerActor) continue;
      const actor = world.actors.get(ownerId);
      if (actor === undefined || actor.treasury <= 0) continue;
      if (
        best === null ||
        price > best.price ||
        (price === best.price && actor.treasury > best.actor.treasury)
      ) {
        best = { settlement, actor, price };
      }
    }
  }
  return best;
};

const sellCaravanCargoAtLocalMarkets = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): void => {
  for (const [resource, currentQty] of Array.from(caravan.cargo.entries())) {
    const sellableQty = caravanSellableQuantity(caravan, resource, currentQty);
    // Whole-unit trade boundary per docs/08 §"Whole-unit transactions":
    // sub-1-unit residues are below the smallest tradable quantity.
    if (sellableQty < 1) continue;
    const buyer = bestLocalBuyer(world, settlements, caravan, resource);
    if (buyer === null) continue;
    const maxByTreasury = buyer.actor.treasury / buyer.price;
    const maxByBook = buyer.quantity ?? Number.POSITIVE_INFINITY;
    // Whole-unit transaction (docs/08): caravans haul tangible goods,
    // not services — floor to integer.
    const qty = wholeUnitsForTransaction(
      resource,
      Math.min(sellableQty, maxByTreasury, maxByBook),
    );
    if (qty <= 0) continue;
    const coin = qty * buyer.price;
    const remaining = currentQty - qty;
    // Whole-unit cargo: residue under 1 unit is unsellable — drop it.
    if (remaining >= 1) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    addCoin(caravan, coin);
    subtractCoin(buyer.actor, coin);
    if (buyer.disposition === 'consume') recordConsumption(buyer.settlement, resource, qty);
    else increaseStockpile(buyer.actor, buyer.settlement.id, resource, qty);
    // Caravan sold cargo to the settlement: import for the settlement.
    recordImport(buyer.settlement, resource, qty);
    // Per docs/08 §"Transaction observability": write the trade's
    // execution price so the settlement's price ladder reflects every
    // participant, not just yesterday's CDA. buyer.price is integer
    // coin per docs/08 §"Integer-coin prices" (it came from the
    // residual book ladder or lastClearingPrice).
    recordClearingPrice(buyer.settlement, resource, buyer.price);
    events.push({
      type: 'caravan_traded',
      caravan: caravan.id,
      settlement: buyer.settlement.id,
      side: 'sold',
      resource,
      quantity: qty,
      coin,
    });
  }
};

const buyPlannedCargoAtLocalMarkets = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  cargoPlan: ReadonlyMap<ResourceId, Quantity>,
  events: TickEvent[],
): number => {
  let boughtUnits = 0;
  for (const [resource, targetQty] of cargoPlan) {
    if (targetQty <= 0) continue;
    const weightKg = getResource(resource).weightKgPerUnit;
    const quotes = localSellerQuotes(world, settlements, resource);
    let remainingTarget = targetQty;
    for (const seller of quotes) {
      // Whole-unit trade boundary: stop when sub-1-unit remains to buy.
      if (remainingTarget < 1) break;
      const capacityRemainingKg = caravanTradeCargoCapacityRemainingKg(caravan);
      // Kg residue is naturally fractional; treat near-zero as zero.
      if (capacityRemainingKg <= 1e-9) break;
      const maxByCapacity = weightKg > 0 ? capacityRemainingKg / weightKg : remainingTarget;
      const sameOwner = seller.actor.id === caravan.ownerActor;
      const maxByTreasury = sameOwner ? remainingTarget : caravan.treasury / seller.price;
      // Whole-unit transaction (docs/08): caravans haul tangible goods.
      const qty = wholeUnitsForTransaction(
        resource,
        Math.min(remainingTarget, seller.stock, maxByCapacity, maxByTreasury),
      );
      if (qty <= 0) continue;
      const coin = sameOwner ? 0 : qty * seller.price;
      decreaseStockpile(seller.actor, seller.settlement.id, resource, qty);
      increaseCaravanCargo(caravan, resource, qty);
      if (!sameOwner) {
        subtractCoin(caravan, coin);
        addCoin(seller.actor, coin);
      }
      // Caravan picked up cargo from this settlement: export.
      recordExport(seller.settlement, resource, qty);
      // Per docs/08 §"Transaction observability": record the trade's
      // execution price even though it wasn't a CDA crossing.
      if (!sameOwner) recordClearingPrice(seller.settlement, resource, seller.price);
      remainingTarget -= qty;
      boughtUnits += qty;
      events.push({
        type: 'caravan_traded',
        caravan: caravan.id,
        settlement: seller.settlement.id,
        side: 'bought',
        resource,
        quantity: qty,
        coin,
      });
    }
  }
  return boughtUnits;
};

const buyCaravanRationsAtLocalMarkets = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): number => {
  const targetKg = dailyCarriedFoodReserveKg(caravan) * CARAVAN_RATION_RESERVE_DAYS;
  let remainingKg = targetKg - caravanRationCargoKg(caravan);
  if (remainingKg <= 1e-9) return 0;

  const quotes: Array<{
    readonly resource: ResourceId;
    readonly seller: LocalSellerQuote;
    readonly weightKgPerUnit: number;
    readonly pricePerKg: number;
  }> = [];
  for (const resourceKey of CARAVAN_RATION_RESOURCES) {
    const resource = resourceId(resourceKey);
    const weightKgPerUnit = getResource(resource).weightKgPerUnit;
    if (weightKgPerUnit <= 0) continue;
    for (const seller of localRationSellerQuotes(
      world,
      settlements,
      resource,
      caravan.ownerActor,
    )) {
      quotes.push({
        resource,
        seller,
        weightKgPerUnit,
        pricePerKg: seller.price / weightKgPerUnit,
      });
    }
  }
  quotes.sort((a, b) => {
    if (a.pricePerKg !== b.pricePerKg) return a.pricePerKg - b.pricePerKg;
    return String(a.resource).localeCompare(String(b.resource));
  });

  let boughtKg = 0;
  for (const quote of quotes) {
    if (remainingKg <= 1e-9) break;
    const capacityRemainingKg = Math.max(0, totalCarryKg(caravan) - totalCargoWeightKg(caravan));
    if (capacityRemainingKg <= 1e-9) break;
    const sameOwner = quote.seller.actor.id === caravan.ownerActor;
    const maxByNeed = remainingKg / quote.weightKgPerUnit;
    const maxByCapacity = capacityRemainingKg / quote.weightKgPerUnit;
    const maxByTreasury = sameOwner ? maxByNeed : caravan.treasury / quote.seller.price;
    // Whole-unit transaction (docs/08).
    const qty = wholeUnitsForTransaction(
      quote.resource,
      Math.min(maxByNeed, maxByCapacity, maxByTreasury, quote.seller.stock),
    );
    if (qty <= 0) continue;
    const coin = sameOwner ? 0 : qty * quote.seller.price;
    decreaseStockpile(quote.seller.actor, quote.seller.settlement.id, quote.resource, qty);
    increaseCaravanCargo(caravan, quote.resource, qty);
    if (!sameOwner) {
      subtractCoin(caravan, coin);
      addCoin(quote.seller.actor, coin);
    }
    recordClearingPrice(quote.seller.settlement, quote.resource, quote.seller.price);
    // Caravan loaded cargo at this settlement: export.
    recordExport(quote.seller.settlement, quote.resource, qty);
    remainingKg -= qty * quote.weightKgPerUnit;
    boughtKg += qty * quote.weightKgPerUnit;
    events.push({
      type: 'caravan_traded',
      caravan: caravan.id,
      settlement: quote.seller.settlement.id,
      side: 'bought',
      resource: quote.resource,
      quantity: qty,
      coin,
    });
  }

  return boughtKg;
};

const estimateLocalRationPurchaseKg = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  treasuryBudget: number,
): number => {
  const quotes: Array<{
    readonly resource: ResourceId;
    readonly seller: LocalSellerQuote;
    readonly weightKgPerUnit: number;
    readonly pricePerKg: number;
  }> = [];
  for (const resourceKey of CARAVAN_RATION_RESOURCES) {
    const resource = resourceId(resourceKey);
    const weightKgPerUnit = getResource(resource).weightKgPerUnit;
    if (weightKgPerUnit <= 0) continue;
    for (const seller of localRationSellerQuotes(
      world,
      settlements,
      resource,
      caravan.ownerActor,
    )) {
      quotes.push({
        resource,
        seller,
        weightKgPerUnit,
        pricePerKg: seller.price / weightKgPerUnit,
      });
    }
  }
  quotes.sort((a, b) => {
    if (a.pricePerKg !== b.pricePerKg) return a.pricePerKg - b.pricePerKg;
    return String(a.resource).localeCompare(String(b.resource));
  });

  let purchasableKg = 0;
  let remainingCapacityKg = Math.max(0, totalCarryKg(caravan) - totalCargoWeightKg(caravan));
  let remainingTreasury = Math.max(0, treasuryBudget);
  for (const quote of quotes) {
    if (remainingCapacityKg <= 1e-9) break; // kg residue, float
    const sameOwner = quote.seller.actor.id === caravan.ownerActor;
    const maxByCapacity = remainingCapacityKg / quote.weightKgPerUnit;
    const maxByTreasury = sameOwner ? quote.seller.stock : remainingTreasury / quote.seller.price;
    const qty = Math.min(quote.seller.stock, maxByCapacity, maxByTreasury);
    // Whole-unit trade boundary (docs/08): sub-1-unit quotes don't fire.
    if (qty < 1) continue;
    const kg = qty * quote.weightKgPerUnit;
    purchasableKg += kg;
    remainingCapacityKg -= kg;
    if (!sameOwner) remainingTreasury -= qty * quote.seller.price;
  }
  return purchasableKg;
};

const remitStandingCaravanProfitAtHome = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): number => {
  // Standing merchant caravans and villager caravans (free_village steward,
  // docs/15 §C31) remit profit at home. Edge-hub + tax caravans are excluded
  // because their balance is closed at the hub/capital, not at an owner's home.
  if (!isStandingMerchantCaravan(caravan) && !isVillagerCaravan(caravan)) return 0;
  const owner = world.actors.get(caravan.ownerActor);
  if (owner === undefined || owner.homeSettlement === undefined) return 0;
  const home = settlements.find((settlement) => settlement.id === owner.homeSettlement);
  if (home === undefined) return 0;

  const reserveCoin = Math.max(
    MERCHANT_CARAVAN_HOME_OPERATING_RESERVE_COIN,
    caravanMissingRationReserveKg(caravan),
  );
  const surplus = caravan.treasury - reserveCoin;
  if (surplus <= 0) return 0; // integer coin per docs/08

  const coin = Math.floor(surplus * MERCHANT_CARAVAN_HOME_REMITTANCE_RATE);
  if (coin <= 0) return 0;
  subtractCoin(caravan, coin);
  addCoin(owner, coin);
  events.push({
    type: 'caravan_profit_remitted',
    caravan: caravan.id,
    ownerActor: owner.id,
    settlement: home.id,
    coin,
  });
  return coin;
};

const unloadVillagerCaravanCargoAtHome = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): number => {
  if (!isVillagerCaravan(caravan)) return 0;
  const owner = world.actors.get(caravan.ownerActor);
  if (owner === undefined || owner.homeSettlement === undefined) return 0;
  const home = settlements.find((settlement) => settlement.id === owner.homeSettlement);
  if (home === undefined) return 0;

  let unloaded = 0;
  for (const [resource, currentQty] of Array.from(caravan.cargo.entries())) {
    const qty = wholeUnitsForTransaction(
      resource,
      caravanSellableQuantity(caravan, resource, currentQty),
    );
    if (qty <= 0) continue;
    const remaining = currentQty - qty;
    if (remaining >= 1) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    receiveResourceOrCoin(owner, home.id, resource, qty);
    if (caravan.importDemand !== undefined) {
      const remainingDemand = (caravan.importDemand.get(resource) ?? 0) - qty;
      if (remainingDemand >= 1) caravan.importDemand.set(resource, remainingDemand);
      else caravan.importDemand.delete(resource);
      if (caravan.importDemand.size === 0) delete caravan.importDemand;
    }
    recordImport(home, resource, qty);
    unloaded += qty;
    events.push({
      type: 'caravan_unloaded_home',
      caravan: caravan.id,
      ownerActor: owner.id,
      settlement: home.id,
      resource,
      quantity: qty,
    });
  }
  return unloaded;
};

const VILLAGER_HOME_TOOL_IMPORT_MIN_TARGET = 5;
const VILLAGER_HOME_TOOL_IMPORT_MAX_TARGET = 30;
const VILLAGER_HOME_TOOL_IMPORT_PER_CAPITA = 0.05;

const villagerHomeSettlementForCaravan = (
  world: WorldState,
  caravan: Caravan,
): { readonly owner: Actor; readonly home: Settlement } | null => {
  if (!isVillagerCaravan(caravan)) return null;
  const owner = world.actors.get(caravan.ownerActor);
  if (owner === undefined || owner.homeSettlement === undefined) return null;
  if (owner.kind !== 'free_village' && owner.kind !== 'hamlet_household') return null;
  const home = world.settlements.get(owner.homeSettlement);
  if (home === undefined) return null;
  return { owner, home };
};

const villagerHomeToolTarget = (home: Settlement): number => {
  const scaled = Math.ceil(home.population.total() * VILLAGER_HOME_TOOL_IMPORT_PER_CAPITA);
  return Math.max(
    VILLAGER_HOME_TOOL_IMPORT_MIN_TARGET,
    Math.min(VILLAGER_HOME_TOOL_IMPORT_MAX_TARGET, scaled),
  );
};

const buyVillagerPlannedImports = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): boolean => {
  const homeInfo = villagerHomeSettlementForCaravan(world, caravan);
  if (homeInfo === null) return false;
  if (hexEquals(caravan.position, homeInfo.home.anchor)) return false;
  if (caravan.importDemand === undefined || caravan.importDemand.size === 0) return false;

  const wanted = new Map<ResourceId, Quantity>();
  for (const [resource, targetQty] of caravan.importDemand) {
    const remaining = Math.ceil(targetQty - (caravan.cargo.get(resource) ?? 0));
    if (remaining >= 1) wanted.set(resource, remaining);
  }
  if (wanted.size === 0) {
    caravan.destination = { q: homeInfo.home.anchor.q, r: homeInfo.home.anchor.r };
    caravan.goalStack = [{ type: 'return_home', home: caravan.destination }];
    return true;
  }

  const bought = buyPlannedCargoAtLocalMarkets(
    world,
    caravan,
    settlements,
    wanted,
    events,
  );
  if (bought < 1) return false;

  caravan.destination = { q: homeInfo.home.anchor.q, r: homeInfo.home.anchor.r };
  caravan.goalStack = [{ type: 'return_home', home: caravan.destination }];
  caravan.noProfitableRouteDays = 0;
  return true;
};

const increaseCaravanCargo = (caravan: Caravan, resource: ResourceId, qty: Quantity): void => {
  if (qty <= 0) return;
  caravan.cargo.set(resource, (caravan.cargo.get(resource) ?? 0) + qty);
};

/** Per docs/10 decision 40: 20-tick invisible off-map sojourn. */
const OFF_MAP_SOJOURN_DAYS = 20;

const completeOffMapExportIfArrived = (
  world: WorldState,
  _caravanId: CaravanId,
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
  today: Day,
  events: TickEvent[],
): boolean => {
  if (String(caravan.id).startsWith('tax-')) return false;
  if (caravan.destination === null) return false;
  if (!hexEquals(caravan.position, caravan.destination)) return false;
  if (!edgeHexKeys.has(hexKey(caravan.position))) return false;
  // If the caravan is already mid-sojourn (re-emerged in a prior tick),
  // this is not a fresh arrival — handled by the off-map sojourn phase.
  if (caravan.offMapUntil !== undefined) return false;
  let exportedAny = false;
  for (const [resource, rawQty] of Array.from(caravan.cargo.entries())) {
    const price = DEFAULT_GLOBAL_PRICES.get(resource);
    if (price === undefined || price <= 0 || rawQty <= 0) continue;
    // Whole-unit transaction (docs/08): off-map export crosses
    // ownership at the world's edge, so round to integer.
    const qty = wholeUnitsForTransaction(resource, rawQty);
    if (qty <= 0) {
      caravan.cargo.delete(resource);
      continue;
    }
    const coin = qty * price;
    const owner = world.actors.get(caravan.ownerActor);
    // Per docs/10 decision 41: the global market pays into the caravan's
    // operating treasury (the cash travels with the caravan during the
    // sojourn, not magically into the owner's pocket). The owner gets
    // the surplus on home arrival via the standard home-market remit.
    addCoin(caravan, coin);
    void owner;
    caravan.cargo.delete(resource);
    exportedAny = true;
    events.push({
      type: 'caravan_exported_off_map',
      caravan: caravan.id,
      resource,
      quantity: qty,
      coin,
    });
  }
  if (!exportedAny) return false;
  // Per docs/06 §"The 20-tick off-map sojourn" + docs/10 decision 40:
  // the caravan is now invisible on the map for OFF_MAP_SOJOURN_DAYS
  // while it conducts trade beyond the world edge. It still consumes
  // rations and wages during the sojourn. After the sojourn it re-
  // emerges at the same edge hex and routes home to its origin.
  caravan.offMapUntil = (today + OFF_MAP_SOJOURN_DAYS) as Day;
  // Clear destination so the movement / planner phases don't try to
  // re-execute the arrival. The sojourn phase re-sets destination to
  // originSettlement on re-emergence.
  caravan.destination = null;
  return true;
};

/**
 * Per docs/06 §"Edge-hub inbound visits" + docs/10 decision 45 (v1.9):
 * an inbound off-map caravan has arrived back at its edge gate. Sell
 * any remaining cargo to the global market at the global reference
 * price (the caravan was either unable to clear it at the destination
 * city or deliberately picked it up as profitable return cargo), then
 * delete the caravan. **The caravan's entire treasury is destroyed
 * along with it** — coin returning off-map physically leaves our
 * economy. No remittance.
 */
const completeOffMapImportReturnIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
  events: TickEvent[],
): boolean => {
  if (!isEdgeHubImportCaravan(caravan)) return false;
  if (caravan.destination === null) return false;
  const homeGate = edgeHubHomeGateForCaravan(caravan, edgeHexKeys);
  if (homeGate === null) return false;
  if (!hexEquals(caravan.position, homeGate) || !hexEquals(caravan.destination, homeGate)) {
    return false;
  }
  // Sell remaining cargo at global reference prices before the caravan
  // and its treasury both disappear. Each unit converts to coin, then
  // coin disappears with the caravan delete below.
  for (const [resource, rawQty] of Array.from(caravan.cargo.entries())) {
    const price = DEFAULT_GLOBAL_PRICES.get(resource);
    if (price === undefined || price <= 0 || rawQty <= 0) {
      caravan.cargo.delete(resource);
      continue;
    }
    const qty = wholeUnitsForTransaction(resource, rawQty);
    if (qty <= 0) {
      caravan.cargo.delete(resource);
      continue;
    }
    const coin = qty * price;
    addCoin(caravan, coin);
    caravan.cargo.delete(resource);
    events.push({
      type: 'caravan_exported_off_map',
      caravan: caravan.id,
      resource,
      quantity: qty,
      coin,
    });
  }
  world.caravans.delete(caravanId);
  return true;
};

const completeTaxShipmentIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  settlements: readonly Settlement[],
): boolean => {
  if (!String(caravan.id).startsWith('tax-')) return false;
  if (caravan.destination === null) return false;
  if (!hexEquals(caravan.position, caravan.destination)) return false;

  const owner = world.actors.get(caravan.ownerActor);
  const destination = settlements[0];
  if (owner !== undefined && destination !== undefined) {
    for (const [resource, qty] of caravan.cargo) {
      receiveResourceOrCoin(owner, destination.id, resource, qty);
      // Tax shipment unloaded its cargo at the capital: an import for
      // the capital from the perspective of the receiving settlement.
      recordImport(destination, resource, qty);
    }
  }
  world.caravans.delete(caravanId);
  return true;
};

/**
 * Per docs/06 §"Edge-hub inbound visits" + docs/10 decision 45 (v1.9):
 * after an inbound off-map caravan finishes selling its import cargo at
 * a destination city, it evaluates whether any locally-available resource
 * has a positive arbitrage spread vs the off-map global reference price,
 * net of the return leg's transport cost. If so, it buys the highest-
 * margin-per-kg items at the local ask up to its remaining capacity and
 * treasury. The cargo will then be sold off-map when the caravan reaches
 * the edge gate.
 *
 * The local ask is taken from `representativeObservedPrice` — what a
 * domestic seller would charge today. Transport cost back to the edge
 * is the per-kg variable component of `travelCost(distance)`.
 *
 * Returns the total kg loaded. Caravan treasury is debited; the
 * domestic seller's coin side is not affected by this function — we
 * model the foreign-merchant purchase as paying the prevailing market
 * ask (the existing market schedule absorbs the inverse side on the
 * next clearing through normal supply/demand mechanics).
 */
const buyReturnCargoForOffMapExport = (
  caravan: Caravan,
  settlements: readonly Settlement[],
  homeGate: Hex,
): number => {
  // Pick the on-map settlement at the caravan's current position to
  // canvass for local asks. Use the first hosted settlement (the same
  // policy local-sell uses).
  const here = settlements[0];
  if (here === undefined) return 0;

  // Distance to the edge gate determines the return-leg transport cost.
  const returnDistance = hexDistance(caravan.position, homeGate);
  const transportCostPerKg = returnDistance > 0 ? travelCost(caravan, returnDistance) : 0;

  const remainingKgInit = Math.max(0, totalCarryKg(caravan) - totalCargoWeightKg(caravan));
  if (remainingKgInit < 1) return 0;

  interface Candidate {
    readonly resource: ResourceId;
    readonly localAsk: number;
    readonly globalAsk: number;
    readonly weightKg: number;
    readonly marginPerKg: number;
  }
  const candidates: Candidate[] = [];
  for (const resource of here.market.lastClearingPrice.keys()) {
    const globalAsk = DEFAULT_GLOBAL_PRICES.get(resource);
    if (globalAsk === undefined || globalAsk <= 0) continue;
    const localAsk = representativeObservedPrice(here, resource);
    if (!Number.isFinite(localAsk) || localAsk <= 0) continue;
    const weightKg = weightKgPerUnitForResource(resource);
    if (weightKg <= 0) continue;
    // Per-kg arbitrage net of return transport: a unit costs localAsk
    // to acquire, weighs weightKg, will sell for globalAsk off-map.
    // Spread per kg = (globalAsk - localAsk) / weightKg.
    const transportPerUnit = transportCostPerKg * weightKg;
    const netSpreadPerUnit = globalAsk - localAsk - transportPerUnit;
    if (netSpreadPerUnit <= 0) continue;
    const marginPerKg = netSpreadPerUnit / weightKg;
    candidates.push({ resource, localAsk, globalAsk, weightKg, marginPerKg });
  }
  if (candidates.length === 0) return 0;
  candidates.sort((a, b) => b.marginPerKg - a.marginPerKg);

  let remainingKg = remainingKgInit;
  let remainingCoin = caravan.treasury;
  let loadedKg = 0;
  for (const c of candidates) {
    if (remainingKg < c.weightKg || remainingCoin < c.localAsk) continue;
    const maxByCapacity = Math.floor(remainingKg / c.weightKg);
    const maxByCoin = Math.floor(remainingCoin / Math.max(1, c.localAsk));
    const qty = Math.min(maxByCapacity, maxByCoin);
    if (qty <= 0) continue;
    increaseCaravanCargo(caravan, c.resource, qty as Quantity);
    const spent = qty * c.localAsk;
    subtractCoin(caravan, spent);
    remainingKg -= qty * c.weightKg;
    remainingCoin -= spent;
    loadedKg += qty * c.weightKg;
    // Selling the local supply to a departing foreign merchant is an
    // export from this settlement's POV.
    recordExport(here, c.resource, qty);
  }
  return loadedKg;
};

const weightKgPerUnitForResource = (resource: ResourceId): number => {
  const w = getResource(resource).weightKgPerUnit;
  return w > 0 ? w : 1;
};

// --- Merchant caravan assembly --------------------------------------------

const MERCHANT_CARAVAN_ASSEMBLY_INTERVAL_DAYS = 7;
const MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL = 2;
const MERCHANT_CARAVAN_TARGET_PER_SETTLEMENT = 0.25;
const MERCHANT_CARAVAN_TARGET_MIN = 4;
const MERCHANT_CARAVAN_TARGET_MAX = 80;
const MERCHANT_CARAVAN_OWNER_CAP = 3;
const MERCHANT_CARAVAN_MIN_OPERATING_TREASURY = 100;
const MERCHANT_CARAVAN_EQUINES_RESOURCE = resourceId('livestock.equines');
const MERCHANT_CARAVAN_CART_RESOURCE = resourceId('goods.cart');
const EQUINE_ANIMALS_PER_HERD_UNIT = 6;
const MERCHANT_CARAVAN_MAX_LIGHT_CARTS = 1;
const MERCHANT_CARAVAN_MIN_STARTER_RATION_DAYS = 7;
const MERCHANT_CARAVAN_MIN_PACK_ANIMALS = 6;
const MERCHANT_CARAVAN_PREFERRED_EQUINE_UNITS = 2;

/**
 * Per docs/15 §C31: villager caravans are low-capacity village / hamlet
 * market runs spawned by `free_village` or `hamlet_household` stewards.
 * Their ID carries the `villager-` prefix so the viewer renders them with
 * the dedicated peasant-with-handcart glyph and so caravan-bookkeeping
 * doesn't confuse them with patron-owned long-haul merchant trains.
 */
const VILLAGER_CARAVAN_PREFIX = 'villager-';
// v1.6 pass-22: villager caravan dispatch made faster + more aggressive
// to absorb cross-settlement trade flow that the v1.6 deletion of the
// localTradePhase abstraction (Phase 24c) leaves uncarried. Pre-v1.6
// these ran every 14 days with cap 1 per village; now they run every
// 3 days with cap 3 per village so village / hamlet trade flow has real
// bandwidth instead of relying on the abstract daily-pass teleportation.
const VILLAGER_CARAVAN_ASSEMBLY_INTERVAL_DAYS = 3;
const VILLAGER_CARAVAN_OWNER_CAP = 3;
const VILLAGER_CARAVAN_MIN_OPERATING_TREASURY = 30;
const VILLAGER_CARAVAN_MIN_STARTER_RATION_DAYS = 4;
const VILLAGER_CARAVAN_MIN_PACK_ANIMALS = 2;
const VILLAGER_CARAVAN_PREFERRED_EQUINE_UNITS = 0.6; // ≈3-4 mules
const VILLAGER_CARAVAN_SURPLUS_DAYS_THRESHOLD = 14;

const isVillagerCaravan = (caravan: Caravan): boolean =>
  String(caravan.id).startsWith(VILLAGER_CARAVAN_PREFIX);

const isStandingMerchantCaravan = (caravan: Caravan): boolean => {
  const id = String(caravan.id);
  return (
    !id.startsWith(EDGE_HUB_IMPORT_CARAVAN_PREFIX) &&
    !id.startsWith(EDGE_HUB_EXPORT_CARAVAN_PREFIX) &&
    !id.startsWith('tax-') &&
    !id.startsWith(VILLAGER_CARAVAN_PREFIX)
  );
};

const merchantCaravanTarget = (world: WorldState): number => {
  const raw = Math.floor(world.settlements.size * MERCHANT_CARAVAN_TARGET_PER_SETTLEMENT);
  return Math.max(MERCHANT_CARAVAN_TARGET_MIN, Math.min(MERCHANT_CARAVAN_TARGET_MAX, raw));
};

const standingMerchantCaravanCountByOwner = (world: WorldState): Map<ActorId, number> => {
  const out = new Map<ActorId, number>();
  for (const caravan of world.caravans.values()) {
    if (!isStandingMerchantCaravan(caravan)) continue;
    out.set(caravan.ownerActor, (out.get(caravan.ownerActor) ?? 0) + 1);
  }
  return out;
};

const eligibleMerchantCaravanOwners = (
  world: WorldState,
  activeByOwner: ReadonlyMap<ActorId, number>,
): { readonly actor: Actor; readonly settlement: Settlement }[] => {
  const out: { actor: Actor; settlement: Settlement }[] = [];
  for (const actor of world.actors.values()) {
    // docs/10 decision 45 (v1.9): off_map_house is NEVER a standing-merchant
    // owner. The kind exists only as the edge-gate synthetic endpoint. Any
    // on-map standing caravan must be owned by a domestic actor.
    if (actor.kind !== 'patrician_family' && actor.kind !== 'caravan_owner') {
      continue;
    }
    if ((activeByOwner.get(actor.id) ?? 0) >= MERCHANT_CARAVAN_OWNER_CAP) continue;
    if (actor.treasury < MERCHANT_CARAVAN_MIN_OPERATING_TREASURY) continue;
    if (actor.homeSettlement === undefined) continue;
    const settlement = world.settlements.get(actor.homeSettlement);
    if (settlement === undefined) continue;
    out.push({ actor, settlement });
  }
  out.sort((a, b) => {
    if (b.actor.treasury !== a.actor.treasury) return b.actor.treasury - a.actor.treasury;
    return String(a.actor.id).localeCompare(String(b.actor.id));
  });
  return out;
};

const buyOwnerAssemblyStockAtLocalMarket = (
  world: WorldState,
  buyer: Actor,
  settlement: Settlement,
  resource: ResourceId,
  targetQty: number,
): number => {
  let remaining = Math.max(0, targetQty - getStockAt(buyer, settlement.id, resource));
  // Whole-unit trade boundary (docs/08): sub-1-unit assembly buys are
  // not orderable. Buyer treasury is integer-coin per docs/08
  // §"Integer-coin prices".
  if (remaining < 1) return 0;
  let bought = 0;
  for (const seller of localSellerQuotes(world, [settlement], resource)) {
    if (remaining < 1) break;
    if (seller.actor.id === buyer.id) continue;
    const spendable = Math.max(0, buyer.treasury - MERCHANT_CARAVAN_MIN_OPERATING_TREASURY);
    if (spendable <= 0) break;
    const maxByTreasury = spendable / seller.price;
    const qty = Math.min(remaining, seller.stock, maxByTreasury);
    if (qty < 1) continue;
    const coin = qty * seller.price;
    decreaseStockpile(seller.actor, seller.settlement.id, resource, qty);
    increaseStockpile(buyer, settlement.id, resource, qty);
    subtractCoin(buyer, coin);
    addCoin(seller.actor, coin);
    remaining -= qty;
    bought += qty;
  }
  return bought;
};

const createReplacementMerchantCaravan = (
  world: WorldState,
  today: Day,
  owner: Actor,
  origin: Settlement,
  rng: Rng,
  index: number,
  events: TickEvent[],
): Caravan | null => {
  buyOwnerAssemblyStockAtLocalMarket(
    world,
    owner,
    origin,
    MERCHANT_CARAVAN_EQUINES_RESOURCE,
    MERCHANT_CARAVAN_PREFERRED_EQUINE_UNITS,
  );
  const availablePackAnimals = Math.floor(
    getStockAt(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE) * EQUINE_ANIMALS_PER_HERD_UNIT,
  );
  if (availablePackAnimals < MERCHANT_CARAVAN_MIN_PACK_ANIMALS) return null;
  let muleCount = rng.int(8, 14);
  let donkeyCount = rng.int(0, 3);
  while (muleCount + donkeyCount > availablePackAnimals) {
    if (donkeyCount > 0) donkeyCount -= 1;
    else muleCount -= 1;
  }
  if (muleCount < MERCHANT_CARAVAN_MIN_PACK_ANIMALS) return null;
  const equineUnitsNeeded = (muleCount + donkeyCount) / EQUINE_ANIMALS_PER_HERD_UNIT;
  const lightCartCount = Math.min(
    MERCHANT_CARAVAN_MAX_LIGHT_CARTS,
    Math.floor(getStockAt(owner, origin.id, MERCHANT_CARAVAN_CART_RESOURCE)),
  );
  const operatingTreasury = Math.min(owner.treasury, rng.int(250, 750));
  if (operatingTreasury < MERCHANT_CARAVAN_MIN_OPERATING_TREASURY) return null;
  const tag = Math.floor(rng.next() * 1_000_000_000);
  // Per docs/06 §"Crew demographics": replacement assembly draws each
  // crew member's sex/age from the origin settlement's working-age pool
  // with the role-appropriate bias. Without this, the recruited crew
  // would be anonymous counts and casualty draws would have nothing
  // realistic to remove from the home cohort.
  const droverCount = rng.int(3, 5);
  const guardCount = rng.int(4, 6);
  const demoRng = rng.derive(`merchant-crew-${String(owner.id)}-${tag}`);
  const caravan = createCaravan({
    id: makeCaravanIdLocal(`merchant-${today}-${index}-${String(owner.id)}-${tag}`),
    ownerActor: owner.id,
    position: { q: origin.anchor.q, r: origin.anchor.r },
    destination: { q: origin.anchor.q, r: origin.anchor.r },
    crew: [
      {
        kind: 'merchant',
        count: 1,
        weapons: 0.1,
        armor: 0.05,
        demographics: drawDemographicsFromPool(
          origin.population,
          1,
          ROLE_BIASES.caravan_merchant,
          demoRng.derive('merchant'),
        ),
      },
      {
        kind: 'drover',
        count: droverCount,
        weapons: 0.1,
        armor: 0.05,
        demographics: drawDemographicsFromPool(
          origin.population,
          droverCount,
          ROLE_BIASES.caravan_drover,
          demoRng.derive('drover'),
        ),
      },
      {
        kind: 'caravan_guard',
        count: guardCount,
        weapons: 0.7,
        armor: 0.45,
        demographics: drawDemographicsFromPool(
          origin.population,
          guardCount,
          ROLE_BIASES.caravan_guard,
          demoRng.derive('guard'),
        ),
      },
    ],
    animals: { mule: muleCount, donkey: donkeyCount },
    vehicles:
      lightCartCount > 0 ? { pack_saddle: 1, light_cart: lightCartCount } : { pack_saddle: 1 },
    treasury: operatingTreasury,
  });
  if (!world.grid.has(caravan.position)) return null;
  const minStarterRationKg =
    dailyCarriedFoodReserveKg(caravan) * MERCHANT_CARAVAN_MIN_STARTER_RATION_DAYS;
  if (
    estimateLocalRationPurchaseKg(world, caravan, [origin], operatingTreasury) < minStarterRationKg
  ) {
    return null;
  }
  decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE, equineUnitsNeeded);
  if (lightCartCount > 0) {
    decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_CART_RESOURCE, lightCartCount);
  }
  subtractCoin(owner, operatingTreasury);
  buyCaravanRationsAtLocalMarkets(world, caravan, [origin], events);
  return caravan;
};

export const merchantCaravanAssemblyPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (today % MERCHANT_CARAVAN_ASSEMBLY_INTERVAL_DAYS !== 0) return;
  const activeByOwner = standingMerchantCaravanCountByOwner(world);
  const active = Array.from(activeByOwner.values()).reduce((sum, n) => sum + n, 0);
  const target = merchantCaravanTarget(world);
  if (active >= target) return;

  const eligible = rng.shuffle(eligibleMerchantCaravanOwners(world, activeByOwner));
  if (eligible.length === 0) return;
  const toDispatch = Math.min(MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL, target - active);
  let dispatched = 0;
  for (let i = 0; i < eligible.length && dispatched < toDispatch; i++) {
    const slot = eligible[i];
    if (slot === undefined) continue;
    const currentForOwner = activeByOwner.get(slot.actor.id) ?? 0;
    if (currentForOwner >= MERCHANT_CARAVAN_OWNER_CAP) continue;
    const caravan = createReplacementMerchantCaravan(
      world,
      today,
      slot.actor,
      slot.settlement,
      rng.derive(`dispatch-${i}`),
      dispatched,
      events,
    );
    if (caravan === null) continue;
    world.caravans.set(caravan.id, caravan);
    activeByOwner.set(slot.actor.id, currentForOwner + 1);
    dispatched += 1;
    events.push({
      type: 'merchant_caravan_dispatched',
      caravan: caravan.id,
      settlement: slot.settlement.id,
      ownerActor: slot.actor.id,
    });
  }
};

// --- Villager caravans (docs/15 §C31) ------------------------------------

/**
 * Count active villager caravans per owner. Villager caravans use the
 * `villager-` ID prefix so we can distinguish them from standing merchant
 * caravans.
 */
const villagerCaravanCountByOwner = (world: WorldState): Map<ActorId, number> => {
  const out = new Map<ActorId, number>();
  for (const caravan of world.caravans.values()) {
    if (!isVillagerCaravan(caravan)) continue;
    out.set(caravan.ownerActor, (out.get(caravan.ownerActor) ?? 0) + 1);
  }
  return out;
};

/**
 * Per docs/15 §C31: things a Roman village routinely had surplus of and
 * carted to a nearby city for sale — basic rural production. Food items,
 * fibre/fleece, lumber, hides, livestock, and the simplest goods the village
 * can make from those (cloth, clothing). NOT included: imports like wine,
 * oil, pottery, tools, salt — those flow IN to a typical village, not out.
 */
const VILLAGER_EXPORTABLE_RESOURCES: ReadonlyArray<ResourceId> = [
  // Food
  resourceId('food.grain'),
  resourceId('food.legumes'),
  resourceId('food.salted_fish'),
  resourceId('food.salted_meat'),
  resourceId('food.cheese'),
  // Fibres + raw materials
  resourceId('material.flax'),
  resourceId('material.linen_fiber'),
  resourceId('material.wool'),
  resourceId('material.wood'),
  resourceId('material.lumber'),
  resourceId('material.hides'),
  resourceId('material.leather'),
  // Livestock + goods made in-village
  resourceId('livestock.sheep'),
  resourceId('livestock.cattle'),
  resourceId('livestock.pigs'),
  resourceId('goods.cloth'),
  resourceId('goods.clothing'),
];

interface VillagerCaravanDemand {
  readonly importDemand: Map<ResourceId, Quantity>;
}

const villagerExportAvailabilityByResource = (
  settlement: Settlement,
  steward: Actor,
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  const pop = settlement.population.total();
  if (pop <= 0) return out;
  for (const r of VILLAGER_EXPORTABLE_RESOURCES) {
    const stock = getStockAt(steward, settlement.id, r);
    if (stock <= 0) continue;
    // Loose threshold: stock equivalent to >= N days of the village's own
    // subsistence-style consumption of that resource. Per-resource rate
    // varies, but 0.02/adult/day is a safe lower bound across the list.
    const daysOfLocalUse = stock / Math.max(1, pop * 0.02);
    if (daysOfLocalUse >= VILLAGER_CARAVAN_SURPLUS_DAYS_THRESHOLD) out.set(r, stock);
  }
  return out;
};

const plannedVillagerImportDemand = (
  settlement: Settlement,
  steward: Actor,
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  const tools = resourceId('goods.tools');
  const wantedTools = Math.ceil(villagerHomeToolTarget(settlement) - getStockAt(steward, settlement.id, tools));
  if (wantedTools >= 1) out.set(tools, wantedTools);
  return out;
};

const hasFreshNonHomeMarketObservation = (
  steward: Actor,
  home: SettlementId,
  today: Day,
): boolean => {
  for (const [settlement] of iterFreshKnownPrices(steward, today)) {
    if (settlement !== home) return true;
  }
  return false;
};

const stewardCanAffordKnownImport = (
  steward: Actor,
  home: SettlementId,
  today: Day,
  demand: ReadonlyMap<ResourceId, Quantity>,
): boolean => {
  const spendable = Math.max(0, steward.treasury - VILLAGER_CARAVAN_MIN_OPERATING_TREASURY);
  if (spendable <= 0) return false;
  for (const [settlement, obs] of iterFreshKnownPrices(steward, today)) {
    if (settlement === home) continue;
    for (const [resource] of demand) {
      const ask = obs.quotes.get(resource)?.bestAsk;
      if (ask !== undefined && Number.isFinite(ask) && ask > 0 && ask <= spendable) return true;
    }
  }
  return false;
};

const villagerKnownProfitableExportPlan = (
  world: WorldState,
  settlement: Settlement,
  steward: Actor,
  today: Day,
  rng: Rng,
): boolean => {
  const originAvailableQuantity = villagerExportAvailabilityByResource(settlement, steward);
  if (originAvailableQuantity.size === 0) return false;
  const candidates = settlementAnchorIndexForWorld(world).candidates;
  if (candidates.length < 2) return false;
  const probe = createCaravan({
    id: makeCaravanIdLocal(`villager-probe-${String(steward.id)}`),
    ownerActor: steward.id,
    position: settlement.anchor,
    destination: settlement.anchor,
    crew: [{ kind: 'drover', count: 1, weapons: 0, armor: 0 }],
    animals: { mule: VILLAGER_CARAVAN_MIN_PACK_ANIMALS },
    vehicles: { pack_saddle: 1 },
    treasury: Math.max(0, steward.treasury - VILLAGER_CARAVAN_MIN_OPERATING_TREASURY),
  });
  copyActorKnownPricesToCaravan(world, steward, probe, today);
  const plan = planCaravanRoute({
    caravan: probe,
    candidateSettlements: candidates,
    knownPrices: probe.priceBook,
    knownBanditDensity: new Map(),
    knownToll: () => 0,
    cargoConstraints: {
      maxSpendCoin: probe.treasury,
      reserveTripOperatingCost: true,
      originAvailableQuantity,
      destinationBidDepth: destinationBidDepthFromPriceBook(probe.priceBook),
    },
    minNetProfitCoin: CARAVAN_MIN_NET_PROFIT_COIN,
    minNetProfitFraction: CARAVAN_MIN_NET_PROFIT_FRACTION,
    includeReason: false,
    rng,
  });
  return plan !== null;
};

/**
 * Per docs/15 §C31: is it worth sending a villager caravan out THIS
 * cycle? Dispatch must be demand-backed: actual sellable surplus, an
 * import shortage learned at home before departure, or hard-times staple
 * need. Accumulated treasury alone is not demand. Known-price maps gate
 * obvious bad trips; if the steward has no non-home observations yet, a
 * surplus-backed trip may still scout because that is how it learns.
 */
const villageCaravanDemand = (
  world: WorldState,
  settlement: Settlement,
  steward: Actor,
  today: Day,
  rng: Rng,
): VillagerCaravanDemand | null => {
  const pop = settlement.population.total();
  if (pop <= 0) return null;
  const exportAvailability = villagerExportAvailabilityByResource(settlement, steward);
  const hasExportSurplus = exportAvailability.size > 0;
  const hasNonHomeObservation = hasFreshNonHomeMarketObservation(steward, settlement.id, today);
  const exportDemandViable =
    hasExportSurplus &&
    (!hasNonHomeObservation ||
      villagerKnownProfitableExportPlan(world, settlement, steward, today, rng.derive('export')));

  const importDemand = plannedVillagerImportDemand(settlement, steward);
  const importDemandViable =
    importDemand.size > 0 &&
    (exportDemandViable ||
      stewardCanAffordKnownImport(steward, settlement.id, today, importDemand));

  const grainStock = getStockAt(steward, settlement.id, resourceId('food.grain'));
  const grainDays = grainStock / Math.max(1, pop * 0.06);
  const hardTimesDemandViable =
    grainDays < 7 &&
    steward.treasury >= VILLAGER_CARAVAN_MIN_OPERATING_TREASURY &&
    (hasNonHomeObservation || hasExportSurplus);

  if (!exportDemandViable && !importDemandViable && !hardTimesDemandViable) return null;
  return { importDemand: importDemandViable ? importDemand : new Map() };
};

const eligibleVillagerCaravanOwners = (
  world: WorldState,
  activeByOwner: ReadonlyMap<ActorId, number>,
  today: Day,
  rng: Rng,
): { readonly actor: Actor; readonly settlement: Settlement; readonly demand: VillagerCaravanDemand }[] => {
  const out: { actor: Actor; settlement: Settlement; demand: VillagerCaravanDemand }[] = [];
  for (const actor of world.actors.values()) {
    // v1.7 cleanup (pass 29): hamlet_household actors at hamlet-tier
    // settlements also dispatch villager-style caravans. Per the 10y
    // burn-in report v1.7, hamlets showed 0 days of supply for nearly
    // every consumable - they had no outbound dispatch path so the
    // few that produced surplus couldn't sell it and the rest couldn't
    // buy what they needed. Same villager-caravan machinery, smaller
    // owner / settlement scale.
    if (actor.kind !== 'free_village' && actor.kind !== 'hamlet_household') continue;
    if ((activeByOwner.get(actor.id) ?? 0) >= VILLAGER_CARAVAN_OWNER_CAP) continue;
    if (actor.treasury < VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) continue;
    if (actor.homeSettlement === undefined) continue;
    const settlement = world.settlements.get(actor.homeSettlement);
    if (settlement === undefined) continue;
    if (settlement.tier !== 'village' && settlement.tier !== 'hamlet') continue;
    const demand = villageCaravanDemand(
      world,
      settlement,
      actor,
      today,
      rng.derive(String(actor.id)),
    );
    if (demand === null) continue;
    out.push({ actor, settlement, demand });
  }
  // Stable order: deterministic by id; shuffled later when picking the
  // dispatch slice.
  out.sort((a, b) => String(a.actor.id).localeCompare(String(b.actor.id)));
  return out;
};

const createVillagerCaravan = (
  world: WorldState,
  today: Day,
  owner: Actor,
  origin: Settlement,
  demand: VillagerCaravanDemand,
  rng: Rng,
  index: number,
  events: TickEvent[],
): Caravan | null => {
  // Allow the village to buy a small herd locally before assembling, just
  // like the merchant flow — but with a much smaller target.
  buyOwnerAssemblyStockAtLocalMarket(
    world,
    owner,
    origin,
    MERCHANT_CARAVAN_EQUINES_RESOURCE,
    VILLAGER_CARAVAN_PREFERRED_EQUINE_UNITS,
  );
  const availablePackAnimals = Math.floor(
    getStockAt(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE) * EQUINE_ANIMALS_PER_HERD_UNIT,
  );
  if (availablePackAnimals < VILLAGER_CARAVAN_MIN_PACK_ANIMALS) return null;
  let muleCount = rng.int(2, 4);
  let donkeyCount = rng.int(0, 1);
  while (muleCount + donkeyCount > availablePackAnimals) {
    if (donkeyCount > 0) donkeyCount -= 1;
    else muleCount -= 1;
  }
  if (muleCount < VILLAGER_CARAVAN_MIN_PACK_ANIMALS) return null;
  const equineUnitsNeeded = (muleCount + donkeyCount) / EQUINE_ANIMALS_PER_HERD_UNIT;
  // Per docs/15 §C31: scale operating treasury with the village's coin
  // reserves so import trips + hard-times resupply can actually fund
  // meaningful purchases at the city. Lower bound keeps the trip funded;
  // upper bound is randomized but capped at what the village can afford
  // while still keeping a small reserve at home.
  const stewardReserveFloor = VILLAGER_CARAVAN_MIN_OPERATING_TREASURY;
  const spendable = Math.max(0, owner.treasury - stewardReserveFloor);
  const operatingTreasury = Math.min(spendable, rng.int(50, 250));
  if (operatingTreasury < VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) return null;
  const tag = Math.floor(rng.next() * 1_000_000_000);
  const caravan = createCaravan({
    id: makeCaravanIdLocal(
      `${VILLAGER_CARAVAN_PREFIX}${today}-${index}-${String(owner.id)}-${tag}`,
    ),
    ownerActor: owner.id,
    position: { q: origin.anchor.q, r: origin.anchor.r },
    destination: { q: origin.anchor.q, r: origin.anchor.r },
    // Minimal crew: a driver and a single guard. No merchant — the village
    // headman / steward is back at the granary. Demographics drawn from
    // the origin village's pool per docs/06 §"Crew demographics".
    crew: (() => {
      const villagerRng = rng.derive(`villager-crew-${String(owner.id)}-${tag}`);
      return [
        {
          kind: 'drover' as const,
          count: 1,
          weapons: 0.1,
          armor: 0.05,
          demographics: drawDemographicsFromPool(
            origin.population,
            1,
            ROLE_BIASES.caravan_drover,
            villagerRng.derive('drover'),
          ),
        },
        {
          kind: 'caravan_guard' as const,
          count: 1,
          weapons: 0.4,
          armor: 0.2,
          demographics: drawDemographicsFromPool(
            origin.population,
            1,
            ROLE_BIASES.caravan_guard,
            villagerRng.derive('guard'),
          ),
        },
      ];
    })(),
    animals: { mule: muleCount, donkey: donkeyCount },
    vehicles: { pack_saddle: 1 },
    treasury: operatingTreasury,
    originSettlement: origin.id,
  });
  copyActorKnownPricesToCaravan(world, owner, caravan, today);
  if (demand.importDemand.size > 0) caravan.importDemand = new Map(demand.importDemand);
  if (!world.grid.has(caravan.position)) return null;
  const minStarterRationKg =
    dailyCarriedFoodReserveKg(caravan) * VILLAGER_CARAVAN_MIN_STARTER_RATION_DAYS;
  if (
    estimateLocalRationPurchaseKg(world, caravan, [origin], operatingTreasury) < minStarterRationKg
  ) {
    return null;
  }
  decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE, equineUnitsNeeded);
  subtractCoin(owner, operatingTreasury);
  buyCaravanRationsAtLocalMarkets(world, caravan, [origin], events);
  return caravan;
};

export const villagerCaravanAssemblyPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (today % VILLAGER_CARAVAN_ASSEMBLY_INTERVAL_DAYS !== 0) return;
  const activeByOwner = villagerCaravanCountByOwner(world);
  const eligible = rng.shuffle(eligibleVillagerCaravanOwners(world, activeByOwner, today, rng));
  if (eligible.length === 0) return;
  let dispatched = 0;
  for (let i = 0; i < eligible.length; i++) {
    const slot = eligible[i];
    if (slot === undefined) continue;
    const currentForOwner = activeByOwner.get(slot.actor.id) ?? 0;
    if (currentForOwner >= VILLAGER_CARAVAN_OWNER_CAP) continue;
    const caravan = createVillagerCaravan(
      world,
      today,
      slot.actor,
      slot.settlement,
      slot.demand,
      rng.derive(`dispatch-${i}`),
      dispatched,
      events,
    );
    if (caravan === null) continue;
    world.caravans.set(caravan.id, caravan);
    activeByOwner.set(slot.actor.id, currentForOwner + 1);
    dispatched += 1;
    events.push({
      type: 'villager_caravan_dispatched',
      caravan: caravan.id,
      settlement: slot.settlement.id,
      ownerActor: slot.actor.id,
    });
  }
};

const knownBanditDensityForCaravans = (world: WorldState): Map<string, number> => {
  const out = new Map<string, number>();
  if (world.banditCamps === undefined) return out;
  for (const camp of world.banditCamps.values()) {
    if (camp.banditCount <= 0) continue;
    const perHexRisk = Math.min(0.08, camp.banditCount / 5_000);
    if (perHexRisk <= 0) continue;
    for (const h of hexesWithinRange(camp.hex, 6)) {
      const key = hexKey(h);
      out.set(key, Math.max(out.get(key) ?? 0, perHexRisk));
    }
  }
  return out;
};

const LOW_RISK_SCOUT_WINDOW = 0.015;
const LOW_RATION_RISK_PENALTY_HEXES = 24;
const SCOUT_NEAR_DISTANCE_WINDOW_HEXES = 6;

type RouteRiskLookup = (from: Hex, to: Hex) => number;
const ROUTE_RISK_KEY_OFFSET = 32768;
const routeRiskCoordKey = (h: Hex): number =>
  (((h.q + ROUTE_RISK_KEY_OFFSET) << 16) | (h.r + ROUTE_RISK_KEY_OFFSET)) >>> 0;

const fallbackScoutCandidate = (
  from: Hex,
  candidates: readonly {
    readonly id: SettlementId;
    readonly hex: Hex;
    readonly tier: Settlement['tier'];
  }[],
  routeRisk: RouteRiskLookup,
  rationDays: number,
  rng: Rng,
):
  | {
      readonly id: SettlementId;
      readonly hex: Hex;
      readonly tier: Settlement['tier'];
    }
  | undefined => {
  if (rationDays < 7) {
    let best:
      | {
          readonly candidate: (typeof candidates)[number];
          readonly distance: number;
          readonly risk: number;
          readonly score: number;
        }
      | undefined;
    for (const candidate of candidates) {
      if (hexEquals(candidate.hex, from)) continue;
      const distance = hexDistance(from, candidate.hex);
      const risk = routeRisk(from, candidate.hex);
      const score = distance + risk * LOW_RATION_RISK_PENALTY_HEXES;
      if (
        best === undefined ||
        score < best.score ||
        (score === best.score && distance < best.distance) ||
        (score === best.score && distance === best.distance && risk < best.risk) ||
        (score === best.score &&
          distance === best.distance &&
          risk === best.risk &&
          String(candidate.id).localeCompare(String(best.candidate.id)) < 0)
      ) {
        best = { candidate, distance, risk, score };
      }
    }
    return best?.candidate;
  }

  let minRisk = Infinity;
  for (const candidate of candidates) {
    if (hexEquals(candidate.hex, from)) continue;
    minRisk = Math.min(minRisk, routeRisk(from, candidate.hex));
  }
  if (!Number.isFinite(minRisk)) return undefined;

  let nearest = Infinity;
  for (const candidate of candidates) {
    if (hexEquals(candidate.hex, from)) continue;
    const risk = routeRisk(from, candidate.hex);
    if (risk <= minRisk + LOW_RISK_SCOUT_WINDOW) {
      nearest = Math.min(nearest, hexDistance(from, candidate.hex));
    }
  }
  const reasonable: Array<{
    readonly candidate: (typeof candidates)[number];
    readonly distance: number;
    readonly risk: number;
  }> = [];
  for (const candidate of candidates) {
    if (hexEquals(candidate.hex, from)) continue;
    const risk = routeRisk(from, candidate.hex);
    if (risk > minRisk + LOW_RISK_SCOUT_WINDOW) continue;
    const distance = hexDistance(from, candidate.hex);
    if (distance <= nearest + SCOUT_NEAR_DISTANCE_WINDOW_HEXES) {
      reasonable.push({ candidate, distance, risk });
    }
  }
  reasonable.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.risk !== b.risk) return a.risk - b.risk;
    return String(a.candidate.id).localeCompare(String(b.candidate.id));
  });
  return rng.pick(reasonable).candidate;
};

const routeOffMapImportHomeIfDelivered = (
  _world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  edgeHexKeys: ReadonlySet<string>,
): boolean => {
  if (!isEdgeHubImportCaravan(caravan)) return false;
  const homeGate = edgeHubHomeGateForCaravan(caravan, edgeHexKeys);
  if (homeGate === null) return false;

  // Per docs/06 §"Edge-hub inbound visits" + docs/10 decision 45 (v1.9):
  // before heading back to the edge, evaluate whether to load profitable
  // return cargo. The arbitrage uses local ask vs the off-map reference
  // price net of return transport cost. The pre-v1.9 free-consignment
  // path was a coin-neutral resource leak (factor received free
  // inventory); this version makes the foreign merchant *pay* for what
  // they take out.
  buyReturnCargoForOffMapExport(caravan, settlements, homeGate);

  caravan.destination = { q: homeGate.q, r: homeGate.r };
  caravan.goalStack = [{ type: 'return_home', home: { q: homeGate.q, r: homeGate.r } }];
  return true;
};

interface MarketObservationAccumulator {
  priceSum: number;
  priceCount: number;
  bidSum: number;
  bidCount: number;
  askSum: number;
  askCount: number;
  bidDepth: number;
  askDepth: number;
}

const observedMarketResources = (settlement: Settlement): Set<ResourceId> => {
  const out = new Set<ResourceId>();
  for (const r of settlement.market.lastClearingPrice.keys()) out.add(r);
  for (const r of settlement.market.midPrice.keys()) out.add(r);
  for (const r of settlement.market.bestBid.keys()) out.add(r);
  for (const r of settlement.market.bestAsk.keys()) out.add(r);
  return out;
};

const representativeObservedPrice = (settlement: Settlement, resource: ResourceId): number => {
  const mid = settlement.market.midPrice.get(resource);
  if (mid !== undefined && Number.isFinite(mid) && mid > 0) return mid;
  const last = settlement.market.lastClearingPrice.get(resource);
  if (last !== undefined && Number.isFinite(last) && last > 0) return last;
  const bid = settlement.market.bestBid.get(resource);
  const ask = settlement.market.bestAsk.get(resource);
  if (
    bid !== undefined &&
    ask !== undefined &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0
  ) {
    return Math.sqrt(bid * ask);
  }
  if (ask !== undefined && Number.isFinite(ask) && ask > 0) return ask;
  if (bid !== undefined && Number.isFinite(bid) && bid > 0) return bid;
  return 0;
};

const addSettlementMarketObservation = (
  acc: Map<ResourceId, MarketObservationAccumulator>,
  settlement: Settlement,
  resource: ResourceId,
): void => {
  const price = representativeObservedPrice(settlement, resource);
  if (!Number.isFinite(price) || price <= 0) return;
  let entry = acc.get(resource);
  if (entry === undefined) {
    entry = {
      priceSum: 0,
      priceCount: 0,
      bidSum: 0,
      bidCount: 0,
      askSum: 0,
      askCount: 0,
      bidDepth: 0,
      askDepth: 0,
    };
    acc.set(resource, entry);
  }
  entry.priceSum += price;
  entry.priceCount += 1;
  const bid = settlement.market.bestBid.get(resource);
  if (bid !== undefined && Number.isFinite(bid) && bid > 0) {
    entry.bidSum += bid;
    entry.bidCount += 1;
    entry.bidDepth += settlement.market.bidDepth.get(resource) ?? 0;
  }
  const ask = settlement.market.bestAsk.get(resource);
  if (ask !== undefined && Number.isFinite(ask) && ask > 0) {
    entry.askSum += ask;
    entry.askCount += 1;
    entry.askDepth += settlement.market.askDepth.get(resource) ?? 0;
  }
};

const averageObservedMarket = (
  entry: MarketObservationAccumulator,
  today: Day,
): PriceObservation => ({
  price: entry.priceSum / entry.priceCount,
  ...(entry.bidCount > 0 ? { bidPrice: entry.bidSum / entry.bidCount } : {}),
  ...(entry.askCount > 0 ? { askPrice: entry.askSum / entry.askCount } : {}),
  ...(entry.bidDepth > 0 ? { bidDepth: entry.bidDepth } : {}),
  ...(entry.askDepth > 0 ? { askDepth: entry.askDepth } : {}),
  observedOnDay: today,
});

/**
 * Per docs/15 §C25 + §C28: caravan profitability gate constants.
 *
 * `CARAVAN_MIN_NET_PROFIT_COIN`: absolute floor on net profit per trip,
 * representing the crew's reservation wages + capital opportunity cost
 * not fully captured by travelCost.
 *
 * `CARAVAN_MIN_NET_PROFIT_FRACTION`: fractional floor — netProfit must be
 * at least N× travelCost for the trip to be worth running. 0.05 means
 * "the trip needs to clear ~5% margin over its travel cost." Loosened
 * from 0.10 in §C28: 10% rejected too many marginal-but-real flows
 * and reduced inter-settlement food movement; 5% still rejects pure
 * noise trades.
 *
 * `CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS`: after this many
 * consecutive ticks the planner returned no profitable route, the
 * caravan disbands. Day-based (not stop-based) because the
 * stop-based variant produced fewer caravans + higher famine in
 * burn-in — long-trip caravans got too many "free" stops and
 * accumulated losses on marginal trades. The day-based count more
 * accurately reflects "this caravan has been bleeding resources
 * for over a month with nothing to show."
 */
const CARAVAN_MIN_NET_PROFIT_COIN = 5;
const CARAVAN_MIN_NET_PROFIT_FRACTION = 0.05;
const CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS = 45;

export const caravanReplanPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  const settlementIndex = settlementAnchorIndexForWorld(world);
  const candidates = settlementIndex.candidates;
  const edgeHexKeys = new Set(computeEdgeHexes(world.grid).map(hexKey));
  const knownBanditDensity = knownBanditDensityForCaravans(world);
  const routeRiskCache = new Map<number, Map<number, number>>();
  const routeRisk: RouteRiskLookup =
    knownBanditDensity.size === 0
      ? () => 0
      : (from, to) => {
          const fromKey = routeRiskCoordKey(from);
          const toKey = routeRiskCoordKey(to);
          let byDestination = routeRiskCache.get(fromKey);
          if (byDestination === undefined) {
            byDestination = new Map<number, number>();
            routeRiskCache.set(fromKey, byDestination);
          }
          const cached = byDestination.get(toKey);
          if (cached !== undefined) return cached;
          const risk = expectedRiskOnApproximatePath(knownBanditDensity, from, to);
          byDestination.set(toKey, risk);
          return risk;
        };
  // Build a city-anchor lookup once per phase for goal-completion checks.
  const settlementAnchorByCity = new Map<SettlementId, Hex>();
  for (const s of world.settlements.values()) settlementAnchorByCity.set(s.id, s.anchor);

  for (const [cId, c] of Array.from(world.caravans.entries())) {
    if (completeOffMapImportReturnIfArrived(world, cId, c, edgeHexKeys, events)) continue;
    if (completeOffMapExportIfArrived(world, cId, c, edgeHexKeys, today, events)) continue;

    // Per docs/15 §C18: if this caravan has a goalStack, advance it
    // BEFORE the legacy single-destination logic. When the top goal
    // completes, pop and adopt the next goal's implied destination.
    if (c.goalStack !== undefined && c.goalStack.length > 0) {
      while (c.goalStack.length > 0) {
        const top = peekGoal(c.goalStack) as Goal;
        if (!isGoalComplete(top, c.position, { settlementAnchorByCity })) break;
        popGoal(c.goalStack);
      }
      const next = peekGoal(c.goalStack);
      if (next !== undefined) {
        // Adopt the goal's implied destination so the existing movement
        // engine drives the caravan toward it. trade_at + return_home +
        // flee_to + move_to all imply a hex; escort + patrol use the
        // active route logic in the patrol/conflict layer.
        const dest = goalDestination(next, settlementAnchorByCity);
        if (dest !== null) c.destination = dest;
      }
    }
    if (c.destination === null) continue;
    if (!hexEquals(c.position, c.destination)) continue; // not yet arrived

    const localBucket = settlementIndex.byAnchorHex.get(hexKey(c.position));
    if (completeTaxShipmentIfArrived(world, cId, c, localBucket === undefined ? [] : localBucket)) {
      continue;
    }

    // 1. Record observed local prices into caravan's price book. The
    // priceBook key is the hex (the merchant remembers "this is what
    // bread cost in town X"); when multiple settlements share a hex we
    // average their clearing prices for each resource so the order in
    // which settlements were inserted into world.settlements does not
    // change what the caravan remembers.
    if (localBucket !== undefined && localBucket.length > 0) {
      const observedByResource = new Map<ResourceId, MarketObservationAccumulator>();
      for (const local of localBucket) {
        for (const resource of observedMarketResources(local)) {
          addSettlementMarketObservation(observedByResource, local, resource);
        }
      }
      for (const [resource, entry] of observedByResource) {
        if (entry.priceCount === 0) continue;
        let book = c.priceBook.get(resource);
        if (book === undefined) {
          book = new Map<string, PriceObservation>();
          c.priceBook.set(resource, book);
        }
        book.set(`${c.position.q},${c.position.r}`, averageObservedMarket(entry, today));
      }
      unloadVillagerCaravanCargoAtHome(world, c, localBucket, events);
      sellCaravanCargoAtLocalMarkets(world, c, localBucket, events);
      buyCaravanRationsAtLocalMarkets(world, c, localBucket, events);
      if (routeOffMapImportHomeIfDelivered(world, c, localBucket, edgeHexKeys)) continue;
      if (buyVillagerPlannedImports(world, c, localBucket, events)) continue;
      remitStandingCaravanProfitAtHome(world, c, localBucket, events);
    }

    // Per docs/15 §C17: deposit observations into the local guild's
    // ledger if the caravan owner is a member of any guild. Read the
    // freshest collective observations BACK into the priceBook so the
    // departing caravan inherits other members' recent intel.
    syncCaravanWithLocalGuild(world, c, today);

    if (candidates.length < 2) continue;

    const originAvailability =
      localBucket === undefined ? undefined : localSupplyAvailabilityByResource(world, localBucket);
    const missingRationKg = caravanMissingRationReserveKg(c);
    // Per docs/15 §C22 + C19: cap expected destination volume from the
    // caravan's own observed bid-depth book. Do not read the current remote
    // market book here; the caravan only knows markets it has learned about.
    // 2. Plan next route.
    // Per docs/15 §C25: require a meaningful margin, not just netProfit>0.
    // CARAVAN_MIN_NET_PROFIT_COIN sets an absolute floor representing the
    // crew's reservation wages + opportunity cost; the fractional floor
    // says "the trip has to pay back at least N× its travel cost". A
    // route that nets 0.5 coin over a 200-coin trip isn't worth running.
    const plan = planCaravanRoute({
      caravan: c,
      candidateSettlements: candidates,
      knownPrices: c.priceBook,
      knownBanditDensity,
      expectedRiskForRoute: routeRisk,
      knownToll: () => 0, // v1: no toll signal yet
      cargoConstraints: {
        reserveCapacityKg: missingRationKg,
        // Keep enough cash to buy the missing survival reserve later. This
        // uses the same 1 coin/kg ration-cost approximation as the planner's
        // travel-cost model, so cargo demand is cash-feasible instead of
        // spending the caravan into starvation.
        maxSpendCoin: Math.max(0, c.treasury - missingRationKg),
        reserveTripOperatingCost: true,
        ...(originAvailability !== undefined
          ? { originAvailableQuantity: originAvailability }
          : {}),
        destinationBidDepth: destinationBidDepthFromPriceBook(c.priceBook),
      },
      minNetProfitCoin: CARAVAN_MIN_NET_PROFIT_COIN,
      minNetProfitFraction: CARAVAN_MIN_NET_PROFIT_FRACTION,
      includeReason: false,
      rng: rng.derive(String(cId)),
    });

    if (plan !== null) {
      // Per docs/15 §C25: a profitable plan resets the no-profit counter.
      c.noProfitableRouteDays = 0;
      const boughtUnits =
        localBucket === undefined
          ? 0
          : buyPlannedCargoAtLocalMarkets(world, c, localBucket, plan.cargoToCarry, events);
      const rationDays = caravanRationDays(c);
      if (boughtUnits < 1 && !caravanHasMarketCargo(c)) {
        const rngHere = rng.derive(`${String(cId)}-fallback`);
        const fallback = fallbackScoutCandidate(
          c.position,
          candidates,
          routeRisk,
          rationDays,
          rngHere,
        );
        if (fallback === undefined) continue;
        c.destination = { q: fallback.hex.q, r: fallback.hex.r };
        continue;
      }
      if (rationDays + 1e-9 < plan.estimatedDays) {
        const fallback = fallbackScoutCandidate(
          c.position,
          candidates,
          routeRisk,
          0,
          rng.derive(`${String(cId)}-ration-fallback`),
        );
        if (fallback === undefined) continue;
        c.destination = { q: fallback.hex.q, r: fallback.hex.r };
        continue;
      }
      // Set new destination. Cargo isn't restocked here (that's a market
      // operation handled above); the planner's expected profit reflects
      // what it expects to be able to load.
      c.destination = plan.destination;
    } else {
      // Per docs/15 §C25: no profitable plan available. Bump the
      // no-profit counter (day-based); if it crosses the disband
      // threshold, dissolve the caravan instead of pointlessly
      // scouting forever. §C28 experimented with a stop-based
      // counter but it produced fewer caravans + higher famine —
      // the day-based count more reliably catches caravans that
      // bleed resources without finding a route.
      c.noProfitableRouteDays = (c.noProfitableRouteDays ?? 0) + 1;
      if (c.noProfitableRouteDays >= CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS) {
        disbandUnprofitableCaravan(world, cId, c, today, events);
        continue;
      }
      // Below threshold — fall back to "scout to a random different
      // settlement" so the caravan keeps accumulating price observations.
      // This is what unspecialized merchants did historically: travel to
      // gossip and find out where prices are good.
      const rationDays = caravanRationDays(c);
      const fallback = fallbackScoutCandidate(
        c.position,
        candidates,
        routeRisk,
        rationDays,
        rng.derive(`${String(cId)}-fallback`),
      );
      if (fallback === undefined) continue;
      c.destination = { q: fallback.hex.q, r: fallback.hex.r };
    }
  }
};

/**
 * Per docs/15 §C25 + §C28: disband a caravan that hasn't found a
 * profitable route after `CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS`
 * consecutive ticks of failed planning. Emits a `caravan_disbanded`
 * event with reason `'unprofitable'`.
 */
const disbandUnprofitableCaravan = (
  world: WorldState,
  cId: CaravanId,
  c: Caravan,
  today: Day,
  events: TickEvent[],
): void => {
  refundCaravanToOwner(world, c);
  world.caravans.delete(cId);
  events.push({
    type: 'caravan_disbanded',
    caravan: cId,
    at: { q: c.position.q, r: c.position.r },
    reason: 'unprofitable',
  });
  void today;
};

/**
 * Shared helper: return a disbanded caravan's treasury + cargo +
 * livestock + carts to the owner's stockpile/treasury. The crew
 * demographics are intentionally dropped on the floor for now —
 * re-feeding them into the home settlement's population pool is a
 * follow-up (it requires the crew-demographics → population integration
 * described in docs/06).
 */
const refundCaravanToOwner = (world: WorldState, c: Caravan): void => {
  const owner = world.actors.get(c.ownerActor);
  if (owner === undefined) return;
  addCoin(owner, Math.max(0, c.treasury));
  c.treasury = 0;
  // Cargo + livestock + carts refund to the owner's slice at their home
  // settlement (per docs/15 §C30 — inventory must land at a specific
  // settlement). Off-map owners with no homeSettlement just lose the
  // physical assets; their treasury is already refunded above.
  const refundSettlement = owner.homeSettlement;
  if (refundSettlement === undefined) {
    c.cargo.clear();
    return;
  }
  for (const [resource, qty] of c.cargo) {
    if (qty > 0) increaseStockpile(owner, refundSettlement, resource, qty);
  }
  c.cargo.clear();
  const equineResource = resourceId('livestock.equines');
  const cartResource = resourceId('goods.cart');
  let equineUnits = 0;
  for (const k of Object.keys(c.animals) as (keyof typeof c.animals)[]) {
    const n = c.animals[k] ?? 0;
    if (n > 0) equineUnits += n;
  }
  if (equineUnits > 0) {
    // ~6 pack animals per herd unit (matches procgen's
    // transport-capital convention).
    const herdUnits = equineUnits / 6;
    if (herdUnits > 0) increaseStockpile(owner, refundSettlement, equineResource, herdUnits);
  }
  let cartUnits = 0;
  for (const k of Object.keys(c.vehicles) as (keyof typeof c.vehicles)[]) {
    const n = c.vehicles[k] ?? 0;
    if (n > 0) cartUnits += n;
  }
  if (cartUnits > 0) increaseStockpile(owner, refundSettlement, cartResource, cartUnits);
};
