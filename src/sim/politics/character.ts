/**
 * Named characters: the individual people who decide and act.
 *
 * docs/11 §"Every faction has named characters" + docs/13: every
 * faction has named members; the world is a few thousand of them
 * total. Reputation is held *of* and *by* these characters but
 * lives in a separate sparse module — this file is just the
 * person record + aging + movement.
 *
 * The interface is immutable: mutators return a new instance
 * rather than mutating in place. This makes per-day deltas easy
 * to diff and keeps the event log honest.
 */

import type { Rng } from '../rng.js';
import type { CharacterClass, Sex } from '../population/types.js';
import type { CharacterId, FactionId, Position } from '../types.js';

export type CharacterStatus = 'alive' | 'dead' | 'captured' | 'missing';

export type CharacterRole =
  | 'patriarch'
  | 'elder'
  | 'headman'
  | 'governor'
  | 'magistrate'
  | 'merchant'
  | 'bandit_leader'
  | 'lieutenant'
  | 'priest'
  | 'watch_captain'
  | 'patrol_officer'
  | 'family_member';

export interface NamedCharacter {
  readonly id: CharacterId;
  readonly name: string;
  readonly age: number;
  readonly sex: Sex;
  readonly class: CharacterClass;
  readonly faction: FactionId;
  readonly role?: CharacterRole;
  readonly location: Position;
  readonly status: CharacterStatus;
  readonly traits: readonly string[];
}

export interface CreateCharacterInput {
  readonly id: CharacterId;
  readonly name: string;
  readonly age: number;
  readonly sex: Sex;
  readonly class: CharacterClass;
  readonly faction: FactionId;
  readonly role?: CharacterRole;
  readonly location: Position;
  readonly status?: CharacterStatus;
  readonly traits?: readonly string[];
}

export const createCharacter = (input: CreateCharacterInput): NamedCharacter => {
  if (input.name.length === 0) {
    throw new Error(`Character ${input.id} must have a non-empty name`);
  }
  if (!Number.isInteger(input.age)) {
    throw new Error(`Character ${input.id} age must be an integer, got ${input.age}`);
  }
  if (input.age < 0) {
    throw new Error(`Character ${input.id} age must be non-negative, got ${input.age}`);
  }
  return {
    id: input.id,
    name: input.name,
    age: input.age,
    sex: input.sex,
    class: input.class,
    faction: input.faction,
    ...(input.role !== undefined ? { role: input.role } : {}),
    location: { q: input.location.q, r: input.location.r },
    status: input.status ?? 'alive',
    traits: input.traits ? [...input.traits] : [],
  };
};

export const isAlive = (c: NamedCharacter): boolean => c.status === 'alive';

export const moveTo = (c: NamedCharacter, pos: Position): NamedCharacter => ({
  ...c,
  location: { q: pos.q, r: pos.r },
});

/**
 * Annual mortality probability by age, calibrated to Roman-era
 * vital tables (docs/04 §"Life expectancy at age 15" — if you
 * survive childhood, you can live long; mortality climbs steeply
 * past 60). Returns a per-year death probability for an
 * individual of the given age.
 *
 * Roughly: ~1.2% in mid-adulthood, doubling each ~10 years past
 * 60, so a 70-yr-old is ~6%, an 80-yr-old ~15%, a 90-yr-old ~30%.
 * Survival from 70 to 90: prod_{a=70..89} (1 - p(a)) ≈ 0.06 →
 * ~94% mortality across 20 years.
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

export const ageOneYear = (c: NamedCharacter, rng: Rng): NamedCharacter => {
  if (c.status === 'dead') return c;
  const newAge = c.age + 1;
  const p = annualMortalityForAge(newAge);
  if (rng.next() < p) {
    return { ...c, age: newAge, status: 'dead' };
  }
  return { ...c, age: newAge };
};

// --- Latin name generator ---------------------------------------------------
//
// Small lists; expand later. Praenomens are the personal first
// name (Marcus, Lucius); nomens are the gentile family name
// (Vibianus). Cognomens (Caesar, Cicero) are out of v1 scope.

export const LATIN_PRAENOMEN_MALE: readonly string[] = [
  'Marcus',
  'Lucius',
  'Quintus',
  'Gaius',
  'Publius',
  'Titus',
  'Sextus',
  'Decimus',
  'Aulus',
  'Gnaeus',
  'Servius',
  'Tiberius',
];

export const LATIN_PRAENOMEN_FEMALE: readonly string[] = [
  'Aurelia',
  'Cornelia',
  'Julia',
  'Claudia',
  'Livia',
  'Octavia',
  'Tullia',
  'Antonia',
  'Pomponia',
  'Drusilla',
  'Marcella',
  'Vipsania',
];

export const LATIN_NOMEN_CHOICES: readonly string[] = [
  'Vibianus',
  'Marcellus',
  'Aurelius',
  'Cornelius',
  'Julius',
  'Claudius',
  'Flavius',
  'Aelius',
  'Domitius',
  'Pomponius',
  'Caelius',
  'Sergius',
  'Valerius',
  'Postumius',
  'Sempronius',
];

export const generateLatinPraenomen = (rng: Rng, sex: Sex): string => {
  return rng.pick(sex === 'male' ? LATIN_PRAENOMEN_MALE : LATIN_PRAENOMEN_FEMALE);
};

export const generateLatinNomen = (rng: Rng): string => {
  return rng.pick(LATIN_NOMEN_CHOICES);
};

export const generateFullName = (rng: Rng, sex: Sex): string => {
  return `${generateLatinPraenomen(rng, sex)} ${generateLatinNomen(rng)}`;
};
