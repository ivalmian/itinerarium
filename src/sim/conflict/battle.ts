/**
 * Battle system: a probabilistic round-based resolver shared by every
 * engagement in the world (caravan ambush, patrol vs. camp, two caravans,
 * settlement defense, sieges).
 *
 * Design references:
 *   docs/12-bandits-and-conflict.md §"Battle system (locked, simple,
 *     probabilistic)" — formulas and resolution loop.
 *   docs/13-reputation-and-relationships.md §"Battle survivor system" —
 *     escaped survivors become news carriers; the survivor categorization
 *     here feeds that system.
 *
 * The resolver is a pure function over CombatUnits and an Rng. The caller
 * (a tick-layer engagement) is responsible for sourcing the units, applying
 * the result to the world, and ferrying survivors back to the news layer.
 */

import type { Rng } from '../rng.js';

export type Posture = 'attacking' | 'defending' | 'fleeing';

/** A combat unit: a group of people with shared stats. */
export interface CombatUnit {
  /** Stable id for diagnostics and survivor accounting. */
  readonly id: string;
  /** Effective combatants. Must be a positive integer. */
  readonly count: number;
  /** 0..1 — soldier ~0.9, guard ~0.6, bandit ~0.4, militia ~0.2, civilian ~0.1. */
  readonly training: number;
  /** 0..1 — none=0, basic=0.5, full kit=1. */
  readonly weapons: number;
  /** 0..1 — armor coverage. */
  readonly armor: number;
  /** 0..1 — average health (fatigue / disease / wounds). */
  readonly health: number;
  /** Initial posture. */
  readonly posture: Posture;
  /** Defender bonus when in walls, on hills, in forest cover, etc. 0..0.5 typical. */
  readonly terrainBonus: number;
}

export interface BattleOpts {
  /** If true, whichever side is `attacking` gets a free first round. */
  readonly ambush: boolean;
  readonly rng: Rng;
  /** Cap on rounds to guarantee termination. Default 10. */
  readonly maxRounds?: number;
}

export type SurvivorFate =
  | 'killed'
  | 'captured'
  | 'fled_caught_killed'
  | 'fled_captured'
  | 'fled_escaped';

export interface BattleSurvivor {
  readonly unitId: string;
  readonly fate: SurvivorFate;
  readonly count: number;
}

export interface CasualtyRecord {
  readonly unitId: string;
  readonly deaths: number;
  readonly wounded: number;
}

export interface BattleResult {
  readonly rounds: number;
  /** id of the side still standing; null on mutual rout / stalemate. */
  readonly winnerId: string | null;
  readonly loserId: string | null;
  readonly finalUnits: readonly CombatUnit[];
  readonly casualties: readonly CasualtyRecord[];
  /** Survivors split by fate. Critical input to the news-carrier system (docs/13). */
  readonly survivors: readonly BattleSurvivor[];
}

/** Threshold of casualties-per-round (as fraction of starting-of-round count) that triggers a morale check. */
const ROUT_THRESHOLD = 0.35;
/** Maximum probability of routing in a single round when above the threshold. */
const ROUT_MAX_CHANCE = 0.85;

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

const validateRange = (label: string, value: number, lo: number, hi: number): void => {
  if (!Number.isFinite(value) || value < lo || value > hi) {
    throw new Error(`${label} must be in [${lo}, ${hi}], got ${value}`);
  }
};

const validateUnit = (u: CombatUnit, slot: string): void => {
  if (!Number.isInteger(u.count) || u.count <= 0) {
    throw new Error(`${slot}.count must be a positive integer, got ${u.count}`);
  }
  validateRange(`${slot}.training`, u.training, 0, 1);
  validateRange(`${slot}.weapons`, u.weapons, 0, 1);
  validateRange(`${slot}.armor`, u.armor, 0, 1);
  validateRange(`${slot}.health`, u.health, 0, 1);
  validateRange(`${slot}.terrainBonus`, u.terrainBonus, 0, 1);
};

/** Convenience constructor that clamps free-form numeric inputs into the valid ranges. */
export const campaignerUnit = (input: {
  id: string;
  posture: Posture;
  count: number;
  training: number;
  weapons: number;
  armor: number;
  health: number;
  terrainBonus: number;
}): CombatUnit => {
  if (!Number.isInteger(input.count) || input.count <= 0) {
    throw new Error(`count must be a positive integer, got ${input.count}`);
  }
  return {
    id: input.id,
    count: input.count,
    posture: input.posture,
    training: clamp(input.training, 0, 1),
    weapons: clamp(input.weapons, 0, 1),
    armor: clamp(input.armor, 0, 1),
    health: clamp(input.health, 0, 1),
    terrainBonus: clamp(input.terrainBonus, 0, 0.5),
  };
};

