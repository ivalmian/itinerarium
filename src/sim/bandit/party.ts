/**
 * Bandit parties — movable units that handle every camp-originated
 * action. Per docs/12 §"Bandit raid parties" and docs/15 §C32, a camp
 * no longer raids / fences / recruits / migrates in-place: it splits off
 * a subset of its bandits as a `BanditParty`, the party walks to the
 * target, executes the mission on arrival, and walks back. The visible
 * raid + visible interception are the gameplay surface.
 *
 * Movement is one hex per day along a straight-ish path. Round-trip
 * target ~1 week, so most missions fire against targets 3-4 hexes from
 * the home camp.
 *
 * Combat: a patrol within sight (2 hexes per docs/12 patrol revision)
 * with positive expected advantage pursues the party; the party flees;
 * actual combat resolves only on hex-overlap. There is no bribery —
 * every engagement is fought.
 *
 * Design references:
 *   docs/12-bandits-and-conflict.md §"Bandit raid parties"
 *   docs/15-v1-5-cleanups.md §C32
 */

import type {
  ActorId,
  BanditCampId,
  BanditPartyId,
  Coin,
  Position,
  Quantity,
  ResourceId,
  SettlementId,
} from '../types.js';
import type { CombatUnit, Posture } from '../conflict/battle.js';
import type { Demographics } from '../population/demographics.js';
import { hex as makeHex, hexDistance, hexEquals, type Hex } from '../world/hex.js';

/**
 * Mission a party is dispatched to perform. The `targetHex` is where the
 * mission resolves; for missions tied to a Settlement we also carry the
 * settlement id so we can call into the existing settlement-resolution
 * code (executeSettlementRaid, fence transactions, recruitment) once the
 * party arrives.
 */
export type BanditPartyMission =
  | {
      readonly type: 'raid_settlement';
      readonly target: SettlementId;
      readonly targetHex: Position;
    }
  | {
      readonly type: 'raid_caravan';
      readonly targetHex: Position;
    }
  | {
      readonly type: 'fence_loot';
      readonly through: SettlementId;
      readonly throughHex: Position;
    }
  | {
      readonly type: 'recruit_drive';
      readonly fromSettlement: SettlementId;
      readonly fromHex: Position;
    }
  | {
      /**
       * One-way migration. The party never returns; on arrival at
       * `targetHex` it spawns a new camp (with itself as the founding
       * roster) and the homeCamp is abandoned.
       */
      readonly type: 'migrate';
      readonly targetHex: Position;
    }
  | {
      readonly type: 'bribe_settlement';
      readonly settlement: SettlementId;
      readonly settlementHex: Position;
      readonly amount: Coin;
    };

/**
 * Where in the mission lifecycle the party currently is.
 *  - `outbound`: walking toward the mission's resolution hex.
 *  - `executing`: arrived; mission resolves this tick. Transient — the
 *    tick that flips to executing immediately processes the action and
 *    flips to `returning` (or, for `migrate`, to `done`).
 *  - `returning`: walking back toward home camp.
 *  - `fleeing`: a patrol within sight is likely to beat us; walking
 *    one hex away from it per tick. Mission is paused while fleeing.
 *  - `done`: ready to despawn (transient — tick cleans up).
 */
export type BanditPartyPhase = 'outbound' | 'executing' | 'returning' | 'fleeing' | 'done';

export interface BanditParty {
  readonly id: BanditPartyId;
  /**
   * Home camp id. `null` if the party has lost its camp (the camp was
   * destroyed while the party was out, or this party was spawned by a
   * `migrate` action with no return). On a `returning` party with no
   * home camp, the party founds a new camp at its current hex.
   */
  homeCamp: BanditCampId | null;
  /** Hex the party will return to. Snapshot of camp hex at dispatch. */
  readonly homeHex: Position;
  /** The faction actor that owns this party (same as the home camp's). */
  readonly ownerActor: ActorId;
  /** Current position on the grid. Mutated daily. */
  position: Position;
  readonly mission: BanditPartyMission;
  phase: BanditPartyPhase;
  /** Combat-capable bandits in the party. Mutated by combat + recruitment. */
  banditCount: number;
  /** 0..1 — average kit. */
  weaponsPerBandit: number;
  /** 0..1. */
  armorPerBandit: number;
  /** 0..1. */
  averageHealth: number;
  /** Per-(sex, age band) split when known. */
  banditDemographics?: Demographics;
  /** Days elapsed since dispatch. Used for both telemetry + give-up budgets. */
  daysOnTrip: number;
  /**
   * When the party is in `fleeing` phase, the hex of the patrol it is
   * running from. Cleared when the patrol is no longer within sight.
   */
  fleeingFromHex?: Position;
  /**
   * Goods carried. Outbound for `fence_loot` (loot from camp);
   * accumulating for `raid_settlement` (gathered at target). Fungible
   * with `loot` semantics — handed back to the camp on return.
   */
  cargo: Map<ResourceId, Quantity>;
  /** Coin balance. Bribes pre-load this; fence trips fill it on arrival. */
  treasury: Coin;
}

