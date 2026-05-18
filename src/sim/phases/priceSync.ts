/**
 * Mobile-unit price syncs (docs/06 §"All knowledge comes from syncs",
 * docs/08 §"Update channels", docs/10 decision 38, docs/13
 * §"News-carrier price piggyback").
 *
 * Three syncs run each tick after the day's markets clear:
 *
 *   1. Caravan arrival sync — every caravan whose position matches
 *      a settlement anchor writes a fresh MarketObservation of that
 *      settlement into the **owner's** knownPrices map. This is the
 *      "I just got to town and saw the prices" channel.
 *
 *   2. Caravan meeting sync (piggyback) — every pair of caravans on
 *      the same hex on the same day swaps their owners' knownPrices
 *      maps (per-settlement, newer day wins). Hostile owners refuse
 *      to share; neutral and friendly default to syncing. This is
 *      the long-distance gossip channel.
 *
 *   3. Guild ledger sync — for every merchant guild, every guild
 *      member resident at the guild's home settlement (patrician
 *      families and city_corp members) plus every guild-member-owned
 *      caravan currently at the guild's home settlement performs a
 *      mutual merge with the guild's knownPrices map. The guild's
 *      map itself stays fresh because the guild is a resident actor
 *      (homePresenceSyncPhase refreshes it for its home settlement
 *      each tick).
 *
 * For Phase 23 we scope to caravan-driven syncs. Patrol / news-
 * carrier / bandit-party syncs follow the same pattern and can be
 * added in a subsequent pass without disturbing this one.
 */

import type { ActorId, Day } from '../types.js';
import { hexKey } from '../world/hex.js';
import { settlementAnchorIndexForWorld } from '../world/settlementIndex.js';
import type { Actor } from '../politics/actor.js';
import {
  mergeKnownPrices,
  recordMarketObservation,
  type MarketObservation,
} from '../politics/knownPrices.js';
import { snapshotSettlementMarket } from './homePresenceSync.js';
// docs/13 §"What reputation affects": hostility threshold is -0.3.
// Below it counterparties refuse to deal / refuse to share information.
const HOSTILE_THRESHOLD = -0.3;
import type { Caravan } from '../caravan/caravan.js';
import type { WorldState } from '../../procgen/seed.js';

/**
 * Caravan arrival sync. For every caravan currently parked on a
 * settlement anchor, record that settlement's just-cleared market
 * state into the caravan owner's knownPrices map. Idempotent within
 * a tick because recordMarketObservation respects newer-day-wins.
 *
 * Subtle: a caravan visiting a multi-settlement hex (rare — pagus +
 * dependent hamlets) records ONE observation per settlement, with
 * the same observedDay. The owner sees each settlement individually.
 */
export const caravanArrivalSyncPhase = (world: WorldState, today: Day): void => {
  const index = settlementAnchorIndexForWorld(world);
  for (const caravan of world.caravans.values()) {
    const bucket = index.byAnchorHex.get(hexKey(caravan.position));
    if (bucket === undefined || bucket.length === 0) continue;
    const owner = world.actors.get(caravan.ownerActor);
    if (owner === undefined) continue;
    for (const settlement of bucket) {
      const obs = snapshotSettlementMarket(settlement, today);
      if (obs.quotes.size === 0) continue;
      recordMarketObservation(owner, settlement.id, obs);
    }
  }
};

/**
 * Are these two actors willing to share information with each
 * other? Per docs/13: friendly and neutral share; hostile refuses.
 * Symmetric — if either side is hostile, no sync. We treat
 * unknown-relationship as neutral (default merchant courtesy).
 */
const willShare = (world: WorldState, a: ActorId, b: ActorId): boolean => {
  if (a === b) return true;
  // ReputationTable.get(holder, subject) → holder's opinion of subject.
  // Unknown pairs return 0 (neutral); sharing requires neither side hostile.
  const ab = world.reputation.get(a, b);
  const ba = world.reputation.get(b, a);
  if (ab < HOSTILE_THRESHOLD) return false;
  if (ba < HOSTILE_THRESHOLD) return false;
  return true;
};

