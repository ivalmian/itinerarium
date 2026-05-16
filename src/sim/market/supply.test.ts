/**
 * Supply schedule tests. Source: docs/08-money-and-trade.md "Supply: how it forms".
 *
 * Each owner emits a step-function source: 0 below their reservation price,
 * full availableToSell at or above it. The aggregate sums them.
 */

import { describe, expect, it } from 'vitest';
import { actorId } from '../types.js';
import { aggregateSupply, ownerSupply, type SupplySource } from './supply.js';

const A = actorId('actor:owner-A');
const B = actorId('actor:owner-B');

describe('ownerSupply step', () => {
  it('offers nothing below the reservation price', () => {
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 5,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(s.quantityAt(s.reservationPrice - 0.0001)).toBe(0);
  });

  it('offers everything available at or above the reservation price', () => {
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 5,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(s.quantityAt(s.reservationPrice)).toBe(100);
    expect(s.quantityAt(s.reservationPrice + 1)).toBe(100);
    expect(s.quantityAt(1e6)).toBe(100);
  });

  it('availableToSell = stockpile - reservedForOwnUse', () => {
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 25,
      productionCost: 5,
      expectedFuturePrice: 5,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(s.availableToSell).toBe(75);
    expect(s.quantityAt(s.reservationPrice)).toBe(75);
  });

  it('clamps availableToSell to zero when reservation exceeds stockpile', () => {
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 10,
      reservedForOwnUse: 50,
      productionCost: 5,
      expectedFuturePrice: 5,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(s.availableToSell).toBe(0);
    expect(s.quantityAt(1e6)).toBe(0);
  });
});

describe('reservation price', () => {
  it('with all-zero urgency, no spoilage = max(productionCost, expectedFuturePrice)', () => {
    const s1 = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 8,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(s1.reservationPrice).toBeCloseTo(8);

    const s2 = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 12,
      expectedFuturePrice: 8,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(s2.reservationPrice).toBeCloseTo(12);
  });

  it('patrician hoarder (urgency=0, high expectedFuturePrice) has higher reservation than poor seller (urgency=2, same conditions)', () => {
    const patrician = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 20,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    const poor = ownerSupply({
      ownerActor: B,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 20,
      ownerUrgencyFactor: 2,
      storageHoldingDays: 30,
    });
    expect(patrician.reservationPrice).toBeGreaterThan(poor.reservationPrice);
  });

  it('higher urgency lowers the opportunity premium but not below production cost', () => {
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 9,
      expectedFuturePrice: 9,
      ownerUrgencyFactor: 2,
      storageHoldingDays: 30,
    });
    // raw = max(9, 9) = 9; divisor = 1 + 2 = 3 would discount to 3,
    // but the marginal-cost floor keeps the ask at 9.
    expect(s.reservationPrice).toBeCloseTo(9);
  });

  it('perishable item near spoilage has lower reservation than fresh', () => {
    const fresh = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 10,
      ownerUrgencyFactor: 0,
      spoilageDaysRemaining: 30,
      storageHoldingDays: 30,
    });
    const nearSpoilage = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 10,
      ownerUrgencyFactor: 0,
      spoilageDaysRemaining: 1,
      storageHoldingDays: 30,
    });
    expect(nearSpoilage.reservationPrice).toBeLessThan(fresh.reservationPrice);
  });

  it('non-perishable (no spoilageDaysRemaining) does not feel spoilage pressure', () => {
    const nonPerishable = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 10,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    expect(nonPerishable.reservationPrice).toBeCloseTo(10);
  });

  it('production cost acts as a floor (cannot go below it via urgency alone)', () => {
    // Production cost is a true marginal-cost floor; urgency may lower the
    // opportunity premium, but not the physical cost floor.
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 10,
      expectedFuturePrice: 60,
      ownerUrgencyFactor: 20,
      storageHoldingDays: 30,
    });
    expect(s.reservationPrice).toBeCloseTo(10);
  });

  it('minimumReservationPrice prevents local-only goods from collapsing to zero', () => {
    // Per docs/08 §"Integer-coin prices": a true reservation of 0.35
    // floors to the 1-coin quoted ask.
    const s = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 0,
      minimumReservationPrice: 0.35,
      expectedFuturePrice: 0.1,
      ownerUrgencyFactor: 10,
      storageHoldingDays: 30,
    });
    expect(s.reservationPrice).toBe(1);
  });

  it('spoilageDaysRemaining at or above storageHoldingDays yields no spoilage pressure', () => {
    const ample = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 10,
      ownerUrgencyFactor: 0,
      spoilageDaysRemaining: 60,
      storageHoldingDays: 30,
    });
    expect(ample.reservationPrice).toBeCloseTo(10);
  });

  it('spoilageDaysRemaining = 0 yields full spoilage pressure (urgency += 1)', () => {
    const dying = ownerSupply({
      ownerActor: A,
      stockpile: 100,
      reservedForOwnUse: 0,
      productionCost: 0,
      expectedFuturePrice: 10,
      ownerUrgencyFactor: 0,
      spoilageDaysRemaining: 0,
      storageHoldingDays: 30,
    });
    // raw price = max(0, 10) = 10; spoilage urgency = 1; divisor = 2 → 5.
    expect(dying.reservationPrice).toBeCloseTo(5);
  });
});

