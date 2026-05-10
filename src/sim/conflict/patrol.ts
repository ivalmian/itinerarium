/**
 * Patrols: hunt bandit camps, inspect suspicious caravans, return to base.
 *
 * Per docs/12 §"Patrols (Roman-era)": four flavors share one mechanic —
 * provincial garrison (governor's stationarii + mobile detachments), city
 * watch, family guards, caravan escorts. All four walk a route, consume
 * patrol-days, decide whether to engage, and respect bribery (a corrupt
 * patrol may "see nothing").
 *
 * This module owns the per-day patrol state machine. It does NOT execute
 * battles — it produces `PatrolEvent`s and `pendingBattles[]` for the tick
 * loop, which feeds them into `resolveBattle` (T15).
 *
 * Design references:
 *   docs/12-bandits-and-conflict.md §"Patrols (Roman-era)"
 *   docs/11-politics-and-ownership.md §"Garrison and family guards"
 *   docs/13-reputation-and-relationships.md §"Reputation as gameplay"
 *     (bribery threshold)
 */

import type { BanditCamp } from '../bandit/camp.js';
import { campAsCombatUnit } from '../bandit/camp.js';
import type { ReputationTable } from '../reputation/table.js';
import type { Rng } from '../rng.js';
import type { ActorId, BanditCampId, CaravanId, Day, Position, SettlementId } from '../types.js';
import { hex as makeHex, hexEquals, type Hex } from '../world/hex.js';
import type { CombatUnit } from './battle.js';

export type PatrolKind = 'provincial_garrison' | 'city_watch' | 'family_guard' | 'caravan_escort';

export interface Patrol {
  readonly id: string;
  readonly kind: PatrolKind;
  readonly ownerActor: ActorId;
  readonly basedAt: SettlementId;
  /** Current location. Mutated each tick. */
  position: Position;
  /** Cyclic patrol path. Patrols loop forever; tick advances by routeIndex+1 mod length. */
  readonly route: readonly Hex[];
  /** Index of the patrol's current step on `route`. position == route[routeIndex]. */
  routeIndex: number;
  /** Combat unit fielded by the patrol. Mutated as casualties accumulate. */
  unit: CombatUnit;
  /** Days since last rest at base. Reset when patrol returns to its base hex. */
  daysOnPatrol: number;
  /** Days since last engagement / inspection event. */
  daysWithoutEngagement: number;
}

export interface CreatePatrolInput {
  readonly id: string;
  readonly kind: PatrolKind;
  readonly ownerActor: ActorId;
  readonly basedAt: SettlementId;
  readonly route: readonly Hex[];
  readonly unit: CombatUnit;
}

export interface KnownCaravanOnRoute {
  readonly caravanId: CaravanId;
  readonly ownerActor: ActorId;
  readonly hex: Hex;
  readonly suspicious: boolean;
}

export interface KnownBanditCampOnRoute {
  readonly camp: BanditCamp;
  readonly hex: Hex;
}

export interface KnownFriendlySettlementHex {
  readonly id: SettlementId;
  readonly hex: Hex;
}

export interface PatrolTickInputs {
  readonly patrol: Patrol;
  readonly rng: Rng;
  readonly knownBanditCampsOnRoute: readonly KnownBanditCampOnRoute[];
  readonly knownCaravansOnRoute: readonly KnownCaravanOnRoute[];
  readonly knownFriendlySettlementHexes?: readonly KnownFriendlySettlementHex[];
  readonly reputation?: ReputationTable;
  readonly today: Day;
}

export type PatrolEventType =
  | 'engagement'
  | 'inspection'
  | 'arrived_at_base'
  | 'returned_to_route'
  | 'tactical_retreat'
  | 'turned_blind_eye';

export interface PatrolEventDetail {
  readonly hex: Hex;
  readonly day: Day;
  readonly campId?: BanditCampId;
  readonly caravanId?: CaravanId;
  readonly settlementId?: SettlementId;
  readonly reason?: string;
}

