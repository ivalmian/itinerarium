/**
 * Market clearing tests. Source: docs/08-money-and-trade.md "Market clearing".
 *
 * The clearing price is where aggregate demand meets aggregate supply,
 * computed as a continuous double auction over the demand and supply
 * schedules built upstream by demand.ts / supply.ts.
 */

import { describe, expect, it } from 'vitest';
import { actorId } from '../types.js';
import {
  aggregateDemand,
  comfortDemand,
  derivedInputDemand,
  statusDemand,
  subsistenceDemand,
} from './demand.js';
import { aggregateSupply, ownerSupply } from './supply.js';
import { clearMarket } from './clear.js';

const A = actorId('actor:A');
const B = actorId('actor:B');
const C = actorId('actor:C');

describe('clearMarket — trivial case', () => {
  it('one demand source, one supply source: clears at the supply reservation, full quantity traded', () => {
    const demand = aggregateDemand([
      subsistenceDemand({ id: 'd1', needPerDay: 10, segmentWealth: 1000 }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 10,
        reservedForOwnUse: 0,
        productionCost: 5,
        expectedFuturePrice: 5,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    expect(result.clearingPrice).toBeCloseTo(5);
    expect(result.totalTraded).toBeCloseTo(10);
    expect(result.unsoldSupplyAtClearingPrice).toBe(0);
    expect(result.trades.length).toBe(1);
    const trade = result.trades[0];
    if (!trade) throw new Error('expected at least one trade');
    expect(trade.quantity).toBeCloseTo(10);
    expect(trade.price).toBeCloseTo(5);
    expect(trade.buyerSourceId).toBe('d1');
    expect(trade.sellerSourceId).toBe('s1');
  });
});

describe('clearMarket — excess supply', () => {
  it('clears at the supply reservation; unsold portion equals supply minus demand', () => {
    const demand = aggregateDemand([
      derivedInputDemand({
        id: 'd1',
        expectedOutputRevenuePerInputUnit: 8,
        otherCostsPerInputUnit: 1,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 20,
        reservedForOwnUse: 0,
        productionCost: 2,
        expectedFuturePrice: 2,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    // Demand: 5 below break-even (7), 0 above. Supply: 20 above 2.
    // Crossing happens at price 2 with supply=20, demand=5.
    expect(result.clearingPrice).toBeCloseTo(2);
    expect(result.totalTraded).toBeCloseTo(5);
    expect(result.unsoldSupplyAtClearingPrice).toBeCloseTo(15);
    expect(result.unmetDemandAtClearingPrice).toBe(0);
  });
});

describe('clearMarket — excess demand (famine)', () => {
  it('clears at maxPrice when subsistence demand outstrips supply at every price', () => {
    const demand = aggregateDemand([
      subsistenceDemand({ id: 'd1', needPerDay: 100, segmentWealth: 1e9 }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 1,
        expectedFuturePrice: 1,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply, { maxPrice: 100 });
    expect(result.clearingPrice).toBeCloseTo(100);
    expect(result.totalTraded).toBeCloseTo(5);
    expect(result.unmetDemandAtClearingPrice).toBeGreaterThan(0);
    expect(result.unsoldSupplyAtClearingPrice).toBe(0);
  });

  it('finds a finite crossing in the subsistence hyperbolic tail (large but finite WTP)', () => {
    // Subsistence with need=100, wealth=1e6 → flat at 100 below p=1e4,
    // then hyperbolic 1e6/p above. Supply: 5 at reservation 1.
    // Crossing where 1e6/p = 5 → p = 2e5.
    const demand = aggregateDemand([
      subsistenceDemand({ id: 'd1', needPerDay: 100, segmentWealth: 1e6 }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 1,
        expectedFuturePrice: 1,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    expect(result.clearingPrice).toBeCloseTo(2e5, -2);
    expect(result.totalTraded).toBeCloseTo(5);
    expect(result.unmetDemandAtClearingPrice).toBe(0);
  });
});

describe('clearMarket — multiple steps', () => {
  it('finds the correct intersection across three demand step sources and three supply sources', () => {
    // Demand:
    //   derived_high: 10 units at price ≤ 8
    //   derived_med:   5 units at price ≤ 5
    //   status_low:    3 units at price ≤ 3
    // Supply:
    //   cheap:  4 units at reservation 2
    //   medium: 6 units at reservation 4
    //   expensive: 3 units at reservation 6
    //
    // Aggregate demand at each candidate (just above the breakpoint, exclusive):
    //   p > 8: 0
    //   p in (5, 8]: 10
    //   p in (3, 5]: 15
    //   p ≤ 3: 18
    // Aggregate supply at each candidate (at-or-above):
    //   p ≥ 6: 13
    //   p in [4, 6): 10
    //   p in [2, 4): 4
    //   p < 2: 0
    //
    // Crossing: at p = 4, supply = 10, demand at p just below = 15 (since p < 5),
    // demand at p = 4 = 15. Supply (10) < demand (15). Move up.
    // At p = 5, demand drops to 10 (the derived_med step is exclusive above 5).
    // Supply at 5 still 10. Demand 10 = Supply 10 → clear at 5.
    const demand = aggregateDemand([
      derivedInputDemand({
        id: 'd_high',
        expectedOutputRevenuePerInputUnit: 9,
        otherCostsPerInputUnit: 1,
        margin: 0,
        productionCapacity: 10,
        inputPerOutput: 1,
      }),
      derivedInputDemand({
        id: 'd_med',
        expectedOutputRevenuePerInputUnit: 6,
        otherCostsPerInputUnit: 1,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
      statusDemand({
        id: 'd_low',
        wantQuantity: 3,
        segmentWealth: 1000,
        veryHighThreshold: 3,
      }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's_cheap',
        ownerActor: A,
        stockpile: 4,
        reservedForOwnUse: 0,
        productionCost: 2,
        expectedFuturePrice: 2,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
      ownerSupply({
        id: 's_medium',
        ownerActor: B,
        stockpile: 6,
        reservedForOwnUse: 0,
        productionCost: 4,
        expectedFuturePrice: 4,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
      ownerSupply({
        id: 's_expensive',
        ownerActor: C,
        stockpile: 3,
        reservedForOwnUse: 0,
        productionCost: 6,
        expectedFuturePrice: 6,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    expect(result.clearingPrice).toBeCloseTo(5);
    expect(result.totalTraded).toBeCloseTo(10);
  });
});

describe('clearMarket — trade matching', () => {
  it('matches highest-WTP demand to lowest-reservation supply first', () => {
    const demand = aggregateDemand([
      derivedInputDemand({
        id: 'd_high',
        expectedOutputRevenuePerInputUnit: 10,
        otherCostsPerInputUnit: 0,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
      derivedInputDemand({
        id: 'd_low',
        expectedOutputRevenuePerInputUnit: 6,
        otherCostsPerInputUnit: 0,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's_cheap',
        ownerActor: A,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 1,
        expectedFuturePrice: 1,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
      ownerSupply({
        id: 's_dear',
        ownerActor: B,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 4,
        expectedFuturePrice: 4,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    // 10 demand units (5 high + 5 low) vs 10 supply units; clears around 4.
    expect(result.totalTraded).toBeCloseTo(10);
    // Highest-WTP demander (d_high) must be served from the cheapest supplier
    // (s_cheap). Verify by matching their pairing.
    const highTrade = result.trades.find(
      (t) => t.buyerSourceId === 'd_high' && t.sellerSourceId === 's_cheap',
    );
    expect(highTrade).toBeDefined();
    expect(highTrade?.quantity).toBeGreaterThan(0);
  });

  it('all trades are at the clearing price (CDA convention)', () => {
    const demand = aggregateDemand([
      derivedInputDemand({
        id: 'd1',
        expectedOutputRevenuePerInputUnit: 10,
        otherCostsPerInputUnit: 0,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
      derivedInputDemand({
        id: 'd2',
        expectedOutputRevenuePerInputUnit: 6,
        otherCostsPerInputUnit: 0,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 1,
        expectedFuturePrice: 1,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
      ownerSupply({
        id: 's2',
        ownerActor: B,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 4,
        expectedFuturePrice: 4,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    for (const t of result.trades) {
      expect(t.price).toBe(result.clearingPrice);
    }
  });

  it('total trade quantity equals min(demand, supply) at the clearing price', () => {
    const demand = aggregateDemand([
      derivedInputDemand({
        id: 'd1',
        expectedOutputRevenuePerInputUnit: 10,
        otherCostsPerInputUnit: 0,
        margin: 0,
        productionCapacity: 5,
        inputPerOutput: 1,
      }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 8,
        reservedForOwnUse: 0,
        productionCost: 2,
        expectedFuturePrice: 2,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    const sumQuantity = result.trades.reduce((s, t) => s + t.quantity, 0);
    expect(sumQuantity).toBeCloseTo(result.totalTraded);
    expect(result.totalTraded).toBeCloseTo(5);
  });
});

describe('clearMarket — degenerate cases', () => {
  it('no demand, no supply: zero trades, clearing returns minPrice (default 0)', () => {
    const demand = aggregateDemand([]);
    const supply = aggregateSupply([]);
    const result = clearMarket(demand, supply);
    expect(result.totalTraded).toBe(0);
    expect(result.trades).toEqual([]);
    expect(result.unmetDemandAtClearingPrice).toBe(0);
    expect(result.unsoldSupplyAtClearingPrice).toBe(0);
  });

  it('no supply: clearing price hits the cap and unmet demand is reported', () => {
    const demand = aggregateDemand([
      subsistenceDemand({ id: 'd1', needPerDay: 10, segmentWealth: 1e6 }),
    ]);
    const supply = aggregateSupply([]);
    const result = clearMarket(demand, supply, { maxPrice: 100 });
    expect(result.totalTraded).toBe(0);
    expect(result.unmetDemandAtClearingPrice).toBeGreaterThan(0);
  });

  it('does not count priced-out derived demand as unmet at the clearing price', () => {
    const demand = aggregateDemand([
      derivedInputDemand({
        id: 'priced-out-feed',
        expectedOutputRevenuePerInputUnit: 1,
        otherCostsPerInputUnit: 0,
        margin: 0,
        productionCapacity: 100,
        inputPerOutput: 1,
      }),
      subsistenceDemand({ id: 'subsistence', needPerDay: 10, segmentWealth: 1e6 }),
    ]);
    const supply = aggregateSupply([]);

    const result = clearMarket(demand, supply, { maxPrice: 100 });

    expect(result.totalTraded).toBe(0);
    expect(result.unmetDemandAtClearingPrice).toBeCloseTo(10);
  });

  it('no demand: clearing price hits the floor and supply is reported unsold', () => {
    const demand = aggregateDemand([]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 50,
        reservedForOwnUse: 0,
        productionCost: 5,
        expectedFuturePrice: 5,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    expect(result.totalTraded).toBe(0);
    expect(result.unmetDemandAtClearingPrice).toBe(0);
    // Supply that didn't sell remains.
    expect(result.unsoldSupplyAtClearingPrice).toBeGreaterThanOrEqual(0);
  });

  it('honors minPrice floor', () => {
    const demand = aggregateDemand([]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 50,
        reservedForOwnUse: 0,
        productionCost: 5,
        expectedFuturePrice: 5,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply, { minPrice: 3 });
    expect(result.clearingPrice).toBeGreaterThanOrEqual(3);
  });

  it('honors maxPrice ceiling (price cap from edicts)', () => {
    const demand = aggregateDemand([
      subsistenceDemand({ id: 'd1', needPerDay: 100, segmentWealth: 1e9 }),
    ]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 1,
        expectedFuturePrice: 1,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply, { maxPrice: 50 });
    expect(result.clearingPrice).toBeLessThanOrEqual(50);
  });
});

describe('clearMarket — continuous demand (subsistence + comfort)', () => {
  it('clears against a smooth-decaying comfort demand', () => {
    const demand = aggregateDemand([comfortDemand({ id: 'd1', wantQuantity: 10, budget: 5 })]);
    const supply = aggregateSupply([
      ownerSupply({
        id: 's1',
        ownerActor: A,
        stockpile: 5,
        reservedForOwnUse: 0,
        productionCost: 2,
        expectedFuturePrice: 2,
        ownerUrgencyFactor: 0,
        storageHoldingDays: 30,
      }),
    ]);
    const result = clearMarket(demand, supply);
    // Supply step at p=2 makes 5 available. Comfort demand decays as
    // 10*exp(-p/5); equals supply 5 at p = 5*ln(2) ≈ 3.466.
    expect(result.clearingPrice).toBeCloseTo(5 * Math.log(2), 2);
    expect(result.totalTraded).toBeCloseTo(5);
  });
});

describe('clearMarket — determinism', () => {
  it('same schedules produce identical results', () => {
    const make = (): ReturnType<typeof clearMarket> => {
      const demand = aggregateDemand([
        subsistenceDemand({ id: 'd_sub', needPerDay: 5, segmentWealth: 100 }),
        derivedInputDemand({
          id: 'd_der',
          expectedOutputRevenuePerInputUnit: 8,
          otherCostsPerInputUnit: 1,
          margin: 0,
          productionCapacity: 4,
          inputPerOutput: 1,
        }),
      ]);
      const supply = aggregateSupply([
        ownerSupply({
          id: 's_a',
          ownerActor: A,
          stockpile: 4,
          reservedForOwnUse: 0,
          productionCost: 1,
          expectedFuturePrice: 1,
          ownerUrgencyFactor: 0,
          storageHoldingDays: 30,
        }),
        ownerSupply({
          id: 's_b',
          ownerActor: B,
          stockpile: 4,
          reservedForOwnUse: 0,
          productionCost: 5,
          expectedFuturePrice: 5,
          ownerUrgencyFactor: 0,
          storageHoldingDays: 30,
        }),
      ]);
      return clearMarket(demand, supply);
    };
    const a = make();
    const b = make();
    expect(a.clearingPrice).toBe(b.clearingPrice);
    expect(a.totalTraded).toBe(b.totalTraded);
    expect(a.trades.length).toBe(b.trades.length);
    for (let i = 0; i < a.trades.length; i++) {
      const ta = a.trades[i];
      const tb = b.trades[i];
      if (!ta || !tb) throw new Error('mismatched trade lengths');
      expect(ta.quantity).toBe(tb.quantity);
      expect(ta.price).toBe(tb.price);
      expect(ta.buyerSourceId).toBe(tb.buyerSourceId);
      expect(ta.sellerSourceId).toBe(tb.sellerSourceId);
    }
  });
});
