import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { AGE_BANDS, agedKey, emptyPool, poolFromMap } from './cohort.js';
import type { AgeBand, CohortKey } from './cohort.js';
import { ROMAN_VITAL_RATES, tickDaily, tickYearly } from './vitalRates.js';
import { CHARACTER_CLASSES, SEXES } from './types.js';
import type { CharacterClass, Sex } from './types.js';

const k = (age: AgeBand, sex: Sex, cls: CharacterClass): CohortKey => ({ age, sex, class: cls });

const evenlyDistributedPool = (perBucket: number): ReturnType<typeof emptyPool> => {
  const m = new Map<string, number>();
  for (const a of AGE_BANDS) {
    for (const s of SEXES) {
      for (const c of CHARACTER_CLASSES) {
        m.set(agedKey({ age: a, sex: s, class: c }), perBucket);
      }
    }
  }
  return poolFromMap(m);
};

const totalCount = (pool: ReturnType<typeof emptyPool>): number => pool.total();

describe('ROMAN_VITAL_RATES', () => {
  it('matches docs/04 reference numbers (within plausible band)', () => {
    expect(ROMAN_VITAL_RATES.crudeBirthRatePer1000PerYear).toBeGreaterThanOrEqual(35);
    expect(ROMAN_VITAL_RATES.crudeBirthRatePer1000PerYear).toBeLessThanOrEqual(45);
    expect(ROMAN_VITAL_RATES.adultMortalityPer1000PerYear).toBeGreaterThanOrEqual(8);
    expect(ROMAN_VITAL_RATES.adultMortalityPer1000PerYear).toBeLessThanOrEqual(20);
    // Infant annual mortality such that ~30%+ die by 5 (1 - (1-r)^5 >= 0.3 → r >= 0.069)
    expect(ROMAN_VITAL_RATES.infantMortalityPerYearAge0_4).toBeGreaterThanOrEqual(0.05);
    expect(ROMAN_VITAL_RATES.infantMortalityPerYearAge0_4).toBeLessThanOrEqual(0.15);
    // Elder mortality should be higher than adult
    expect(ROMAN_VITAL_RATES.elderMortalityPer1000PerYear).toBeGreaterThan(
      ROMAN_VITAL_RATES.adultMortalityPer1000PerYear,
    );
  });
});

describe('tickDaily', () => {
  it('empty pool produces no births and no deaths', () => {
    const pool = emptyPool();
    const rng = createRng('empty-tick');
    for (let i = 0; i < 365; i++) tickDaily(pool, ROMAN_VITAL_RATES, rng);
    expect(pool.total()).toBe(0);
  });

  it('pool with no fertile females produces no births', () => {
    const pool = emptyPool();
    pool.set(k('20-24', 'male', 'plebeian'), 1000);
    pool.set(k('60-64', 'female', 'plebeian'), 1000);
    const rng = createRng('no-fertile');
    let beforeChildren =
      pool.count(k('0-4', 'female', 'plebeian')) + pool.count(k('0-4', 'male', 'plebeian'));
    expect(beforeChildren).toBe(0);
    for (let i = 0; i < 365; i++) tickDaily(pool, ROMAN_VITAL_RATES, rng);
    const afterChildren =
      pool.count(k('0-4', 'female', 'plebeian')) + pool.count(k('0-4', 'male', 'plebeian'));
    expect(afterChildren).toBe(0);
  });

  it('produces children when fertile females are present', () => {
    const pool = emptyPool();
    // Lots of fertile women across all classes so daily-rate births don't all round to 0.
    pool.set(k('20-24', 'female', 'plebeian'), 5000);
    pool.set(k('25-29', 'female', 'plebeian'), 5000);
    pool.set(k('30-34', 'female', 'plebeian'), 5000);
    pool.set(k('20-24', 'male', 'plebeian'), 5000);
    const rng = createRng('births');
    for (let i = 0; i < 365; i++) tickDaily(pool, ROMAN_VITAL_RATES, rng);
    const newborns =
      pool.count(k('0-4', 'female', 'plebeian')) + pool.count(k('0-4', 'male', 'plebeian'));
    expect(newborns).toBeGreaterThan(0);
  });

  it('produces deaths in adult cohorts over a year', () => {
    const pool = emptyPool();
    pool.set(k('30-34', 'male', 'plebeian'), 10000);
    const rng = createRng('deaths');
    const before = pool.count(k('30-34', 'male', 'plebeian'));
    for (let i = 0; i < 365; i++) tickDaily(pool, ROMAN_VITAL_RATES, rng);
    const after = pool.count(k('30-34', 'male', 'plebeian'));
    expect(after).toBeLessThan(before);
    // Adult mortality ~12 / 1000 / yr → expect ~1.2% loss; allow wide slack.
    const lossFraction = (before - after) / before;
    expect(lossFraction).toBeGreaterThan(0.005);
    expect(lossFraction).toBeLessThan(0.05);
  });

  it('elder mortality is higher than adult mortality', () => {
    const adultPool = emptyPool();
    adultPool.set(k('30-34', 'male', 'plebeian'), 10000);
    const elderPool = emptyPool();
    elderPool.set(k('70-74', 'male', 'plebeian'), 10000);
    const rng1 = createRng('elder-vs-adult-1');
    const rng2 = createRng('elder-vs-adult-2');
    for (let i = 0; i < 365; i++) {
      tickDaily(adultPool, ROMAN_VITAL_RATES, rng1);
      tickDaily(elderPool, ROMAN_VITAL_RATES, rng2);
    }
    const adultLoss = 10000 - adultPool.count(k('30-34', 'male', 'plebeian'));
    const elderLoss = 10000 - elderPool.count(k('70-74', 'male', 'plebeian'));
    expect(elderLoss).toBeGreaterThan(adultLoss);
  });

  it('infant mortality is higher than adult mortality (proportionally)', () => {
    const infantPool = emptyPool();
    infantPool.set(k('0-4', 'male', 'plebeian'), 10000);
    const adultPool = emptyPool();
    adultPool.set(k('30-34', 'male', 'plebeian'), 10000);
    const rng1 = createRng('infant-1');
    const rng2 = createRng('adult-1');
    for (let i = 0; i < 365; i++) {
      tickDaily(infantPool, ROMAN_VITAL_RATES, rng1);
      tickDaily(adultPool, ROMAN_VITAL_RATES, rng2);
    }
    const infantLoss = 10000 - infantPool.count(k('0-4', 'male', 'plebeian'));
    const adultLoss = 10000 - adultPool.count(k('30-34', 'male', 'plebeian'));
    expect(infantLoss).toBeGreaterThan(adultLoss);
  });

  it('is deterministic for the same seed', () => {
    const a = evenlyDistributedPool(50);
    const b = evenlyDistributedPool(50);
    const rngA = createRng('determinism');
    const rngB = createRng('determinism');
    for (let i = 0; i < 365; i++) {
      tickDaily(a, ROMAN_VITAL_RATES, rngA);
      tickDaily(b, ROMAN_VITAL_RATES, rngB);
    }
    expect(a.total()).toBe(b.total());
    for (const [key, n] of a.cohorts()) {
      expect(b.count(key)).toBe(n);
    }
  });

  it('healthy population grows over a year', () => {
    const pool = evenlyDistributedPool(100);
    const rng = createRng('growth');
    const before = totalCount(pool);
    for (let i = 0; i < 365; i++) tickDaily(pool, ROMAN_VITAL_RATES, rng);
    expect(pool.total()).toBeGreaterThan(before);
  });
});

