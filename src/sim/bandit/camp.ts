/**
 * Bandit camps: a special settlement-like entity in wilderness hexes.
 *
 * Per docs/12-bandits-and-conflict.md §"Bandit camps":
 *   - No buildings beyond crude shelter; stockpile is loot.
 *   - Population: bandits (combat-capable) + hangers-on (children, captives,
 *     dependents).
 *   - Decisions per turn: raid, lay low, move camp, recruit, fence, bribe.
 *   - Subject to consumption rules — bandits eat.
 *
 * This module provides:
 *   - The `BanditCamp` data model (immutable; mutators return new instances
 *     except for the `loot` Map and `treasury` field, which are mutable by
 *     design to match the Actor pattern in src/sim/politics).
 *   - `campSize` — bucket per the docs/12 capability table.
 *   - `recruit` — bandit-count delta from a recruitment migration arrival.
 *   - `decideCampAction` — per-day decision proposal. The tick layer is
 *     responsible for actually executing it.
 *   - `campAsCombatUnit` — adapter to feed the camp into the docs/12 battle
 *     resolver (src/sim/conflict).
 */

import type { CombatUnit, Posture } from '../conflict/battle.js';
import { drainDemographics, type Demographics } from '../population/demographics.js';
import type { Rng } from '../rng.js';
import type {
  ActorId,
  BanditCampId,
  Coin,
  Position,
  Quantity,
  ResourceId,
  SettlementId,
} from '../types.js';

export type CampSize = 'small' | 'medium' | 'large' | 'insurgency';

export interface BanditCamp {
  readonly id: BanditCampId;
  readonly name: string;
  readonly hex: Position;
  readonly ownerActor: ActorId;
  readonly banditCount: number;
  readonly hangersOnCount: number;
  /** Loot stockpile (resource → quantity). Mutable by design (matches Actor stockpile). */
  readonly loot: Map<ResourceId, Quantity>;
  /** Liquid coin from fenced loot or bribes. Mutable by design. */
  treasury: Coin;
  /** 0..1 — average kit. */
  readonly weaponsPerBandit: number;
  /** 0..1. */
  readonly armorPerBandit: number;
  /** 0..1. */
  readonly averageHealth: number;
  /**
   * Per-(sex, age band) split of the camp's `banditCount` fighters.
   * Optional — existing fixtures don't all carry it. When present the
   * counts should sum to `banditCount`.
   *
   * docs/12-bandits-and-conflict.md §"Bandit demographics"
   */
  readonly banditDemographics?: Demographics;
  /**
   * Per-(sex, age band) split of the camp's `hangersOnCount`. Same
   * optional/sum semantics as `banditDemographics`. Hangers-on are
   * children, captives, and non-fighting dependents.
   */
  readonly hangersOnDemographics?: Demographics;
}

export interface CreateCampInput {
  readonly id: BanditCampId;
  readonly name: string;
  readonly hex: Position;
  readonly ownerActor: ActorId;
  readonly banditCount: number;
  readonly hangersOnCount: number;
  readonly weaponsPerBandit: number;
  readonly armorPerBandit: number;
  readonly averageHealth: number;
  readonly treasury?: Coin;
  /** Optional initial loot (otherwise empty). */
  readonly loot?: ReadonlyMap<ResourceId, Quantity>;
  readonly banditDemographics?: Demographics;
  readonly hangersOnDemographics?: Demographics;
}

export type CampAction =
  | { readonly type: 'lay_low' }
  | { readonly type: 'raid_caravan'; readonly targetHex: Position }
  | { readonly type: 'raid_settlement'; readonly targetSettlement: SettlementId }
  | { readonly type: 'move_camp'; readonly toHex: Position }
  | { readonly type: 'recruit_drive' }
  | { readonly type: 'fence_loot'; readonly throughSettlement: SettlementId }
  | { readonly type: 'bribe_settlement'; readonly settlement: SettlementId; readonly amount: Coin };

