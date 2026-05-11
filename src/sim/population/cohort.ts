/**
 * Demographic pyramid storage: 5-year age cohorts × sex × class.
 *
 * Stores per-settlement population as a stratified pool. Storage
 * is sparse (a Map keyed by encoded cohort key) so that empty or
 * lightly-populated settlements stay cheap. Per-cohort aggregate
 * properties (jobs, wealth, exposure) live elsewhere; this module
 * is only the count.
 *
 * Design references:
 *   docs/04-population.md  (17 age bands, 2 sexes, 5 classes)
 */

import { CHARACTER_CLASSES, SEXES } from './types.js';
import type { CharacterClass, Sex } from './types.js';

export const AGE_BANDS = [
  '0-4',
  '5-9',
  '10-14',
  '15-19',
  '20-24',
  '25-29',
  '30-34',
  '35-39',
  '40-44',
  '45-49',
  '50-54',
  '55-59',
  '60-64',
  '65-69',
  '70-74',
  '75-79',
  '80+',
] as const;

export type AgeBand = (typeof AGE_BANDS)[number];

const AGE_BAND_INDEX: ReadonlyMap<AgeBand, number> = new Map(
  AGE_BANDS.map((a, i) => [a, i] as const),
);

export const ageBandIndex = (a: AgeBand): number => {
  const i = AGE_BAND_INDEX.get(a);
  if (i === undefined) throw new Error(`Unknown age band: ${a as string}`);
  return i;
};

/** True if the age band represents reproductive-age females (15–49). */
const FERTILE_AGE_BANDS: ReadonlySet<AgeBand> = new Set([
  '15-19',
  '20-24',
  '25-29',
  '30-34',
  '35-39',
  '40-44',
  '45-49',
]);

export const isFertileAgeBand = (a: AgeBand): boolean => FERTILE_AGE_BANDS.has(a);

const CHILD_AGE_BANDS: ReadonlySet<AgeBand> = new Set(['0-4', '5-9', '10-14']);
const ELDER_AGE_BANDS: ReadonlySet<AgeBand> = new Set(['60-64', '65-69', '70-74', '75-79', '80+']);
const CONSUMER_ADULT_EQUIVALENT_BY_AGE: Readonly<Record<AgeBand, number>> = {
  '0-4': 0.5,
  '5-9': 0.5,
  '10-14': 0.5,
  '15-19': 1,
  '20-24': 1,
  '25-29': 1,
  '30-34': 1,
  '35-39': 1,
  '40-44': 1,
  '45-49': 1,
  '50-54': 1,
  '55-59': 1,
  '60-64': 1,
  '65-69': 0.8,
  '70-74': 0.8,
  '75-79': 0.8,
  '80+': 0.8,
};

export interface CohortKey {
  readonly age: AgeBand;
  readonly sex: Sex;
  readonly class: CharacterClass;
}

/** Encodes a cohort triple into a stable string key. */
export const agedKey = (k: CohortKey): string => `${k.age}|${k.sex}|${k.class}`;

const VALID_KEYS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const a of AGE_BANDS) {
    for (const sex of SEXES) {
      for (const c of CHARACTER_CLASSES) {
        s.add(agedKey({ age: a, sex, class: c }));
      }
    }
  }
  return s;
})();

const PARSED_KEY_CACHE: ReadonlyMap<string, CohortKey> = (() => {
  const m = new Map<string, CohortKey>();
  for (const a of AGE_BANDS) {
    for (const sex of SEXES) {
      for (const c of CHARACTER_CLASSES) {
        const key = agedKey({ age: a, sex, class: c });
        m.set(key, { age: a, sex, class: c });
      }
    }
  }
  return m;
})();

const COHORT_KEYS: readonly CohortKey[] = Array.from(PARSED_KEY_CACHE.values());

const COHORT_INDEX_BY_KEY: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  COHORT_KEYS.forEach((key, index) => m.set(agedKey(key), index));
  return m;
})();

