/**
 * Unit demographics: per-(sex, age band) headcount split for any
 * mobile group of people the sim tracks (caravan crew, patrol soldiers,
 * news carriers, bandit camps).
 *
 * Design intent (CLAUDE.md "everyone in all units has gender and age"):
 *   The sim isn't agent-based — we don't simulate every individual. But
 *   we DO want every aggregate body of people to carry a demographic
 *   shape, both because pillar 1 ("no hidden hands") forbids labor
 *   appearing from nowhere AND because future systems (battlefield
 *   widows, conscription on a settlement, recruit-from-bandit-camp)
 *   need the breakdown to feed back to a settlement's PopulationPool.
 *
 * Data shape: a sparse `Map<string, number>` keyed by `${sex}|${ageBand}`,
 * matching how `PopulationPool` keys are encoded. Sparse keeps the
 * memory footprint tiny (a 5-person caravan crew touches ≤5 keys, not
 * 17 × 2 = 34).
 *
 * The type is `optional` on every unit it lives on, so existing tests
 * with crew/patrol/camp fixtures don't all need updating in one shot.
 *
 * Design references:
 *   docs/06-caravans.md  §"Crew demographics"
 *   docs/12-bandits-and-conflict.md  §"Bandit demographics"
 *   docs/04-population.md  (the source pool we draw from)
 */

import type { Rng } from '../rng.js';
import { AGE_BANDS, type AgeBand, type CohortKey, type PopulationPool } from './cohort.js';
import { SEXES, type Sex } from './types.js';

/** Sparse map from `${sex}|${ageBand}` → headcount. */
export type Demographics = ReadonlyMap<string, number>;

/** Mutable counterpart used internally when building / mutating splits. */
export type MutableDemographics = Map<string, number>;

export const demoKey = (sex: Sex, age: AgeBand): string => `${sex}|${age}`;

const VALID_DEMO_KEYS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const sex of SEXES) for (const age of AGE_BANDS) s.add(demoKey(sex, age));
  return s;
})();

interface ParsedDemoKey {
  readonly sex: Sex;
  readonly age: AgeBand;
}

const PARSED_DEMO_CACHE: ReadonlyMap<string, ParsedDemoKey> = (() => {
  const m = new Map<string, ParsedDemoKey>();
  for (const sex of SEXES) for (const age of AGE_BANDS) m.set(demoKey(sex, age), { sex, age });
  return m;
})();

export const parseDemoKey = (k: string): ParsedDemoKey => {
  const parsed = PARSED_DEMO_CACHE.get(k);
  if (!parsed) throw new Error(`Unknown demographics key: ${k}`);
  return parsed;
};

