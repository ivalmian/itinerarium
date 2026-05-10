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

const requireKey = (k: string): CohortKey => {
  const parsed = PARSED_KEY_CACHE.get(k);
  if (!parsed) throw new Error(`Unknown cohort key: ${k}`);
  return parsed;
};

export interface PopulationPool {
  count(key: CohortKey): number;
  set(key: CohortKey, count: number): void;
  total(): number;
  totalByClass(c: CharacterClass): number;
  totalByAgeBand(a: AgeBand): number;
  copy(): PopulationPool;
  cohorts(): IterableIterator<readonly [CohortKey, number]>;
}

class MapPool implements PopulationPool {
  readonly #counts: Map<string, number>;

  constructor(initial?: Iterable<readonly [string, number]>) {
    this.#counts = new Map(initial ?? []);
  }

  count(key: CohortKey): number {
    return this.#counts.get(agedKey(key)) ?? 0;
  }

  set(key: CohortKey, count: number): void {
    if (!Number.isInteger(count)) {
      throw new Error(`Cohort count must be an integer, got ${count}`);
    }
    if (count < 0) {
      throw new Error(`Cohort count must be non-negative, got ${count}`);
    }
    const k = agedKey(key);
    if (count === 0) {
      this.#counts.delete(k);
    } else {
      this.#counts.set(k, count);
    }
  }

  total(): number {
    let sum = 0;
    for (const n of this.#counts.values()) sum += n;
    return sum;
  }

  totalByClass(c: CharacterClass): number {
    let sum = 0;
    for (const [key, n] of this.#counts) {
      if (requireKey(key).class === c) sum += n;
    }
    return sum;
  }

  totalByAgeBand(a: AgeBand): number {
    let sum = 0;
    for (const [key, n] of this.#counts) {
      if (requireKey(key).age === a) sum += n;
    }
    return sum;
  }

  copy(): PopulationPool {
    return new MapPool(this.#counts.entries());
  }

  *cohorts(): IterableIterator<readonly [CohortKey, number]> {
    for (const [key, n] of this.#counts) {
      yield [requireKey(key), n];
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