describe('aggregateSupply', () => {
  const makeMix = (): SupplySource[] => [
    ownerSupply({
      ownerActor: A,
      stockpile: 50,
      reservedForOwnUse: 0,
      productionCost: 4,
      expectedFuturePrice: 4,
      ownerUrgencyFactor: 1,
      storageHoldingDays: 30,
    }),
    ownerSupply({
      ownerActor: B,
      stockpile: 30,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 10,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    }),
  ];

  it('totalAt equals the sum of quantityAt across sources at every test price', () => {
    const sources = makeMix();
    const agg = aggregateSupply(sources);
    for (const p of [0.001, 1, 1.99, 2, 2.01, 5, 9.99, 10, 10.01, 100]) {
      const expected = sources.reduce((s, src) => s + src.quantityAt(p), 0);
      expect(agg.totalAt(p)).toBeCloseTo(expected);
    }
  });

  it('exposes the same sources passed in', () => {
    const sources = makeMix();
    const agg = aggregateSupply(sources);
    expect(agg.sources).toEqual(sources);
  });

  it('with no sources, totalAt is 0 and breakpoints empty', () => {
    const agg = aggregateSupply([]);
    expect(agg.totalAt(0)).toBe(0);
    expect(agg.totalAt(100)).toBe(0);
    expect(agg.breakpoints()).toEqual([]);
  });

  it('breakpoints are sorted ascending by price and each contributes a positive jump', () => {
    const sources = makeMix();
    const agg = aggregateSupply(sources);
    const bps = agg.breakpoints();
    expect(bps.length).toBe(2);
    for (let i = 1; i < bps.length; i++) {
      // Safe: i in [1, bps.length-1].
      const prev = bps[i - 1] as { price: number; quantityChange: number };
      const cur = bps[i] as { price: number; quantityChange: number };
      expect(cur.price).toBeGreaterThanOrEqual(prev.price);
    }
    for (const bp of bps) {
      expect(bp.quantityChange).toBeGreaterThan(0);
    }
  });

  it('skips sources with zero availableToSell', () => {
    const empty = ownerSupply({
      ownerActor: A,
      stockpile: 0,
      reservedForOwnUse: 0,
      productionCost: 5,
      expectedFuturePrice: 5,
      ownerUrgencyFactor: 0,
      storageHoldingDays: 30,
    });
    const agg = aggregateSupply([empty]);
    expect(agg.breakpoints()).toEqual([]);
    expect(agg.totalAt(1e6)).toBe(0);
  });
});

describe('determinism', () => {
  it('repeated construction yields identical reservation prices', () => {
    const a = ownerSupply({
      ownerActor: A,
      stockpile: 50,
      reservedForOwnUse: 0,
      productionCost: 4,
      expectedFuturePrice: 7,
      ownerUrgencyFactor: 0.5,
      storageHoldingDays: 30,
    });
    const b = ownerSupply({
      ownerActor: A,
      stockpile: 50,
      reservedForOwnUse: 0,
      productionCost: 4,
      expectedFuturePrice: 7,
      ownerUrgencyFactor: 0.5,
      storageHoldingDays: 30,
    });
    expect(a.reservationPrice).toBe(b.reservationPrice);
    expect(a.availableToSell).toBe(b.availableToSell);
  });
});
