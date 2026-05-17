/**
 * Tests for the marginal-product wage model per docs/08
 * §"Marginal-product wages with class surplus shares".
 *
 * Key contracts:
 *   - Slaves always receive 0 cash wage.
 *   - Free classes receive max(subsistence, mp × class_share), quoted
 *     as integer ≥ 1 coin per docs/08 §"Integer-coin prices".
 *   - More mobile classes (foreigner > plebeian > freedman) capture
 *     larger surplus shares on high-margin recipes.
 *   - Loss-making recipes (output < input) fall back to subsistence.
 */

import { describe, expect, it } from 'vitest';

import { buildingId, recipeId, resourceId, jobId } from '../types.js';
import type { RecipeDef } from '../production/recipes.js';
import {
  SURPLUS_SHARE_BY_CLASS,
  marginalProductPerWorkerDay,
  wagePerWorkerDayForClass,
  conservativeWagePerWorkerDay,
} from './productionWages.js';

const GRAIN = resourceId('food.grain');
const FLOUR = resourceId('food.flour');
const SILK = resourceId('exotic.silk');
const LUXURY = resourceId('goods.luxury_textiles');

const millRecipe: RecipeDef = {
  id: recipeId('mill_test'),
  inputs: new Map([[GRAIN, 50]]),
  outputs: new Map([[FLOUR, 45]]),
  requires: new Map(),
  labor: new Map([[jobId('miller'), 1]]),
  building: buildingId('mill'),
};

describe('marginalProductPerWorkerDay', () => {
  it('returns the per-worker-day surplus at current prices', () => {
    // Mill: 50 grain @ 2 coin → 100 input. 45 flour @ 5 coin → 225 output.
    // mp_per_worker_day = (225 − 100) / 1 worker-day = 125.
    const prices = new Map([
      [GRAIN, 2],
      [FLOUR, 5],
    ]);
    expect(marginalProductPerWorkerDay(millRecipe, prices)).toBe(125);
  });

  it('clamps to 0 for a loss-making recipe', () => {
    // Flour priced below grain → negative surplus → clamp to 0.
    const prices = new Map([
      [GRAIN, 5],
      [FLOUR, 1],
    ]);
    expect(marginalProductPerWorkerDay(millRecipe, prices)).toBe(0);
  });

  it('returns 0 when the recipe has no labor (e.g. raw extraction)', () => {
    const idle: RecipeDef = {
      id: recipeId('idle'),
      inputs: new Map(),
      outputs: new Map([[GRAIN, 1]]),
      requires: new Map(),
      labor: new Map(),
      building: buildingId('farm'),
    };
    expect(marginalProductPerWorkerDay(idle, new Map([[GRAIN, 100]]))).toBe(0);
  });
});

describe('wagePerWorkerDayForClass', () => {
  const subsistence = 4; // integer-coin baseline
  const mp = 100; // generous marginal product

  it('returns 0 for slaves regardless of marginal product', () => {
    expect(wagePerWorkerDayForClass('slave', subsistence, mp)).toBe(0);
    expect(wagePerWorkerDayForClass('slave', 0, 1000)).toBe(0);
  });

  it('returns the larger of subsistence or mp×share for free classes', () => {
    // foreigner: 100 × 0.45 = 45; max(4, 45) = 45.
    expect(wagePerWorkerDayForClass('foreigner', subsistence, mp)).toBe(45);
    // plebeian: 100 × 0.35 = 35.
    expect(wagePerWorkerDayForClass('plebeian', subsistence, mp)).toBe(35);
    // freedman: 100 × 0.25 = 25.
    expect(wagePerWorkerDayForClass('freedman', subsistence, mp)).toBe(25);
    // patrician: 100 × 0.5 = 50.
    expect(wagePerWorkerDayForClass('patrician', subsistence, mp)).toBe(50);
  });

  it('falls back to subsistence on a low-margin recipe', () => {
    const lowMp = 2; // 2 × 0.45 = 0.9, below subsistence of 4
    expect(wagePerWorkerDayForClass('foreigner', subsistence, lowMp)).toBe(4);
    expect(wagePerWorkerDayForClass('plebeian', subsistence, lowMp)).toBe(4);
  });

  it('ceilings sub-1-coin subsistence to the 1-coin integer floor', () => {
    // Subsistence basket on a tiny test settlement might be 0.12 coin
    // (only one basket item priced). Workers earn at least 1 coin/day.
    expect(wagePerWorkerDayForClass('plebeian', 0.12, 0)).toBe(1);
    expect(wagePerWorkerDayForClass('foreigner', 0.5, 0)).toBe(1);
  });

  it('returns 0 when both subsistence and mp are 0', () => {
    expect(wagePerWorkerDayForClass('plebeian', 0, 0)).toBe(0);
  });

  it('foreigners earn more than freedmen on the same recipe (mobility premium)', () => {
    const foreignerWage = wagePerWorkerDayForClass('foreigner', subsistence, mp);
    const freedmanWage = wagePerWorkerDayForClass('freedman', subsistence, mp);
    expect(foreignerWage).toBeGreaterThan(freedmanWage);
  });
});

