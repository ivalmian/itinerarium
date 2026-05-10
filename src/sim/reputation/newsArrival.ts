/**
 * News carrier arrival → reputation update integration (T49).
 *
 * Per docs/13 §"How reputation gets updated — the news-carrier model":
 * when a news carrier reaches a settlement, the news must actually update
 * the reputation slates of the named characters present. Without this
 * step, news carriers walk forever and the reputation system never
 * receives any updates — the entire propagation pipeline is dead.
 *
 * This module is intentionally narrow. It:
 *   1. Walks the named characters at the destination settlement.
 *   2. Classifies each character's alignment toward the news (victim-
 *      aligned, victim-rival, authority, bandit-aligned, or honest).
 *   3. Builds an ArrivalContext from those classifications.
 *   4. Calls arrivalToReputationEvent (T18) → applyReputationEvent (T17).
 *   5. Returns the deltas applied + a count of characters who were
 *      offered an update (even if their bucket produced a zero delta).
 *
 * Pillar 1 ("no hidden hands") is preserved: the caller is responsible
 * for selecting *which* characters are present at the settlement (i.e.,
 * who actually hears the news). This module does not iterate the world
 * looking for characters elsewhere.
 *
 * Design references:
 *   docs/13-reputation-and-relationships.md §"Lifecycle of a reputation event"
 *   docs/13-reputation-and-relationships.md §"Severity of the reputation hit"
 */

import type { CharacterId, FactionId } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import type { NamedCharacter } from '../politics/character.js';
import {
  applyReputationEvent,
  type AppliedReputationDelta,
  type ReputationEvent,
  type ReputationKey,
  type ReputationTable,
} from './table.js';
import {
  arrivalToReputationEvent,
  type ArrivalReceiver,
  type NewsCarrier,
  type ReceiverAlignment,
} from './news.js';

/** Public alias for docs/13 alignment enum. Matches news.ReceiverAlignment exactly. */
export type Alignment = ReceiverAlignment;

/**
 * The classification context the caller assembles. Mirrors the relationship
 * data the news event carries plus the local political map of the receiving
 * settlement.
 *
 * Every field is optional. A character whose faction matches none of the
 * provided buckets is `honest`. With nothing provided, all receivers are
 * honest.
 */
export interface ClassificationContext {
  readonly victimFaction?: FactionId;
  readonly victimAlliedFactions?: readonly FactionId[];
  readonly victimRivalFactions?: readonly FactionId[];
  readonly authorityFaction?: FactionId;
  readonly banditAlignedFactions?: readonly FactionId[];
}

/**
 * Role priority for classification: a character whose faction matches both
 * a victim relationship AND `authority` (e.g., a Vibian magistrate when
 * Vibian is the victim-allied family AND the authority) is classified by the
 * higher-priority role. Matches ROLE_PRIORITY in src/sim/reputation/table.ts:
 * victim relationships are more specific than the generic authority/honest
 * buckets.
 */
const factionMatches = (
  faction: FactionId,
  members: readonly FactionId[] | undefined,
): boolean => {
  if (members === undefined) return false;
  for (const m of members) {
    if (String(m) === String(faction)) return true;
  }
  return false;
};

const factionEquals = (a: FactionId | undefined, b: FactionId): boolean => {
  if (a === undefined) return false;
  return String(a) === String(b);
};

/**
 * Classify a character's alignment toward a news event.
 *
 * Priority (high → low): victim_aligned, victim_rival, authority,
 * bandit_aligned, honest. A faction in multiple buckets is assigned to
 * the highest-priority bucket it matches.
 */
export const classifyAlignment = (
  character: NamedCharacter,
  ctx: ClassificationContext,
): Alignment => {
  const f = character.faction;
  if (factionEquals(ctx.victimFaction, f) || factionMatches(f, ctx.victimAlliedFactions)) {
    return 'victim_aligned';
  }
  if (factionMatches(f, ctx.victimRivalFactions)) {
    return 'victim_rival';
  }
  if (factionEquals(ctx.authorityFaction, f)) {
    return 'authority';
  }
  if (factionMatches(f, ctx.banditAlignedFactions)) {
    return 'bandit_aligned';
  }
  return 'honest';
};