interface MutableUnit {
  readonly id: string;
  count: number;
  readonly training: number;
  readonly weapons: number;
  readonly armor: number;
  health: number;
  posture: Posture;
  readonly terrainBonus: number;
  /** Per-unit running tallies. */
  deaths: number;
  wounded: number;
  /** Cumulative count of survivors that fled the field (a subset of count loss). */
  fled: number;
}

const mutableFrom = (u: CombatUnit): MutableUnit => ({
  id: u.id,
  count: u.count,
  training: u.training,
  weapons: u.weapons,
  armor: u.armor,
  health: u.health,
  posture: u.posture,
  terrainBonus: u.terrainBonus,
  deaths: 0,
  wounded: 0,
  fled: 0,
});

const attackChance = (u: MutableUnit): number => u.training * (0.4 + 0.6 * u.weapons) * u.health;

const defenseChance = (u: MutableUnit): number =>
  clamp(u.training * (0.3 + 0.7 * u.armor) * u.health + u.terrainBonus, 0, 0.95);

const pursuitSpeed = (u: MutableUnit): number => u.training * u.health;

/**
 * Apply casualties to a unit. Returns deaths and wounded counts.
 *
 * Casualty split is governed by armor: more armor → more wounds, fewer deaths.
 * (A blow that would kill an unarmored man tends to leave an armored one wounded.)
 *
 * Only deaths reduce `count` (effective combatants); wounded stay nominally with
 * the formation but pull down its average `health`. When the unit is later
 * destroyed or routed, its standing wounded become casualties of the rout
 * (captured or abandoned) — that bookkeeping happens in `resolveBattle`.
 */
const applyCasualties = (
  unit: MutableUnit,
  rawCasualties: number,
): { deaths: number; wounded: number } => {
  const losses = Math.min(unit.count, Math.max(0, Math.round(rawCasualties)));
  if (losses === 0) return { deaths: 0, wounded: 0 };
  // Death share decreases with armor: armor=0 → ~0.7 dead, armor=1 → ~0.25 dead.
  const deathShare = clamp(0.7 - 0.45 * unit.armor, 0.1, 0.9);
  const deaths = Math.round(losses * deathShare);
  const wounded = losses - deaths;
  unit.count -= deaths;
  unit.deaths += deaths;
  unit.wounded += wounded;
  if (unit.count > 0 && wounded > 0) {
    const woundFraction = wounded / unit.count;
    unit.health = clamp(unit.health * (1 - 0.4 * Math.min(1, woundFraction)), 0.05, 1);
  }
  return { deaths, wounded };
};

interface SidePlan {
  readonly side: MutableUnit;
  readonly opponent: MutableUnit;
  /** True if this side gets a free strike this round. */
  freeStrike: boolean;
}

/**
 * Run one engagement round. Returns true if combat continues, false otherwise
 * (one or both sides have routed or been destroyed).
 */
const runRound = (a: MutableUnit, b: MutableUnit, rng: Rng, ambushAttacker: boolean): void => {
  // Determine free-strike side this round.
  // Ambush only applies to the very first round; it's handled by the caller
  // setting `ambushAttacker` only on round 1.
  const plans: SidePlan[] = [
    { side: a, opponent: b, freeStrike: ambushAttacker && a.posture === 'attacking' },
    { side: b, opponent: a, freeStrike: ambushAttacker && b.posture === 'attacking' },
  ];

  // If a free strike is in play, the strikee does not return fire this round.
  const freeStrikers = plans.filter((p) => p.freeStrike);
  const acting = freeStrikers.length > 0 ? freeStrikers : plans;

  // Snapshot start-of-round counts for morale & damage so simultaneity is fair.
  const startCounts = new Map<string, number>([
    [a.id, a.count],
    [b.id, b.count],
  ]);

  const pendingCasualties = new Map<string, number>();
  for (const plan of acting) {
    const { side, opponent } = plan;
    if (side.count <= 0 || opponent.count <= 0) continue;
    if (side.posture === 'fleeing') continue;
    const aChance = attackChance(side);
    const dChance = defenseChance(opponent);
    const rngFactor = rng.float(0.6, 1.4);
    const damage = side.count * aChance * rngFactor;
    const raw = damage * (1 - dChance);
    pendingCasualties.set(opponent.id, (pendingCasualties.get(opponent.id) ?? 0) + raw);
  }

  for (const [unitId, raw] of pendingCasualties) {
    const target = unitId === a.id ? a : b;
    applyCasualties(target, raw);
  }

  // Morale check: any side that took heavy casualties this round may rout.
  for (const u of [a, b]) {
    if (u.count <= 0) continue;
    if (u.posture === 'fleeing') continue;
    const start = startCounts.get(u.id) ?? u.count;
    const lost = start - u.count;
    const fraction = lost / Math.max(1, start);
    if (fraction >= ROUT_THRESHOLD) {
      // Higher training resists routing; tail probability scales with casualty fraction.
      const overflow = clamp((fraction - ROUT_THRESHOLD) / (1 - ROUT_THRESHOLD), 0, 1);
      const trainingResist = u.training; // 0..1
      const routChance = clamp(ROUT_MAX_CHANCE * overflow * (1 - 0.5 * trainingResist), 0, 1);
      if (rng.chance(routChance)) {
        u.posture = 'fleeing';
      }
    }
  }
};

