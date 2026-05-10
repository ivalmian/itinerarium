/**
 * Vital rates and population ticks.
 *
 * Daily tick: applies birth and per-cohort death events, scaling
 * annual rates by 1/365 and treating each rate as a Bernoulli
 * trial per person. Yearly tick: ages every cohort up by one
 * 5-year band; the 80+ band absorbs both itself and the inbound
 * 75-79 band.
 *
 * Design references:
 *   docs/04-population.md §"Vital rates" and §"Mortality, migration, banditry"
 *
 * Numbers are first-pass calibration; tunable via the `VitalRates`
 * record passed in. ROMAN_VITAL_RATES is the docs/04 baseline.
 */

import type { Rng } from '../rng.js';
import { AGE_BANDS, agedKey, isFertileAgeBand } from './cohort.js';
import type { AgeBand, CohortKey, PopulationPool } from './cohort.js';
import { SEXES } from './types.js';
import type { CharacterClass, Sex } from './types.js';

export interface VitalRates {
  /** Annual births per 1,000 total population. */
  readonly crudeBirthRatePer1000PerYear: number;
  /** Annual death probability for a person in age band 0-4. */
  readonly infantMortalityPerYearAge0_4: number;
  /** Annual death probability for a person in age bands 5-9 or 10-14. */
  readonly childMortalityPerYearAge5_14: number;
  /** Annual deaths per 1,000 people in adult bands (15-59). */
  readonly adultMortalityPer1000PerYear: number;
  /** Annual deaths per 1,000 people in elder bands (60+). */
  readonly elderMortalityPer1000PerYear: number;
}

export const ROMAN_VITAL_RATES: VitalRates = {
  crudeBirthRatePer1000PerYear: 40,
  infantMortalityPerYearAge0_4: 0.09,
  childMortalityPerYearAge5_14: 0.012,
  adultMortalityPer1000PerYear: 12,
  elderMortalityPer1000PerYear: 60,
};

const ELDER_BANDS: ReadonlySet<AgeBand> = new Set(['60-64', '65-69', '70-74', '75-79', '80+']);

const CHILD_BANDS_5_14: ReadonlySet<AgeBand> = new Set(['5-9', '10-14']);

const annualToDaily = (annual: number): number => annual / 365;

const annualPer1000ToDaily = (annual: number): number => annual / 1000 / 365;

const annualMortalityForBand = (band: AgeBand, rates: VitalRates): number => {
  if (band === '0-4') return rates.infantMortalityPerYearAge0_4;
  if (CHILD_BANDS_5_14.has(band)) return rates.childMortalityPerYearAge5_14;
  if (ELDER_BANDS.has(band)) return rates.elderMortalityPer1000PerYear / 1000;
  return rates.adultMortalityPer1000PerYear / 1000;
};

/**
 * Slave mortality multiplier (docs/04 §"Slave": "Higher mortality
 * (especially mines and large estates)"). Applied uniformly here;
 * future work could attach occupation hazard.
 */
const SLAVE_MORTALITY_MULTIPLIER = 1.3;

const classMortalityMultiplier = (c: CharacterClass): number => {
  return c === 'slave' ? SLAVE_MORTALITY_MULTIPLIER : 1;
};

/**
 * Sample a binomial(n, p) outcome by counting Bernoulli trials.
 * Cheap and deterministic at our cohort sizes (a settlement
 * cohort is at most a few thousand people).
 *
 * For very large n we trade exactness for speed via a normal
 * approximation, but at v1 cohort sizes the loop is fine.
 */
const sampleBinomial = (n: number, p: number, rng: Rng): number => {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (rng.next() < p) k++;
  }
  return k;
};

const fertileFemaleCount = (pool: PopulationPool): number => {
  let total = 0;
  for (const [key, n] of pool.cohorts()) {
    if (key.sex === 'female' && isFertileAgeBand(key.age)) total += n;
  }
  return total;
};

const totalPopulation = (pool: PopulationPool): number => pool.total();

/**
 * Allocate `n` newborns across the maternal-class buckets weighted
 * by each class's share of fertile women. Newborns inherit their
 * mother's class (slaves born to slave women, etc. — docs/04
 * §"Class structure").
 */
