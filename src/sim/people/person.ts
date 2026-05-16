/**
 * Person: a named individual in a moving unit (caravan crew, patrol
 * soldier, bandit camp fighter, raid party member, migrant). Settled
 * villagers stay aggregate (PopulationPool buckets); only people who
 * physically walk somewhere get a stored identity.
 *
 * See docs/04 §"Person registry for moving units" for the design
 * rationale. Key invariants:
 *
 *   - The registry is **event-driven**: no daily tick walks Persons.
 *     They're touched at recruitment, equipment issue/return, casualty
 *     resolution, and the once-a-year aging pass only.
 *   - Persons **compose with** (do not replace) `NamedCharacter`. Where
 *     a politically notable character walks with a unit, the Person
 *     record points at the NamedCharacter via `namedCharacterId`; the
 *     NamedCharacter retains reputation / traits / aliases.
 *   - Equipment is **unit-level + per-person slot**: the unit's
 *     UnitInventory owns the issued weapons in aggregate; per-person
 *     slot maps record which kit each Person currently carries.
 *
 * The interface is immutable: mutators return a new Person rather than
 * mutating in place. Registries store the latest version per id.
 */

import type { CharacterClass, Sex } from '../population/types.js';
import type { CharacterId, Day, FactionId, PersonId } from '../types.js';

export type PersonStatus = 'alive' | 'wounded' | 'dead' | 'captured' | 'missing';

/**
 * What this person does in their unit. Coarser than `NamedCharacter.role`
 * because most Persons are rank-and-file. The named-character role
 * (governor / patriarch / etc.) lives on the linked NamedCharacter.
 */
export type PersonRole =
  | 'merchant'
  | 'drover'
  | 'caravan_guard'
  | 'soldier'
  | 'bandit'
  | 'bandit_hanger_on'
  | 'migrant'
  | 'civilian';

export interface Person {
  readonly id: PersonId;
  readonly name: string;
  readonly age: number;
  readonly sex: Sex;
  readonly class: CharacterClass;
  readonly faction: FactionId;
  readonly role: PersonRole;
  readonly status: PersonStatus;
  /** 0..1 — fatigue/disease/wound aggregate. 1 is fresh, 0 is dying. */
  readonly health: number;
  readonly bornOnDay: Day;
  readonly diedOnDay?: Day;
  /** Optional back-ref to the unit they belong to (camp id, caravan id, etc.). */
  readonly unitId?: string;
  /** Optional upgrade to a politically notable named character (docs/11). */
  readonly namedCharacterId?: CharacterId;
}

export interface CreatePersonInput {
  readonly id: PersonId;
  readonly name: string;
  readonly age: number;
  readonly sex: Sex;
  readonly class: CharacterClass;
  readonly faction: FactionId;
  readonly role: PersonRole;
  readonly bornOnDay: Day;
  readonly status?: PersonStatus;
  readonly health?: number;
  readonly unitId?: string;
  readonly namedCharacterId?: CharacterId;
}

export const createPerson = (input: CreatePersonInput): Person => {
  if (input.name.length === 0) {
    throw new Error(`Person ${String(input.id)} must have a non-empty name`);
  }
  if (!Number.isInteger(input.age) || input.age < 0) {
    throw new Error(`Person ${String(input.id)} age must be a non-negative integer, got ${input.age}`);
  }
  const health = input.health ?? 1;
  if (!Number.isFinite(health) || health < 0 || health > 1) {
    throw new Error(`Person ${String(input.id)} health must be in [0, 1], got ${health}`);
  }
  return {
    id: input.id,
    name: input.name,
    age: input.age,
    sex: input.sex,
    class: input.class,
    faction: input.faction,
    role: input.role,
    status: input.status ?? 'alive',
    health,
    bornOnDay: input.bornOnDay,
    ...(input.unitId !== undefined ? { unitId: input.unitId } : {}),
    ...(input.namedCharacterId !== undefined
      ? { namedCharacterId: input.namedCharacterId }
      : {}),
  };
};

export const isAlive = (p: Person): boolean => p.status === 'alive';

export const markDead = (p: Person, onDay: Day): Person => ({
  ...p,
  status: 'dead',
  diedOnDay: onDay,
});

export const markCaptured = (p: Person): Person => ({ ...p, status: 'captured' });

export const markMissing = (p: Person): Person => ({ ...p, status: 'missing' });

export const markWounded = (p: Person, newHealth: number): Person => ({
  ...p,
  status: 'wounded',
  health: Math.max(0, Math.min(1, newHealth)),
});

/**
 * Annual mortality probability by age, calibrated to Roman-era vital
 * tables (matching `annualMortalityForAge` in politics/character.ts).
 * Used by the once-per-year aging pass over the Person registry.
 */
const annualMortalityForAge = (age: number): number => {
  if (age < 15) return 0.02;
  if (age < 30) return 0.008;
  if (age < 50) return 0.012;
  if (age < 60) return 0.02;
  if (age < 70) return 0.04;
  if (age < 80) return 0.09;
  if (age < 90) return 0.18;
  return 0.32;
};

/**
 * Age a Person by one year and sample baseline mortality.
 *
 * Returns the same person record if no change, a `dead`-marked clone
 * if the mortality draw fires, or an aged-up clone otherwise. The
 * caller (annual phase) provides the uniform random sample so the
 * call is deterministic for a given RNG sequence.
 *
 * Persons in non-`alive` statuses are not aged or sampled — once
 * dead/captured/missing the registry stops updating them.
 */
export const ageOneYear = (p: Person, uniformSample: number, today: Day): Person => {
  if (p.status !== 'alive') return p;
  const newAge = p.age + 1;
  const pDeath = annualMortalityForAge(newAge);
  if (uniformSample < pDeath) {
    return { ...p, age: newAge, status: 'dead', diedOnDay: today };
  }
  return { ...p, age: newAge };
};