/**
 * Mutual merge of two actors' knownPrices maps: each picks up
 * everything the other has where the other's observation is newer
 * for that settlement. Skips if either side is hostile.
 */
const mutualMerge = (target: Actor, other: Actor, world: WorldState): void => {
  if (!willShare(world, target.id, other.id)) return;
  mergeKnownPrices(target, other);
  mergeKnownPrices(other, target);
};

/**
 * Caravan meeting sync (piggyback). For every pair of caravans
 * sharing a hex on the same tick, run a mutual merge of their
 * owners' knownPrices.
 *
 * Same-hex grouping is bucket-based; O(N + total pair count). On
 * a sparse map (most hexes empty, only a few hexes hold 2+
 * caravans), this is well below O(N²).
 */
export const caravanMeetingSyncPhase = (world: WorldState): void => {
  // Group caravans by hex. We avoid creating buckets for solitary
  // caravans (they contribute no pair) to keep the loop tight.
  const byHex = new Map<string, Caravan[]>();
  for (const c of world.caravans.values()) {
    const k = hexKey(c.position);
    let bucket = byHex.get(k);
    if (bucket === undefined) {
      bucket = [];
      byHex.set(k, bucket);
    }
    bucket.push(c);
  }
  for (const bucket of byHex.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      const ci = bucket[i] as Caravan;
      const ai = world.actors.get(ci.ownerActor);
      if (ai === undefined) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        const cj = bucket[j] as Caravan;
        if (ci.ownerActor === cj.ownerActor) continue;
        const aj = world.actors.get(cj.ownerActor);
        if (aj === undefined) continue;
        mutualMerge(ai, aj, world);
      }
    }
  }
};

/**
 * Guild ledger sync. For each merchant guild, mutual-merge with
 * every guild member that is co-present at the guild's home
 * settlement:
 *
 *   - resident members (member.homeSettlement === guild.homeSettlement)
 *     are always co-present; they sync daily.
 *   - non-resident members are co-present iff an owned caravan
 *     of theirs is parked at the guild's home anchor today.
 *
 * Members not on-site don't sync. This is what makes the "guild
 * ledger" channel slow-moving for distant members: they only get
 * the aggregate when they (or their caravan) physically visits.
 */
export const guildLedgerSyncPhase = (world: WorldState): void => {
  if (world.guilds === undefined || world.guilds.size === 0) return;
  const index = settlementAnchorIndexForWorld(world);
  for (const guild of world.guilds.values()) {
    const guildActor = world.actors.get(guild.id);
    if (guildActor === undefined) continue;
    if (guildActor.homeSettlement === undefined) continue;
    // Co-presence at guild's home: list every actor that's either a
    // resident member or has at least one caravan at the guild's
    // anchor hex.
    const guildHome = guildActor.homeSettlement;
    const caravansAtHome = new Set<ActorId>();
    for (const c of world.caravans.values()) {
      const localBucket = index.byAnchorHex.get(hexKey(c.position));
      if (localBucket === undefined) continue;
      for (const local of localBucket) {
        if (local.id === guildHome) {
          caravansAtHome.add(c.ownerActor);
          break;
        }
      }
    }
    for (const memberId of guild.members) {
      const member = world.actors.get(memberId);
      if (member === undefined) continue;
      const residentHere = member.homeSettlement === guildHome;
      if (!residentHere && !caravansAtHome.has(memberId)) continue;
      mutualMerge(member, guildActor, world);
    }
  }
};

// Re-export for tests + callers that want to compose syncs in a
// custom order. The tick loop wires all three in sequence.
export const composedPriceSyncPhase = (world: WorldState, today: Day): void => {
  caravanArrivalSyncPhase(world, today);
  caravanMeetingSyncPhase(world);
  guildLedgerSyncPhase(world);
};

// Convenience to satisfy MarketObservation import for downstream
// callers that re-export from this module.
export type { MarketObservation };
