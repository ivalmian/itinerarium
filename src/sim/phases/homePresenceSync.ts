/**
 * Resident-presence sync (docs/06 §"All knowledge comes from syncs",
 * docs/08 §"Update channels", docs/10 decision 38).
 *
 * Every tick, after the day's market clearings have landed in each
 * settlement's `lastClearingPrice` book, every actor that
 * physically lives at a settlement records a fresh
 * `MarketObservation` of that settlement into its `knownPrices`
 * map, stamped to today. Not a magical channel — it's literally
 * "I live here, I see the forum prices today."
 *
 * Resident actor kinds (anchored to a single settlement, present
 * there every tick): patrician_family, free_village,
 * hamlet_household, plebeian/freedman/foreigner_household,
 * governor_office, temple, city_corporation, merchant_guild.
 *
 * Non-resident kinds skip this phase — they only learn through
 * arrival/meeting syncs (Phase 23) or by virtue of being mobile.
 */

import { ACTOR_KINDS, type Actor, type ActorKind } from '../politics/actor.js';
import {
  recordMarketObservation,
  type MarketObservation,
  type ResourceQuote,
} from '../politics/knownPrices.js';
import type { Day, ResourceId } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';

/**
 * Actor kinds whose "home presence at the settlement" is a real
 * daily fact. Bandit camps, caravan owners (mobile by definition),
 * the player (location varies), and off-map houses (off-map) are
 * NOT resident.
 */
const RESIDENT_KINDS: ReadonlySet<ActorKind> = new Set<ActorKind>([
  'patrician_family',
  'free_village',
  'plebeian_household',
  'freedman_household',
  'foreigner_household',
  'hamlet_household',
  'governor_office',
  'temple',
  'city_corporation',
  'merchant_guild',
]);

// Sanity guard so future enum members don't silently skip the sync.
for (const k of ACTOR_KINDS) {
  void k;
}

/**
 * Snapshot a settlement's current market state into a fresh
 * MarketObservation stamped to `today`. Reads from
 * `settlement.market.lastClearingPrice` (the post-clearing book),
 * pairing each price with the matching bestBid/bestAsk if present.
 *
 * A settlement with no clearings yet today produces an empty-quotes
 * observation; callers may choose to skip writing it (we don't —
 * an empty observation is still a fact: "I was here today and
 * nothing traded").
 */
export const snapshotSettlementMarket = (
  settlement: Settlement,
  today: Day,
): MarketObservation => {
  const quotes = new Map<ResourceId, ResourceQuote>();
  const lastPrice = settlement.market.lastClearingPrice;
  const bestAskBook = settlement.market.bestAsk;
  const bestBidBook = settlement.market.bestBid;
  for (const [resource, price] of lastPrice) {
    const bestAsk = bestAskBook.get(resource) ?? price;
    const bestBid = bestBidBook.get(resource) ?? price;
    quotes.set(resource, { bestAsk, bestBid });
  }
  return { quotes, observedDay: today };
};

/**
 * Per-tick resident-presence sync. For every actor whose kind is
 * resident AND has a home settlement, write the current market
 * snapshot of that settlement into the actor's knownPrices map.
 *
 * Runs once per tick, after tradePhase. Idempotent within a tick:
 * recordMarketObservation respects the newer-day-wins rule, so
 * re-running on the same day overwrites cleanly.
 */
export const homePresenceSyncPhase = (world: WorldState, today: Day): void => {
  for (const actor of world.actors.values()) {
    if (!RESIDENT_KINDS.has(actor.kind)) continue;
    if (actor.homeSettlement === undefined) continue;
    const settlement = world.settlements.get(actor.homeSettlement);
    if (settlement === undefined) continue;
    const obs = snapshotSettlementMarket(settlement, today);
    if (obs.quotes.size === 0) continue;
    recordMarketObservation(actor as Actor, actor.homeSettlement, obs);
  }
};