const requireKey = (k: string): CohortKey => {
  const parsed = PARSED_KEY_CACHE.get(k);
  if (!parsed) throw new Error(`Unknown cohort key: ${k}`);
  return parsed;
};

const requireKeyIndex = (k: string): number => {
  const index = COHORT_INDEX_BY_KEY.get(k);
  if (index === undefined) throw new Error(`Unknown cohort key: ${k}`);
  return index;
};

export interface PopulationPool {
  count(key: CohortKey): number;
  set(key: CohortKey, count: number): void;
  total(): number;
  totalByClass(c: CharacterClass): number;
  totalByAgeBand(a: AgeBand): number;
  totalChildren(): number;
  totalAdults(): number;
  totalElders(): number;
  adultEquivalentByClass(c: CharacterClass): number;
  totalFertileFemales(): number;
  fertileFemalesByClass(c: CharacterClass): number;
  copy(): PopulationPool;
  cohorts(): IterableIterator<readonly [CohortKey, number]>;
  forEachCohort(visit: (key: CohortKey, count: number) => void): void;
}

class MapPool implements PopulationPool {
  readonly #counts: Map<string, number>;
  readonly #countsByIndex: number[] = new Array(COHORT_KEYS.length).fill(0);
  readonly #activeIndices: number[] = [];
  readonly #activeVersions: number[] = [];
  readonly #activeFlags: Uint8Array = new Uint8Array(COHORT_KEYS.length);
  readonly #cohortVersions: Uint32Array = new Uint32Array(COHORT_KEYS.length);
  #total = 0;
  #children = 0;
  #adults = 0;
  #elders = 0;
  readonly #totalByClass: Map<CharacterClass, number> = new Map();
  readonly #totalByAgeBand: Map<AgeBand, number> = new Map();
  readonly #adultEquivalentByClass: Map<CharacterClass, number> = new Map();
  #fertileFemaleTotal = 0;
  readonly #fertileFemalesByClass: Map<CharacterClass, number> = new Map();

  constructor(initial?: Iterable<readonly [string, number]>) {
    this.#counts = new Map(initial ?? []);
    for (const [key, n] of this.#counts) {
      const index = requireKeyIndex(key);
      const parsed = requireKey(key);
      this.#countsByIndex[index] = n;
      this.#activateIndex(index);
      this.#total += n;
      this.#totalByClass.set(parsed.class, (this.#totalByClass.get(parsed.class) ?? 0) + n);
      this.#totalByAgeBand.set(parsed.age, (this.#totalByAgeBand.get(parsed.age) ?? 0) + n);
      this.#addAgeGroup(parsed.age, n);
      this.#adultEquivalentByClass.set(
        parsed.class,
        (this.#adultEquivalentByClass.get(parsed.class) ?? 0) +
          n * CONSUMER_ADULT_EQUIVALENT_BY_AGE[parsed.age],
      );
      if (parsed.sex === 'female' && isFertileAgeBand(parsed.age)) {
        this.#fertileFemaleTotal += n;
        this.#fertileFemalesByClass.set(
          parsed.class,
          (this.#fertileFemalesByClass.get(parsed.class) ?? 0) + n,
        );
      }
    }
  }

  count(key: CohortKey): number {
    return this.#countsByIndex[requireKeyIndex(agedKey(key))] ?? 0;
  }

