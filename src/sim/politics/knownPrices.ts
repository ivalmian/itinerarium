/**
 * Per-actor information-asymmetric price map (docs/06 §"Caravan
 * information model", docs/08 §"Information", docs/10 decision 38).
 *
 * Each Actor remembers one **MarketObservation per settlement** —
 * the whole-ladder bid/ask snapshot they last saw there, stamped
 * with the day it was taken. Granularity is per-(actor, settlement),
 * NOT per-resource: if you walked to a city you saw the whole
 * market for one day, you didn't see ten unrelated per-resource
 * events.
 *
 * All knowledge enters the map through physical sync events
 * (docs/06 §"All knowledge comes from syncs"):
 *
 *   - Resident-presence sync: actors at home observe home daily.
 *   - Arrival sync: a unit reaching a settlement records its
 *     market state for the unit's owner.
 *   - Meeting sync (piggyback): two friendly units in the same hex
 *     or same settlement on the same day merge each other's maps.
 *   - Guild ledger: a guild is itself a resident actor; visits
 *     run as meeting syncs against its map.
 *   - Edge-hex observation: a caravan at an edge hex records the
 *     global reference palette.
 *
 * Merge rule: for each settlement, newer `observedDay` wins
 * atomically. The older snapshot — and every quote in it — is
 * discarded. There is no per-resource merge. No source field, no
 * provenance tracking; only the day matters.
 *
 * Observations older than KNOWN_PRICE_MAX_AGE_DAYS are treated as
 * missing on read. No deception channel — all observations are
 * authoritative; hostile actors withhold sync, they don't lie.
 */

import type { Day, ResourceId, SettlementId } from '../types.js';
import type { Actor } from './actor.js';

/** One side of the book for one resource at one settlement, one day. */
export interface ResourceQuote {
  readonly bestAsk: number;
  readonly bestBid: number;
}

/**
 * The whole-market snapshot of one settlement as seen on
 * `observedDay`. Resources whose market didn't clear that day
 * simply aren't in `quotes`; the actor's knowledge of those
 * resources at this settlement is "unknown" until a fresher
 * observation arrives.
 */
export interface MarketObservation {
  readonly quotes: Map<ResourceId, ResourceQuote>;
  readonly observedDay: Day;
}

/** Observations older than this many days are dropped on read. */
export const KNOWN_PRICE_MAX_AGE_DAYS = 180;

/**
 * Per-actor map: settlement → its last observed market snapshot.
 */
export type KnownPrices = Map<SettlementId, MarketObservation>;

/** Empty-but-valid KnownPrices for actor creation. */
export const createKnownPrices = (): KnownPrices => new Map();

/** True if `obs` is older than the max age relative to `today`. */
export const isMarketObservationStale = (obs: MarketObservation, today: Day): boolean => {
  return today - obs.observedDay > KNOWN_PRICE_MAX_AGE_DAYS;
};

/**
 * Read one observation if it exists AND is fresh. Returns undefined
 * for missing entries and for stale entries.
 */
export const getMarketObservation = (
  actor: Actor,
  settlement: SettlementId,
  today: Day,
): MarketObservation | undefined => {
  const obs = actor.knownPrices.get(settlement);
  if (obs === undefined) return undefined;
  if (isMarketObservationStale(obs, today)) return undefined;
  return obs;
};

/**
 * Read one resource quote if (a) we have a fresh observation for
 * the settlement AND (b) that observation includes the resource.
 */
export const getResourceQuote = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  today: Day,
): ResourceQuote | undefined => {
  const obs = getMarketObservation(actor, settlement, today);
  return obs?.quotes.get(resource);
};

/**
 * Write a settlement observation into the actor's map. The new
 * observation wins if its `observedDay` is >= the existing one's;
 * same-day overwrite is allowed so a later-arriving sync supersedes
 * an earlier one within the same tick. Strictly older observations
 * are ignored.
 */
export const recordMarketObservation = (
  actor: Actor,
  settlement: SettlementId,
  obs: MarketObservation,
): void => {
  const existing = actor.knownPrices.get(settlement);
  if (existing !== undefined && existing.observedDay > obs.observedDay) return;
  actor.knownPrices.set(settlement, obs);
};

/**
 * Merge `source`'s known-prices into `target`'s. For each
 * settlement, the snapshot with the higher `observedDay` wins
 * atomically. Used by piggyback/meeting syncs.
 */
export const mergeKnownPrices = (target: Actor, source: Actor): void => {
  for (const [s, obs] of source.knownPrices) {
    recordMarketObservation(target, s, obs);
  }
};

/**
 * Drop every observation older than the staleness threshold. Called
 * periodically (e.g. annual phase) to keep memory bounded; not
 * strictly required because reads filter stale entries.
 */
export const pruneStaleObservations = (actor: Actor, today: Day): void => {
  for (const [s, obs] of actor.knownPrices) {
    if (isMarketObservationStale(obs, today)) actor.knownPrices.delete(s);
  }
};

/**
 * Iterate (settlement, observation) over an actor's map, skipping
 * stale entries.
 */
export const iterFreshKnownPrices = function* (
  actor: Actor,
  today: Day,
): IterableIterator<readonly [SettlementId, MarketObservation]> {
  for (const [s, obs] of actor.knownPrices) {
    if (!isMarketObservationStale(obs, today)) yield [s, obs] as const;
  }
};