export interface CreateBanditPartyInput {
  readonly id: BanditPartyId;
  readonly homeCamp: BanditCampId | null;
  readonly homeHex: Position;
  readonly ownerActor: ActorId;
  readonly position: Position;
  readonly mission: BanditPartyMission;
  readonly banditCount: number;
  readonly weaponsPerBandit: number;
  readonly armorPerBandit: number;
  readonly averageHealth: number;
  readonly banditDemographics?: Demographics;
  readonly cargo?: ReadonlyMap<ResourceId, Quantity>;
  readonly treasury?: Coin;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export const createBanditParty = (input: CreateBanditPartyInput): BanditParty => {
  if (input.banditCount < 0 || !Number.isFinite(input.banditCount)) {
    throw new Error(`BanditParty banditCount must be ≥0, got ${input.banditCount}`);
  }
  return {
    id: input.id,
    homeCamp: input.homeCamp,
    homeHex: { q: input.homeHex.q, r: input.homeHex.r },
    ownerActor: input.ownerActor,
    position: { q: input.position.q, r: input.position.r },
    mission: input.mission,
    phase: 'outbound',
    banditCount: input.banditCount,
    weaponsPerBandit: clamp01(input.weaponsPerBandit),
    armorPerBandit: clamp01(input.armorPerBandit),
    averageHealth: clamp01(input.averageHealth),
    ...(input.banditDemographics !== undefined
      ? { banditDemographics: input.banditDemographics }
      : {}),
    daysOnTrip: 0,
    cargo: input.cargo !== undefined ? new Map(input.cargo) : new Map(),
    treasury: input.treasury ?? 0,
  };
};

/** Mission resolution hex — the place the party walks to on the outbound leg. */
export const missionTargetHex = (mission: BanditPartyMission): Hex => {
  switch (mission.type) {
    case 'raid_settlement':
      return makeHex(mission.targetHex.q, mission.targetHex.r);
    case 'raid_caravan':
      return makeHex(mission.targetHex.q, mission.targetHex.r);
    case 'fence_loot':
      return makeHex(mission.throughHex.q, mission.throughHex.r);
    case 'recruit_drive':
      return makeHex(mission.fromHex.q, mission.fromHex.r);
    case 'migrate':
      return makeHex(mission.targetHex.q, mission.targetHex.r);
    case 'bribe_settlement':
      return makeHex(mission.settlementHex.q, mission.settlementHex.r);
  }
};

/** Whether the party has arrived at the mission's target this tick. */
export const partyAtMissionTarget = (party: BanditParty): boolean =>
  hexEquals(party.position, missionTargetHex(party.mission));

/** Whether the party has arrived back at its home hex this tick. */
export const partyAtHome = (party: BanditParty): boolean =>
  hexEquals(party.position, party.homeHex);

/**
 * Translate a party into a `CombatUnit` for the conflict layer (same
 * shape `campAsCombatUnit` produces). Used by patrol-engagement and
 * party-vs-patrol on-overlap battles.
 */
export const partyAsCombatUnit = (
  party: BanditParty,
  posture: Posture = 'attacking',
): CombatUnit => {
  return {
    id: String(party.id),
    count: Math.max(1, Math.floor(party.banditCount)),
    weapons: party.weaponsPerBandit,
    armor: party.armorPerBandit,
    health: party.averageHealth,
    posture,
    training: 0.25,
    terrainBonus: 0,
  };
};

/**
 * Effective combat strength for "do I think I can win" / "will I be
 * caught" heuristics. Mirrors the patrol layer's strength formula —
 * count × (1 + weapons + armor) × health × training. Both sides compute
 * this on each other to decide pursue/flee.
 */
export const partyEffectiveStrength = (party: BanditParty): number => {
  const kit = 1 + party.weaponsPerBandit + party.armorPerBandit;
  return party.banditCount * kit * Math.max(0.1, party.averageHealth) * 0.25;
};

/** Pick the next hex toward `target`. Returns the party's current hex
 *  unchanged when already there. Uses a straight axial-step pathfinder
 *  (cheap, works at this scale — caravans use the same approach for
 *  short hops). For longer / road-aware pathing we lean on the
 *  movement-cost grid in the tick layer, not here. */
export const stepTowardHex = (from: Hex, to: Hex): Hex => {
  if (hexEquals(from, to)) return from;
  const dq = to.q - from.q;
  const dr = to.r - from.r;
  const ds = -dq - dr;
  // Cube-coord rounded step: nudge the largest delta by one.
  const aq = Math.abs(dq);
  const ar = Math.abs(dr);
  const as = Math.abs(ds);
  if (aq >= ar && aq >= as) {
    return makeHex(from.q + Math.sign(dq), from.r);
  } else if (ar >= as) {
    return makeHex(from.q, from.r + Math.sign(dr));
  } else {
    // moving in s-axis means combined -q -r
    // Move along the axis that closes the larger of dq, dr negatives
    return makeHex(from.q - Math.sign(dq + dr), from.r);
  }
};

/** One-hex step directly away from `away`. Used by flee logic. */
export const stepAwayFromHex = (from: Hex, away: Hex): Hex => {
  if (hexEquals(from, away)) {
    // Already on the same hex — pick an arbitrary neighbor.
    return makeHex(from.q + 1, from.r);
  }
  const dq = from.q - away.q;
  const dr = from.r - away.r;
  const aq = Math.abs(dq);
  const ar = Math.abs(dr);
  const as = Math.abs(dq + dr);
  if (aq >= ar && aq >= as) {
    return makeHex(from.q + Math.sign(dq), from.r);
  } else if (ar >= as) {
    return makeHex(from.q, from.r + Math.sign(dr));
  } else {
    return makeHex(from.q + Math.sign(dq + dr), from.r);
  }
};

/** Hex-distance helper re-export. */
export const partyDistanceTo = (party: BanditParty, target: Hex): number =>
  hexDistance(party.position, target);
