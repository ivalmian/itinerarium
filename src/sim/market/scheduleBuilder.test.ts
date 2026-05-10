/**
 * Per-settlement market schedule builder tests.
 *
 * The builder turns a Settlement + its stockpiles + the resources to clear
 * into per-resource (DemandSchedule, SupplySchedule) pairs that the tick
 * loop hands to clearMarket.
 */

import { describe, expect, it } from 'vitest';
import { actorId, buildingId, resourceId, settlementId, type Day } from '../types.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import { hex } from '../world/hex.js';
import { buildSettlementSchedules } from './scheduleBuilder.js';

const seedHex = hex(0, 0);

const RES = {
  grain: resourceId('food.grain'),
  bread: resourceId('food.bread'),
  flour: resourceId('food.flour'),
  salt: resourceId('mineral.salt'),
  wood: resourceId('material.wood'),
  wine: resourceId('food.wine'),
  oil: resourceId('food.olive_oil'),
  cheese: resourceId('food.cheese'),
  cloth: resourceId('goods.cloth'),
  furniture: resourceId('goods.furniture'),
  silk: resourceId('exotic.silk'),
  spices: resourceId('exotic.spices'),
  luxury: resourceId('goods.luxury_textiles'),
};

const PATRICIAN = actorId('actor:vibian');
const PLEBEIAN = actorId('actor:plebeian-coop');
const MILLER = actorId('actor:miller-1');

const baseSettlement = (id: string = 's1', name: string = 'Aquileia'): Settlement =>
  createSettlement({
    id: settlementId(id),
    tier: 'town',
    name,
    anchor: seedHex,
    urbanHexes: [seedHex],
    catchmentHexes: [],
    stockpileOwners: [PATRICIAN, PLEBEIAN, MILLER],
  });

const setSegment = (
  s: Settlement,
  klass: 'patrician' | 'plebeian' | 'freedman' | 'slave' | 'foreigner',
  count: number,
): void => {
  s.population.set({ age: '20-24', sex: 'male', class: klass }, count);
};

describe('buildSettlementSchedules — coverage', () => {
  it('emits one (demand, supply) pair per requested resource', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain, RES.salt, RES.wine],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    expect(result.schedulesByResource.size).toBe(3);
    for (const r of [RES.grain, RES.salt, RES.wine]) {
      const pair = result.schedulesByResource.get(r);
      expect(pair).toBeDefined();
      if (!pair) continue;
      expect(pair.demand).toBeDefined();
      expect(pair.supply).toBeDefined();
    }
  });
});

describe('buildSettlementSchedules — subsistence', () => {
  it('plebeian population produces a positive subsistence demand for grain', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 1]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('expected grain schedule');
    expect(pair.demand.totalAt(0.001)).toBeGreaterThan(0);
  });

  it('subsistence demand scales linearly with population size', () => {
    const a = baseSettlement('s1');
    setSegment(a, 'plebeian', 100);
    const b = baseSettlement('s2');
    setSegment(b, 'plebeian', 200);
    const make = (s: Settlement): number => {
      const r = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map(),
        resources: [RES.grain],
        recentLocalPrices: new Map(),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = r.schedulesByResource.get(RES.grain);
      if (!pair) throw new Error('missing grain pair');
      return pair.demand.totalAt(0.001);
    };
    expect(make(b)).toBeCloseTo(make(a) * 2, 5);
  });

  it('slaves get subsistence calories + salt but no comfort or status demand', () => {
    const s = baseSettlement();
    setSegment(s, 'slave', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain, RES.salt, RES.wine, RES.silk],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    const grain = result.schedulesByResource.get(RES.grain);
    const salt = result.schedulesByResource.get(RES.salt);
    const wine = result.schedulesByResource.get(RES.wine);
    const silk = result.schedulesByResource.get(RES.silk);
    if (!grain || !salt || !wine || !silk) throw new Error('missing schedules');
    expect(grain.demand.totalAt(0.001)).toBeGreaterThan(0);
    expect(salt.demand.totalAt(0.001)).toBeGreaterThan(0);
    expect(wine.demand.totalAt(0.001)).toBe(0);
    expect(silk.demand.totalAt(0.001)).toBe(0);
  });

  it('children consume less than adults (~0.5x per docs/04)', () => {
    const adults = baseSettlement('a');
    adults.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
    const children = baseSettlement('c');
    children.population.set({ age: '0-4', sex: 'male', class: 'plebeian' }, 100);
    const adultDemand = buildSettlementSchedules({
      settlement: adults,
      stockpilesByOwner: new Map(),
      resources: [RES.grain],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    }).schedulesByResource.get(RES.grain);
    const childDemand = buildSettlementSchedules({
      settlement: children,
      stockpilesByOwner: new Map(),
      resources: [RES.grain],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    }).schedulesByResource.get(RES.grain);
    if (!adultDemand || !childDemand) throw new Error('missing schedules');
    const a = adultDemand.demand.totalAt(0.001);
    const c = childDemand.demand.totalAt(0.001);
    expect(c).toBeLessThan(a);
    expect(c).toBeCloseTo(a * 0.5, 1);
  });
});