/** Defensive validation. Use only on builders that accept caller-provided maps. */
export const validateDemographics = (demo: Demographics): void => {
  for (const [k, n] of demo) {
    if (!VALID_DEMO_KEYS.has(k)) {
      throw new Error(`Demographics: unknown key ${k}`);
    }
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Demographics: count for ${k} must be a non-negative integer, got ${n}`);
    }
  }
};

export const totalDemographics = (demo: Demographics | undefined): number => {
  if (demo === undefined) return 0;
  let n = 0;
  for (const v of demo.values()) n += v;
  return n;
};

export const cloneDemographics = (demo: Demographics | undefined): MutableDemographics => {
  const out = new Map<string, number>();
  if (demo === undefined) return out;
  for (const [k, v] of demo) {
    if (v > 0) out.set(k, v);
  }
  return out;
};

/**
 * Return a new Demographics map combining `a` and `b`. Bucket counts add;
 * missing keys are treated as zero. Either input may be undefined.
 *
 * Used when an existing unit (bandit camp, caravan crew, patrol) recruits
 * additional members and the recruited cohort's demographics should be
 * folded into the unit's existing roster — see docs/12 §"Bandit
 * demographics" and docs/06 §"Crew demographics".
 */
export const mergeDemographics = (
  a: Demographics | undefined,
  b: Demographics | undefined,
): MutableDemographics => {
  const out = cloneDemographics(a);
  if (b === undefined) return out;
  for (const [k, v] of b) {
    if (v <= 0) continue;
    out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
};

// --- Role bias profiles ----------------------------------------------------

/**
 * Bias profile used to weight a draw from a settlement's working-age cohorts.
 * Each axis returns a non-negative weight; 0 means "exclude this slice."
 * The drawDemographicsFromPool helper multiplies these by the actual
 * cohort count to get the effective weight per (sex, age) bucket.
 */
export interface RoleBias {
  readonly sexBias: (sex: Sex) => number;
  readonly ageBias: (age: AgeBand) => number;
}

const FEMALE_RARE: (sex: Sex) => number = (sex) => (sex === 'male' ? 1 : 0.05);
const FEMALE_LOW: (sex: Sex) => number = (sex) => (sex === 'male' ? 1 : 0.2);
const SEX_NEUTRAL: (sex: Sex) => number = () => 1;

/**
 * Working-age (15-59) bias with a bell centered on prime adulthood.
 * 5-year bands; older / younger ages get progressively less weight.
 */
const PRIME_ADULT_AGES: Record<AgeBand, number> = {
  '0-4': 0,
  '5-9': 0,
  '10-14': 0,
  '15-19': 0.4,
  '20-24': 1,
  '25-29': 1,
  '30-34': 1,
  '35-39': 0.9,
  '40-44': 0.7,
  '45-49': 0.5,
  '50-54': 0.3,
  '55-59': 0.2,
  '60-64': 0,
  '65-69': 0,
  '70-74': 0,
  '75-79': 0,
  '80+': 0,
};

const FIGHTING_AGE: Record<AgeBand, number> = {
  '0-4': 0,
  '5-9': 0,
  '10-14': 0,
  '15-19': 0.5,
  '20-24': 1,
  '25-29': 1,
  '30-34': 0.9,
  '35-39': 0.7,
  '40-44': 0.5,
  '45-49': 0.3,
  '50-54': 0.1,
  '55-59': 0,
  '60-64': 0,
  '65-69': 0,
  '70-74': 0,
  '75-79': 0,
  '80+': 0,
};

const MERCHANT_AGE: Record<AgeBand, number> = {
  '0-4': 0,
  '5-9': 0,
  '10-14': 0,
  '15-19': 0.1,
  '20-24': 0.6,
  '25-29': 1,
  '30-34': 1,
  '35-39': 1,
  '40-44': 0.9,
  '45-49': 0.7,
  '50-54': 0.5,
  '55-59': 0.3,
  '60-64': 0.1,
  '65-69': 0,
  '70-74': 0,
  '75-79': 0,
  '80+': 0,
};

const lookupAge = (table: Record<AgeBand, number>): ((age: AgeBand) => number) => {
  return (age: AgeBand) => table[age];
};

/**
 * Per-role draw biases. The sex/age weighting is realistic for the
 * Roman Mediterranean (caravan & patrol crews historically male; bandit
 * camps recruited rough working-age men but sometimes had hardened
 * women fighters; news carriers are whoever survived to walk away).
 *
 * Weights aren't probabilities — they multiply pool counts, so a "0.05"
 * for women still picks women if every man in the pool is unavailable.
 */
export const ROLE_BIASES = {
  caravan_merchant: {
    sexBias: SEX_NEUTRAL,
    ageBias: lookupAge(MERCHANT_AGE),
  },
  caravan_drover: {
    sexBias: FEMALE_LOW,
    ageBias: lookupAge(PRIME_ADULT_AGES),
  },
  caravan_guard: {
    sexBias: FEMALE_RARE,
    ageBias: lookupAge(FIGHTING_AGE),
  },
  caravan_soldier: {
    sexBias: FEMALE_RARE,
    ageBias: lookupAge(FIGHTING_AGE),
  },
  patrol_soldier: {
    sexBias: FEMALE_RARE,
    ageBias: lookupAge(FIGHTING_AGE),
  },
  news_carrier: {
    sexBias: SEX_NEUTRAL,
    ageBias: lookupAge(PRIME_ADULT_AGES),
  },
  bandit: {
    // Bandit camps are heavily male but not exclusively — historically
    // women joined for survival and as fighters. Weight female ~10%.
    sexBias: (sex: Sex) => (sex === 'male' ? 1 : 0.1),
    ageBias: lookupAge(FIGHTING_AGE),
  },
  bandit_hanger_on: {
    // Hangers-on are a different population: the camp's children, captives,
    // dependents. Wider age band, more women.
    sexBias: (sex: Sex) => (sex === 'male' ? 0.5 : 1),
    ageBias: (age: AgeBand) => {
      // Children + dependents + a sliver of elderly. Anyone non-fighting age.
      switch (age) {
        case '0-4':
        case '5-9':
        case '10-14':
          return 1;
        case '15-19':
          return 0.5;
        case '20-24':
        case '25-29':
        case '30-34':
        case '35-39':
        case '40-44':
        case '45-49':
          return 0.6;
        case '50-54':
        case '55-59':
          return 0.4;
        case '60-64':
        case '65-69':
        case '70-74':
        case '75-79':
        case '80+':
          return 0.2;
      }
    },
  },
} as const satisfies Record<string, RoleBias>;

export type RoleBiasName = keyof typeof ROLE_BIASES;

// --- Pool-backed draw ------------------------------------------------------

interface BucketWeight {
  readonly sex: Sex;
  readonly age: AgeBand;
  readonly poolCount: number;
  readonly weight: number;
}

const sumPoolByDemo = (
  pool: PopulationPool | undefined,
  bias: RoleBias,
): { readonly buckets: readonly BucketWeight[]; readonly totalWeight: number } => {
  const buckets: BucketWeight[] = [];
  let totalWeight = 0;
  if (pool === undefined) return { buckets, totalWeight };
  // Aggregate across class — recruitment doesn't care which class lineage.
  // The class restriction (slaves can't be soldiers, etc.) is a settlement-
  // level filter the caller can apply by passing a class-restricted pool.
  const byBucket = new Map<string, number>();
  for (const [key, n] of pool.cohorts()) {
    const k = demoKey(key.sex, key.age);
    byBucket.set(k, (byBucket.get(k) ?? 0) + n);
  }
  for (const [k, n] of byBucket) {
    if (n <= 0) continue;
    const { sex, age } = parseDemoKey(k);
    const w = bias.sexBias(sex) * bias.ageBias(age) * n;
    if (w <= 0) continue;
    buckets.push({ sex, age, poolCount: n, weight: w });
    totalWeight += w;
  }
  return { buckets, totalWeight };
};

/**
 * Draw `count` people from `pool` using `bias` to weight each
 * (sex, age) bucket. Returns a Demographics map summing to `count`.
 *
 * Determinism: every random pick uses `rng.next()`. Caller is
 * responsible for `rng.derive(...)` before calling.
 *
 * Edge cases:
 *   - If the pool is undefined or empty (no working-age people),
 *     falls back to a uniform-ish sex split at the prime-age band
 *     so the unit still has a demographic shape (we don't want to
 *     return an empty demographics for a non-zero-headcount unit).
 *   - If `count` exceeds the weighted pool, we still draw `count`
 *     people — the bias just collapses to the available buckets.
 *     This matches the procgen reality that a hamlet of 30 fielding
 *     a 5-person caravan crew may exhaust its prime-age men.
 */
export const drawDemographicsFromPool = (
  pool: PopulationPool | undefined,
  count: number,
  bias: RoleBias,
  rng: Rng,
): MutableDemographics => {
  const out = new Map<string, number>();
  if (!Number.isInteger(count) || count <= 0) return out;
  const { buckets, totalWeight } = sumPoolByDemo(pool, bias);
  if (buckets.length === 0 || totalWeight <= 0) {
    // Fallback: the pool didn't have anyone fitting the bias. Spread
    // the count across `25-29` male/female with a sex-bias-weighted
    // 80/20 split. This keeps the demographic non-empty even on
    // pathologically small settlements.
    const maleW = bias.sexBias('male');
    const femaleW = bias.sexBias('female');
    const totalW = maleW + femaleW;
    if (totalW <= 0) {
      // No sex passes the bias filter — fall back to half/half.
      const male = Math.floor(count / 2);
      const female = count - male;
      if (male > 0) out.set(demoKey('male', '25-29'), male);
      if (female > 0) out.set(demoKey('female', '25-29'), female);
      return out;
    }
    const male = Math.round(count * (maleW / totalW));
    const female = count - male;
    if (male > 0) out.set(demoKey('male', '25-29'), male);
    if (female > 0) out.set(demoKey('female', '25-29'), female);
    return out;
  }

  // Largest-remainder allocation by weight. Deterministic; uses RNG only
  // for tie-breaking on equal fractional remainders so the remaining +1
  // assignments aren't always biased by sort order.
  const exact = buckets.map((b) => ({
    key: demoKey(b.sex, b.age),
    poolCount: b.poolCount,
    exact: (count * b.weight) / totalWeight,
  }));
  const floored = exact.map((e) => ({
    key: e.key,
    poolCount: e.poolCount,
    count: Math.min(e.poolCount, Math.floor(e.exact)),
    frac: e.exact - Math.floor(e.exact),
    jitter: rng.next(),
  }));
  let assigned = 0;
  for (const f of floored) assigned += f.count;
  let remainder = count - assigned;

  if (remainder > 0) {
    const order = floored
      .map((_, i) => i)
      .sort((a, b) => {
        const fa = floored[a]?.frac ?? 0;
        const fb = floored[b]?.frac ?? 0;
        if (fb !== fa) return fb - fa;
        // RNG tie-break.
        const ja = floored[a]?.jitter ?? 0;
        const jb = floored[b]?.jitter ?? 0;
        return jb - ja;
      });
    for (const idx of order) {
      if (remainder <= 0) break;
      const f = floored[idx];
      if (f === undefined) continue;
      if (f.count >= f.poolCount) continue;
      f.count += 1;
      remainder -= 1;
    }
  }

  // If pool exhausted before we reached `count`, allow further draws
  // beyond the pool cap (pillar-1 wise: the body still has people in
  // it; their demographics are an approximation when the source pool
  // is undersized).
  if (remainder > 0) {
    const order = floored
      .map((_, i) => i)
      .sort((a, b) => {
        const fa = floored[a]?.frac ?? 0;
        const fb = floored[b]?.frac ?? 0;
        return fb - fa;
      });
    while (remainder > 0) {
      let placed = false;
      for (const idx of order) {
        if (remainder <= 0) break;
        const f = floored[idx];
        if (f === undefined) continue;
        f.count += 1;
        remainder -= 1;
        placed = true;
      }
      if (!placed) break; // no buckets at all
    }
  }

  for (const f of floored) {
    if (f.count > 0) out.set(f.key, f.count);
  }
  return out;
};

// --- Casualty-driven drain -------------------------------------------------

/**
 * Apply `deathCount` total casualties to a demographics map, removing
 * people proportionally to each bucket's current share. The returned
 * Map<string, number> records who died (suitable for forwarding to a
 * settlement's PopulationPool when deaths-feed-back-to-cohort lands).
 *
 * Mutates `demo` in place. Buckets that drop to 0 are removed.
 *
 * Determinism: largest-remainder; the RNG is only used to tie-break
 * fractional remainders so the same input yields the same draw.
 */
export const drainDemographics = (
  demo: MutableDemographics,
  deathCount: number,
  rng: Rng,
): Map<string, number> => {
  const removed = new Map<string, number>();
  if (!Number.isInteger(deathCount) || deathCount <= 0) return removed;
  let total = 0;
  for (const v of demo.values()) total += v;
  if (total <= 0) return removed;
  const cap = Math.min(total, deathCount);

  const buckets = [...demo.entries()].map(([k, n]) => ({
    key: k,
    have: n,
    exact: (cap * n) / total,
    jitter: rng.next(),
  }));
  const floored = buckets.map((b) => ({
    key: b.key,
    have: b.have,
    take: Math.min(b.have, Math.floor(b.exact)),
    frac: b.exact - Math.floor(b.exact),
    jitter: b.jitter,
  }));
  let assigned = 0;
  for (const f of floored) assigned += f.take;
  let remainder = cap - assigned;
  if (remainder > 0) {
    const order = floored
      .map((_, i) => i)
      .sort((a, b) => {
        const fa = floored[a]?.frac ?? 0;
        const fb = floored[b]?.frac ?? 0;
        if (fb !== fa) return fb - fa;
        const ja = floored[a]?.jitter ?? 0;
        const jb = floored[b]?.jitter ?? 0;
        return jb - ja;
      });
    for (const idx of order) {
      if (remainder <= 0) break;
      const f = floored[idx];
      if (f === undefined) continue;
      if (f.take >= f.have) continue;
      f.take += 1;
      remainder -= 1;
    }
  }

  for (const f of floored) {
    if (f.take <= 0) continue;
    removed.set(f.key, f.take);
    const remaining = f.have - f.take;
    if (remaining <= 0) {
      demo.delete(f.key);
    } else {
      demo.set(f.key, remaining);
    }
  }
  return removed;
};

/**
 * Apply removed-by-bucket back to a settlement's PopulationPool. The
 * caller decides which class to attribute the deaths to (e.g., crew
 * deaths feed back as plebeians; bandit hangers-on as foreigners).
 *
 * Returns the count actually applied (may be less than the requested
 * removal if a bucket was already empty in the pool).
 *
 * NOT yet wired everywhere — see docs/06 §"Crew demographics" and
 * docs/12 §"Bandit demographics" for the integration plan.
 */
export const applyDeathsToPool = (
  pool: PopulationPool,
  removed: ReadonlyMap<string, number>,
  klass: CohortKey['class'],
): number => {
  let applied = 0;
  for (const [k, n] of removed) {
    if (n <= 0) continue;
    const { sex, age } = parseDemoKey(k);
    const have = pool.count({ age, sex, class: klass });
    const drop = Math.min(have, n);
    if (drop > 0) {
      pool.set({ age, sex, class: klass }, have - drop);
      applied += drop;
    }
  }
  return applied;
};