/**
 * After combat, resolve fates of fleers vs. an active pursuer.
 * The pursuer chooses to chase if still combat-effective.
 *
 * Pursuit success per fleer is governed by relative pursuit_speed; failed
 * pursuit means the fleer escapes. A successful catch may kill or capture.
 */
const resolvePursuit = (
  fled: MutableUnit,
  pursuer: MutableUnit | null,
  rng: Rng,
): { caughtKilled: number; captured: number; escaped: number } => {
  const total = fled.count;
  if (total <= 0) return { caughtKilled: 0, captured: 0, escaped: 0 };
  if (!pursuer || pursuer.count <= 0 || pursuer.posture === 'fleeing') {
    return { caughtKilled: 0, captured: 0, escaped: total };
  }
  // Probability each fleer is caught. Pursuer faster → more catches.
  // We treat fled units as exhausted (health *= 0.7) to favor pursuit.
  const fleeSpeed = pursuitSpeed(fled) * 0.7;
  const chaseSpeed = pursuitSpeed(pursuer);
  const catchProb = clamp((chaseSpeed - fleeSpeed + 0.3) / 1.3, 0.05, 0.95);
  let caught = 0;
  for (let i = 0; i < total; i++) {
    if (rng.chance(catchProb)) caught++;
  }
  const escaped = total - caught;
  // Of those caught: armor / training pushes toward capture (worth ransom)
  // rather than outright kill. Pursuer's choice modeled as pure stats.
  // killShare drops with fleer's armor.
  const killShare = clamp(0.6 - 0.3 * fled.armor, 0.2, 0.85);
  const caughtKilled = Math.round(caught * killShare);
  const captured = caught - caughtKilled;
  return { caughtKilled, captured, escaped };
};

const isCombatEffective = (u: MutableUnit): boolean => u.count > 0 && u.posture !== 'fleeing';

const freezeUnit = (u: MutableUnit): CombatUnit => ({
  id: u.id,
  count: u.count,
  training: u.training,
  weapons: u.weapons,
  armor: u.armor,
  health: u.health,
  posture: u.posture,
  terrainBonus: u.terrainBonus,
});