export interface PatrolEvent {
  readonly type: PatrolEventType;
  readonly detail: PatrolEventDetail;
}

export interface PendingBattleTarget {
  readonly with:
    | { readonly kind: 'bandit_camp'; readonly campId: BanditCampId }
    | { readonly kind: 'caravan'; readonly caravanId: CaravanId };
  readonly defenderUnit: CombatUnit;
  readonly ambushFavors: 'attacker' | 'defender' | 'neither';
}

export interface PatrolTickResult {
  readonly patrol: Patrol;
  readonly events: readonly PatrolEvent[];
  readonly pendingBattles: readonly PendingBattleTarget[];
}

// --- Constants -------------------------------------------------------------

/** Bribery: if patrol owner's reputation of camp owner is at or above this, look the other way. */
const BRIBERY_REP_THRESHOLD = 0.6;

/**
 * Engagement strength threshold: patrol won't initiate a battle if its
 * "effective combat strength" is less than this fraction of the camp's
 * raw bandit count. A modest training/weapons advantage suffices, but a
 * 2x numerical deficit triggers tactical retreat.
 */
const MIN_ENGAGE_RATIO = 0.6;

// --- Construction ----------------------------------------------------------

const cloneHex = (h: Hex): Hex => makeHex(h.q, h.r);

const cloneUnit = (u: CombatUnit): CombatUnit => ({ ...u });

export const createPatrol = (input: CreatePatrolInput): Patrol => {
  if (input.id.length === 0) {
    throw new Error('Patrol id must be non-empty');
  }
  if (input.route.length === 0) {
    throw new Error(`Patrol ${input.id} must have a non-empty route`);
  }
  if (input.unit.count <= 0) {
    throw new Error(`Patrol ${input.id} unit must have positive count`);
  }
  return {
    id: input.id,
    kind: input.kind,
    ownerActor: input.ownerActor,
    basedAt: input.basedAt,
    position: cloneHex(input.route[0] as Hex),
    route: input.route.map(cloneHex),
    routeIndex: 0,
    unit: cloneUnit(input.unit),
    daysOnPatrol: 0,
    daysWithoutEngagement: 0,
  };
};

// --- Default route generator ----------------------------------------------

export interface DefaultPatrolRouteInput {
  readonly anchor: Hex;
  readonly urbanHexes: readonly Hex[];
  /** Soft cap on number of hexes in the lap. Default 12. */
  readonly hexesPerLap?: number;
}

/**
 * Generate a simple cyclic patrol route covering a settlement's urban hexes.
 *
 * The naive heuristic: walk the urban hexes in input order starting from the
 * anchor, then close back to the anchor. Truncates to `hexesPerLap`. The
 * road-network-aware version belongs to a future patrol-routing pass once
 * road graphs land (T25 — currently in progress).
 */