export interface NewsArrivalInputs {
  readonly carrier: NewsCarrier;
  readonly destinationSettlement: Settlement;
  readonly charactersAtSettlement: readonly NamedCharacter[];
  readonly reputation: ReputationTable;
  readonly victimFaction?: FactionId | undefined;
  readonly victimAlliedFactions?: readonly FactionId[] | undefined;
  readonly victimRivalFactions?: readonly FactionId[] | undefined;
  readonly authorityFaction?: FactionId | undefined;
  readonly banditAlignedFactions?: readonly FactionId[] | undefined;
}

export interface NewsArrivalResult {
  /**
   * Deltas actually written to the reputation table. Empty when every
   * receiver's role-base-delta evaluated to 0 (e.g., a lawful act seen
   * only by bandit-aligned characters: cheering is suppressed).
   */
  readonly reputationDeltasApplied: readonly AppliedReputationDelta[];
  /**
   * The number of characters whose slates were offered an update — i.e.,
   * the headcount of receivers, NOT the number of non-zero deltas. The
   * news reached them; whether their alignment produced a delta is a
   * separate question.
   */
  readonly charactersUpdated: number;
}

const buildClassificationContext = (inputs: NewsArrivalInputs): ClassificationContext => ({
  ...(inputs.victimFaction !== undefined ? { victimFaction: inputs.victimFaction } : {}),
  ...(inputs.victimAlliedFactions !== undefined
    ? { victimAlliedFactions: inputs.victimAlliedFactions }
    : {}),
  ...(inputs.victimRivalFactions !== undefined
    ? { victimRivalFactions: inputs.victimRivalFactions }
    : {}),
  ...(inputs.authorityFaction !== undefined
    ? { authorityFaction: inputs.authorityFaction }
    : {}),
  ...(inputs.banditAlignedFactions !== undefined
    ? { banditAlignedFactions: inputs.banditAlignedFactions }
    : {}),
});

/**
 * Process a news carrier arrival at a settlement: classify each character's
 * alignment toward the news, build a ReputationEvent, apply it to the table,
 * and return the deltas + a receiver count.
 *
 * Throws if the carrier is not yet `arrived`.
 *
 * The perpetrator (if also present at the settlement) is automatically
 * skipped by applyReputationEvent (a perpetrator never holds a delta about
 * themselves).
 *
 * The settlement reference is taken for diagnostic / future use (e.g., the
 * settlement's name shows up in the eventual UI tooltip). This module does
 * not currently read state from it.
 */
export const processNewsArrival = (inputs: NewsArrivalInputs): NewsArrivalResult => {
  if (!inputs.carrier.arrived) {
    throw new Error(
      `processNewsArrival: carrier ${inputs.carrier.id} has not arrived (${String(
        inputs.destinationSettlement.id,
      )} is not the origin)`,
    );
  }

  // Empty receiver list → no deltas, no count.
  if (inputs.charactersAtSettlement.length === 0) {
    return { reputationDeltasApplied: [], charactersUpdated: 0 };
  }

  const ctx = buildClassificationContext(inputs);

  // Classify every character → ArrivalReceiver. Characters whose id matches
  // the perpetrator are still classified (alignment may matter elsewhere)
  // but applyReputationEvent will drop them.
  const receivers: ArrivalReceiver[] = inputs.charactersAtSettlement.map(
    (c): ArrivalReceiver => ({
      holder: c.id as ReputationKey & CharacterId,
      alignment: classifyAlignment(c, ctx),
    }),
  );

  const event = arrivalToReputationEvent(inputs.carrier, { receivers });

  // Filter event.victim: the victim heard at the time of the event (they
  // were the direct witness). News carriers arriving at OTHER settlements
  // don't re-update the victim's slate. Only apply the victim delta if
  // the victim is among the characters present at this settlement.
  const localCharacterIds = new Set(inputs.charactersAtSettlement.map((c) => String(c.id)));
  const victimIsLocal = event.victim !== null && localCharacterIds.has(String(event.victim));
  const localizedEvent: ReputationEvent = {
    ...event,
    victim: victimIsLocal ? event.victim : null,
  };
  const applied = applyReputationEvent(inputs.reputation, localizedEvent);

  return {
    reputationDeltasApplied: applied,
    charactersUpdated: inputs.charactersAtSettlement.length,
  };
};
