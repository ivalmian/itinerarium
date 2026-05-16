import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { emptyPool, poolFromMap, type CohortKey } from './cohort.js';
import {
  applyDeathsToPool,
  cloneDemographics,
  demoKey,
  drainDemographics,
  drawDemographicsFromPool,
  mergeDemographics,
  parseDemoKey,
  ROLE_BIASES,
  totalDemographics,
  validateDemographics,
} from './demographics.js';

const sumMap = (m: ReadonlyMap<string, number>): number => {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
};

describe('demoKey + parseDemoKey', () => {
  it('round-trips', () => {
    expect(parseDemoKey(demoKey('male', '20-24'))).toEqual({ sex: 'male', age: '20-24' });
    expect(parseDemoKey(demoKey('female', '70-74'))).toEqual({ sex: 'female', age: '70-74' });
  });

  it('rejects unknown keys', () => {
    expect(() => parseDemoKey('martian|99-99')).toThrow(/Unknown demographics key/);
  });
});

describe('validateDemographics', () => {
  it('accepts well-formed sparse maps', () => {
    expect(() =>
      validateDemographics(new Map([[demoKey('male', '25-29'), 5]])),
    ).not.toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => validateDemographics(new Map([['bogus', 1]]))).toThrow(/unknown key/);
  });

  it('rejects negative or non-integer counts', () => {
    expect(() => validateDemographics(new Map([[demoKey('male', '25-29'), -1]]))).toThrow();
    expect(() => validateDemographics(new Map([[demoKey('male', '25-29'), 1.5]]))).toThrow();
  });
});

describe('totalDemographics', () => {
  it('returns 0 for undefined', () => {
    expect(totalDemographics(undefined)).toBe(0);
  });
  it('sums values', () => {
    const d = new Map([
      [demoKey('male', '25-29'), 3],
      [demoKey('female', '30-34'), 2],
    ]);
    expect(totalDemographics(d)).toBe(5);
  });
});

describe('cloneDemographics', () => {
  it('drops zero-count buckets', () => {
    const d = new Map([
      [demoKey('male', '25-29'), 3],
      [demoKey('female', '30-34'), 0],
    ]);
    const c = cloneDemographics(d);
    expect(c.size).toBe(1);
    expect(c.get(demoKey('male', '25-29'))).toBe(3);
  });
});

describe('mergeDemographics', () => {
  it('sums overlapping buckets and includes new ones', () => {
    const a = new Map([
      [demoKey('male', '25-29'), 4],
      [demoKey('female', '30-34'), 1],
    ]);
    const b = new Map([
      [demoKey('male', '25-29'), 2],
      [demoKey('male', '15-19'), 3],
    ]);
    const out = mergeDemographics(a, b);
    expect(out.get(demoKey('male', '25-29'))).toBe(6);
    expect(out.get(demoKey('female', '30-34'))).toBe(1);
    expect(out.get(demoKey('male', '15-19'))).toBe(3);
  });

  it('treats either side as undefined gracefully', () => {
    const a = new Map([[demoKey('male', '20-24'), 5]]);
    expect(mergeDemographics(undefined, a).get(demoKey('male', '20-24'))).toBe(5);
    expect(mergeDemographics(a, undefined).get(demoKey('male', '20-24'))).toBe(5);
    expect(mergeDemographics(undefined, undefined).size).toBe(0);
  });

  it('does not mutate the inputs', () => {
    const a = new Map([[demoKey('male', '25-29'), 4]]);
    const b = new Map([[demoKey('male', '25-29'), 2]]);
    mergeDemographics(a, b);
    expect(a.get(demoKey('male', '25-29'))).toBe(4);
    expect(b.get(demoKey('male', '25-29'))).toBe(2);
  });
});