export const resolveBattle = (
  side1: CombatUnit,
  side2: CombatUnit,
  opts: BattleOpts,
): BattleResult => {
  validateUnit(side1, 'side1');
  validateUnit(side2, 'side2');
  if (side1.id === side2.id) {
    throw new Error(`side1 and side2 must have distinct ids (both '${side1.id}')`);
  }
  const maxRounds = opts.maxRounds ?? 10;
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
    throw new Error(`maxRounds must be a positive integer, got ${maxRounds}`);
  }

  const a = mutableFrom(side1);
  const b = mutableFrom(side2);
  const rng = opts.rng;

  let rounds = 0;
  for (let i = 0; i < maxRounds; i++) {
    if (a.count <= 0 || b.count <= 0) break;
    if (a.posture === 'fleeing' || b.posture === 'fleeing') break;
    rounds++;
    runRound(a, b, rng, opts.ambush && i === 0);
  }

  // Pursuit phase. The side still combat-effective pursues the other if it routed.
  const aEff = isCombatEffective(a);
  const bEff = isCombatEffective(b);

  // Track fled counts: if a side is in `fleeing` posture, its remaining count
  // is the pool of fleers eligible for pursuit. Routed-and-destroyed are
  // already counted as deaths in `runRound`.
  const fledByUnit = new Map<string, number>();
  if (a.posture === 'fleeing' && a.count > 0) fledByUnit.set(a.id, a.count);
  if (b.posture === 'fleeing' && b.count > 0) fledByUnit.set(b.id, b.count);

  // Resolve pursuit for each fleer.
  const survivorRecords: BattleSurvivor[] = [];
  for (const u of [a, b]) {
    const fledCount = fledByUnit.get(u.id) ?? 0;
    if (fledCount > 0) {
      // The other side pursues if it's combat-effective.
      const pursuer = u.id === a.id ? (bEff ? b : null) : aEff ? a : null;
      // Treat the fleeing pool as a temporary unit for pursuit math.
      const fleerSnapshot: MutableUnit = {
        id: u.id,
        count: fledCount,
        training: u.training,
        weapons: u.weapons,
        armor: u.armor,
        health: u.health * 0.8,
        posture: 'fleeing',
        terrainBonus: 0,
        deaths: 0,
        wounded: 0,
        fled: 0,
      };
      const { caughtKilled, captured, escaped } = resolvePursuit(fleerSnapshot, pursuer, rng);
      // Caught-killed count as additional deaths on the unit. Captured and
      // escaped have all left the field — none are in `finalUnits`.
      u.deaths += caughtKilled;
      u.count -= caughtKilled + captured + escaped;
      u.fled = fledCount;
      if (caughtKilled > 0)
        survivorRecords.push({ unitId: u.id, fate: 'fled_caught_killed', count: caughtKilled });
      if (captured > 0)
        survivorRecords.push({ unitId: u.id, fate: 'fled_captured', count: captured });
      if (escaped > 0) survivorRecords.push({ unitId: u.id, fate: 'fled_escaped', count: escaped });
    }
  }

  // Account remaining count on each unit. Two cases for a "survivor" still on the field:
  //   - the side won (or stalemate): they survived as `killed=0` non-fled; we
  //     do NOT label winners as `killed`; we simply do not emit a survivor row
  //     for surviving combat-effective troops (they're alive, on-field, and
  //     fully captured by `finalUnits`).
  //   - the side was destroyed in combat (count==0, never fled): all losses
  //     are `killed`.
  // Captured troops who didn't flee: a routed unit that got caught is captured-fled;
  // a unit fully destroyed in stand-up combat has no captives in this simple model.

  // Emit a `killed` row only for those who died in combat (deaths minus
  // those caught-during-flight already emitted as `fled_caught_killed`).
  for (const u of [a, b]) {
    const fledCaughtKilled = survivorRecords
      .filter((s) => s.unitId === u.id && s.fate === 'fled_caught_killed')
      .reduce((acc, s) => acc + s.count, 0);
    const inCombatDeaths = u.deaths - fledCaughtKilled;
    if (inCombatDeaths > 0) {
      survivorRecords.push({ unitId: u.id, fate: 'killed', count: inCombatDeaths });
    }
  }

  // Sort survivors deterministically: by unitId then fate.
  const fateOrder: Record<SurvivorFate, number> = {
    killed: 0,
    captured: 1,
    fled_caught_killed: 2,
    fled_captured: 3,
    fled_escaped: 4,
  };
  survivorRecords.sort((x, y) => {
    if (x.unitId !== y.unitId) return x.unitId < y.unitId ? -1 : 1;
    return fateOrder[x.fate] - fateOrder[y.fate];
  });

  // Determine winner.
  let winnerId: string | null;
  let loserId: string | null;
  const aGone = a.count <= 0 || a.posture === 'fleeing';
  const bGone = b.count <= 0 || b.posture === 'fleeing';
  if (aGone && bGone) {
    winnerId = null;
    loserId = null;
  } else if (aGone) {
    winnerId = b.id;
    loserId = a.id;
  } else if (bGone) {
    winnerId = a.id;
    loserId = b.id;
  } else {
    // Both still standing — true stalemate (hit maxRounds with both effective).
    winnerId = null;
    loserId = null;
  }

  const casualties: CasualtyRecord[] = [
    { unitId: a.id, deaths: a.deaths, wounded: a.wounded },
    { unitId: b.id, deaths: b.deaths, wounded: b.wounded },
  ];

  return {
    rounds,
    winnerId,
    loserId,
    finalUnits: [freezeUnit(a), freezeUnit(b)],
    casualties,
    survivors: survivorRecords,
  };
};
