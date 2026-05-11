/**
 * Caravan ambush resolver: bandit camp vs. caravan on the road.
 *
 * Per docs/12 §"Risk: Banditry" and the Examples list ("a band of 30
 * bandits surprises a caravan of 4 drovers + 2 guards…"): the same
 * battle mechanic resolves the encounter, with terrain modulating the
 * ambush effect — dense forest and mountains favor the ambusher, open
 * plains favor the defender.
 *
 * This module is the companion to `raid.ts` (T38, settlement raid). It
 * shares the same shape: build a defender CombatUnit, run the battle,
 * compute loot transfer, captives, casualties. Caravan-specific bits:
 *   - Defender stats come from the crew kind mix (soldier/guard/drover/
 *     merchant), each with its own training profile.
 *   - Treasury is fully taken on attacker victory (small enough that
 *     it fits in a coin pouch — no carry cap on coin).
 *   - Cargo is taken by value/kg, capped at the bandits' carry limit
 *     (~30 kg/bandit, same as a settlement raid).
 *   - "caravan_fled" is a distinct outcome: the caravan routed but the
 *     bandits don't fully overrun it; some cargo is dropped on the road
 *     for the bandits to pick up.
 *
 * Pure function — does not mutate caravan or camp. The tick layer
 * applies the returned diff.
 *
 * Design references:
 *   docs/12-bandits-and-conflict.md §"Risk: Banditry" + §"Battle"
 *   docs/06-caravans.md §"Crew composition"
 *   docs/13-reputation-and-relationships.md §"Battle survivor system"
 */

import { campAsCombatUnit, type BanditCamp } from '../bandit/camp.js';
import {
  ANIMAL_KINDS,
  totalCrewCount,
  type Caravan,
  type CrewKind,
  type CrewMember,
} from '../caravan/caravan.js';
import { getResource } from '../resources/index.js';
import type { Rng } from '../rng.js';
import type { Coin, Quantity, ResourceId } from '../types.js';
import type { Terrain } from '../world/terrain.js';
import { campaignerUnit, resolveBattle, type BattleResult, type CombatUnit } from './battle.js';

export interface AmbushInputs {
  readonly attacker: BanditCamp;
  readonly target: Caravan;
  /** Terrain the encounter happens on. Modulates ambush bonus. */
  readonly ambushHexTerrain: Terrain;
  /**
   * Per-unit value used for cargo prioritization (highest first). Defaults to
   * 1 for every resource — without a price oracle the value/kg ranking
   * collapses to weight/kg only. Same hook shape as raid.ts's loot picker.
   */
  readonly valueOfResource?: (id: ResourceId) => number;
  readonly rng: Rng;
}

export type AmbushOutcome = 'attacker_won' | 'defender_won' | 'mutual_rout' | 'caravan_fled';

export interface AmbushResult {
  readonly battle: BattleResult;
  readonly outcome: AmbushOutcome;
  readonly cargoTaken: ReadonlyMap<ResourceId, Quantity>;
  readonly coinTaken: Coin;
  readonly captivesTaken: number;
  readonly banditCasualties: { readonly deaths: number; readonly wounded: number };
  readonly caravanCasualties: {
    readonly crewDeaths: number;
    readonly animalDeaths: number;
  };
  readonly survivors: BattleResult['survivors'];
}

// --- Constants -------------------------------------------------------------

/** Per-crew-kind training (docs/12 §"Unit stats"). */
const CREW_TRAINING: Record<CrewKind, number> = {
  soldier: 0.9,
  caravan_guard: 0.6,
  drover: 0.2,
  merchant: 0.1,
};

/**
 * Terrain ambush bonus: how much terrainBonus the *attacker* gets when
 * surprising a caravan here. Open ground gives little advantage; dense
 * cover gives a lot. Capped at 0.5 to match docs/12's terrain_bonus
 * range and the campaignerUnit clamp.
 */
const TERRAIN_AMBUSH_BONUS: Record<Terrain, number> = {
  plains: 0.05,
  fertile_valley: 0.05,
  steppe: 0.05,
  hills: 0.25,
  desert: 0.1,
  forest: 0.35,
  dense_forest: 0.5,
  marsh: 0.4,
  mountains: 0.5,
  river: 0.2,
  lake: 0,
  urban: 0,
  ruin: 0.3,
};

/** Same carry cap as T38 — a bandit can lug ~30 kg of plunder home. */
const KG_PER_BANDIT_CARRY = 30;

/**
 * Per-surviving-defender chance of being taken captive on attacker victory.
 * Drovers and merchants are more often grabbed (ransom / slavery); soldiers
 * tend to die fighting. We model this with a single rate scaled by the
 * average non-soldier fraction of the surviving crew.
 */
const CAPTIVE_PROB_PER_SURVIVOR = 0.5;

/** When a routed caravan flees, this fraction of its cargo is dropped on the road. */
const FLEE_DROP_FRACTION = 0.4;

