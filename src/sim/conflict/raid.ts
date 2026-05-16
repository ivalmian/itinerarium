/**
 * Settlement raid resolver: bandit-camp vs. settlement.
 *
 * Per docs/12 §"Attacks on settlements": large enough bandit bands attack
 * directly (hamlets and small villages routinely; towns rarely; cities very
 * rarely). The settlement defends with garrison soldiers, local militia
 * (idle adults grabbing whatever they have), and walls.
 *
 * This module:
 *   1. Constructs a defender CombatUnit by merging garrison patrol units
 *      with a militia bucket weighted to lower training / weapons / armor.
 *   2. Applies wallLevel as a `terrainBonus` on the defender.
 *   3. Calls `resolveBattle` (T15) with `ambush` set when there's no wall
 *      to give the patrol any warning.
 *   4. On attacker victory, transfers loot from the settlement stockpile
 *      to a returned Map, ranking by per-unit value/kg, capped at the
 *      attacker's carrying capacity.
 *   5. Computes captives as a fraction of surviving defenders +
 *      civilian casualties (a small fraction of total population proxy).
 *
 * This module is a pure function. It does NOT mutate the settlement or the
 * attacker — the tick layer applies the returned diff.
 *
 * Design references:
 *   docs/12-bandits-and-conflict.md §"Attacks on settlements" + §"Battle"
 *   docs/13-reputation-and-relationships.md §"Battle survivor system"
 *     (the survivors[] passes through to the news layer)
 */

import { campAsCombatUnit, type BanditCamp } from '../bandit/camp.js';
import { getResource } from '../resources/index.js';
import type { Rng } from '../rng.js';
import type { Quantity, ResourceId } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import { campaignerUnit, resolveBattle, type BattleResult, type CombatUnit } from './battle.js';
import type { Patrol } from './patrol.js';

export type WallLevel = 0 | 1 | 2 | 3;

export interface RaidInputs {
  readonly attacker: BanditCamp;
  readonly target: Settlement;
  /** Garrison and watch detachments stationed at this settlement. */
  readonly defendingPatrols: readonly Patrol[];
  /**
   * Pre-computed count of able-bodied idle adults the settlement can muster
   * as militia. The job-allocation layer is responsible for deciding how
   * many of the population's idle pool actually shows up under arms.
   */
  readonly militiaCount: number;
  /** 0=none, 1=palisade, 2=stone walls, 3=high walls + towers. */
  readonly wallLevel: WallLevel;
  /**
   * Snapshot of the settlement's plunderable stockpile (resource → quantity).
   * The tick layer hands this in (typically aggregated across stockpile
   * owners). Loot taken is removed from this; the returned `lootTaken` is
   * the diff to apply.
   */
  readonly settlementStockpile: ReadonlyMap<ResourceId, Quantity>;
  /**
   * Per-unit value used for loot prioritization (highest first). Defaults to
   * 1 for every resource (so loot is then ordered by available quantity /
   * stockpile insertion order — meaningless but deterministic).
   */
  readonly valueOfResource?: (id: ResourceId) => number;
  /**
   * Optional weapons/armor scores derived from the world's Person registry
   * + per-Person equipment per docs/12 §"Unit stats". When supplied,
   * override the camp's static scalar fields so combat reflects the kit
   * each bandit actually carries.
   */
  readonly attackerScoreOverride?: { readonly weapons: number; readonly armor: number };
  readonly rng: Rng;
}

export type RaidOutcome = 'attacker_won' | 'defender_won' | 'mutual_rout';

export interface RaidResult {
  readonly battle: BattleResult;
  readonly outcome: RaidOutcome;
  readonly lootTaken: ReadonlyMap<ResourceId, Quantity>;
  readonly captivesTaken: number;
  readonly banditCasualties: { readonly deaths: number; readonly wounded: number };
  readonly settlementCasualties: {
    readonly defenderDeaths: number;
    readonly civilianDeaths: number;
  };
  readonly survivors: BattleResult['survivors'];
}

// --- Constants -------------------------------------------------------------

const WALL_TERRAIN_BONUS: Record<WallLevel, number> = {
  0: 0,
  1: 0.15,
  2: 0.3,
  3: 0.45,
};

