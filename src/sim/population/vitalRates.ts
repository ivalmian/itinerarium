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
 * Yearly tick: 20% of each cohort ages into the next band, since each
 * band is 5 years wide and on average 1/5 of its residents have their
 * "next-band birthday" each year. The 0-4 cohort is NOT zeroed —
 * it retains its surviving 0-3-year-olds (and gains continuously from
 * tickDaily births).
 *
 * The 80+ band is absorbing: the 20% from 75-79 join its existing
 * residents (no further band above it).
 *
 * No births or deaths happen here — that's `tickDaily`'s job. The
 * `_rng` parameter is reserved for future per-class noise (e.g. early
 * aging in slaves) without changing the signature.
 *
 * Why 20%, not 100%: in pre-fix code we age-shifted the entire band
 * each year, which meant a 1-day-old infant born on day 364 became
 * 5-9 years old at year-end. Demographic snapshots showed 0-4 = 0
 * after every year boundary and a single "birth wave" propagating
 * through the pyramid instead of a steady age structure. The 20% rule
 * is the standard discretization for 5-year cohorts.
 */
const FRACTION_AGING_PER_YEAR = 0.2;

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

  // Process each (sex, class) group. For each band i except the oldest,
  // 20% ages into band i+1. The 80+ band absorbs its 20%-of-75-79
  // inbound on top of its own residents (with no further outbound).
  for (const [bk, bucket] of buckets) {
    const [sexStr, clsStr] = bk.split('|');
    if (!sexStr || !clsStr) continue;
    const sex = sexStr as Sex;
    const cls = clsStr as CharacterClass;

    // Compute integer age-out per band (round toward floor for stability).
    const outflows: number[] = [];
    for (let i = 0; i < AGE_BANDS.length; i++) {
      const band = AGE_BANDS[i] as AgeBand;
      const n = bucket.get(band) ?? 0;
      // The 80+ band has no outflow (no band above it); everyone older just stays.
      if (i === AGE_BANDS.length - 1) {
        outflows.push(0);
      } else {
        outflows.push(Math.floor(n * FRACTION_AGING_PER_YEAR));
      }
    }

    // Rebuild: each band keeps (n - outflow_out) and gains outflow_in.
    for (let i = 0; i < AGE_BANDS.length; i++) {
      const band = AGE_BANDS[i] as AgeBand;
      const existing = bucket.get(band) ?? 0;
      const outflowOut = outflows[i] ?? 0;
      const outflowIn = i === 0 ? 0 : (outflows[i - 1] ?? 0);
      const next = existing - outflowOut + outflowIn;
      pool.set({ age: band, sex, class: cls }, next);
    }
  }
};

// Re-export so consumers can import from vitalRates.ts directly.
export { agedKey, SEXES };
