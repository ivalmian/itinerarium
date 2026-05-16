/**
 * Person registry: the central Map<PersonId, Person> that lives on
 * WorldState alongside the existing characters/actors/settlements
 * maps. See docs/04 §"Person registry for moving units".
 *
 * The registry is event-driven: register at unit creation / recruitment,
 * mutate at casualty/equipment events, age once per year via the annual
 * phase. The daily tick loops do NOT walk it.
 */

import type { Day, PersonId, ResourceId } from '../types.js';
import { ageOneYear, isAlive, markDead, type Person } from './person.js';
import { demoKey } from '../population/demographics.js';
import { AGE_BANDS, type AgeBand } from '../population/cohort.js';
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
 * Map an integer age to its 5-year cohort band (per docs/04 + cohort.ts).
 * Pure helper; exported for casualty resolution where we need to look
 * up Persons by their birth-band even though Person.age is an int.
 */
export const ageToBand = (age: number): AgeBand => {
  if (!Number.isFinite(age) || age < 0) return '0-4';
  if (age >= 80) return '80+';
  const idx = Math.min(AGE_BANDS.length - 2, Math.floor(age / 5));
  return AGE_BANDS[idx] as AgeBand;
};

/**
 * Mark `count` alive Persons in the given unit dead, picking them
 * deterministically by the supplied (sex, age-band) demographics map.
 *
 * Used by casualty paths (caravan ambush, bandit raid, patrol fight):
 * the unit-level helpers (applyCrewCasualties / applyBanditCasualties /
 * applyPatrolCasualties) already drain the unit's demographics; this
 * helper translates that drain into Person registry updates plus
 * equipment recovery.
 *
 * For each (sex, ageBand) bucket in `removedDemographics`, the helper
 * picks that many alive Persons in `unitId` matching the bucket and
 * marks them dead. If fewer matching Persons exist than requested
 * (the unit + registry got out of sync, or the bucket is empty), the
 * remainder falls back to any alive Person in the unit so the count
 * stays consistent.
 *
 * Returns the dead Persons' equipment aggregated as a single
 * Map<ResourceId, count> — the caller can route this to the unit's
 * loot pile or back into the camp's UnitInventory.
 *
 * Determinism: RNG is used only for tie-breaking among equally-eligible
 * Persons, sorted by id ascending so the choice is reproducible.
 */
export const markPersonsDeadByDemographics = (
  registry: PersonRegistry,
  equipment: Map<PersonId, Map<ResourceId, number>> | undefined,
  unitId: string,
  removedDemographics: ReadonlyMap<string, number>,
  rng: Rng,
  today: Day,
): {
  readonly deadIds: readonly PersonId[];
  readonly returnedKit: ReadonlyMap<ResourceId, number>;
} => {
  const deadIds: PersonId[] = [];
  const returnedKit = new Map<ResourceId, number>();
  if (registry.size === 0) return { deadIds, returnedKit };

  // Bucket the unit's alive Persons by (sex, ageBand).
  const buckets = new Map<string, PersonId[]>();
  const fallback: PersonId[] = [];
  for (const [id, p] of registry) {
    if (p.unitId !== unitId) continue;
    if (!isAlive(p)) continue;
    const key = demoKey(p.sex, ageToBand(p.age));
    let arr = buckets.get(key);
    if (arr === undefined) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(id);
    fallback.push(id);
  }
  if (fallback.length === 0) return { deadIds, returnedKit };
  // Sort buckets + fallback so the selection is deterministic.
  for (const arr of buckets.values()) arr.sort();
  fallback.sort();

  const killOne = (id: PersonId): void => {
    const p = registry.get(id);
    if (p === undefined || !isAlive(p)) return;
    registry.set(id, markDead(p, today));
    deadIds.push(id);
    if (equipment !== undefined) {
      const slot = equipment.get(id);
      if (slot !== undefined) {
        for (const [r, q] of slot) {
          if (q <= 0) continue;
          returnedKit.set(r, (returnedKit.get(r) ?? 0) + q);
        }
        equipment.delete(id);
      }
    }
  };

  // For each bucket, kill that many matching Persons. Choose with a
  // jitter so repeated runs with the same RNG stream are reproducible
  // but bucket order doesn't always pick the lowest-id Person first.
  for (const [key, want] of removedDemographics) {
    if (!Number.isInteger(want) || want <= 0) continue;
    const arr = buckets.get(key);
    if (arr === undefined) continue;
    let remaining = want;
    while (remaining > 0 && arr.length > 0) {
      const pick = Math.floor(rng.derive(`pick-${key}-${remaining}`).next() * arr.length);
      const id = arr.splice(pick, 1)[0] as PersonId;
      // Also remove from fallback so it isn't double-killed.
      const fbIdx = fallback.indexOf(id);
      if (fbIdx !== -1) fallback.splice(fbIdx, 1);
      killOne(id);
      remaining -= 1;
    }
    // Fallback to any other Person in the unit if bucket exhausted.
    while (remaining > 0 && fallback.length > 0) {
      const pick = Math.floor(rng.derive(`fb-${key}-${remaining}`).next() * fallback.length);
      const id = fallback.splice(pick, 1)[0] as PersonId;
      // Remove from its bucket too so the count is consistent.
      for (const otherArr of buckets.values()) {
        const idx = otherArr.indexOf(id);
        if (idx !== -1) {
          otherArr.splice(idx, 1);
          break;
        }
      }
      killOne(id);
      remaining -= 1;
    }
  }

  return { deadIds, returnedKit };
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
