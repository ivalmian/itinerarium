import { describe, expect, it } from 'vitest';
import { AGE_BANDS, agedKey, ageBandIndex, emptyPool, poolFromMap } from './cohort.js';
import type { CohortKey } from './cohort.js';
import { CHARACTER_CLASSES, SEXES } from './types.js';

const k = (
  age: (typeof AGE_BANDS)[number],
  sex: 'male' | 'female',
  cls: 'patrician' | 'plebeian' | 'freedman' | 'slave' | 'foreigner',
): CohortKey => ({ age, sex, class: cls });

describe('AGE_BANDS', () => {
  it('has 17 contiguous 5-year buckets ending in 80+', () => {
    expect(AGE_BANDS).toHaveLength(17);
    expect(AGE_BANDS[0]).toBe('0-4');
    expect(AGE_BANDS[16]).toBe('80+');
  });

  it('ageBandIndex returns the position', () => {
    expect(ageBandIndex('0-4')).toBe(0);
    expect(ageBandIndex('5-9')).toBe(1);
    expect(ageBandIndex('80+')).toBe(16);
  });
});

describe('agedKey', () => {
  it('encodes a stable string key for cohorts', () => {
    const key = agedKey(k('20-24', 'female', 'plebeian'));
    expect(typeof key).toBe('string');
    expect(key).toContain('20-24');
    expect(key).toContain('female');
    expect(key).toContain('plebeian');
  });

  it('different cohorts produce different keys', () => {
    const a = agedKey(k('20-24', 'female', 'plebeian'));
    const b = agedKey(k('20-24', 'male', 'plebeian'));
    const c = agedKey(k('25-29', 'female', 'plebeian'));
    const d = agedKey(k('20-24', 'female', 'patrician'));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe('PopulationPool', () => {
  it('empty pool has zero counts', () => {
    const p = emptyPool();
    expect(p.total()).toBe(0);
    expect(p.count(k('20-24', 'female', 'plebeian'))).toBe(0);
  });

  it('set and count round-trip', () => {
    const p = emptyPool();
    p.set(k('20-24', 'female', 'plebeian'), 42);
    expect(p.count(k('20-24', 'female', 'plebeian'))).toBe(42);
    expect(p.total()).toBe(42);
  });

  it('overwriting set replaces, not adds', () => {
    const p = emptyPool();
    p.set(k('30-34', 'male', 'slave'), 10);
    p.set(k('30-34', 'male', 'slave'), 7);
    expect(p.count(k('30-34', 'male', 'slave'))).toBe(7);
    expect(p.total()).toBe(7);
  });

  it('totalByClass sums across age & sex', () => {
    const p = emptyPool();
    p.set(k('5-9', 'female', 'slave'), 5);
    p.set(k('5-9', 'male', 'slave'), 3);
    p.set(k('40-44', 'female', 'slave'), 12);
    p.set(k('20-24', 'female', 'plebeian'), 100);
    expect(p.totalByClass('slave')).toBe(20);
    expect(p.totalByClass('plebeian')).toBe(100);
    expect(p.totalByClass('patrician')).toBe(0);
  });

  it('totalByAgeBand sums across class & sex', () => {
    const p = emptyPool();
    p.set(k('20-24', 'female', 'plebeian'), 10);
    p.set(k('20-24', 'male', 'plebeian'), 9);
    p.set(k('20-24', 'female', 'slave'), 4);
    p.set(k('25-29', 'female', 'plebeian'), 20);
    expect(p.totalByAgeBand('20-24')).toBe(23);
    expect(p.totalByAgeBand('25-29')).toBe(20);
    expect(p.totalByAgeBand('80+')).toBe(0);
  });

  it('cohorts() iterates only nonzero buckets', () => {
    const p = emptyPool();
    p.set(k('20-24', 'female', 'plebeian'), 1);
    p.set(k('30-34', 'male', 'slave'), 2);
    const collected = Array.from(p.cohorts());
    expect(collected).toHaveLength(2);
    const counts = collected.map(([, n]) => n).sort((a, b) => a - b);
    expect(counts).toEqual([1, 2]);
  });

  it('setting count to 0 removes the cohort from iteration', () => {
    const p = emptyPool();
    p.set(k('20-24', 'female', 'plebeian'), 5);
    p.set(k('20-24', 'female', 'plebeian'), 0);
    expect(Array.from(p.cohorts())).toHaveLength(0);
    expect(p.total()).toBe(0);
  });

  it('rejects negative counts', () => {
    const p = emptyPool();
    expect(() => p.set(k('20-24', 'female', 'plebeian'), -1)).toThrow();
  });

  it('rejects non-integer counts', () => {
    const p = emptyPool();
    expect(() => p.set(k('20-24', 'female', 'plebeian'), 3.5)).toThrow();
  });

  it('copy() is a deep copy', () => {
    const p = emptyPool();
    p.set(k('20-24', 'female', 'plebeian'), 10);
    const q = p.copy();
    q.set(k('20-24', 'female', 'plebeian'), 99);
    expect(p.count(k('20-24', 'female', 'plebeian'))).toBe(10);
    expect(q.count(k('20-24', 'female', 'plebeian'))).toBe(99);
  });

  it('poolFromMap loads from a map of encoded keys', () => {
    const m = new Map<string, number>();
    m.set(agedKey(k('20-24', 'female', 'plebeian')), 50);
    m.set(agedKey(k('30-34', 'male', 'slave')), 7);
    const p = poolFromMap(m);
    expect(p.total()).toBe(57);
    expect(p.count(k('20-24', 'female', 'plebeian'))).toBe(50);
    expect(p.count(k('30-34', 'male', 'slave'))).toBe(7);
  });

  it('poolFromMap rejects unknown keys', () => {
    const m = new Map<string, number>();
    m.set('not-a-real-key', 1);
    expect(() => poolFromMap(m)).toThrow();
  });
});

describe('exhaustive cohort coverage', () => {
  it('17 ages × 2 sexes × 5 classes = 170 distinct keys', () => {
    const seen = new Set<string>();
    for (const a of AGE_BANDS) {
      for (const s of SEXES) {
        for (const c of CHARACTER_CLASSES) {
          seen.add(agedKey({ age: a, sex: s, class: c }));
        }
      }
    }
    expect(seen.size).toBe(17 * 2 * 5);
  });
});