describe('buildSettlementSchedules — comfort', () => {
  it('plebeian populations want wine (comfort)', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.wine],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.wine);
    if (!pair) throw new Error('missing wine schedule');
    expect(pair.demand.totalAt(0)).toBeGreaterThan(0);
  });

  it('comfort demand decays as price climbs (elastic)', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.wine],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.wine);
    if (!pair) throw new Error('missing wine schedule');
    expect(pair.demand.totalAt(1000000)).toBeLessThan(pair.demand.totalAt(0.001));
  });
});

describe('buildSettlementSchedules — status', () => {
  it('patrician populations want silk; plebeians do not', () => {
    const patricianHouse = baseSettlement('p');
    setSegment(patricianHouse, 'patrician', 20);
    const plebHouse = baseSettlement('q');
    setSegment(plebHouse, 'plebeian', 200);
    const buildFor = (s: Settlement): number => {
      const r = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map(),
        resources: [RES.silk],
        recentLocalPrices: new Map(),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = r.schedulesByResource.get(RES.silk);
      if (!pair) throw new Error('missing silk schedule');
      return pair.demand.totalAt(0);
    };
    expect(buildFor(patricianHouse)).toBeGreaterThan(0);
    expect(buildFor(plebHouse)).toBe(0);
  });

  it('status demand is a step function (cuts to 0 above the threshold)', () => {
    const s = baseSettlement();
    setSegment(s, 'patrician', 20);
    const r = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.silk],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = r.schedulesByResource.get(RES.silk);
    if (!pair) throw new Error('missing silk schedule');
    // Far above any plausible threshold the step has dropped.
    expect(pair.demand.totalAt(1e12)).toBe(0);
  });
});

describe('buildSettlementSchedules — supply', () => {
  it('an owner with positive stockpile produces a supply source for that resource', () => {
    const s = baseSettlement();
    const stockpiles = new Map([[PATRICIAN, new Map([[RES.grain, 500]])]]);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: stockpiles,
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 2]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    // At a sufficiently high price the full stockpile should be available.
    expect(pair.supply.totalAt(1000)).toBe(500);
  });

  it('an empty stockpile produces no supply for that resource', () => {
    const s = baseSettlement();
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 2]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    expect(pair.supply.totalAt(1e9)).toBe(0);
  });

  it('multiple owners produce multiple supply sources that aggregate', () => {
    const s = baseSettlement();
    const stockpiles = new Map([
      [PATRICIAN, new Map([[RES.grain, 100]])],
      [PLEBEIAN, new Map([[RES.grain, 50]])],
    ]);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: stockpiles,
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 2]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    expect(pair.supply.sources.length).toBe(2);
    expect(pair.supply.totalAt(1000)).toBe(150);
  });

  it('supply is keyed off positive quantity only — zero entries are dropped', () => {
    const s = baseSettlement();
    const stockpiles = new Map([[PATRICIAN, new Map([[RES.grain, 0]])]]);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: stockpiles,
      resources: [RES.grain],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    expect(pair.supply.sources.length).toBe(0);
  });
});

