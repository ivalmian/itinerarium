/**
 * Shared movement + visibility + strength helpers for patrol and
 * bandit-party phases.
 *
 * Per docs/15 §C32 + docs/06: bandits and patrols are foot-mobile
 * but travel ~25 hex/day off-road — comparable to a mule caravan
 * and faster than a refugee on foot (~20 hex/day). With this speed
 * a 1-week round trip covers ~75-100 hex one-way, so a typical
 * raid party fires against targets up to that distance from the
 * home camp.
 *
 * The 2-hex "sight" radius the patrol uses to detect bandits is a
 * separate concept; it's vision, not movement speed. Sight is
 * uniform across patrol → bandit and party → patrol detection
 * (per the user's spec). Pursuit gives the patrol a small speed
 * bonus so a target one hex away can actually be caught.
 *
 * Originally lived inline in `src/sim/tick.ts`; lifted here so the
 * patrol phase and bandit-party phase can extract independently.
 */

import { stepAwayFromHex, stepTowardHex, type BanditParty } from '../bandit/party.js';
import type { BanditCamp } from '../bandit/camp.js';
import type { Patrol } from '../conflict/patrol.js';
import { partyEffectiveStrength } from '../bandit/party.js';
import { hexDistance, hexEquals, type Hex } from '../world/hex.js';
import type { WorldState } from '../../procgen/seed.js';

export const BANDIT_PARTY_MOVEMENT_HEXES_PER_DAY = 25;
export const PATROL_MOVEMENT_HEXES_PER_DAY = 25;
/** Range at which patrols hear about / detect bandit camps. */
export const PATROL_DETECTION_HEXES = 15;
export const PATROL_SIGHT_HEXES = 2;
export const PARTY_SIGHT_HEXES = 2;
export const PATROL_PURSUIT_HEXES_PER_DAY = 30;
export const PATROL_PURSUIT_MAX_DAYS = 3;

/** Advance `from` up to `maxHexes` straight-line steps toward `to`. */
export const advanceTowardHex = (
  from: Hex,
  to: Hex,
  maxHexes: number,
  world: WorldState,
): Hex => {
  let cur: Hex = { q: from.q, r: from.r };
  for (let i = 0; i < maxHexes; i++) {
    if (hexEquals(cur, to)) return cur;
    const next = stepTowardHex(cur, to);
    if (!world.grid.has(next)) return cur;
    cur = next;
  }
  return cur;
};

/** Advance `from` up to `maxHexes` straight-line steps away from `away`. */
export const advanceAwayFromHex = (
  from: Hex,
  away: Hex,
  maxHexes: number,
  world: WorldState,
): Hex => {
  let cur: Hex = { q: from.q, r: from.r };
  for (let i = 0; i < maxHexes; i++) {
    const next = stepAwayFromHex(cur, away);
    if (!world.grid.has(next)) return cur;
    cur = next;
  }
  return cur;
};

/**
 * Effective combat strength used for "do I think I can win" / "will I
 * be caught" heuristics. Mirrors the formula in
 * `partyEffectiveStrength` but works for both camps and patrols.
 */
export const banditCampStrength = (camp: BanditCamp): number => {
  const kit = 1 + camp.weaponsPerBandit + camp.armorPerBandit;
  return camp.banditCount * kit * Math.max(0.1, camp.averageHealth) * 0.25;
};

export const patrolStrength = (patrol: Patrol): number => {
  const u = patrol.unit;
  const kit = 1 + (u.weapons ?? 0) + (u.armor ?? 0);
  return u.count * kit * Math.max(0.1, u.health ?? 1) * Math.max(0.25, u.training ?? 0.25);
};

export const partyStrength = partyEffectiveStrength;

/**
 * For a bandit party, find the nearest patrol within sight that is
 * likely to win an engagement. Returns the patrol or undefined.
 */
export const visibleThreatForParty = (
  world: WorldState,
  party: BanditParty,
): Patrol | undefined => {
  if (world.patrols === undefined) return undefined;
  let best: Patrol | undefined;
  let bestD = Infinity;
  const myStrength = partyStrength(party);
  for (const p of world.patrols.values()) {
    if (p.unit.count <= 0) continue;
    const d = hexDistance(p.position, party.position);
    if (d > PARTY_SIGHT_HEXES) continue;
    if (patrolStrength(p) <= myStrength) continue; // not a threat
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
};

/**
 * For a patrol, find the nearest visible bandit target (camp or party)
 * the patrol believes it can defeat. Returns the target hex.
 */
export const visibleQuarryForPatrol = (
  world: WorldState,
  patrol: Patrol,
): { hex: Hex; kind: 'camp' | 'party' } | undefined => {
  const myStrength = patrolStrength(patrol);
  let best: { hex: Hex; kind: 'camp' | 'party'; d: number } | undefined;
  if (world.banditCamps !== undefined) {
    for (const c of world.banditCamps.values()) {
      if (c.banditCount <= 0) continue;
      const d = hexDistance(c.hex, patrol.position);
      if (d > PATROL_SIGHT_HEXES) continue;
      if (banditCampStrength(c) >= myStrength) continue; // unlikely to win
      if (best === undefined || d < best.d) best = { hex: c.hex, kind: 'camp', d };
    }
  }
  if (world.banditParties !== undefined) {
    for (const party of world.banditParties.values()) {
      if (party.banditCount <= 0) continue;
      const d = hexDistance(party.position, patrol.position);
      if (d > PATROL_SIGHT_HEXES) continue;
      if (partyStrength(party) >= myStrength) continue;
      if (best === undefined || d < best.d) best = { hex: party.position, kind: 'party', d };
    }
  }
  if (best === undefined) return undefined;
  return { hex: best.hex, kind: best.kind };
};