/** Animal deaths approximate fraction of caravan deaths (animals get hit too). */
const ANIMAL_DEATH_FRACTION_OF_CREW_DEATHS = 0.5;

// --- Defender unit construction --------------------------------------------

interface DefenderRollUp {
  count: number;
  weightedTraining: number;
  weightedWeapons: number;
  weightedArmor: number;
}

const foldCrew = (acc: DefenderRollUp, m: CrewMember): void => {
  if (m.count <= 0) return;
  acc.count += m.count;
  acc.weightedTraining += m.count * CREW_TRAINING[m.kind];
  acc.weightedWeapons += m.count * m.weapons;
  acc.weightedArmor += m.count * m.armor;
};

const buildCaravanDefender = (caravan: Caravan): CombatUnit => {
  const acc: DefenderRollUp = {
    count: 0,
    weightedTraining: 0,
    weightedWeapons: 0,
    weightedArmor: 0,
  };
  for (const m of caravan.crew) foldCrew(acc, m);
  // Caravans always have at least one crew entry (validated by createCaravan)
  // but defensively handle the zero-count edge.
  if (acc.count === 0) {
    return campaignerUnit({
      id: 'caravan',
      posture: 'defending',
      count: 1,
      training: 0,
      weapons: 0,
      armor: 0,
      health: Math.max(0.05, caravan.health),
      terrainBonus: 0,
    });
  }
  return campaignerUnit({
    id: 'caravan',
    posture: 'defending',
    count: acc.count,
    training: acc.weightedTraining / acc.count,
    weapons: acc.weightedWeapons / acc.count,
    armor: acc.weightedArmor / acc.count,
    health: Math.max(0.05, caravan.health),
    terrainBonus: 0,
  });
};

// --- Cargo selection ------------------------------------------------------

interface CargoCandidate {
  readonly id: ResourceId;
  readonly available: Quantity;
  readonly valuePerKg: number;
  readonly weightKgPerUnit: number;
}

const buildCargoRanking = (
  cargo: ReadonlyMap<ResourceId, Quantity>,
  valueOfResource: (id: ResourceId) => number,
): CargoCandidate[] => {
  const out: CargoCandidate[] = [];
  for (const [id, qty] of cargo) {
    if (qty <= 0) continue;
    const def = getResource(id);
    const valuePerKg = valueOfResource(id) / def.weightKgPerUnit;
    out.push({ id, available: qty, valuePerKg, weightKgPerUnit: def.weightKgPerUnit });
  }
  out.sort((a, b) => b.valuePerKg - a.valuePerKg);
  return out;
};

const takeCargo = (
  cargo: ReadonlyMap<ResourceId, Quantity>,
  carryKg: number,
  maxAvailableScale: number,
  valueOfResource: (id: ResourceId) => number,
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  if (carryKg <= 0 || maxAvailableScale <= 0) return out;
  let remainingKg = carryKg;
  for (const c of buildCargoRanking(cargo, valueOfResource)) {
    if (remainingKg <= 0) break;
    const maxByCapacity = Math.floor(remainingKg / c.weightKgPerUnit);
    if (maxByCapacity <= 0) continue;
    const maxByAvailable = Math.floor(c.available * maxAvailableScale);
    const take = Math.min(maxByCapacity, maxByAvailable);
    if (take <= 0) continue;
    out.set(c.id, take);
    remainingKg -= take * c.weightKgPerUnit;
  }
  return out;
};

// --- Animals --------------------------------------------------------------

const totalAnimalCount = (c: Caravan): number => {
  let n = 0;
  for (const k of ANIMAL_KINDS) n += c.animals[k] ?? 0;
  return n;
};

// --- Resolver --------------------------------------------------------------

