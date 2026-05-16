/**
 * Person registry: the central Map<PersonId, Person> that lives on
 * WorldState alongside the existing characters/actors/settlements
 * maps. See docs/04 §"Person registry for moving units".
 *
 * The registry is event-driven: register at unit creation / recruitment,
 * mutate at casualty/equipment events, age once per year via the annual
 * phase. The daily tick loops do NOT walk it.
 */

import type { Day, PersonId } from '../types.js';
import { ageOneYear, isAlive, type Person } from './person.js';
import type { Rng } from '../rng.js';

export type PersonRegistry = Map<PersonId, Person>;

/** Empty registry used by snapshot deserialization defaults and tests. */
export const emptyPersonRegistry = (): PersonRegistry => new Map();

/**
 * Register or replace a Person record. Returns the registry for
 * fluent chaining (the underlying Map is mutated in place — that
 * matches the WorldState pattern for characters / actors).
 */
export const registerPerson = (registry: PersonRegistry, person: Person): PersonRegistry => {
  registry.set(person.id, person);
  return registry;
};

/** Look up a Person by id; returns undefined if absent. */
export const getPerson = (registry: PersonRegistry, id: PersonId): Person | undefined =>
  registry.get(id);

/** True when every supplied id maps to a Person currently `alive`. */
export const allAlive = (
  registry: PersonRegistry,
  ids: readonly PersonId[],
): boolean => {
  for (const id of ids) {
    const p = registry.get(id);
    if (p === undefined || !isAlive(p)) return false;
  }
  return true;
};

/**
 * Run the once-per-year aging pass over every alive Person in the
 * registry. Each Person ages one year and is subject to a baseline
 * Roman-era mortality draw (see `ageOneYear` in person.ts).
 *
 * Mutates the registry in place (replaces each touched Person record
 * with its aged-up version). Returns the count of Persons that died
 * during the pass — useful for telemetry / TickEvents.
 *
 * Determinism: each Person draws from a derived RNG seeded by their
 * id so the order of iteration does not affect outcomes.
 */
export const tickAnnualAging = (
  registry: PersonRegistry,
  today: Day,
  rng: Rng,
): number => {
  let deaths = 0;
  for (const [id, p] of registry) {
    if (!isAlive(p)) continue;
    const sample = rng.derive(`age-${String(id)}`).next();
    const next = ageOneYear(p, sample, today);
    if (next === p) continue;
    registry.set(id, next);
    if (next.status === 'dead' && p.status !== 'dead') deaths += 1;
  }
  return deaths;
};
