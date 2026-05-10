/**
 * News carriers — the second half of docs/13.
 *
 * A NewsCarrier is a person walking toward a friendly settlement carrying
 * first-hand testimony of a recent action. They take real time to arrive
 * (~20 km/day for a refugee on foot per docs/13). On arrival, the news is
 * delivered to local named characters and reputation slates update.
 *
 * Pillar 1 ("no hidden hands") forbids instant propagation: every reputation
 * update is anchored to a specific carrier walking a specific route. This
 * module is that machinery.
 *
 * For now movement is a straight-line cube-lerp on the hex grid; a later
 * integration task will route carriers through the real A* pathfinder
 * (T10) so terrain and roads matter.
 */

import type { Day } from '../types.js';
import { hex, hexDistance, type Hex } from '../world/hex.js';
import type { ReputationEvent, ReputationKey, ReputationMagnitude } from './table.js';

/** Default refugee walking speed in hexes (km) per day, per docs/13. */
const DEFAULT_REFUGEE_SPEED = 20;

export interface NewsItem {
  readonly id: string;
  readonly perpetrator: ReputationKey;
  /** The named character harmed by the action, if any. */
  readonly victim: ReputationKey | null;
  readonly magnitude: ReputationMagnitude;
  readonly isCriminalAct: boolean;
  readonly occurredAtHex: Hex;
  readonly occurredOnDay: Day;
  /** Optional severity hint for docs/12 integration (battle survivors). */
  readonly battleSurvivors?: number;
}

export interface CreateNewsItemInput {
  readonly id: string;
  readonly perpetrator: ReputationKey;
  readonly victim: ReputationKey | null;
  readonly magnitude: ReputationMagnitude;
  readonly isCriminalAct: boolean;
  readonly occurredAtHex: Hex;
  readonly occurredOnDay: Day;
  readonly battleSurvivors?: number;
}

export const createNewsItem = (input: CreateNewsItemInput): NewsItem => {
  if (input.id.length === 0) {
    throw new Error('NewsItem id must be non-empty');
  }
  return {
    id: input.id,
    perpetrator: input.perpetrator,
    victim: input.victim,
    magnitude: input.magnitude,
    isCriminalAct: input.isCriminalAct,
    occurredAtHex: input.occurredAtHex,
    occurredOnDay: input.occurredOnDay,
    ...(input.battleSurvivors !== undefined ? { battleSurvivors: input.battleSurvivors } : {}),
  };
};

export interface NewsCarrier {
  readonly id: string;
  readonly carrying: NewsItem;
  readonly position: Hex;
  readonly destination: Hex;
  /** ~20 hexes (km) per day for a refugee on foot. */
  readonly movementPointsPerDay: number;
  readonly arrived: boolean;
  readonly startedOnDay: Day;
}

export interface CreateNewsCarrierInput {
  readonly id: string;
  readonly news: NewsItem;
  readonly spawnHex: Hex;
  readonly destination: Hex;
  readonly spawnDay: Day;
  readonly speed?: number;
}

export const createNewsCarrier = (input: CreateNewsCarrierInput): NewsCarrier => {
  if (input.id.length === 0) {
    throw new Error('NewsCarrier id must be non-empty');
  }
  const speed = input.speed ?? DEFAULT_REFUGEE_SPEED;
  if (!(speed > 0) || !Number.isFinite(speed)) {
    throw new Error(`NewsCarrier speed must be positive finite, got ${speed}`);
  }
  const arrived = hexDistance(input.spawnHex, input.destination) === 0;
  return {
    id: input.id,
    carrying: input.news,
    position: input.spawnHex,
    destination: input.destination,
    movementPointsPerDay: speed,
    arrived,
    startedOnDay: input.spawnDay,
  };
};

// ---------------------------------------------------------------------------
// Movement: cube-coord lerp + round to walk the carrier `speed` hexes toward
// destination per tick. Determinism only requires that the result is a pure
// function of the inputs — we do not consult the RNG here.
// ---------------------------------------------------------------------------