/** Bandit baseline militia stat profile (poorly equipped working-age idle). */
const MILITIA_TRAINING = 0.2;
const MILITIA_WEAPONS = 0.2;
const MILITIA_ARMOR = 0.05;
const MILITIA_HEALTH = 0.85;

/** A bandit can carry roughly 30 kg of plunder home — pack mules excluded. */
const KG_PER_BANDIT_CARRY = 30;

/** Civilian collateral on attacker victory (fraction of settlement population). */
const CIVILIAN_DEATH_FRACTION_OF_TOTAL_POPULATION = 0.005;
const CIVILIAN_CAPTIVE_FRACTION_OF_TOTAL_POPULATION = 0.01;
/** Floor on civilian captives when the attacker overruns the settlement. */
const MIN_CIVILIAN_CAPTIVES_ON_OVERRUN = 1;

// --- Defender unit construction --------------------------------------------

interface DefenderRollUp {
  count: number;
  weightedTraining: number;
  weightedWeapons: number;
  weightedArmor: number;
  weightedHealth: number;
}

const fold = (
  acc: DefenderRollUp,
  count: number,
  u: CombatUnit | null,
  raw?: { training: number; weapons: number; armor: number; health: number },
): void => {
  if (count <= 0) return;
  acc.count += count;
  if (u) {
    acc.weightedTraining += count * u.training;
    acc.weightedWeapons += count * u.weapons;
    acc.weightedArmor += count * u.armor;
    acc.weightedHealth += count * u.health;
  } else if (raw) {
    acc.weightedTraining += count * raw.training;
    acc.weightedWeapons += count * raw.weapons;
    acc.weightedArmor += count * raw.armor;
    acc.weightedHealth += count * raw.health;
  }
};

const buildDefenderUnit = (
  patrols: readonly Patrol[],
  militiaCount: number,
  wallLevel: WallLevel,
): CombatUnit => {
  const acc: DefenderRollUp = {
    count: 0,
    weightedTraining: 0,
    weightedWeapons: 0,
    weightedArmor: 0,
    weightedHealth: 0,
  };
  for (const p of patrols) fold(acc, p.unit.count, p.unit);
  if (militiaCount > 0) {
    fold(acc, militiaCount, null, {
      training: MILITIA_TRAINING,
      weapons: MILITIA_WEAPONS,
      armor: MILITIA_ARMOR,
      health: MILITIA_HEALTH,
    });
  }
  if (acc.count === 0) {
    return campaignerUnit({
      id: 'defenders',
      posture: 'defending',
      count: 1,
      training: 0,
      weapons: 0,
      armor: 0,
      health: 0.1,
      terrainBonus: WALL_TERRAIN_BONUS[wallLevel],
    });
  }
  return campaignerUnit({
    id: 'defenders',
    posture: 'defending',
    count: acc.count,
    training: acc.weightedTraining / acc.count,
    weapons: acc.weightedWeapons / acc.count,
    armor: acc.weightedArmor / acc.count,
    health: acc.weightedHealth / acc.count,
    terrainBonus: WALL_TERRAIN_BONUS[wallLevel],
  });
};

// --- Loot ---------------------------------------------------------------

interface LootCandidate {
  readonly id: ResourceId;
  readonly available: Quantity;
  readonly valuePerKg: number;
  readonly weightKgPerUnit: number;
}

const buildLootRanking = (
  stockpile: ReadonlyMap<ResourceId, Quantity>,
  valueOfResource: (id: ResourceId) => number,
): LootCandidate[] => {
  const out: LootCandidate[] = [];
  for (const [id, qty] of stockpile) {
    if (qty <= 0) continue;
    const def = getResource(id);
    const valuePerUnit = valueOfResource(id);
    const valuePerKg = valuePerUnit / def.weightKgPerUnit;
    out.push({ id, available: qty, valuePerKg, weightKgPerUnit: def.weightKgPerUnit });
  }
  // Sort by value/kg descending. Stable: ties resolve by insertion order.
  out.sort((a, b) => b.valuePerKg - a.valuePerKg);
  return out;
};

const takeLoot = (
  stockpile: ReadonlyMap<ResourceId, Quantity>,
  carryKg: number,
  valueOfResource: (id: ResourceId) => number,
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  if (carryKg <= 0) return out;
  let remainingKg = carryKg;
  for (const cand of buildLootRanking(stockpile, valueOfResource)) {
    if (remainingKg <= 0) break;
    const maxByCapacity = Math.floor(remainingKg / cand.weightKgPerUnit);
    if (maxByCapacity <= 0) continue;
    const take = Math.min(maxByCapacity, cand.available);
    if (take <= 0) continue;
    out.set(cand.id, take);
    remainingKg -= take * cand.weightKgPerUnit;
  }
  return out;
};

