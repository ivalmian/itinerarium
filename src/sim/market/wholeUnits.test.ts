import { describe, expect, it } from 'vitest';

import { resourceId } from '../types.js';

import {
  integerCoinAsk,
  integerCoinBid,
  integerCoinClearing,
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

describe('integerCoinAsk', () => {
  it.each([
    [0.4, 1],
    [0.999, 1],
    [1, 1],
    [1.1, 2],
    [2, 2],
    [3.7, 4],
    [100, 100],
  ])('rounds up to integer ≥ 1: %f → %d', (input, expected) => {
    expect(integerCoinAsk(input)).toBe(expected);
  });

  it('clamps zero, negatives, and non-finite to the 1-coin floor', () => {
    // Asks are sellers' prices; a non-positive or unknown ask would
    // otherwise let a seller quote below cost, so we floor at 1 coin.
    expect(integerCoinAsk(0)).toBe(1);
    expect(integerCoinAsk(-3)).toBe(1);
    expect(integerCoinAsk(Number.NaN)).toBe(1);
    expect(integerCoinAsk(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('integerCoinBid', () => {
  it.each([
    [0.4, 1],
    [0.999, 1],
    [1, 1],
    [1.1, 1],
    [2.7, 2],
    [3, 3],
    [100, 100],
  ])('floors positive bids to integer ≥ 1: %f → %d', (input, expected) => {
    expect(integerCoinBid(input)).toBe(expected);
  });

  it('preserves 0 and clamps negatives/non-finite to 0', () => {
    // Bids that are 0 mean the source has no actual willingness to pay
    // (e.g. a comfort segment with zero discretionary budget). We keep
    // 0 representable so the demand source can still be a valid no-bid.
    expect(integerCoinBid(0)).toBe(0);
    expect(integerCoinBid(-1)).toBe(0);
    expect(integerCoinBid(Number.NaN)).toBe(0);
    // +Infinity is a sentinel used by subsistence; the bid quantizer is
    // only called for finite-WTP curves, but defensively returns 0.
    expect(integerCoinBid(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('integerCoinClearing', () => {
  it.each([
    [0.4, 1],
    [1, 1],
    [1.2, 1],
    [1.6, 2],
    [4.5, 5],
    [4.4, 4],
    [100, 100],
  ])('rounds to nearest integer ≥ 1: %f → %d', (input, expected) => {
    expect(integerCoinClearing(input)).toBe(expected);
  });

  it('passes +Infinity through (famine sentinel)', () => {
    expect(integerCoinClearing(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('clamps zero and negatives to the 1-coin floor', () => {
    expect(integerCoinClearing(0)).toBe(1);
    expect(integerCoinClearing(-3)).toBe(1);
  });

  it('passes NaN through unchanged (non-finite caller decides)', () => {
    expect(integerCoinClearing(Number.NaN)).toBeNaN();
  });
});