export const defaultPatrolRoute = (input: DefaultPatrolRouteInput): readonly Hex[] => {
  const cap = input.hexesPerLap ?? 12;
  if (cap <= 0) throw new Error(`hexesPerLap must be positive, got ${cap}`);
  if (input.urbanHexes.length === 0) {
    return [cloneHex(input.anchor)];
  }
  const seen = new Set<string>();
  const out: Hex[] = [];
  const pushUnique = (h: Hex): void => {
    const k = `${h.q},${h.r}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(cloneHex(h));
  };
  pushUnique(input.anchor);
  for (const u of input.urbanHexes) {
    if (out.length >= cap) break;
    pushUnique(u);
  }
  return out;
};

// --- Tick ------------------------------------------------------------------

const advanceRoute = (patrol: Patrol): void => {
  const next = (patrol.routeIndex + 1) % patrol.route.length;
  patrol.routeIndex = next;
  patrol.position = cloneHex(patrol.route[next] as Hex);
};

/**
 * Effective patrol strength used for the engage-or-retreat decision. We weight
 * count by training and weapons relative to a bandit baseline (0.4 / 0.5).
 * Terrain bonus and posture aren't factored — those will resolve in battle.
 */
const effectiveStrength = (u: CombatUnit): number => {
  const trainFactor = u.training / 0.4;
  const weapFactor = 0.5 + u.weapons;
  return u.count * trainFactor * weapFactor;
};

const isBribed = (
  patrol: Patrol,
  camp: BanditCamp,
  reputation: ReputationTable | undefined,
): boolean => {
  if (!reputation) return false;
  return reputation.get(patrol.ownerActor, camp.ownerActor) >= BRIBERY_REP_THRESHOLD;
};

const willEngage = (patrolUnit: CombatUnit, camp: BanditCamp): boolean => {
  const ours = effectiveStrength(patrolUnit);
  // Bandit baseline strength: count * 1.0 (training=0.4) * (0.5 + 0.4 weapons) = 0.9*count.
  const theirs = camp.banditCount * camp.averageHealth * (0.5 + camp.weaponsPerBandit);
  if (theirs <= 0) return true;
  return ours / theirs >= MIN_ENGAGE_RATIO;
};

export const tickPatrol = (inputs: PatrolTickInputs): PatrolTickResult => {
  const { rng, today } = inputs;
  // Work on a shallow clone so callers' references aren't mutated.
  const patrol: Patrol = {
    ...inputs.patrol,
    position: cloneHex(inputs.patrol.position),
    unit: cloneUnit(inputs.patrol.unit),
  };
  const events: PatrolEvent[] = [];
  const pendingBattles: PendingBattleTarget[] = [];

  // 1. Step to next hex on the route.
  advanceRoute(patrol);
  patrol.daysOnPatrol += 1;
  patrol.daysWithoutEngagement += 1;

  const here = patrol.position;

  // 2. Arrival at home base resets patrol-day budget.
  const friendlyHexes = inputs.knownFriendlySettlementHexes ?? [];
  for (const f of friendlyHexes) {
    if (hexEquals(f.hex, here) && f.id === patrol.basedAt) {
      patrol.daysOnPatrol = 0;
      events.push({
        type: 'arrived_at_base',
        detail: { hex: cloneHex(here), day: today, settlementId: f.id },
      });
      break;
    }
  }

  // 3. Bandit camp encounters. Engage if camp is on the current hex.
  for (const k of inputs.knownBanditCampsOnRoute) {
    if (!hexEquals(k.hex, here)) continue;
    if (isBribed(patrol, k.camp, inputs.reputation)) {
      events.push({
        type: 'turned_blind_eye',
        detail: { hex: cloneHex(here), day: today, campId: k.camp.id, reason: 'bribed' },
      });
      continue;
    }
    if (!willEngage(patrol.unit, k.camp)) {
      events.push({
        type: 'tactical_retreat',
        detail: { hex: cloneHex(here), day: today, campId: k.camp.id, reason: 'undermanned' },
      });
      continue;
    }
    const defenderUnit = campAsCombatUnit(k.camp, 'defending');
    pendingBattles.push({
      with: { kind: 'bandit_camp', campId: k.camp.id },
      defenderUnit,
      ambushFavors: 'neither',
    });
    events.push({
      type: 'engagement',
      detail: { hex: cloneHex(here), day: today, campId: k.camp.id },
    });
    patrol.daysWithoutEngagement = 0;
  }

  // 4. Caravan inspections. Only suspicious caravans on the patrol's hex.
  for (const c of inputs.knownCaravansOnRoute) {
    if (!hexEquals(c.hex, here)) continue;
    if (!c.suspicious) continue;
    events.push({
      type: 'inspection',
      detail: { hex: cloneHex(here), day: today, caravanId: c.caravanId },
    });
    patrol.daysWithoutEngagement = 0;
  }

  // 5. (RNG reserved for future use — chance-based events like a corrupt
  //    patrol leader sometimes inspecting anyway, or a fatigued patrol
  //    skipping a fight even when nominally able. For now we draw nothing
  //    so the RNG stream stays stable across ticks.)
  void rng;

  return { patrol, events, pendingBattles };
};