describe('conservativeWagePerWorkerDay (affordability cap)', () => {
  it('uses the largest class share so authorized capacity covers actual wage bill', () => {
    // mp 100 × conservative share 0.5 = 50; max(subsistence 4, 50) = 50.
    expect(conservativeWagePerWorkerDay(4, 100)).toBe(50);
  });

  it('ceilings to integer ≥ 1', () => {
    expect(conservativeWagePerWorkerDay(0.4, 0)).toBe(1);
  });
});

describe('SURPLUS_SHARE_BY_CLASS ordering', () => {
  it('respects the docs/08 mobility ordering', () => {
    expect(SURPLUS_SHARE_BY_CLASS.slave).toBe(0);
    expect(SURPLUS_SHARE_BY_CLASS.freedman).toBeLessThan(SURPLUS_SHARE_BY_CLASS.plebeian);
    expect(SURPLUS_SHARE_BY_CLASS.plebeian).toBeLessThan(SURPLUS_SHARE_BY_CLASS.foreigner);
  });
});

describe('integration: luxury textile vs grain milling', () => {
  it('luxury recipe pays free workers materially above subsistence', () => {
    // Luxury textiles: high margin → free workers get a real bonus.
    // Pretend recipe outputs 0.5 luxury @ 500 coin, inputs 1 cloth @ 60, labor 1 worker-day.
    // mp = (250 − 60) / 1 = 190. foreigner wage = max(4, 190×0.45) = 86.
    const luxuryRecipe: RecipeDef = {
      id: recipeId('weave_luxury_test'),
      inputs: new Map([[resourceId('goods.cloth'), 1]]),
      outputs: new Map([[LUXURY, 0.5]]),
      requires: new Map(),
      labor: new Map([[jobId('weaver'), 1]]),
      building: buildingId('weaver_workshop'),
    };
    const prices = new Map([
      [resourceId('goods.cloth'), 60],
      [LUXURY, 500],
      [SILK, 1000],
    ]);
    const mp = marginalProductPerWorkerDay(luxuryRecipe, prices);
    expect(mp).toBe(190);
    const subsistence = 4;
    expect(wagePerWorkerDayForClass('plebeian', subsistence, mp)).toBe(67); // 190 × 0.35 = 66.5 → ceil 67
    expect(wagePerWorkerDayForClass('foreigner', subsistence, mp)).toBe(86); // 190 × 0.45 = 85.5 → ceil 86
    // Slaves at the same luxury workshop: still 0 (owner captures full surplus).
    expect(wagePerWorkerDayForClass('slave', subsistence, mp)).toBe(0);
  });

  it('grain milling pays at subsistence (low margin)', () => {
    // mill: mp = 125 (from above). 125 × 0.35 = 43.75 → 44.
    // Still above subsistence here BUT this is because input/output prices in
    // this test fixture are unrealistic. Real grain milling has tighter spreads.
    const prices = new Map([
      [GRAIN, 5],
      [FLOUR, 5.2], // very tight spread
    ]);
    const mp = marginalProductPerWorkerDay(millRecipe, prices);
    // (45 × 5.2 − 50 × 5) / 1 = (234 − 250) / 1 = -16 → clamp 0.
    expect(mp).toBe(0);
    const subsistence = 4;
    expect(wagePerWorkerDayForClass('plebeian', subsistence, mp)).toBe(4);
    expect(wagePerWorkerDayForClass('foreigner', subsistence, mp)).toBe(4);
  });
});