export const resolveAmbush = (inputs: AmbushInputs): AmbushResult => {
  // 1. Build the bandit attacker unit. Apply terrain ambush bonus to the
  //    attacker (caravans don't have walls; the surprise is the cover).
  const baseUnit = campAsCombatUnit(inputs.attacker, 'attacking');
  const terrainBonus = TERRAIN_AMBUSH_BONUS[inputs.ambushHexTerrain];
  const attackerUnit: CombatUnit = campaignerUnit({
    id: `bandits:${String(inputs.attacker.id)}`,
    posture: 'attacking',
    count: baseUnit.count,
    training: baseUnit.training,
    weapons: baseUnit.weapons,
    armor: baseUnit.armor,
    health: baseUnit.health,
    terrainBonus,
  });

  // 2. Caravan defender.
  const defenderUnit = buildCaravanDefender(inputs.target);

  // 3. Battle. Ambush flag set when the terrain offers real cover (any
  //    bonus above the open-ground baseline triggers free first round).
  const ambush = terrainBonus >= 0.2;
  const battle = resolveBattle(attackerUnit, defenderUnit, {
    ambush,
    rng: inputs.rng,
  });

  // 4. Outcome classification.
  //    caravan_fled fires when defender broke EARLY — before being
  //    heavily mauled in stand-up combat. The signal we use: posture is
  //    'fleeing' AND in-combat deaths are less than half the starting
  //    crew. A caravan that stood and fought to near-annihilation before
  //    its last few broke is recorded as attacker_won, even if pursuit
  //    let one or two escape.
  const startCrew = totalCrewCount(inputs.target);
  const finalDefender = battle.finalUnits.find((u) => u.id === defenderUnit.id);
  const finalAttacker = battle.finalUnits.find((u) => u.id === attackerUnit.id);
  const defenderEscaped = battle.survivors
    .filter((s) => s.unitId === defenderUnit.id && s.fate === 'fled_escaped')
    .reduce((acc, s) => acc + s.count, 0);
  // Two paths to caravan_fled: either more than half escaped (clear rout
  // with most surviving), or attacker overwhelmingly outnumbers defender
  // (≥8:1) so the rout was inevitable and any escapees count as a flight.
  // The asymmetry matches docs/12: "small caravan ambushed by a much
  // larger band so it routs in the first round" → caravan_fled.
  const overwhelmingAttacker = inputs.attacker.banditCount >= startCrew * 8;
  const defenderFledEarly =
    finalDefender?.posture === 'fleeing' &&
    defenderEscaped > 0 &&
    (overwhelmingAttacker || defenderEscaped * 2 > startCrew);
  const attackerFled = finalAttacker?.posture === 'fleeing';

  let outcome: AmbushOutcome;
  if (defenderFledEarly && !attackerFled) {
    outcome = 'caravan_fled';
  } else if (battle.winnerId === attackerUnit.id) {
    outcome = 'attacker_won';
  } else if (battle.winnerId === defenderUnit.id) {
    outcome = 'defender_won';
  } else {
    outcome = 'mutual_rout';
  }

  // 5. Casualties pulled from the canonical battle records.
  const banditCas = battle.casualties.find((c) => c.unitId === attackerUnit.id);
  const defenderCas = battle.casualties.find((c) => c.unitId === defenderUnit.id);
  const banditCasualties = {
    deaths: banditCas?.deaths ?? 0,
    wounded: banditCas?.wounded ?? 0,
  };
  const crewDeaths = defenderCas?.deaths ?? 0;

  // 6. Loot + captives flow on attacker victory or caravan flee.
  let cargoTaken: Map<ResourceId, Quantity> = new Map();
  let coinTaken: Coin = 0;
  let captivesTaken = 0;
  if (outcome === 'attacker_won' || outcome === 'caravan_fled') {
    const survivingBandits = battle.finalUnits.find((u) => u.id === attackerUnit.id)?.count ?? 0;
    const carryKg = survivingBandits * KG_PER_BANDIT_CARRY;
    const valueOfResource = inputs.valueOfResource ?? (() => 1);
    // On caravan_fled, bandits only get the fraction of cargo dropped on the road.
    const availableScale = outcome === 'attacker_won' ? 1 : FLEE_DROP_FRACTION;
    cargoTaken = takeCargo(inputs.target.cargo, carryKg, availableScale, valueOfResource);
    if (outcome === 'attacker_won') {
      // Coin pouch is light; bandits take all of it.
      coinTaken = Math.max(0, inputs.target.treasury);
      // Captives: defenders explicitly captured during the battle (survivor
      // fates `captured`/`fled_captured`), plus a fraction of any uninjured
      // crew left on the field, plus the wounded crew abandoned on the road.
      // Soldiers fight to the death; everyone else may be captured.
      const startCrew = totalCrewCount(inputs.target);
      const soldierCount = inputs.target.crew
        .filter((m) => m.kind === 'soldier')
        .reduce((acc, m) => acc + m.count, 0);
      const nonSoldierFraction = startCrew > 0 ? 1 - soldierCount / startCrew : 1;
      const survivorCaptured = battle.survivors
        .filter(
          (s) =>
            s.unitId === defenderUnit.id &&
            (s.fate === 'captured' || s.fate === 'fled_captured'),
        )
        .reduce((acc, s) => acc + s.count, 0);
      const survivingDefenders =
        battle.finalUnits.find((u) => u.id === defenderUnit.id)?.count ?? 0;
      const fromOnField = Math.round(
        survivingDefenders * CAPTIVE_PROB_PER_SURVIVOR * nonSoldierFraction,
      );
      const woundedTaken = Math.round((defenderCas?.wounded ?? 0) * nonSoldierFraction);
      captivesTaken = survivorCaptured + fromOnField + woundedTaken;
    }
  }

  // 7. Animal deaths: a fraction of crew deaths (pack animals get hit).
  const totalAnimals = totalAnimalCount(inputs.target);
  const animalDeaths = Math.min(
    totalAnimals,
    Math.round(crewDeaths * ANIMAL_DEATH_FRACTION_OF_CREW_DEATHS),
  );

  return {
    battle,
    outcome,
    cargoTaken,
    coinTaken,
    captivesTaken,
    banditCasualties,
    caravanCasualties: { crewDeaths, animalDeaths },
    survivors: battle.survivors,
  };
};