  set(key: CohortKey, count: number): void {
    if (!Number.isInteger(count)) {
      throw new Error(`Cohort count must be an integer, got ${count}`);
    }
    if (count < 0) {
      throw new Error(`Cohort count must be non-negative, got ${count}`);
    }
    const k = agedKey(key);
    const index = requireKeyIndex(k);
    const prior = this.#countsByIndex[index] ?? 0;
    if (prior === count) return;
    const delta = count - prior;
    this.#countsByIndex[index] = count;
    this.#total += delta;
    this.#totalByClass.set(key.class, (this.#totalByClass.get(key.class) ?? 0) + delta);
    this.#totalByAgeBand.set(key.age, (this.#totalByAgeBand.get(key.age) ?? 0) + delta);
    this.#addAgeGroup(key.age, delta);
    this.#adultEquivalentByClass.set(
      key.class,
      (this.#adultEquivalentByClass.get(key.class) ?? 0) +
        delta * CONSUMER_ADULT_EQUIVALENT_BY_AGE[key.age],
    );
    if (key.sex === 'female' && isFertileAgeBand(key.age)) {
      this.#fertileFemaleTotal += delta;
      this.#fertileFemalesByClass.set(
        key.class,
        (this.#fertileFemalesByClass.get(key.class) ?? 0) + delta,
      );
    }
    if (count === 0) {
      this.#counts.delete(k);
      this.#deactivateIndex(index);
    } else {
      if (prior === 0) this.#activateIndex(index);
      this.#counts.set(k, count);
    }
  }

  #activateIndex(index: number): void {
    if (this.#activeFlags[index] === 1) return;
    this.#activeFlags[index] = 1;
    this.#cohortVersions[index] = (this.#cohortVersions[index] ?? 0) + 1;
    this.#activeIndices.push(index);
    this.#activeVersions.push(this.#cohortVersions[index] as number);
  }

  #deactivateIndex(index: number): void {
    if (this.#activeFlags[index] === 0) return;
    this.#activeFlags[index] = 0;
    this.#cohortVersions[index] = (this.#cohortVersions[index] ?? 0) + 1;
  }

  #addAgeGroup(age: AgeBand, delta: number): void {
    if (CHILD_AGE_BANDS.has(age)) {
      this.#children += delta;
    } else if (ELDER_AGE_BANDS.has(age)) {
      this.#elders += delta;
    } else {
      this.#adults += delta;
    }
  }

  total(): number {
    return this.#total;
  }

  totalByClass(c: CharacterClass): number {
    return this.#totalByClass.get(c) ?? 0;
  }

  totalByAgeBand(a: AgeBand): number {
    return this.#totalByAgeBand.get(a) ?? 0;
  }

  totalChildren(): number {
    return this.#children;
  }

  totalAdults(): number {
    return this.#adults;
  }

  totalElders(): number {
    return this.#elders;
  }

  adultEquivalentByClass(c: CharacterClass): number {
    return this.#adultEquivalentByClass.get(c) ?? 0;
  }

  totalFertileFemales(): number {
    return this.#fertileFemaleTotal;
  }

  fertileFemalesByClass(c: CharacterClass): number {
    return this.#fertileFemalesByClass.get(c) ?? 0;
  }

  copy(): PopulationPool {
    return new MapPool(this.#counts.entries());
  }

  *cohorts(): IterableIterator<readonly [CohortKey, number]> {
    for (const [key, n] of this.#counts) {
      yield [requireKey(key), n];
    }
  }

  forEachCohort(visit: (key: CohortKey, count: number) => void): void {
    for (let i = 0; i < this.#activeIndices.length; i++) {
      const index = this.#activeIndices[i] as number;
      if (this.#activeVersions[i] !== this.#cohortVersions[index]) continue;
      if (this.#activeFlags[index] === 0) continue;
      const count = this.#countsByIndex[index] ?? 0;
      if (count > 0) visit(COHORT_KEYS[index] as CohortKey, count);
    }
  }
}

export const emptyPool = (): PopulationPool => new MapPool();

export const poolFromMap = (initial: ReadonlyMap<string, number>): PopulationPool => {
  for (const k of initial.keys()) {
    if (!VALID_KEYS.has(k)) {
      throw new Error(`poolFromMap: unknown cohort key: ${k}`);
    }
  }
  const pool = new MapPool();
  for (const [k, n] of initial) {
    pool.set(requireKey(k), n);
  }
  return pool;
};
