/**
 * News-carrier arrival phase (docs/13).
 *
 * Drains every `world.newsCarriers` entry whose `arrived` flag is
 * set: for each, look up the destination settlement (by anchor
 * hex) and the named characters currently at that hex, run
 * `processNewsArrival` to apply reputation deltas to each
 * receiver, then delete the carrier from the world.
 *
 * Same-hex settlements (the pagus + dependent-hamlets case from
 * docs/05 §"Same-hex coexistence") are handled by routing the
 * arrival through the first same-hex settlement only —
 * `processNewsArrival`'s receiver list is hex-keyed via
 * `NamedCharacter.location`, so calling it once per same-hex
 * settlement would apply the same delta multiple times. The
 * settlement reference is otherwise diagnostic-only inside
 * processNewsArrival.
 *
 * Faction lookups for victim / perpetrator come from a one-shot
 * `actor → faction` index built per call (cheap; faction count
 * is small compared to actor count and reputation tables).
 */

import type { NamedCharacter } from '../politics/character.js';
import { processNewsArrival } from '../reputation/newsArrival.js';
import type { Day, FactionId } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const buildActorToFactionIndex = (world: WorldState): Map<string, FactionId> => {
  const out = new Map<string, FactionId>();
  for (const f of world.factions.values()) {
    out.set(String(f.actor), f.id);
  }
  return out;
};

export const newsArrivalPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  void _today;
  if (world.newsCarriers === undefined || world.newsCarriers.size === 0) return;

  // Index settlements by anchor hex once per call.
  const settlementsByAnchor = new Map<string, Settlement[]>();
  for (const s of world.settlements.values()) {
    const k = `${s.anchor.q},${s.anchor.r}`;
    let bucket = settlementsByAnchor.get(k);
    if (bucket === undefined) {
      bucket = [];
      settlementsByAnchor.set(k, bucket);
    }
    bucket.push(s);
  }

  // Build per-settlement character list. NamedCharacter.location is
  // the hex they're currently at; we group by anchor-hex match.
  const charsBySettlementAnchor = new Map<string, NamedCharacter[]>();
  const factionByActor = buildActorToFactionIndex(world);
  for (const c of world.characters.values()) {
    const key = `${c.location.q},${c.location.r}`;
    const list = charsBySettlementAnchor.get(key);
    if (list === undefined) charsBySettlementAnchor.set(key, [c]);
    else list.push(c);
  }

  for (const [id, carrier] of [...world.newsCarriers]) {
    if (!carrier.arrived) continue;
    const destKey = `${carrier.destination.q},${carrier.destination.r}`;
    const destBucket = settlementsByAnchor.get(destKey);
    if (destBucket === undefined || destBucket.length === 0) {
      // Carrier arrived somewhere with no settlement (shouldn't
      // happen since we pick anchors as destinations) — drop it.
      world.newsCarriers.delete(id);
      continue;
    }
    // Process against the first same-hex settlement (see header).
    const settlement = destBucket[0]!;
    const characters = charsBySettlementAnchor.get(destKey) ?? [];

    const victimFaction =
      carrier.carrying.victim !== null
        ? factionByActor.get(String(carrier.carrying.victim))
        : undefined;
    const perpetratorFaction = factionByActor.get(String(carrier.carrying.perpetrator));

    const inputs = {
      carrier,
      destinationSettlement: settlement,
      charactersAtSettlement: characters,
      reputation: world.reputation,
      ...(victimFaction !== undefined ? { victimFaction } : {}),
      ...(perpetratorFaction !== undefined
        ? { banditAlignedFactions: [perpetratorFaction] as readonly FactionId[] }
        : {}),
    };
    const result = processNewsArrival(inputs);
    events.push({
      type: 'news_carrier_arrived',
      id,
      settlement: settlement.id,
      receiverCount: result.charactersUpdated,
      deltasApplied: result.reputationDeltasApplied.length,
    });
    for (const d of result.reputationDeltasApplied) {
      events.push({
        type: 'reputation_updated',
        holder: d.holder,
        subject: d.subject,
        delta: d.delta,
      });
    }
    world.newsCarriers.delete(id);
  }
};