interface CubeHex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const toCube = (h: Hex): CubeHex => ({ x: h.q, z: h.r, y: -h.q - h.r });

const fromCube = (c: CubeHex): Hex => hex(c.x, c.z);

/** Standard cube-rounding: round each coord, fix the one with the largest delta. */
const cubeRound = (c: CubeHex): CubeHex => {
  let rx = Math.round(c.x);
  let ry = Math.round(c.y);
  let rz = Math.round(c.z);
  const dx = Math.abs(rx - c.x);
  const dy = Math.abs(ry - c.y);
  const dz = Math.abs(rz - c.z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx, y: ry, z: rz };
};

const cubeLerp = (a: CubeHex, b: CubeHex, t: number): CubeHex => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Step `speed` hexes from `from` toward `to`. Stops at `to` (no overshoot). */
const stepToward = (from: Hex, to: Hex, speed: number): Hex => {
  const distance = hexDistance(from, to);
  if (distance === 0) return from;
  if (speed >= distance) return to;
  const t = speed / distance;
  return fromCube(cubeRound(cubeLerp(toCube(from), toCube(to), t)));
};

/**
 * Per-day movement step. Returns a new carrier (input is not mutated). When
 * the carrier reaches the destination the returned carrier has `arrived =
 * true`; subsequent ticks are no-ops. The `today` parameter is reserved for a
 * future change where carriers track actual elapsed days; currently we only
 * use the spawn day.
 */
export const tickCarrier = (carrier: NewsCarrier, _today: Day): NewsCarrier => {
  if (carrier.arrived) return carrier;
  const next = stepToward(carrier.position, carrier.destination, carrier.movementPointsPerDay);
  const arrived = hexDistance(next, carrier.destination) === 0;
  return {
    ...carrier,
    position: next,
    arrived,
  };
};

// ---------------------------------------------------------------------------
// Arrival → ReputationEvent.
// ---------------------------------------------------------------------------

/** Per-receiver alignment with the news. The caller (settlement-entry handler) computes this from local relationships. */
export type ReceiverAlignment =
  | 'victim_aligned'
  | 'victim_rival'
  | 'authority'
  | 'honest'
  | 'bandit_aligned';

export interface ArrivalReceiver {
  readonly holder: ReputationKey;
  readonly alignment: ReceiverAlignment;
}

export interface ArrivalContext {
  readonly receivers: readonly ArrivalReceiver[];
}

/**
 * Convert a carrier-arrival into a ReputationEvent suitable for
 * `applyReputationEvent`. Receivers are partitioned by their alignment with
 * the news; the news's perpetrator and victim flow through unchanged.
 *
 * If multiple receivers list themselves as `authority`, the first wins
 * (matches docs/13: a settlement has one authority who matters in its
 * jurisdiction).
 */
export const arrivalToReputationEvent = (
  carrier: NewsCarrier,
  ctx: ArrivalContext,
): ReputationEvent => {
  const news = carrier.carrying;
  const victimAlliedActors: ReputationKey[] = [];
  const victimRivalActors: ReputationKey[] = [];
  const banditAligned: ReputationKey[] = [];
  const honestThirdParties: ReputationKey[] = [];
  let authority: ReputationKey | null = null;

  for (const r of ctx.receivers) {
    switch (r.alignment) {
      case 'victim_aligned':
        victimAlliedActors.push(r.holder);
        break;
      case 'victim_rival':
        victimRivalActors.push(r.holder);
        break;
      case 'authority':
        if (authority === null) authority = r.holder;
        break;
      case 'honest':
        honestThirdParties.push(r.holder);
        break;
      case 'bandit_aligned':
        banditAligned.push(r.holder);
        break;
    }
  }

  return {
    perpetrator: news.perpetrator,
    victim: news.victim,
    victimAlliedActors,
    victimRivalActors,
    authority,
    banditAligned,
    honestThirdParties,
    magnitude: news.magnitude,
    isCriminalAct: news.isCriminalAct,
  };
};