describe('buildSettlementSchedules — derived input demand', () => {
  it('a miller with grain stockpile + bakers present + flour demand → derived-input demand for grain', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 200);
    // Add a mill at the settlement (with capacity > 0).
    s.buildings.push({
      buildingId: buildingId('mill'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 2,
      daysSinceMaintained: 0,
    });
    // Recent flour price is high → the miller wants grain.
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.flour, 5]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    // The derived-input source contributes to total demand below the break-even.
    expect(pair.demand.totalAt(1)).toBeGreaterThan(pair.demand.totalAt(1e9));
  });

  it('no derived demand when no producing building is present', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 0);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.flour, 5]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    // No derived source, no consumer demand (zero population) → empty demand.
    expect(pair.demand.totalAt(0.0001)).toBe(0);
  });

  it('derived demand respects building capacity (more capacity → more derived qty)', () => {
    const small = baseSettlement('s1');
    small.buildings.push({
      buildingId: buildingId('mill'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 1,
      daysSinceMaintained: 0,
    });
    const big = baseSettlement('s2');
    big.buildings.push({
      buildingId: buildingId('mill'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 10,
      daysSinceMaintained: 0,
    });
    const buildFor = (s: Settlement): number => {
      const r = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map(),
        resources: [RES.grain],
        recentLocalPrices: new Map([[RES.flour, 5]]),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = r.schedulesByResource.get(RES.grain);
      if (!pair) throw new Error('missing grain schedule');
      return pair.demand.totalAt(1);
    };
    expect(buildFor(big)).toBeGreaterThan(buildFor(small));
  });
});

describe('buildSettlementSchedules — determinism', () => {
  it('same inputs → identical schedules (totals + source counts)', () => {
    const make = (): ReturnType<typeof buildSettlementSchedules> => {
      const s = baseSettlement();
      setSegment(s, 'plebeian', 100);
      setSegment(s, 'patrician', 10);
      const stockpiles = new Map([
        [PATRICIAN, new Map([[RES.grain, 200]])],
        [PLEBEIAN, new Map([[RES.grain, 50]])],
      ]);
      return buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: stockpiles,
        resources: [RES.grain, RES.wine, RES.silk],
        recentLocalPrices: new Map([[RES.grain, 2]]),
        today: 0 as Day,
        season: 'spring',
      });
    };
    const a = make();
    const b = make();
    for (const [resource, pa] of a.schedulesByResource) {
      const pb = b.schedulesByResource.get(resource);
      if (!pb) throw new Error('missing in second run');
      expect(pa.demand.sources.length).toBe(pb.demand.sources.length);
      expect(pa.supply.sources.length).toBe(pb.supply.sources.length);
      for (const p of [0.001, 1, 10, 100]) {
        expect(pa.demand.totalAt(p)).toBe(pb.demand.totalAt(p));
        expect(pa.supply.totalAt(p)).toBe(pb.supply.totalAt(p));
      }
    }
  });
});

describe('buildSettlementSchedules — owner kind drives urgency', () => {
  it('patrician hoarder reservation > poor seller reservation for the same resource and price expectation', () => {
    const s = baseSettlement();
    const stockpiles = new Map([
      [PATRICIAN, new Map([[RES.grain, 100]])],
      [PLEBEIAN, new Map([[RES.grain, 100]])],
    ]);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: stockpiles,
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 10]]),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([
        [PATRICIAN, 'patrician_family'],
        [PLEBEIAN, 'hamlet_household'],
      ]),
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    const patricianSource = pair.supply.sources.find((src) => src.ownerActor === PATRICIAN);
    const plebSource = pair.supply.sources.find((src) => src.ownerActor === PLEBEIAN);
    if (!patricianSource || !plebSource) throw new Error('expected both supply sources');
    expect(patricianSource.reservationPrice).toBeGreaterThan(plebSource.reservationPrice);
  });
});
