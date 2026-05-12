import { describe, expect, it } from 'vitest';

import { resourceId } from '../types.js';

import {
  isServiceTransaction,
  wholeUnits,
  wholeUnitsForTransaction,
} from './wholeUnits.js';

describe('wholeUnits', () => {
  it.each([
    [0, 0],
    [0.4, 0],
    [0.999_999, 0],
    [1, 1],
    [1.4, 1],
    [2.999, 2],
    [62.5, 62],
    [10_000, 10_000],
  ])('floors %f → %d', (input, expected) => {
    expect(wholeUnits(input)).toBe(expected);
  });

  it('clamps negative and non-finite values to zero', () => {
    // Non-finite values (NaN, ±Infinity) clamp to zero — a trade
    // quantity must be a representable integer to settle.
    expect(wholeUnits(-1)).toBe(0);
    expect(wholeUnits(Number.NaN)).toBe(0);
    expect(wholeUnits(Number.POSITIVE_INFINITY)).toBe(0);
    expect(wholeUnits(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('isServiceTransaction', () => {
  it('identifies service resources by the `service.` prefix', () => {
    expect(isServiceTransaction(resourceId('service.garrison'))).toBe(true);
    expect(isServiceTransaction(resourceId('service.administration'))).toBe(true);
    expect(isServiceTransaction(resourceId('service.priesthood'))).toBe(true);
    expect(isServiceTransaction(resourceId('service.public_works'))).toBe(true);
  });

  it('returns false for tangible goods', () => {
    expect(isServiceTransaction(resourceId('food.grain'))).toBe(false);
    expect(isServiceTransaction(resourceId('food.bread'))).toBe(false);
    expect(isServiceTransaction(resourceId('goods.tools'))).toBe(false);
    expect(isServiceTransaction(resourceId('livestock.cattle'))).toBe(false);
  });
});

describe('wholeUnitsForTransaction', () => {
  it('floors tangible goods to integer units', () => {
    expect(wholeUnitsForTransaction(resourceId('food.bread'), 1)).toBe(1);
    expect(wholeUnitsForTransaction(resourceId('food.bread'), 12.4)).toBe(12);
    expect(wholeUnitsForTransaction(resourceId('food.bread'), 0.5)).toBe(0);
    expect(wholeUnitsForTransaction(resourceId('goods.tools'), 62.5)).toBe(62);
  });

  it('passes service capacity through fractionally', () => {
    expect(wholeUnitsForTransaction(resourceId('service.priesthood'), 0.4)).toBeCloseTo(0.4);
    expect(wholeUnitsForTransaction(resourceId('service.garrison'), 3.7)).toBeCloseTo(3.7);
  });

  it('clamps services at zero for negative input', () => {
    expect(wholeUnitsForTransaction(resourceId('service.garrison'), -1)).toBe(0);
  });
});