describe('drawDemographicsFromPool', () => {
  const fertileVillage = (): ReturnType<typeof poolFromMap> => {
    const m = new Map<string, number>();
    // 50 working-age males 20-39, 30 females 20-39, 20 elderly.
    const set = (
      k: CohortKey,
      n: number,
    ): void => {
      m.set(`${k.age}|${k.sex}|${k.class}`, n);
    };
    set({ age: '20-24', sex: 'male', class: 'plebeian' }, 25);
    set({ age: '25-29', sex: 'male', class: 'plebeian' }, 25);
    set({ age: '20-24', sex: 'female', class: 'plebeian' }, 15);
    set({ age: '25-29', sex: 'female', class: 'plebeian' }, 15);
    set({ age: '70-74', sex: 'male', class: 'plebeian' }, 10);
    set({ age: '70-74', sex: 'female', class: 'plebeian' }, 10);
    return poolFromMap(m);
  };

  it('returns empty for non-positive count', () => {
    const rng = createRng('t');
    const pool = fertileVillage();
    expect(drawDemographicsFromPool(pool, 0, ROLE_BIASES.caravan_drover, rng).size).toBe(0);
    expect(drawDemographicsFromPool(pool, -3, ROLE_BIASES.caravan_drover, rng).size).toBe(0);
  });

  it('total drawn equals requested count for non-zero pool', () => {
    const rng = createRng('draw-1');
    const pool = fertileVillage();
    const d = drawDemographicsFromPool(pool, 7, ROLE_BIASES.caravan_drover, rng);
    expect(sumMap(d)).toBe(7);
  });

  it('respects sex bias: caravan_guard heavily picks male', () => {
    const rng = createRng('draw-guard');
    const pool = fertileVillage();
    const d = drawDemographicsFromPool(pool, 50, ROLE_BIASES.caravan_guard, rng);
    expect(sumMap(d)).toBe(50);
    let male = 0;
    let female = 0;
    for (const [k, n] of d) {
      const { sex } = parseDemoKey(k);
      if (sex === 'male') male += n;
      else female += n;
    }
    // Pool has 40 prime males vs 30 prime females and a 0.05 sex bias.
    // Expected: nearly all male.
    expect(male).toBeGreaterThanOrEqual(40);
    expect(female).toBeLessThanOrEqual(10);
  });

  it('respects age bias: bandit_hanger_on picks children + young', () => {
    const rng = createRng('draw-hanger');
    const m = new Map<string, number>();
    m.set('5-9|male|plebeian', 20);
    m.set('5-9|female|plebeian', 20);
    m.set('25-29|male|plebeian', 20);
    m.set('70-74|female|plebeian', 20);
    const pool = poolFromMap(m);
    const d = drawDemographicsFromPool(pool, 10, ROLE_BIASES.bandit_hanger_on, rng);
    expect(sumMap(d)).toBe(10);
    let kids = 0;
    let elders = 0;
    for (const [k, n] of d) {
      const { age } = parseDemoKey(k);
      if (age === '5-9') kids += n;
      if (age === '70-74') elders += n;
    }
    expect(kids).toBeGreaterThan(elders);
  });

  it('falls back to a non-empty 25-29 split when pool is empty', () => {
    const rng = createRng('fallback');
    const d = drawDemographicsFromPool(emptyPool(), 5, ROLE_BIASES.caravan_drover, rng);
    expect(sumMap(d)).toBe(5);
  });

  it('falls back to a non-empty 25-29 split when pool is undefined', () => {
    const rng = createRng('fallback-undef');
    const d = drawDemographicsFromPool(undefined, 4, ROLE_BIASES.patrol_soldier, rng);
    expect(sumMap(d)).toBe(4);
    // patrol_soldier strongly prefers male.
    const male = d.get(demoKey('male', '25-29')) ?? 0;
    expect(male).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic for the same rng seed', () => {
    const pool = fertileVillage();
    const a = drawDemographicsFromPool(pool, 8, ROLE_BIASES.caravan_drover, createRng('det'));
    const b = drawDemographicsFromPool(pool, 8, ROLE_BIASES.caravan_drover, createRng('det'));
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('handles requests larger than the weighted pool', () => {
    const rng = createRng('overdraw');
    const m = new Map<string, number>();
    m.set('25-29|male|plebeian', 3);
    const pool = poolFromMap(m);
    const d = drawDemographicsFromPool(pool, 10, ROLE_BIASES.caravan_guard, rng);
    expect(sumMap(d)).toBe(10);
  });
});

describe('drainDemographics', () => {
  it('removes proportionally and sums to deathCount', () => {
    const rng = createRng('drain');
    const d = new Map([
      [demoKey('male', '25-29'), 10],
      [demoKey('female', '30-34'), 5],
    ]);
    const removed = drainDemographics(d, 6, rng);
    expect(sumMap(removed)).toBe(6);
    expect(sumMap(d)).toBe(15 - 6);
  });

  it('caps at total when deaths exceed pool', () => {
    const rng = createRng('drain-cap');
    const d = new Map([[demoKey('male', '25-29'), 4]]);
    const removed = drainDemographics(d, 100, rng);
    expect(sumMap(removed)).toBe(4);
    expect(d.size).toBe(0);
  });

  it('removes empty buckets', () => {
    const rng = createRng('drain-empty');
    const d = new Map([[demoKey('male', '25-29'), 3]]);
    drainDemographics(d, 3, rng);
    expect(d.has(demoKey('male', '25-29'))).toBe(false);
  });

  it('returns empty for non-positive deaths', () => {
    const d = new Map([[demoKey('male', '25-29'), 3]]);
    expect(drainDemographics(d, 0, createRng('z')).size).toBe(0);
    expect(drainDemographics(d, -1, createRng('z')).size).toBe(0);
  });
});

describe('applyDeathsToPool', () => {
  it('decrements pool counts for the chosen class', () => {
    const m = new Map<string, number>();
    m.set('25-29|male|plebeian', 10);
    m.set('25-29|female|plebeian', 8);
    const pool = poolFromMap(m);
    const removed = new Map([
      [demoKey('male', '25-29'), 3],
      [demoKey('female', '25-29'), 2],
    ]);
    const applied = applyDeathsToPool(pool, removed, 'plebeian');
    expect(applied).toBe(5);
    expect(pool.count({ age: '25-29', sex: 'male', class: 'plebeian' })).toBe(7);
    expect(pool.count({ age: '25-29', sex: 'female', class: 'plebeian' })).toBe(6);
  });

  it('clamps when a bucket would go negative', () => {
    const m = new Map<string, number>();
    m.set('25-29|male|plebeian', 2);
    const pool = poolFromMap(m);
    const removed = new Map([[demoKey('male', '25-29'), 5]]);
    const applied = applyDeathsToPool(pool, removed, 'plebeian');
    expect(applied).toBe(2);
    expect(pool.count({ age: '25-29', sex: 'male', class: 'plebeian' })).toBe(0);
  });
});