const allocateNewbornsByClass = (
  pool: PopulationPool,
  totalNewborns: number,
  rng: Rng,
): Map<CharacterClass, number> => {
  const out = new Map<CharacterClass, number>();
  if (totalNewborns <= 0) return out;

  const fertileByClass = new Map<CharacterClass, number>();
  for (const [key, n] of pool.cohorts()) {
    if (key.sex !== 'female') continue;
    if (!isFertileAgeBand(key.age)) continue;
    fertileByClass.set(key.class, (fertileByClass.get(key.class) ?? 0) + n);
  }
  let remainingFertile = 0;
  for (const n of fertileByClass.values()) remainingFertile += n;
  if (remainingFertile === 0) return out;

  let remainingNewborns = totalNewborns;
  const classes = Array.from(fertileByClass.keys());
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i] as CharacterClass;
    const share = fertileByClass.get(cls) ?? 0;
    if (share <= 0) continue;
    const isLast = i === classes.length - 1;
    const allotted = isLast
      ? remainingNewborns
      : sampleBinomial(remainingNewborns, share / remainingFertile, rng);
    if (allotted > 0) out.set(cls, allotted);
    remainingNewborns -= allotted;
    remainingFertile -= share;
    if (remainingNewborns <= 0) break;
  }
  return out;
};

/** Daily population tick: deaths first, then births. */
export const tickDaily = (pool: PopulationPool, rates: VitalRates, rng: Rng): void => {
  // 1) Deaths. Snapshot keys first so we can mutate during the loop safely.
  const snapshot: Array<readonly [CohortKey, number]> = [];
  for (const entry of pool.cohorts()) snapshot.push(entry);

  for (const [key, count] of snapshot) {
    if (count <= 0) continue;
    const annualP = annualMortalityForBand(key.age, rates) * classMortalityMultiplier(key.class);
    const dailyP = annualToDaily(annualP);
    if (dailyP <= 0) continue;
    const deaths = sampleBinomial(count, dailyP, rng);
    if (deaths > 0) {
      pool.set(key, count - deaths);
    }
  }

  // 2) Births. CBR applies to total population; allocated to mothers' class.
  const totalAfterDeaths = totalPopulation(pool);
  if (totalAfterDeaths === 0 || fertileFemaleCount(pool) === 0) return;

  const dailyBirthP = annualPer1000ToDaily(rates.crudeBirthRatePer1000PerYear);
  const newborns = sampleBinomial(totalAfterDeaths, dailyBirthP, rng);
  if (newborns === 0) return;

  const newbornsByClass = allocateNewbornsByClass(pool, newborns, rng);
  for (const [cls, n] of newbornsByClass) {
    if (n <= 0) continue;
    // Sex assigned per-newborn ~50/50.
    let females = 0;
    for (let i = 0; i < n; i++) {
      if (rng.next() < 0.5) females++;
    }
    const males = n - females;
    if (females > 0) {
      const key: CohortKey = { age: '0-4', sex: 'female', class: cls };
      pool.set(key, pool.count(key) + females);
    }
    if (males > 0) {
      const key: CohortKey = { age: '0-4', sex: 'male', class: cls };
      pool.set(key, pool.count(key) + males);
    }
  }
};

/**
 * Yearly tick: every cohort ages one band up. The oldest band
 * (80+) absorbs the inbound 75-79 cohort plus its existing
 * residents.
 *
 * No births or deaths happen here — that's `tickDaily`'s job.
 * The `_rng` parameter is reserved for future per-class noise
 * (e.g. early aging in slaves) without changing the signature.
 */
export const tickYearly = (pool: PopulationPool, _rng: Rng): void => {
  // Snapshot the whole pyramid keyed by (sex, class) so we can rebuild it.
  type Bucket = Map<AgeBand, number>;
  const buckets = new Map<string, Bucket>();
  const bucketKey = (s: Sex, c: CharacterClass): string => `${s}|${c}`;

  for (const [key, n] of pool.cohorts()) {
    const bk = bucketKey(key.sex, key.class);
    let b = buckets.get(bk);
    if (!b) {
      b = new Map();
      buckets.set(bk, b);
    }
    b.set(key.age, n);
  }

  // Now rebuild by aging-up. Iterate the (sex, class) groups we saw.
  for (const [bk, bucket] of buckets) {
    const [sexStr, clsStr] = bk.split('|');
    if (!sexStr || !clsStr) continue;
    const sex = sexStr as Sex;
    const cls = clsStr as CharacterClass;

    const oldestExisting = bucket.get('80+') ?? 0;
    const inboundTo80 = bucket.get('75-79') ?? 0;

    // Process from oldest down so we don't double-shift.
    // 80+ becomes oldestExisting + inboundTo80.
    pool.set({ age: '80+', sex, class: cls }, oldestExisting + inboundTo80);

    // For the rest, age band i comes from band i-1.
    for (let i = AGE_BANDS.length - 2; i >= 1; i--) {
      const dest = AGE_BANDS[i] as AgeBand;
      const src = AGE_BANDS[i - 1] as AgeBand;
      pool.set({ age: dest, sex, class: cls }, bucket.get(src) ?? 0);
    }
    // Youngest band 0-4 is emptied (no aging-into source).
    pool.set({ age: '0-4', sex, class: cls }, 0);
  }
};

// Re-export so consumers can import from vitalRates.ts directly.
export { agedKey, SEXES };