describe('tickYearly', () => {
  it('ages 0-4 cohort up into 5-9', () => {
    const pool = emptyPool();
    pool.set(k('0-4', 'female', 'plebeian'), 80);
    pool.set(k('5-9', 'female', 'plebeian'), 0);
    const rng = createRng('yearly-1');
    tickYearly(pool, rng);
    expect(pool.count(k('0-4', 'female', 'plebeian'))).toBe(0);
    expect(pool.count(k('5-9', 'female', 'plebeian'))).toBe(80);
  });

  it('ages chains across all bands', () => {
    const pool = emptyPool();
    pool.set(k('70-74', 'male', 'patrician'), 5);
    pool.set(k('75-79', 'male', 'patrician'), 3);
    pool.set(k('80+', 'male', 'patrician'), 2);
    const rng = createRng('yearly-2');
    tickYearly(pool, rng);
    expect(pool.count(k('70-74', 'male', 'patrician'))).toBe(0);
    expect(pool.count(k('75-79', 'male', 'patrician'))).toBe(5);
    // 80+ accumulates: previous 80+ stays AND previous 75-79 ages in.
    expect(pool.count(k('80+', 'male', 'patrician'))).toBe(2 + 3);
  });

  it('preserves total population (no births/deaths in yearly)', () => {
    const pool = evenlyDistributedPool(7);
    const before = pool.total();
    const rng = createRng('yearly-3');
    tickYearly(pool, rng);
    expect(pool.total()).toBe(before);
  });

  it('shifts mass upward in the pyramid', () => {
    const pool = emptyPool();
    pool.set(k('20-24', 'female', 'plebeian'), 100);
    const rng = createRng('yearly-4');
    tickYearly(pool, rng);
    expect(pool.count(k('25-29', 'female', 'plebeian'))).toBe(100);
    expect(pool.count(k('20-24', 'female', 'plebeian'))).toBe(0);
  });

  it('preserves class identity through aging', () => {
    const pool = emptyPool();
    pool.set(k('20-24', 'female', 'slave'), 50);
    pool.set(k('20-24', 'female', 'patrician'), 30);
    const rng = createRng('yearly-5');
    tickYearly(pool, rng);
    expect(pool.count(k('25-29', 'female', 'slave'))).toBe(50);
    expect(pool.count(k('25-29', 'female', 'patrician'))).toBe(30);
  });
});

describe('combined daily + yearly ticks', () => {
  it('5 years of healthy ticks shifts the pyramid older overall', () => {
    const pool = evenlyDistributedPool(50);
    const rng = createRng('long-run');
    const initialOldest = pool.totalByAgeBand('80+');
    for (let year = 0; year < 5; year++) {
      for (let day = 0; day < 365; day++) {
        tickDaily(pool, ROMAN_VITAL_RATES, rng);
      }
      tickYearly(pool, rng);
    }
    // 80+ should accumulate from 75-79 → 80+ aging in, even with deaths.
    expect(pool.totalByAgeBand('80+')).toBeGreaterThan(initialOldest);
  });

  it('determinism across a multi-year run', () => {
    const a = evenlyDistributedPool(30);
    const b = evenlyDistributedPool(30);
    const rngA = createRng('multi-det');
    const rngB = createRng('multi-det');
    for (let year = 0; year < 3; year++) {
      for (let day = 0; day < 365; day++) {
        tickDaily(a, ROMAN_VITAL_RATES, rngA);
        tickDaily(b, ROMAN_VITAL_RATES, rngB);
      }
      tickYearly(a, rngA);
      tickYearly(b, rngB);
    }
    for (const [key, n] of a.cohorts()) {
      expect(b.count(key)).toBe(n);
    }
    expect(a.total()).toBe(b.total());
  });
});