export interface CampDecisionInputs {
  readonly camp: BanditCamp;
  readonly knownNearbyCaravans: readonly {
    readonly hex: Position;
    readonly estimatedCargoValue: number;
    readonly guards: number;
  }[];
  readonly knownNearbyPatrols: readonly { readonly hex: Position; readonly size: number }[];
  readonly knownFriendlySettlements: readonly {
    readonly id: SettlementId;
    readonly hex: Position;
  }[];
  readonly daysSinceLastSuccessfulRaid: number;
  readonly rng: Rng;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

const requireRange = (label: string, value: number, lo: number, hi: number): void => {
  if (!Number.isFinite(value) || value < lo || value > hi) {
    throw new Error(`${label} must be in [${lo}, ${hi}], got ${value}`);
  }
};

const requireNonNegativeInt = (label: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
};

export const createCamp = (input: CreateCampInput): BanditCamp => {
  if (input.name.length === 0) {
    throw new Error(`Camp ${String(input.id)} must have a non-empty name`);
  }
  requireNonNegativeInt('banditCount', input.banditCount);
  requireNonNegativeInt('hangersOnCount', input.hangersOnCount);
  requireRange('weaponsPerBandit', input.weaponsPerBandit, 0, 1);
  requireRange('armorPerBandit', input.armorPerBandit, 0, 1);
  requireRange('averageHealth', input.averageHealth, 0, 1);
  const treasury = input.treasury ?? 0;
  if (!Number.isFinite(treasury) || treasury < 0) {
    throw new Error(`treasury must be a non-negative finite number, got ${treasury}`);
  }
  const loot = new Map<ResourceId, Quantity>();
  if (input.loot) for (const [k, v] of input.loot) loot.set(k, v);
  return {
    id: input.id,
    name: input.name,
    hex: input.hex,
    ownerActor: input.ownerActor,
    banditCount: input.banditCount,
    hangersOnCount: input.hangersOnCount,
    weaponsPerBandit: input.weaponsPerBandit,
    armorPerBandit: input.armorPerBandit,
    averageHealth: input.averageHealth,
    treasury,
    loot,
    ...(input.banditDemographics !== undefined
      ? { banditDemographics: new Map(input.banditDemographics) }
      : {}),
    ...(input.hangersOnDemographics !== undefined
      ? { hangersOnDemographics: new Map(input.hangersOnDemographics) }
      : {}),
  };
};

export const campSize = (camp: BanditCamp): CampSize => {
  const n = camp.banditCount;
  if (n < 20) return 'small';
  if (n < 100) return 'medium';
  if (n < 500) return 'large';
  return 'insurgency';
};

/** Recruitment delta: returns a new camp with `newBandits` more bandits. */
export const recruit = (camp: BanditCamp, newBandits: number): BanditCamp => {
  if (!Number.isInteger(newBandits) || newBandits < 0) {
    throw new Error(`newBandits must be a non-negative integer, got ${newBandits}`);
  }
  return {
    ...camp,
    banditCount: camp.banditCount + newBandits,
  };
};

/**
 * Apply bandit casualties: returns a new camp with `deaths` removed from
 * `banditCount` AND from `banditDemographics` (proportionally) when
 * present. Mirrors `applyCrewCasualties` in src/sim/caravan/caravan.ts.
 *
 * Returns the drained demographics map so callers can feed deaths back
 * into the home settlement's PopulationPool (the village or city the
 * bandits were originally recruited from).
 *
 * docs/12-bandits-and-conflict.md §"Bandit demographics" — casualties.
 */
export const applyBanditCasualties = (
  camp: BanditCamp,
  deaths: number,
  rng: Rng,
): { readonly camp: BanditCamp; readonly removed: ReadonlyMap<string, number> } => {
  if (!Number.isInteger(deaths) || deaths <= 0) {
    return { camp, removed: new Map() };
  }
  const take = Math.min(camp.banditCount, deaths);
  const newCount = camp.banditCount - take;
  let drained: Map<string, number> = new Map();
  let newDemo: Demographics | undefined = camp.banditDemographics;
  if (camp.banditDemographics !== undefined) {
    const mut = new Map(camp.banditDemographics);
    drained = drainDemographics(mut, take, rng.derive('bandit-drain'));
    newDemo = mut;
  }
  return {
    camp: {
      ...camp,
      banditCount: newCount,
      ...(newDemo !== undefined ? { banditDemographics: newDemo } : {}),
    },
    removed: drained,
  };
};

/** Bandit baseline training per docs/12 §"Unit stats" (~0.4 with ± per camp). */
const BANDIT_BASE_TRAINING = 0.4;

export const campAsCombatUnit = (camp: BanditCamp, posture: Posture): CombatUnit => {
  if (camp.banditCount <= 0) {
    throw new Error(`Camp ${String(camp.id)} has no bandits to field`);
  }
  // Slight variance per camp by health: a fitter camp drills more, so training
  // shifts up to +0.05 from the base.
  const training = clamp(BANDIT_BASE_TRAINING + 0.05 * (camp.averageHealth - 0.5) * 2, 0.2, 0.6);
  return {
    id: `bandit:${String(camp.id)}`,
    count: camp.banditCount,
    training,
    weapons: camp.weaponsPerBandit,
    armor: camp.armorPerBandit,
    health: camp.averageHealth,
    posture,
    terrainBonus: 0,
  };
};

interface ScoredCaravan {
  readonly hex: Position;
  readonly estimatedCargoValue: number;
  readonly guards: number;
  readonly score: number;
}

const lootValue = (camp: BanditCamp): number => {
  // Loot value approximation: treasury + 1 unit-coin per stocked unit.
  // Real pricing comes from the market layer; this is the camp's heuristic.
  let v = camp.treasury;
  for (const qty of camp.loot.values()) v += qty;
  return v;
};

const patrolPressure = (
  camp: BanditCamp,
  patrols: CampDecisionInputs['knownNearbyPatrols'],
): number => {
  if (patrols.length === 0) return 0;
  const totalPatrol = patrols.reduce((acc, p) => acc + p.size, 0);
  const ourCombat = camp.banditCount * (0.5 + camp.weaponsPerBandit * 0.5);
  return totalPatrol / Math.max(1, ourCombat);
};

const scoreCaravan = (
  camp: BanditCamp,
  c: { hex: Position; estimatedCargoValue: number; guards: number },
): number => {
  // Score = value / (1 + guard pressure relative to camp size).
  const guardPressure = c.guards / Math.max(1, camp.banditCount * 0.5);
  return c.estimatedCargoValue / (1 + 2 * guardPressure);
};

export const decideCampAction = (inputs: CampDecisionInputs): CampAction => {
  const { camp, knownNearbyCaravans, knownNearbyPatrols, knownFriendlySettlements, rng } = inputs;
  const size = campSize(camp);
  const pressure = patrolPressure(camp, knownNearbyPatrols);

  // 1. Settlement raids — gated by camp size so smaller bands hit smaller
  //    settlements without waiting until they reach insurgency scale.
  //    insurgency (500+) hits anything; large (100-499) raids at moderate
  //    chance; medium (20-99) sends a small scouting raid at low chance
  //    against the nearest available hamlet/village. small camps don't
  //    raid settlements at all — they need caravans or recruitment.
  //
  //    Without this scaling the early-game bandit world looks dormant
  //    because (a) recruitment takes seasons to push a camp past 500
  //    bandits and (b) caravans that don't pass within sight of a camp
  //    leave the camp with nothing to do. Scouting raids give the
  //    bandits proactive behavior visible in the viewer.
  if (pressure < 1.5 && knownFriendlySettlements.length > 0) {
    let raidProb = 0;
    if (size === 'insurgency') raidProb = 0.4;
    else if (size === 'large') raidProb = 0.22;
    else if (size === 'medium') raidProb = 0.1;
    if (raidProb > 0 && rng.chance(raidProb)) {
      const target = rng.pick(knownFriendlySettlements);
      return { type: 'raid_settlement', targetSettlement: target.id };
    }
  }

  // 2. Look for a worthwhile caravan target. If present and patrol pressure
  //    permits, raid the best one.
  const scoredCaravans: ScoredCaravan[] = knownNearbyCaravans.map((c) => ({
    ...c,
    score: scoreCaravan(camp, c),
  }));
  scoredCaravans.sort((a, b) => b.score - a.score);
  if (scoredCaravans.length > 0) {
    const best = scoredCaravans[0];
    if (best) {
      // Patrol pressure suppresses raid willingness. Above ~1 the camp hesitates.
      const raidWillingness = clamp(1 - pressure * 0.5, 0, 1);
      // High-value targets above threshold push past hesitation.
      const valueBoost = clamp(best.estimatedCargoValue / 1000, 0, 0.6);
      const raidProb = clamp(raidWillingness + valueBoost, 0, 0.95);
      if (rng.chance(raidProb)) {
        return { type: 'raid_caravan', targetHex: best.hex };
      }
    }
  }

  // 3. With heavy patrol pressure and no acceptable raid, consider moving camp.
  if (pressure >= 1 && rng.chance(0.4)) {
    // Move toward a friendly settlement if any; else jitter one hex away.
    if (knownFriendlySettlements.length > 0) {
      const refuge = rng.pick(knownFriendlySettlements);
      return { type: 'move_camp', toHex: refuge.hex };
    }
    return {
      type: 'move_camp',
      toHex: { q: camp.hex.q + rng.int(-1, 1), r: camp.hex.r + rng.int(-1, 1) },
    };
  }

  // 4. If loot is high and a friendly settlement is available, fence.
  if (lootValue(camp) >= 100 && knownFriendlySettlements.length > 0) {
    if (rng.chance(0.4)) {
      const fence = rng.pick(knownFriendlySettlements);
      return { type: 'fence_loot', throughSettlement: fence.id };
    }
  }

  // 5. Recruit drive vs. lay low.
  // Recruitment is more attractive when the camp is small and pressure is low.
  const undersized = camp.banditCount < 50 ? 0.6 : 0.3;
  const recruitProb = clamp(undersized * (1 - clamp(pressure * 0.5, 0, 1)), 0, 0.9);
  if (rng.chance(recruitProb)) {
    return { type: 'recruit_drive' };
  }
  return { type: 'lay_low' };
};
