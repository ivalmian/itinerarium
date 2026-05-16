/**
 * Demand schedule tests. Source: docs/08-money-and-trade.md "Demand: how it forms".
 *
 * The four kinds of demand (subsistence, comfort, status, derived input) each
 * have a distinct shape; the aggregate sums them. These tests assert the
 * shapes from the docs without locking us to one specific decay function for
 * comfort beyond "smooth, monotonic, falls to ~0 well past the budget".
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateDemand,
  comfortDemand,
  derivedInputDemand,
  statusDemand,
  subsistenceDemand,
  type DemandSource,
} from './demand.js';

describe('subsistenceDemand', () => {
  it('demands the full need at zero price', () => {
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    expect(d.quantityAt(0.000001)).toBeCloseTo(10);
  });

  it('demands the full need below the wealth/need threshold', () => {
    // need=10, wealth=100 → threshold p = 10. Below 10, quantity = 10.
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    expect(d.quantityAt(1)).toBeCloseTo(10);
    expect(d.quantityAt(5)).toBeCloseTo(10);
    expect(d.quantityAt(9.99)).toBeCloseTo(10);
  });

  it('exactly at the threshold, demand equals need', () => {
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    expect(d.quantityAt(10)).toBeCloseTo(10);
  });

  it('falls to wealth/p once price exceeds wealth/need', () => {
    // need=10, wealth=100, threshold=10. At p=20, quantity = 100/20 = 5.
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    expect(d.quantityAt(20)).toBeCloseTo(5);
    expect(d.quantityAt(50)).toBeCloseTo(2);
    expect(d.quantityAt(100)).toBeCloseTo(1);
  });

  it('approaches 0 as price → infinity but never hits 0', () => {
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    expect(d.quantityAt(1e9)).toBeGreaterThan(0);
    expect(d.quantityAt(1e9)).toBeLessThan(1e-6);
  });

  it('peakQuantity equals needPerDay', () => {
    const d = subsistenceDemand({ needPerDay: 7.5, segmentWealth: 100 });
    expect(d.peakQuantity).toBeCloseTo(7.5);
  });

  it('maxWillingnessToPay is +Infinity (subsistence has no upper bound)', () => {
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    expect(d.maxWillingnessToPay).toBe(Number.POSITIVE_INFINITY);
  });

  it('with zero wealth, demand is 0 above zero price', () => {
    const d = subsistenceDemand({ needPerDay: 10, segmentWealth: 0 });
    expect(d.quantityAt(1)).toBeCloseTo(0);
  });

  it('with zero need, demand is 0 everywhere', () => {
    const d = subsistenceDemand({ needPerDay: 0, segmentWealth: 100 });
    expect(d.quantityAt(0.001)).toBe(0);
    expect(d.quantityAt(100)).toBe(0);
    expect(d.peakQuantity).toBe(0);
  });
});

describe('comfortDemand', () => {
  it('demands full want quantity at zero price', () => {
    const d = comfortDemand({ wantQuantity: 5, budget: 10 });
    expect(d.quantityAt(0)).toBeCloseTo(5);
  });

  it('is monotonic non-increasing in price', () => {
    const d = comfortDemand({ wantQuantity: 5, budget: 10 });
    let prev = d.quantityAt(0);
    for (const p of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
      const q = d.quantityAt(p);
      expect(q).toBeLessThanOrEqual(prev + 1e-9);
      prev = q;
    }
  });

  it('approaches 0 well past the budget', () => {
    const d = comfortDemand({ wantQuantity: 5, budget: 10 });
    expect(d.quantityAt(1000)).toBeLessThan(0.01);
  });

  it('at price equal to the budget, demand has dropped meaningfully but not to zero', () => {
    const d = comfortDemand({ wantQuantity: 5, budget: 10 });
    const q = d.quantityAt(10);
    expect(q).toBeLessThan(5);
    expect(q).toBeGreaterThan(0);
  });

  it('peakQuantity equals wantQuantity', () => {
    const d = comfortDemand({ wantQuantity: 8, budget: 10 });
    expect(d.peakQuantity).toBeCloseTo(8);
  });

  it('maxWillingnessToPay is finite (comfort goods have a price ceiling)', () => {
    const d = comfortDemand({ wantQuantity: 5, budget: 10 });
    expect(Number.isFinite(d.maxWillingnessToPay)).toBe(true);
  });

  it('with zero want, demand is 0 everywhere', () => {
    const d = comfortDemand({ wantQuantity: 0, budget: 10 });
    expect(d.quantityAt(0)).toBe(0);
    expect(d.quantityAt(100)).toBe(0);
  });
});

describe('statusDemand', () => {
  it('returns full status_want below the threshold', () => {
    const d = statusDemand({ wantQuantity: 2, segmentWealth: 100000, veryHighThreshold: 500 });
    expect(d.quantityAt(0)).toBe(2);
    expect(d.quantityAt(1)).toBe(2);
    expect(d.quantityAt(499.99)).toBe(2);
  });

  it('returns full status_want exactly at the threshold', () => {
    const d = statusDemand({ wantQuantity: 2, segmentWealth: 100000, veryHighThreshold: 500 });
    expect(d.quantityAt(500)).toBe(2);
  });

  it('returns 0 above the threshold', () => {
    const d = statusDemand({ wantQuantity: 2, segmentWealth: 100000, veryHighThreshold: 500 });
    expect(d.quantityAt(500.01)).toBe(0);
    expect(d.quantityAt(10000)).toBe(0);
  });

  it('peakQuantity equals wantQuantity', () => {
    const d = statusDemand({ wantQuantity: 3, segmentWealth: 100000, veryHighThreshold: 500 });
    expect(d.peakQuantity).toBe(3);
  });

  it('maxWillingnessToPay equals veryHighThreshold', () => {
    const d = statusDemand({ wantQuantity: 3, segmentWealth: 100000, veryHighThreshold: 500 });
    expect(d.maxWillingnessToPay).toBe(500);
  });
});

describe('derivedInputDemand', () => {
  it('returns the full quantity below the integer-quoted break-even input price', () => {
    // expected revenue per input unit = 5, other costs = 1, margin = 0.5 → raw break-even = 3.5;
    // per docs/08 §"Integer-coin prices", the quoted bid floors to integer 3.
    const d = derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 5,
      otherCostsPerInputUnit: 1,
      margin: 0.5,
      productionCapacity: 10,
      inputPerOutput: 2,
    });
    // quantityDemanded = capacity * inputPerOutput = 20.
    expect(d.quantityAt(0.01)).toBe(20);
    expect(d.quantityAt(3)).toBe(20);
  });

  it('returns 0 above the integer-quoted break-even input price', () => {
    const d = derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 5,
      otherCostsPerInputUnit: 1,
      margin: 0.5,
      productionCapacity: 10,
      inputPerOutput: 2,
    });
    // Quoted bid = floor(3.5) = 3, so price 3.01 already drops the buyer.
    expect(d.quantityAt(3.01)).toBe(0);
    expect(d.quantityAt(100)).toBe(0);
  });

  it('returns 0 when break-even is non-positive (cloth market collapsed)', () => {
    const d = derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 1,
      otherCostsPerInputUnit: 1.5,
      margin: 0,
      productionCapacity: 10,
      inputPerOutput: 1,
    });
    expect(d.quantityAt(0.001)).toBe(0);
    expect(d.quantityAt(100)).toBe(0);
    expect(d.peakQuantity).toBe(0);
  });

  it('peakQuantity equals productionCapacity * inputPerOutput', () => {
    const d = derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 5,
      otherCostsPerInputUnit: 1,
      margin: 0.5,
      productionCapacity: 10,
      inputPerOutput: 2,
    });
    expect(d.peakQuantity).toBe(20);
  });

  it('maxWillingnessToPay equals the integer-quoted break-even input price', () => {
    // Raw break-even = 3.5; quoted bid floors to integer 3 per docs/08
    // §"Integer-coin prices".
    const d = derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 5,
      otherCostsPerInputUnit: 1,
      margin: 0.5,
      productionCapacity: 10,
      inputPerOutput: 2,
    });
    expect(d.maxWillingnessToPay).toBe(3);
  });
});

describe('aggregateDemand', () => {
  const makeMix = (): DemandSource[] => [
    subsistenceDemand({ needPerDay: 10, segmentWealth: 100 }),
    comfortDemand({ wantQuantity: 5, budget: 10 }),
    statusDemand({ wantQuantity: 2, segmentWealth: 100000, veryHighThreshold: 500 }),
    derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 5,
      otherCostsPerInputUnit: 1,
      margin: 0.5,
      productionCapacity: 10,
      inputPerOutput: 2,
    }),
  ];

  it('totalAt equals the sum of quantityAt across sources at every test price', () => {
    const sources = makeMix();
    const agg = aggregateDemand(sources);
    for (const p of [0.001, 1, 3, 3.5, 5, 9, 10, 50, 100, 499, 500, 501, 1e6]) {
      const expected = sources.reduce((s, src) => s + src.quantityAt(p), 0);
      expect(agg.totalAt(p)).toBeCloseTo(expected);
    }
  });

  it('exposes the same sources passed in', () => {
    const sources = makeMix();
    const agg = aggregateDemand(sources);
    expect(agg.sources).toEqual(sources);
  });

  it('with no sources, totalAt is 0 everywhere', () => {
    const agg = aggregateDemand([]);
    expect(agg.totalAt(0)).toBe(0);
    expect(agg.totalAt(100)).toBe(0);
    expect(agg.breakpoints()).toEqual([]);
  });

  it('breakpoints are sorted ascending by price', () => {
    const sources = makeMix();
    const agg = aggregateDemand(sources);
    const bps = agg.breakpoints();
    for (let i = 1; i < bps.length; i++) {
      // Safe: i in [1, bps.length-1].
      const prev = bps[i - 1] as { price: number; quantityChange: number };
      const cur = bps[i] as { price: number; quantityChange: number };
      expect(cur.price).toBeGreaterThanOrEqual(prev.price);
    }
  });

  it('breakpoints include the status threshold and derived-break-even drops', () => {
    const status = statusDemand({
      wantQuantity: 2,
      segmentWealth: 100000,
      veryHighThreshold: 500,
    });
    const derived = derivedInputDemand({
      expectedOutputRevenuePerInputUnit: 5,
      otherCostsPerInputUnit: 1,
      margin: 0.5,
      productionCapacity: 10,
      inputPerOutput: 2,
    });
    const agg = aggregateDemand([status, derived]);
    const bps = agg.breakpoints();
    const prices = bps.map((b) => b.price);
    // Both breakpoints sit at integer coin prices per docs/08 §"Integer-
    // coin prices": status at 500 (already integer), derived at floor(3.5)=3.
    expect(prices).toContain(500);
    expect(prices).toContain(3);
    const statusBp = bps.find((b) => b.price === 500);
    expect(statusBp?.quantityChange).toBe(-2);
    const derivedBp = bps.find((b) => b.price === 3);
    expect(derivedBp?.quantityChange).toBe(-20);
  });
});

describe('determinism', () => {
  it('repeated construction with the same args yields the same curve', () => {
    const a = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    const b = subsistenceDemand({ needPerDay: 10, segmentWealth: 100 });
    for (const p of [1, 5, 10, 20, 50]) {
      expect(a.quantityAt(p)).toBe(b.quantityAt(p));
    }
  });
});
