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
 *   - **merchantCaravanAssemblyPhase** — every 7 days, patrician
 *     families / merchant houses replace lost long-haul caravans
 *     up to a per-world target derived from settlement count.
 *
 *   - **villagerCaravanAssemblyPhase** (docs/15 §C31) — every 14
 *     days, free villages with food surplus dispatch a handcart
 *     caravan to the nearest city. Separate fleet target from the
 *     merchant target so short-haul village→city food runs and
 *     long-haul trade don't compete for the same caravan slots.
 *
 *   - **caravanReplanPhase** — every tick, NPC caravans sitting at
 *     their destination observe local prices, restock their price
 *     book, and pick a new destination via the NPC AI; without this
 *     pass trade circulates exactly zero after the seeded caravans
 *     complete their first leg.
 *
 * Also includes the small `goalDestination` GoalStack lookup and
 * the `remainingWorldCaravanSlots` spawn-pressure cap — both used
 * exclusively inside the caravan cluster.
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
import { expectedRiskOnApproximatePath, planCaravanRoute } from '../caravan/ai.js';
import { isGoalComplete, peekGoal, popGoal, type Goal } from '../caravan/goal.js';
import { MAX_ACTIVE_WORLD_CARAVANS } from '../caravan/limits.js';
import { wholeUnitsForTransaction } from '../market/wholeUnits.js';
import { syncCaravanWithLocalGuild } from '../politics/guildLedger.js';
import { getStockAt, type Actor } from '../politics/actor.js';
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

// --- Caravan spawn pressure ------------------------------------------

const remainingWorldCaravanSlots = (world: WorldState, plannedSpawns = 0): number =>
  Math.max(0, MAX_ACTIVE_WORLD_CARAVANS - world.caravans.size - plannedSpawns);



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

/**
 * Per docs/15 §C22 + C19: collect each candidate destination's residual
 * bid depth (best-bid quantity) per resource so the caravan planner can
 * cap planned cargo at what the destination market can actually absorb.
 * Returns a Map keyed by `hexKey(candidate.hex)` → resource → quantity.
 * Candidates without quoted bids contribute no entry → the planner treats
 * those resources as effectively unlimited (it has no evidence either
 * way), preserving back-compat with fixtures that don't populate books.
 */
const buildDestinationBidDepthMap = (
  world: WorldState,
  candidates: readonly { readonly id: SettlementId; readonly hex: Hex }[],
): ReadonlyMap<string, ReadonlyMap<ResourceId, Quantity>> => {
  const out = new Map<string, Map<ResourceId, Quantity>>();
  for (const candidate of candidates) {
    const settlement = world.settlements.get(candidate.id);
    if (settlement === undefined) continue;
    const market = settlement.market;
    if (market.bidDepth.size === 0) continue;
    const byResource = new Map<ResourceId, Quantity>();
    for (const [resource, depth] of market.bidDepth) {
      if (Number.isFinite(depth) && depth > 0) byResource.set(resource, depth);
    }
    if (byResource.size > 0) out.set(hexKey(candidate.hex), byResource);
  }
  return out;
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
    caravan.treasury += coin;
    buyer.actor.treasury -= coin;
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
        caravan.treasury -= coin;
        seller.actor.treasury += coin;
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
      caravan.treasury -= coin;
      quote.seller.actor.treasury += coin;
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
  // Both standing merchant caravans (patrician/caravan_owner/off_map) and
  // villager caravans (free_village steward, docs/15 §C31) remit profit at
  // home. Edge-hub + tax caravans are excluded because their balance is
  // closed at the hub/capital, not at an owner's home.
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
  caravan.treasury -= coin;
  owner.treasury += coin;
  events.push({
    type: 'caravan_profit_remitted',
    caravan: caravan.id,
    ownerActor: owner.id,
    settlement: home.id,
    coin,
  });
  return coin;
};

const increaseCaravanCargo = (caravan: Caravan, resource: ResourceId, qty: Quantity): void => {
  if (qty <= 0) return;
  caravan.cargo.set(resource, (caravan.cargo.get(resource) ?? 0) + qty);
};

const completeOffMapExportIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
  events: TickEvent[],
): boolean => {
  if (String(caravan.id).startsWith('tax-')) return false;
  if (caravan.destination === null) return false;
  if (!hexEquals(caravan.position, caravan.destination)) return false;
  if (!edgeHexKeys.has(hexKey(caravan.position))) return false;
  let exportedAny = false;
  for (const [resource, rawQty] of Array.from(caravan.cargo.entries())) {
    const price = DEFAULT_GLOBAL_PRICES.get(resource);
    if (price === undefined || price <= 0 || rawQty <= 0) continue;
    // Whole-unit transaction (docs/08): off-map export crosses
    // ownership at the world's edge, so round to integer. Any
    // fractional residual stays in cargo for the next tick (the
    // caravan despawns when cargo.size === 0; a residual < 1 unit
    // is effectively spoilage / spillage).
    const qty = wholeUnitsForTransaction(resource, rawQty);
    if (qty <= 0) {
      caravan.cargo.delete(resource);
      continue;
    }
    const coin = qty * price;
    const owner = world.actors.get(caravan.ownerActor);
    if (owner !== undefined) owner.treasury += coin;
    else caravan.treasury += coin;
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
  if (exportedAny && caravan.cargo.size === 0) {
    world.caravans.delete(caravanId);
    return true;
  }
  return false;
};

const completeOffMapImportReturnIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
): boolean => {
  if (!isEdgeHubImportCaravan(caravan)) return false;
  if (caravan.destination === null) return false;
  const homeGate = edgeHubHomeGateForCaravan(caravan, edgeHexKeys);
  if (homeGate === null) return false;
  if (!hexEquals(caravan.position, homeGate) || !hexEquals(caravan.destination, homeGate)) {
    return false;
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

const importConsignmentFactor = (
  world: WorldState,
  settlements: readonly Settlement[],
  caravan: Caravan,
): { readonly settlement: Settlement; readonly actor: Actor } | null => {
  let fallback: { settlement: Settlement; actor: Actor } | null = null;
  for (const settlement of settlements) {
    for (const ownerId of settlement.stockpileOwners) {
      if (ownerId === caravan.ownerActor) continue;
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const candidate = { settlement, actor };
      if (actor.kind === 'city_corporation') return candidate;
      if (fallback === null || actor.kind === 'patrician_family') fallback = candidate;
    }
  }
  return fallback;
};

const consignOffMapImportCargo = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
): number => {
  const factor = importConsignmentFactor(world, settlements, caravan);
  if (factor === null) return 0;

  let consigned = 0;
  for (const [resource, currentQty] of Array.from(caravan.cargo.entries())) {
    const qty = caravanSellableQuantity(caravan, resource, currentQty);
    // Whole-unit transaction (docs/08): sub-1-unit cargo isn't consignable.
    if (qty < 1) continue;
    const remaining = currentQty - qty;
    if (remaining >= 1) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    increaseStockpile(factor.actor, factor.settlement.id, resource, qty);
    // Off-map factor consignment lands at this settlement: import.
    recordImport(factor.settlement, resource, qty);
    consigned += qty;
  }
  return consigned;
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
 * Per docs/15 §C31: villager caravans are short-haul village → city food
 * runs spawned by the village's `free_village` steward. Their ID carries
 * the `villager-` prefix so the viewer renders them with the dedicated
 * peasant-with-handcart glyph and so caravan-bookkeeping doesn't confuse
 * them with patron-owned long-haul merchant trains.
 */
const VILLAGER_CARAVAN_PREFIX = 'villager-';
const VILLAGER_CARAVAN_ASSEMBLY_INTERVAL_DAYS = 14;
const VILLAGER_CARAVAN_MAX_DISPATCHED_PER_INTERVAL = 4;
const VILLAGER_CARAVAN_TARGET_PER_VILLAGE = 0.5;
const VILLAGER_CARAVAN_TARGET_MAX = 120;
const VILLAGER_CARAVAN_OWNER_CAP = 1;
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
    if (
      actor.kind !== 'patrician_family' &&
      actor.kind !== 'caravan_owner' &&
      actor.kind !== 'off_map_house'
    ) {
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
    buyer.treasury -= coin;
    seller.actor.treasury += coin;
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
  owner.treasury -= operatingTreasury;
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
  const worldRoom = remainingWorldCaravanSlots(world);
  if (worldRoom <= 0) return;
  const activeByOwner = standingMerchantCaravanCountByOwner(world);
  const active = Array.from(activeByOwner.values()).reduce((sum, n) => sum + n, 0);
  const target = merchantCaravanTarget(world);
  if (active >= target) return;

  const eligible = rng.shuffle(eligibleMerchantCaravanOwners(world, activeByOwner));
  if (eligible.length === 0) return;
  const toDispatch = Math.min(
    MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL,
    target - active,
    worldRoom,
  );
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
 * caravans (which fill a separate fleet target).
 */
const villagerCaravanCountByOwner = (world: WorldState): Map<ActorId, number> => {
  const out = new Map<ActorId, number>();
  for (const caravan of world.caravans.values()) {
    if (!isVillagerCaravan(caravan)) continue;
    out.set(caravan.ownerActor, (out.get(caravan.ownerActor) ?? 0) + 1);
  }
  return out;
};

const villagerCaravanTarget = (world: WorldState): number => {
  // Roughly half the villages can have a villager caravan out at any time.
  let villageCount = 0;
  for (const s of world.settlements.values()) {
    if (s.tier === 'village') villageCount += 1;
  }
  const raw = Math.floor(villageCount * VILLAGER_CARAVAN_TARGET_PER_VILLAGE);
  return Math.max(0, Math.min(VILLAGER_CARAVAN_TARGET_MAX, raw));
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

/**
 * Per docs/15 §C31: enough treasury that a village steward could
 * realistically fund an import-only round-trip — fully-paid cart + 4-day
 * starter rations + city-side purchase of pots/oil/tools/salt to bring
 * home. Below this threshold the steward can't really afford an
 * import-driven trip; we still let the caravan launch on a surplus
 * trigger so it can earn coin on the way.
 */
const VILLAGER_CARAVAN_IMPORT_TRIP_MIN_TREASURY = 200;

/**
 * Per docs/15 §C31: is it worth sending a villager caravan out THIS
 * cycle? Three Roman village-to-city motivations:
 *  1. Surplus run — the village has any meaningful exportable inventory
 *     (food, fibre, wood, livestock, cloth) above a small per-capita
 *     threshold. The caravan carries it to the city, returns with coin
 *     and/or city goods.
 *  2. Import trip — the village has accumulated treasury and wants to
 *     buy what it can't make itself (oil, wine, salt, pottery, tools).
 *  3. Hard-times resupply — the village's own subsistence stocks are
 *     critically low AND it has any cash, so the steward drains some
 *     treasury and sends the caravan to buy back food/staples from the
 *     city.
 *
 * Each case is a "yes, dispatch a caravan" — the planner picks the
 * cargo + direction once the caravan exists.
 */
const villageWantsCaravan = (settlement: Settlement, steward: Actor): boolean => {
  const pop = settlement.population.total();
  if (pop <= 0) return false;
  // Case 1: any exportable above a small per-capita day threshold.
  for (const r of VILLAGER_EXPORTABLE_RESOURCES) {
    const stock = getStockAt(steward, settlement.id, r);
    if (stock <= 0) continue;
    // Loose threshold: stock equivalent to ≥ N days of the village's own
    // subsistence-style consumption of that resource. Per-resource rate
    // varies, but 0.02/adult/day is a safe lower bound across the list
    // (grain alone is 0.06; bulky materials less). The planner makes the
    // tight cargo decision; this is just a "do you have meaningful
    // inventory?" filter.
    const daysOfLocalUse = stock / Math.max(1, pop * 0.02);
    if (daysOfLocalUse >= VILLAGER_CARAVAN_SURPLUS_DAYS_THRESHOLD) return true;
  }
  // Case 2: import trip — steward has accumulated coin and wants
  // city-made goods. Even with empty granary, this funds a "go buy us
  // something useful" run.
  if (steward.treasury >= VILLAGER_CARAVAN_IMPORT_TRIP_MIN_TREASURY) return true;
  // Case 3: hard-times resupply — village grain stock under 7 days of
  // subsistence AND steward has any cash to spend. Caravan goes to city
  // and buys staples back.
  const grainStock = getStockAt(steward, settlement.id, resourceId('food.grain'));
  const grainDays = grainStock / Math.max(1, pop * 0.06);
  if (grainDays < 7 && steward.treasury >= VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) return true;
  return false;
};

const eligibleVillagerCaravanOwners = (
  world: WorldState,
  activeByOwner: ReadonlyMap<ActorId, number>,
): { readonly actor: Actor; readonly settlement: Settlement }[] => {
  const out: { actor: Actor; settlement: Settlement }[] = [];
  for (const actor of world.actors.values()) {
    if (actor.kind !== 'free_village') continue;
    if ((activeByOwner.get(actor.id) ?? 0) >= VILLAGER_CARAVAN_OWNER_CAP) continue;
    if (actor.treasury < VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) continue;
    if (actor.homeSettlement === undefined) continue;
    const settlement = world.settlements.get(actor.homeSettlement);
    if (settlement === undefined) continue;
    if (settlement.tier !== 'village') continue;
    if (!villageWantsCaravan(settlement, actor)) continue;
    out.push({ actor, settlement });
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
  });
  if (!world.grid.has(caravan.position)) return null;
  const minStarterRationKg =
    dailyCarriedFoodReserveKg(caravan) * VILLAGER_CARAVAN_MIN_STARTER_RATION_DAYS;
  if (
    estimateLocalRationPurchaseKg(world, caravan, [origin], operatingTreasury) < minStarterRationKg
  ) {
    return null;
  }
  decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE, equineUnitsNeeded);
  owner.treasury -= operatingTreasury;
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
  const worldRoom = remainingWorldCaravanSlots(world);
  if (worldRoom <= 0) return;
  const activeByOwner = villagerCaravanCountByOwner(world);
  const active = Array.from(activeByOwner.values()).reduce((sum, n) => sum + n, 0);
  const target = villagerCaravanTarget(world);
  if (active >= target) return;

  const eligible = rng.shuffle(eligibleVillagerCaravanOwners(world, activeByOwner));
  if (eligible.length === 0) return;
  const toDispatch = Math.min(
    VILLAGER_CARAVAN_MAX_DISPATCHED_PER_INTERVAL,
    target - active,
    worldRoom,
  );
  let dispatched = 0;
  for (let i = 0; i < eligible.length && dispatched < toDispatch; i++) {
    const slot = eligible[i];
    if (slot === undefined) continue;
    const currentForOwner = activeByOwner.get(slot.actor.id) ?? 0;
    if (currentForOwner >= VILLAGER_CARAVAN_OWNER_CAP) continue;
    const caravan = createVillagerCaravan(
      world,
      today,
      slot.actor,
      slot.settlement,
      rng.derive(`villager-dispatch-${i}`),
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
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  edgeHexKeys: ReadonlySet<string>,
): boolean => {
  if (!isEdgeHubImportCaravan(caravan)) return false;
  const homeGate = edgeHubHomeGateForCaravan(caravan, edgeHexKeys);
  if (homeGate === null) return false;

  // If local buyers could not absorb the cargo with immediate cash, consign
  // the remainder to a local factor. The goods are still physically present
  // in a city stockpile, but the off-map convoy does not become permanent
  // provincial rolling storage.
  consignOffMapImportCargo(world, caravan, settlements);

  if (caravanHasMarketCargo(caravan)) {
    caravan.destination = { q: caravan.position.q, r: caravan.position.r };
    return true;
  }

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
  // Market bid-depth books are produced in the trade phase and are not
  // mutated by caravan replan cargo transfers, so one phase-level snapshot is
  // equivalent to rebuilding it for every arrived caravan.
  const destinationBidDepth = buildDestinationBidDepthMap(world, candidates);

  // Build a city-anchor lookup once per phase for goal-completion checks.
  const settlementAnchorByCity = new Map<SettlementId, Hex>();
  for (const s of world.settlements.values()) settlementAnchorByCity.set(s.id, s.anchor);

  for (const [cId, c] of Array.from(world.caravans.entries())) {
    if (completeOffMapImportReturnIfArrived(world, cId, c, edgeHexKeys)) continue;
    if (completeOffMapExportIfArrived(world, cId, c, edgeHexKeys, events)) continue;

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
      sellCaravanCargoAtLocalMarkets(world, c, localBucket, events);
      buyCaravanRationsAtLocalMarkets(world, c, localBucket, events);
      if (routeOffMapImportHomeIfDelivered(world, c, localBucket, edgeHexKeys)) continue;
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
    // Per docs/15 §C22 + C19: pre-build a destination → resource → bid
    // depth map for the candidates so the planner can cap cargo at what
    // each destination market can actually absorb. Without this the
    // planner over-loads goods that won't clear on arrival.
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
        destinationBidDepth,
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
  owner.treasury += Math.max(0, c.treasury);
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