// --- Resolver --------------------------------------------------------------

const validateInputs = (inputs: RaidInputs): void => {
  if (![0, 1, 2, 3].includes(inputs.wallLevel)) {
    throw new Error(`wallLevel must be one of 0|1|2|3, got ${String(inputs.wallLevel)}`);
  }
  if (!Number.isInteger(inputs.militiaCount) || inputs.militiaCount < 0) {
    throw new Error(`militiaCount must be a non-negative integer, got ${inputs.militiaCount}`);
  }
};

export const resolveRaid = (inputs: RaidInputs): RaidResult => {
  validateInputs(inputs);

  // 1. Build the bandit attacker unit.
  // Bandits raiding a settlement are explicitly the attacker side. Their
  // posture is `attacking`; ambush applies when there's no wall to warn.
  const attackerUnit: CombatUnit = {
    ...campAsCombatUnit(inputs.attacker, 'attacking', inputs.attackerScoreOverride),
    id: `bandits:${String(inputs.attacker.id)}`,
  };

  // 2. Build the defender CombatUnit.
  const defenderUnit = buildDefenderUnit(
    inputs.defendingPatrols,
    inputs.militiaCount,
    inputs.wallLevel,
  );

  // 3. Resolve battle. Ambush only when walls = 0 (no warning at all).
  const battle = resolveBattle(attackerUnit, defenderUnit, {
    ambush: inputs.wallLevel === 0,
    rng: inputs.rng,
  });

  // 4. Determine outcome from winnerId.
  let outcome: RaidOutcome;
  if (battle.winnerId === attackerUnit.id) outcome = 'attacker_won';
  else if (battle.winnerId === defenderUnit.id) outcome = 'defender_won';
  else outcome = 'mutual_rout';

  // 5. Casualties — pull from the canonical battle records.
  const banditCas = battle.casualties.find((c) => c.unitId === attackerUnit.id);
  const defenderCas = battle.casualties.find((c) => c.unitId === defenderUnit.id);
  const banditCasualties = {
    deaths: banditCas?.deaths ?? 0,
    wounded: banditCas?.wounded ?? 0,
  };

  // 6. Loot + captives only flow on attacker victory.
  let lootTaken: Map<ResourceId, Quantity> = new Map();
  let captivesTaken = 0;
  let civilianDeaths = 0;
  if (outcome === 'attacker_won') {
    // Surviving bandits (the loot-carriers) are those still on the field.
    const survivingBandits = battle.finalUnits.find((u) => u.id === attackerUnit.id)?.count ?? 0;
    const carryKg = survivingBandits * KG_PER_BANDIT_CARRY;
    const valueOfResource = inputs.valueOfResource ?? (() => 1);
    lootTaken = takeLoot(inputs.settlementStockpile, carryKg, valueOfResource);

    // Captives: defenders the bandits actually took prisoner during the
    // battle (battle survivors with `captured` or `fled_captured` fates),
    // plus a fraction of the settlement's civilians dragged off.
    const defenderCaptives = battle.survivors
      .filter(
        (s) =>
          s.unitId === defenderUnit.id && (s.fate === 'captured' || s.fate === 'fled_captured'),
      )
      .reduce((acc, s) => acc + s.count, 0);
    const totalPopulation = inputs.target.population.total();
    const civilianCaptives = Math.max(
      MIN_CIVILIAN_CAPTIVES_ON_OVERRUN,
      Math.round(totalPopulation * CIVILIAN_CAPTIVE_FRACTION_OF_TOTAL_POPULATION),
    );
    captivesTaken = defenderCaptives + civilianCaptives;
    civilianDeaths = Math.round(totalPopulation * CIVILIAN_DEATH_FRACTION_OF_TOTAL_POPULATION);
  }

  return {
    battle,
    outcome,
    lootTaken,
    captivesTaken,
    banditCasualties,
    settlementCasualties: {
      defenderDeaths: defenderCas?.deaths ?? 0,
      civilianDeaths,
    },
    survivors: battle.survivors,
  };
};
