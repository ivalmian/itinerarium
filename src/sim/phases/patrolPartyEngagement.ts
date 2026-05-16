/**
 * Patrol-vs-party engagement phase (docs/15 §C32).
 *
 * After both movement phases, any patrol whose position overlaps the
 * 2-hex sight radius of a bandit party (or camp not already engaged
 * by the cyclic-route patrolPhase) fights on-hex. The cyclic-route
 * patrol logic in `patrolPhase` handles patrol-vs-camp engagements;
 * this phase catches the patrol-vs-party case the route logic
 * doesn't see.
 *
 * Combat uses `resolveBattle` with `partyAsCombatUnit` / `campAsCombatUnit`
 * adapters. On a patrol win, the bandit count is reduced (potentially
 * to zero — the next bandit-party / camp phase cleans up). On a
 * bandit win, the patrol unit shrinks (potentially to zero, which
 * clears the patrol from `world.patrols`). No bribery (per spec).
 */

import {
  applyBanditCasualties,
  campAsCombatUnit,
  type BanditCamp,
} from '../bandit/camp.js';
import { partyAsCombatUnit, type BanditParty } from '../bandit/party.js';
import { resolveBattle } from '../conflict/battle.js';
import { drainDemographics } from '../population/demographics.js';
import { markPersonsDeadByDemographics } from '../people/registry.js';
import type { Rng } from '../rng.js';
import type { BanditCampId, Day } from '../types.js';
import { hexDistance } from '../world/hex.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

/** Engagement radius in hexes — same as the patrol's sight radius. */
const PATROL_PARTY_ENGAGEMENT_HEXES = 2;

export const patrolPartyEngagementPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (world.patrols === undefined || world.patrols.size === 0) return;
  for (const [patrolId, patrol] of [...world.patrols]) {
    if (patrol.unit.count <= 0) {
      world.patrols.delete(patrolId);
      continue;
    }
    type Target = { kind: 'party'; party: BanditParty } | { kind: 'camp'; camp: BanditCamp };
    let best: { target: Target; d: number } | undefined;
    if (world.banditParties !== undefined) {
      for (const party of world.banditParties.values()) {
        if (party.banditCount <= 0) continue;
        const d = hexDistance(party.position, patrol.position);
        if (d > PATROL_PARTY_ENGAGEMENT_HEXES) continue;
        if (best === undefined || d < best.d) best = { target: { kind: 'party', party }, d };
      }
    }
    if (world.banditCamps !== undefined) {
      for (const camp of world.banditCamps.values()) {
        if (camp.banditCount <= 0) continue;
        const d = hexDistance(camp.hex, patrol.position);
        if (d > PATROL_PARTY_ENGAGEMENT_HEXES) continue;
        if (best === undefined || d < best.d) best = { target: { kind: 'camp', camp }, d };
      }
    }
    if (best === undefined) continue;

    const subRng = rng.derive(`engage-${patrolId}`);
    const defender =
      best.target.kind === 'party'
        ? partyAsCombatUnit(best.target.party, 'defending')
        : campAsCombatUnit(best.target.camp, 'defending');
    const battle = resolveBattle(patrol.unit, defender, {
      ambush: false,
      rng: subRng,
    });
    let outcome: 'patrol_won' | 'bandits_won' | 'mutual_rout';
    if (battle.winnerId === patrol.unit.id) outcome = 'patrol_won';
    else if (battle.winnerId === defender.id) outcome = 'bandits_won';
    else outcome = 'mutual_rout';

    const patrolCas = battle.casualties.find((c) => c.unitId === patrol.unit.id);
    const defCas = battle.casualties.find((c) => c.unitId === defender.id);
    const patrolDeaths = patrolCas?.deaths ?? 0;
    const defDeaths = defCas?.deaths ?? 0;

    const survivingPatrol = Math.max(0, patrol.unit.count - patrolDeaths);
    patrol.unit = { ...patrol.unit, count: survivingPatrol };
    if (patrolDeaths > 0 && patrol.demographics !== undefined) {
      const patrolDemo = new Map(patrol.demographics);
      const drained = drainDemographics(
        patrolDemo,
        patrolDeaths,
        rng.derive(`patrol-cas-${patrolId}`),
      );
      patrol.demographics = patrolDemo;
      if (world.persons !== undefined && drained.size > 0) {
        markPersonsDeadByDemographics(
          world.persons,
          world.personEquipment,
          patrolId,
          drained,
          rng.derive(`patrol-pers-${patrolId}`),
          today,
        );
      }
    }
    if (survivingPatrol <= 0) {
      world.patrols.delete(patrolId);
    } else {
      delete patrol.pursuit;
      world.patrols.set(patrolId, patrol);
    }

    if (best.target.kind === 'party') {
      const partyTake = Math.min(best.target.party.banditCount, defDeaths);
      best.target.party.banditCount = Math.max(0, best.target.party.banditCount - defDeaths);
      if (partyTake > 0 && best.target.party.banditDemographics !== undefined) {
        const partyDemo = new Map(best.target.party.banditDemographics);
        const drained = drainDemographics(
          partyDemo,
          partyTake,
          rng.derive(`party-cas-${String(best.target.party.id)}`),
        );
        best.target.party.banditDemographics = partyDemo;
        if (world.persons !== undefined && drained.size > 0) {
          markPersonsDeadByDemographics(
            world.persons,
            world.personEquipment,
            String(best.target.party.id),
            drained,
            rng.derive(`party-pers-${String(best.target.party.id)}`),
            today,
          );
        }
      }
    } else if (world.banditCamps !== undefined) {
      const drainedCamp = applyBanditCasualties(
        best.target.camp,
        Math.min(defDeaths, best.target.camp.banditCount),
        rng.derive(`camp-cas-${String(best.target.camp.id)}`),
      );
      if (world.persons !== undefined && drainedCamp.removed.size > 0) {
        markPersonsDeadByDemographics(
          world.persons,
          world.personEquipment,
          String(best.target.camp.id),
          drainedCamp.removed,
          rng.derive(`camp-pers-${String(best.target.camp.id)}`),
          today,
        );
      }
      if (drainedCamp.camp.banditCount <= 0) {
        world.banditCamps.delete(best.target.camp.id);
      } else {
        world.banditCamps.set(best.target.camp.id, drainedCamp.camp);
      }
    }

    events.push({
      type: 'patrol_engaged',
      patrolId,
      camp:
        best.target.kind === 'camp'
          ? best.target.camp.id
          : (best.target.party.homeCamp ??
            (`party:${String(best.target.party.id)}` as BanditCampId)),
      outcome,
    });
    void today;
  }
};
