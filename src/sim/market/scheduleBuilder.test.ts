/**
 * Per-settlement market schedule builder tests.
 *
 * The builder turns a Settlement + its stockpiles + the resources to clear
 * into per-resource (DemandSchedule, SupplySchedule) pairs that the tick
 * loop hands to clearMarket.
 */

import { describe, expect, it } from 'vitest';
import {
  actorId,
  buildingId,
  jobId,
  resourceId,
  settlementId,
  type Day,
  type ResourceId,
} from '../types.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import { hex } from '../world/hex.js';
import { createGrid } from '../world/grid.js';
import type { HexTile } from '../world/terrain.js';
import { buildSettlementSchedules, laborCostPerWorkerDay } from './scheduleBuilder.js';

const seedHex = hex(0, 0);

const RES = {
  grain: resourceId('food.grain'),
  legumes: resourceId('food.legumes'),
  bread: resourceId('food.bread'),
  flour: resourceId('food.flour'),
  milk: resourceId('food.milk'),
  fish: resourceId('food.fish'),
  game: resourceId('food.game'),
  salt: resourceId('mineral.salt'),
  wood: resourceId('material.wood'),
  grapes: resourceId('food.grapes'),
  olives: resourceId('food.olives'),
  wine: resourceId('food.wine'),
  oil: resourceId('food.olive_oil'),
  cheese: resourceId('food.cheese'),
  cloth: resourceId('goods.cloth'),
  charcoal: resourceId('material.charcoal'),
  lumber: resourceId('material.lumber'),
  iron: resourceId('metal.iron'),
  tools: resourceId('goods.tools'),
  weapons: resourceId('goods.weapons'),
  armor: resourceId('goods.armor'),
  shields: resourceId('goods.shields'),
  cart: resourceId('goods.cart'),
  furniture: resourceId('goods.furniture'),
  cutStone: resourceId('material.cut_stone'),
  brickTile: resourceId('material.brick_tile'),
  cattle: resourceId('livestock.cattle'),
  sheep: resourceId('livestock.sheep'),
  equines: resourceId('livestock.equines'),
  silk: resourceId('exotic.silk'),
  incense: resourceId('exotic.incense'),
  spices: resourceId('exotic.spices'),
  luxury: resourceId('goods.luxury_textiles'),
  ironOre: resourceId('mineral.iron_ore'),
  garrison: resourceId('service.garrison'),
  administration: resourceId('service.administration'),
  priesthood: resourceId('service.priesthood'),
  publicWorks: resourceId('service.public_works'),
};

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'mediterranean',
  elevation: 20,
  hasRiver: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

const PATRICIAN = actorId('actor:vibian');
const PLEBEIAN = actorId('actor:plebeian-coop');
const MILLER = actorId('actor:miller-1');

const baseSettlement = (
  id: string = 's1',
  name: string = 'Aquileia',
  tier: Settlement['tier'] = 'town',
): Settlement =>
  createSettlement({
    id: settlementId(id),
    tier,
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
  it('plebeian population produces positive subsistence demand for mixed staples', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grain, RES.bread, RES.legumes],
      recentLocalPrices: new Map([[RES.grain, 1]]),
      today: 0 as Day,
      season: 'spring',
    });
    for (const resource of [RES.grain, RES.bread, RES.legumes]) {
      const pair = result.schedulesByResource.get(resource);
      if (!pair) throw new Error(`expected schedule for ${String(resource)}`);
      expect(pair.demand.totalAt(0.001)).toBeGreaterThan(0);
    }
  });

  it('rural households shift most bread demand into grain for household baking', () => {
    const hamlet = baseSettlement('hamlet', 'Rural Hamlet', 'hamlet');
    const city = baseSettlement('city', 'Urban City', 'large_city');
    setSegment(hamlet, 'plebeian', 100);
    setSegment(city, 'plebeian', 100);

    const demandFor = (s: Settlement, resource: ResourceId): number => {
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map(),
        resources: [resource],
        recentLocalPrices: new Map([[RES.grain, 1]]),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = result.schedulesByResource.get(resource);
      if (!pair) throw new Error(`missing ${String(resource)} schedule`);
      return pair.demand.totalAt(0.001);
    };

    expect(demandFor(hamlet, RES.bread)).toBeLessThan(demandFor(city, RES.bread));
    expect(demandFor(hamlet, RES.flour)).toBe(0);
    expect(demandFor(city, RES.flour)).toBe(0);
    expect(demandFor(hamlet, RES.grain)).toBeGreaterThan(demandFor(city, RES.grain));
  });

  it('attaches local buyer actors to consumer demand sources', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([
        [PATRICIAN, new Map()],
        [PLEBEIAN, new Map()],
      ]),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 1]]),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([
        [PATRICIAN, 'patrician_family'],
        [PLEBEIAN, 'hamlet_household'],
      ]),
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    const source = pair.demand.sources.find((src) => src.id.includes(':plebeian:'));
    expect(source?.buyerActor).toBe(PLEBEIAN);
    expect(source?.buyerDisposition).toBe('consume');
  });

  it('cash-caps subsistence demand unless the buyer can self-provision', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const baseInputs = {
      settlement: s,
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 10]]),
      today: 0 as Day,
      season: 'spring' as const,
      ownerKindByActor: new Map([[PLEBEIAN, 'hamlet_household' as const]]),
      actorTreasuryByActor: new Map([[PLEBEIAN, 0]]),
    };

    const cashless = buildSettlementSchedules({
      ...baseInputs,
      stockpilesByOwner: new Map([[PLEBEIAN, new Map()]]),
    }).schedulesByResource.get(RES.grain);
    if (!cashless) throw new Error('missing cashless grain schedule');
    expect(cashless.demand.totalAt(1)).toBe(0);

    const selfProvisioned = buildSettlementSchedules({
      ...baseInputs,
      stockpilesByOwner: new Map([[PLEBEIAN, new Map([[RES.grain, 100]])]]),
    }).schedulesByResource.get(RES.grain);
    if (!selfProvisioned) throw new Error('missing self-provision grain schedule');
    expect(selfProvisioned.demand.totalAt(1)).toBeGreaterThan(0);
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
      resources: [RES.grain, RES.bread, RES.flour, RES.legumes, RES.salt, RES.wine, RES.silk],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });
    const grain = result.schedulesByResource.get(RES.grain);
    const bread = result.schedulesByResource.get(RES.bread);
    const flour = result.schedulesByResource.get(RES.flour);
    const legumes = result.schedulesByResource.get(RES.legumes);
    const salt = result.schedulesByResource.get(RES.salt);
    const wine = result.schedulesByResource.get(RES.wine);
    const silk = result.schedulesByResource.get(RES.silk);
    if (!grain || !bread || !flour || !legumes || !salt || !wine || !silk) {
      throw new Error('missing schedules');
    }
    expect(grain.demand.totalAt(0.001)).toBeGreaterThan(0);
    expect(bread.demand.totalAt(0.001)).toBeGreaterThan(0);
    expect(flour.demand.totalAt(0.001)).toBe(0);
    expect(legumes.demand.totalAt(0.001)).toBeGreaterThan(0);
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

  it('fresh grapes and olives have small direct comfort demand', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grapes, RES.olives],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'autumn',
    });

    for (const resource of [RES.grapes, RES.olives]) {
      const pair = result.schedulesByResource.get(resource);
      expect(pair?.demand.totalAt(0)).toBeGreaterThan(0);
    }
  });

  it('fresh local foods have ordinary consumer demand when offered locally', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.milk, RES.fish, RES.game],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });

    for (const resource of [RES.milk, RES.fish, RES.game]) {
      const pair = result.schedulesByResource.get(resource);
      expect(pair?.demand.totalAt(0)).toBeGreaterThan(0);
    }
  });

  it('fresh grapes and olives do not create off-season comfort demand', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map(),
      resources: [RES.grapes, RES.olives],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
    });

    for (const resource of [RES.grapes, RES.olives]) {
      const pair = result.schedulesByResource.get(resource);
      expect(pair?.demand.totalAt(0)).toBe(0);
    }
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

  it('ignores floating-point treasury dust as spendable comfort demand', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PLEBEIAN, new Map()]]),
      resources: [RES.wine],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[PLEBEIAN, 'common_household']]),
      actorTreasuryByActor: new Map([[PLEBEIAN, 1e-12]]),
    });
    const pair = result.schedulesByResource.get(RES.wine);
    if (!pair) throw new Error('missing wine schedule');
    expect(pair.demand.sources).toHaveLength(0);
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

describe('buildSettlementSchedules — institutional procurement', () => {
  it('barracks create actor-bound demand for garrison upkeep goods', () => {
    const s = baseSettlement();
    s.buildings.push({
      buildingId: buildingId('barracks'),
      hex: seedHex,
      ownerActor: PATRICIAN,
      capacity: 1,
      daysSinceMaintained: 0,
    });
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
      resources: [RES.weapons],
      recentLocalPrices: new Map([[RES.weapons, 40]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.weapons);
    if (!pair) throw new Error('missing weapons schedule');
    const source = pair.demand.sources.find((src) => src.id.startsWith('institutional:'));
    expect(source?.buyerActor).toBe(PATRICIAN);
    expect(source?.buyerDisposition).toBe('consume');
    expect(pair.demand.totalAt(40)).toBeGreaterThan(0);
  });

  it('barracks procure shields as normal garrison equipment', () => {
    const s = baseSettlement();
    s.buildings.push({
      buildingId: buildingId('barracks'),
      hex: seedHex,
      ownerActor: PATRICIAN,
      capacity: 1,
      daysSinceMaintained: 0,
    });
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
      resources: [RES.shields],
      recentLocalPrices: new Map([[RES.shields, 25]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.shields);
    if (!pair) throw new Error('missing shields schedule');
    const source = pair.demand.sources.find((src) => src.id.startsWith('institutional:'));
    expect(source?.buyerActor).toBe(PATRICIAN);
    expect(source?.buyerDisposition).toBe('consume');
    expect(pair.demand.totalAt(25)).toBeGreaterThan(0);
  });

  it('temples create demand for incense offerings when a price signal exists', () => {
    const s = baseSettlement();
    s.buildings.push({
      buildingId: buildingId('temple'),
      hex: seedHex,
      ownerActor: PATRICIAN,
      capacity: 1,
      daysSinceMaintained: 0,
    });
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
      resources: [RES.incense],
      recentLocalPrices: new Map([[RES.incense, 60]]),
      today: 0 as Day,
      season: 'spring',
    });
    const pair = result.schedulesByResource.get(RES.incense);
    if (!pair) throw new Error('missing incense schedule');
    expect(pair.demand.sources.some((src) => src.id.startsWith('institutional:'))).toBe(true);
    expect(pair.demand.totalAt(60)).toBeGreaterThan(0);
  });
});

describe('buildSettlementSchedules — services', () => {
  it('temples supply priesthood service and households demand it', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 500);
    s.buildings.push({
      buildingId: buildingId('temple'),
      hex: seedHex,
      ownerActor: PATRICIAN,
      capacity: 100,
      daysSinceMaintained: 0,
    });

    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([
        [PATRICIAN, new Map()],
        [PLEBEIAN, new Map()],
      ]),
      resources: [RES.priesthood],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([
        [PATRICIAN, 'temple'],
        [PLEBEIAN, 'common_household'],
      ]),
      actorTreasuryByActor: new Map([
        [PATRICIAN, 0],
        [PLEBEIAN, 100],
      ]),
    });

    const pair = result.schedulesByResource.get(RES.priesthood);
    if (!pair) throw new Error('missing priesthood schedule');
    expect(pair.supply.sources[0]?.ownerActor).toBe(PATRICIAN);
    expect(pair.supply.totalAt(6)).toBeGreaterThan(0);
    expect(pair.demand.sources.some((source) => source.id.startsWith('service:'))).toBe(true);
    expect(pair.demand.totalAt(6)).toBeGreaterThan(0);
  });

  it('forums and barracks expose administration and garrison capacity as service supply', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 1000);
    s.buildings.push(
      {
        buildingId: buildingId('forum_market'),
        hex: seedHex,
        ownerActor: PATRICIAN,
        capacity: 100,
        daysSinceMaintained: 0,
      },
      {
        buildingId: buildingId('barracks'),
        hex: seedHex,
        ownerActor: PATRICIAN,
        capacity: 100,
        daysSinceMaintained: 0,
      },
    );
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
      resources: [RES.administration, RES.garrison],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[PATRICIAN, 'city_corporation']]),
      actorTreasuryByActor: new Map([[PATRICIAN, 1_000]]),
    });

    const admin = result.schedulesByResource.get(RES.administration);
    const garrison = result.schedulesByResource.get(RES.garrison);
    if (!admin || !garrison) throw new Error('missing service schedule');
    expect(admin.supply.totalAt(10)).toBeGreaterThan(0);
    expect(admin.demand.totalAt(10)).toBeGreaterThan(0);
    expect(garrison.supply.totalAt(18)).toBeGreaterThan(0);
    expect(garrison.demand.totalAt(18)).toBeGreaterThan(0);
  });

  it('pending construction creates actor-funded public works service demand', () => {
    const s = baseSettlement('public-works-service');
    s.buildings.push({
      buildingId: buildingId('forum_market'),
      hex: seedHex,
      ownerActor: PATRICIAN,
      capacity: 100,
      daysSinceMaintained: 0,
    });
    s.pendingBuildings.push({
      buildingId: buildingId('warehouse'),
      hex: seedHex,
      ownerActor: PLEBEIAN,
      beganOnDay: 0 as Day,
      workerDaysRemaining: 100,
      workerDaysTotal: 100,
      masonDaysRemaining: 40,
      carpenterDaysRemaining: 60,
    });

    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([
        [PATRICIAN, new Map()],
        [PLEBEIAN, new Map()],
      ]),
      resources: [RES.publicWorks],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([
        [PATRICIAN, 'city_corporation'],
        [PLEBEIAN, 'patrician_family'],
      ]),
      actorTreasuryByActor: new Map([
        [PATRICIAN, 0],
        [PLEBEIAN, 1_000],
      ]),
    });

    const publicWorks = result.schedulesByResource.get(RES.publicWorks);
    if (!publicWorks) throw new Error('missing public works schedule');
    expect(publicWorks.supply.sources[0]?.ownerActor).toBe(PATRICIAN);
    expect(publicWorks.supply.totalAt(12)).toBeGreaterThan(0);
    expect(publicWorks.demand.sources.some((source) => source.id.includes('public_works'))).toBe(
      true,
    );
    expect(publicWorks.demand.totalAt(12)).toBeGreaterThan(0);
  });
});

describe('buildSettlementSchedules — capital reserve demand', () => {
  it('investors stockpile construction materials before future builds', () => {
    const s = baseSettlement();
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
      resources: [RES.cutStone, RES.brickTile],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[PATRICIAN, 'patrician_family']]),
      actorTreasuryByActor: new Map([[PATRICIAN, 1_000]]),
    });

    for (const resource of [RES.cutStone, RES.brickTile]) {
      const pair = result.schedulesByResource.get(resource);
      if (!pair) throw new Error(`missing schedule for ${String(resource)}`);
      const source = pair.demand.sources.find((src) => src.id.startsWith('construction_reserve:'));
      expect(source?.buyerActor).toBe(PATRICIAN);
      expect(source?.buyerDisposition).toBe('stockpile');
      expect(pair.demand.totalAt(1)).toBeGreaterThan(0);
    }
  });

  it('merchant-capital owners demand equines and carts for caravan replacement', () => {
    const s = baseSettlement();
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
      resources: [RES.equines, RES.cart],
      recentLocalPrices: new Map(),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[PATRICIAN, 'patrician_family']]),
      actorTreasuryByActor: new Map([[PATRICIAN, 2_000]]),
    });

    for (const resource of [RES.equines, RES.cart]) {
      const pair = result.schedulesByResource.get(resource);
      if (!pair) throw new Error(`missing schedule for ${String(resource)}`);
      const source = pair.demand.sources.find((src) => src.id.startsWith('transport_capital:'));
      expect(source?.buyerActor).toBe(PATRICIAN);
      expect(source?.buyerDisposition).toBe('stockpile');
      expect(pair.demand.totalAt(1)).toBeGreaterThan(0);
    }
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

  it('overstocked sellers lower asks toward marginal cost instead of preserving a stale scarcity price', () => {
    const reservationForStock = (stock: number): number => {
      const s = baseSettlement(`tool-stock-${stock}`);
      s.buildings.push({
        buildingId: buildingId('forum_market'),
        hex: seedHex,
        ownerActor: PATRICIAN,
        capacity: 100,
        daysSinceMaintained: 0,
      });
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[PATRICIAN, new Map([[RES.tools, stock]])]]),
        resources: [RES.tools],
        recentLocalPrices: new Map([
          [RES.tools, 2500],
          [RES.iron, 12],
          [RES.lumber, 20],
          [RES.charcoal, 5],
        ]),
        today: 0 as Day,
        season: 'spring',
        ownerKindByActor: new Map([[PATRICIAN, 'patrician_family']]),
      });
      const pair = result.schedulesByResource.get(RES.tools);
      if (!pair) throw new Error('missing tools schedule');
      const source = pair.supply.sources.find((src) => src.ownerActor === PATRICIAN);
      if (!source) throw new Error('missing patrician tool supply');
      return source.reservationPrice;
    };

    const lean = reservationForStock(20);
    const overstocked = reservationForStock(10_000);

    expect(lean).toBeCloseTo(2500);
    expect(overstocked).toBeLessThan(lean / 2);
    expect(overstocked).toBeGreaterThan(0);
  });

  it('seller-only markets discount stale scarcity quotes when no buyer currently absorbs the good', () => {
    const s = baseSettlement('tool-no-current-buyer');
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PATRICIAN, new Map([[RES.tools, 100]])]]),
      resources: [RES.tools],
      recentLocalPrices: new Map([
        [RES.tools, 2500],
        [RES.iron, 12],
        [RES.lumber, 20],
        [RES.charcoal, 5],
      ]),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[PATRICIAN, 'patrician_family']]),
      actorTreasuryByActor: new Map([[PATRICIAN, 0]]),
    });
    const pair = result.schedulesByResource.get(RES.tools);
    if (!pair) throw new Error('missing tools schedule');
    expect(pair.demand.totalAt(0)).toBe(0);
    const source = pair.supply.sources.find((src) => src.ownerActor === PATRICIAN);
    if (!source) throw new Error('missing patrician tool supply');

    expect(source.reservationPrice).toBeGreaterThan(0);
    expect(source.reservationPrice).toBeLessThan(1000);
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
    const derived = pair.demand.sources.find((src) => src.id.startsWith('derived:'));
    expect(derived?.buyerActor).toBe(MILLER);
    expect(derived?.buyerDisposition).toBe('stockpile');
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

  it('no derived demand when the producing job is unstaffed', () => {
    const s = baseSettlement();
    setSegment(s, 'plebeian', 100);
    s.jobAllocations.set(jobId('farmer'), 100);
    s.buildings.push({
      buildingId: buildingId('mill'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 10,
      daysSinceMaintained: 0,
    });
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
    expect(pair.demand.sources.some((src) => src.id.startsWith('derived:'))).toBe(false);
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

  it('sizes derived input demand in real recipe input units', () => {
    const s = baseSettlement('derived-input-units');
    setSegment(s, 'plebeian', 200);
    s.buildings.push({
      buildingId: buildingId('mill'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 2,
      daysSinceMaintained: 0,
    });
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
    const derived = pair.demand.sources.find((src) => src.id.startsWith('derived:'));
    expect(derived?.peakQuantity).toBeCloseTo(100);
  });

  it('does not bid for recipe inputs when the producer already has enough output stock', () => {
    const hasGrainDemandWithFlourStock = (flourStock: number): boolean => {
      const s = baseSettlement(`output-stock-${flourStock}`);
      setSegment(s, 'plebeian', 200);
      s.buildings.push({
        buildingId: buildingId('mill'),
        hex: seedHex,
        ownerActor: MILLER,
        capacity: 2,
        daysSinceMaintained: 0,
      });
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[MILLER, new Map([[RES.flour, flourStock]])]]),
        resources: [RES.grain],
        recentLocalPrices: new Map([[RES.flour, 5]]),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = result.schedulesByResource.get(RES.grain);
      if (!pair) throw new Error('missing grain schedule');
      return pair.demand.sources.some((src) => src.id.startsWith('derived:'));
    };

    expect(hasGrainDemandWithFlourStock(0)).toBe(true);
    expect(hasGrainDemandWithFlourStock(10_000)).toBe(false);
  });

  it('does not rebuy recipe inputs already held in the producer stockpile', () => {
    const derivedInputQtyWithGrainStock = (grainStock: number): number => {
      const s = baseSettlement(`input-stock-${grainStock}`);
      setSegment(s, 'plebeian', 200);
      s.buildings.push({
        buildingId: buildingId('mill'),
        hex: seedHex,
        ownerActor: MILLER,
        capacity: 2,
        daysSinceMaintained: 0,
      });
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[MILLER, new Map([[RES.grain, grainStock]])]]),
        resources: [RES.grain],
        recentLocalPrices: new Map([[RES.flour, 5]]),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = result.schedulesByResource.get(RES.grain);
      if (!pair) throw new Error('missing grain schedule');
      const derived = pair.demand.sources.find((src) => src.id.startsWith('derived:'));
      return derived?.peakQuantity ?? 0;
    };

    expect(derivedInputQtyWithGrainStock(0)).toBeCloseTo(100);
    expect(derivedInputQtyWithGrainStock(80)).toBeCloseTo(20);
    expect(derivedInputQtyWithGrainStock(100)).toBe(0);
    expect(derivedInputQtyWithGrainStock(10_000)).toBe(0);
  });

  it('keeps military-goods derived input demand to a small procurement buffer', () => {
    const derivedIronQtyWithArmorStock = (armorStock: number): number => {
      const s = baseSettlement(`armor-buffer-${armorStock}`);
      s.buildings.push({
        buildingId: buildingId('smithy'),
        hex: seedHex,
        ownerActor: MILLER,
        capacity: 100,
        daysSinceMaintained: 0,
      });
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[MILLER, new Map([[RES.armor, armorStock]])]]),
        resources: [RES.iron],
        recentLocalPrices: new Map([[RES.armor, 1000]]),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = result.schedulesByResource.get(RES.iron);
      if (!pair) throw new Error('missing iron schedule');
      const derived = pair.demand.sources.find((src) =>
        src.id.startsWith(`derived:${String(s.id)}:forge_armor:`),
      );
      return derived?.peakQuantity ?? 0;
    };

    expect(derivedIronQtyWithArmorStock(0)).toBeCloseTo(12);
    expect(derivedIronQtyWithArmorStock(2)).toBe(0);
  });

  it('depositless mines do not emit derived tool demand when grid data is available', () => {
    const demandWithDeposit = (hasDeposit: boolean): boolean => {
      const s = baseSettlement(`mine-${hasDeposit ? 'with' : 'without'}-deposit`);
      setSegment(s, 'plebeian', 20);
      s.jobAllocations.set(jobId('miner'), 20);
      s.buildings.push({
        buildingId: buildingId('mine'),
        hex: seedHex,
        ownerActor: MILLER,
        capacity: 10,
        daysSinceMaintained: 0,
      });
      const grid = createGrid();
      grid.set(
        seedHex,
        tile(
          hasDeposit
            ? {
                terrain: 'hills',
                deposit: { resource: RES.ironOre, remaining: 500 },
              }
            : { terrain: 'hills' },
        ),
      );
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map(),
        resources: [RES.tools],
        recentLocalPrices: new Map([[RES.ironOre, 100]]),
        today: 0 as Day,
        season: 'spring',
        grid,
      });
      const pair = result.schedulesByResource.get(RES.tools);
      if (!pair) throw new Error('missing tools schedule');
      return pair.demand.sources.some((src) => src.id.startsWith('derived:'));
    };

    expect(demandWithDeposit(true)).toBe(true);
    expect(demandWithDeposit(false)).toBe(false);
  });

  it('treats recipe requires as productive capital demand instead of free capacity', () => {
    const s = baseSettlement('productive-cattle');
    s.buildings.push({
      buildingId: buildingId('dairy'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 10,
      daysSinceMaintained: 0,
    });

    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[MILLER, new Map()]]),
      resources: [RES.cattle],
      recentLocalPrices: new Map([[resourceId('food.milk'), 2]]),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[MILLER, 'city_corporation']]),
      actorTreasuryByActor: new Map([[MILLER, 100_000]]),
    });

    const pair = result.schedulesByResource.get(RES.cattle);
    if (!pair) throw new Error('missing cattle schedule');
    const capital = pair.demand.sources.find((src) => src.id.startsWith('productive_capital:'));
    expect(capital?.buyerActor).toBe(MILLER);
    expect(capital?.buyerDisposition).toBe('stockpile');
    expect(capital?.peakQuantity).toBeCloseTo(0.05);
    expect(pair.demand.totalAt(1)).toBeGreaterThan(0);
  });

  it('does not rebuy required productive capital already in the owner stockpile', () => {
    const requiredDemandWithCattleStock = (stock: number): number => {
      const s = baseSettlement(`productive-cattle-stock-${stock}`);
      s.buildings.push({
        buildingId: buildingId('dairy'),
        hex: seedHex,
        ownerActor: MILLER,
        capacity: 10,
        daysSinceMaintained: 0,
      });

      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[MILLER, new Map([[RES.cattle, stock]])]]),
        resources: [RES.cattle],
        recentLocalPrices: new Map([[resourceId('food.milk'), 2]]),
        today: 0 as Day,
        season: 'spring',
        ownerKindByActor: new Map([[MILLER, 'city_corporation']]),
        actorTreasuryByActor: new Map([[MILLER, 100_000]]),
      });

      const pair = result.schedulesByResource.get(RES.cattle);
      if (!pair) throw new Error('missing cattle schedule');
      return (
        pair.demand.sources.find((src) => src.id.startsWith('productive_capital:'))?.peakQuantity ??
        0
      );
    };

    expect(requiredDemandWithCattleStock(0)).toBeCloseTo(0.05);
    expect(requiredDemandWithCattleStock(0.03)).toBeCloseTo(0.02);
    expect(requiredDemandWithCattleStock(0.05)).toBe(0);
  });

  it('does not turn public-works service prices into seed-grain demand', () => {
    const s = baseSettlement('sow-public-works-leak');
    s.buildings.push({
      buildingId: buildingId('farm'),
      hex: seedHex,
      ownerActor: MILLER,
      capacity: 10,
      daysSinceMaintained: 0,
    });

    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[MILLER, new Map()]]),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.publicWorks, 1_000]]),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[MILLER, 'city_corporation']]),
      actorTreasuryByActor: new Map([[MILLER, 10_000]]),
    });

    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    expect(pair.demand.sources.some((source) => source.id.includes('sow_grain'))).toBe(false);
    expect(pair.demand.totalAt(1)).toBe(0);
  });
});

describe('laborCostPerWorkerDay', () => {
  it('converts physical basket kg into resource units before pricing', () => {
    const wage = laborCostPerWorkerDay(
      new Map([
        // 0.4 kg grain at 6.7 kg/modius = 0.4 coin.
        [RES.grain, 6.7],
        // Bread is available but dearer for the calorie slot: 0.5 loaf × 2 = 1.
        [RES.bread, 2],
        // 7g salt out of a 25kg unit at 25 coin = 0.007 coin.
        [RES.salt, 25],
        // 0.7kg wood out of a 700kg cord at 700 coin = 0.7 coin.
        [RES.wood, 700],
        // 0.001kg cloth out of a 5kg bolt at 100 coin = 0.02 coin.
        [RES.cloth, 100],
      ]),
    );

    expect(wage).toBeCloseTo(1.127, 6);
  });
});

describe('buildSettlementSchedules — labor class pricing', () => {
  it('excludes enslaved worker-days from producer cash wage cost', () => {
    const reservationFor = (klass: 'plebeian' | 'slave'): number => {
      const s = baseSettlement(`labor-${klass}`);
      setSegment(s, klass, 100);
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[PATRICIAN, new Map([[RES.grain, 100]])]]),
        resources: [RES.grain],
        recentLocalPrices: new Map([
          // High bread price makes the paid-labor component exceed the
          // raw grain salvage floor; enslaved labor should still omit it.
          [RES.bread, 60],
          [RES.salt, 25],
          [RES.wood, 700],
          [RES.cloth, 100],
          [RES.tools, 10],
        ]),
        today: 0 as Day,
        season: 'spring',
      });
      const pair = result.schedulesByResource.get(RES.grain);
      if (!pair) throw new Error('missing grain schedule');
      const source = pair.supply.sources[0];
      if (!source) throw new Error('missing grain supply');
      return source.reservationPrice;
    };

    expect(reservationFor('plebeian')).toBeGreaterThan(reservationFor('slave'));
  });

  it('does not emit derived input demand for common producers when only slave labor is allocated', () => {
    const hasToolDemandFor = (ownerKind: 'patrician_family' | 'common_household'): boolean => {
      const s = baseSettlement(`owner-labor-${ownerKind}`);
      setSegment(s, 'slave', 10);
      s.jobAllocations.set(jobId('farmer'), 10);
      s.buildings.push({
        buildingId: buildingId('farm'),
        hex: seedHex,
        ownerActor: PATRICIAN,
        capacity: 10,
        daysSinceMaintained: 0,
      });
      const result = buildSettlementSchedules({
        settlement: s,
        stockpilesByOwner: new Map([[PATRICIAN, new Map()]]),
        resources: [RES.tools],
        recentLocalPrices: new Map([[RES.grain, 100]]),
        today: 0 as Day,
        season: 'spring',
        ownerKindByActor: new Map([[PATRICIAN, ownerKind]]),
      });
      const pair = result.schedulesByResource.get(RES.tools);
      if (!pair) throw new Error('missing tools schedule');
      return pair.demand.sources.some((src) => src.id.startsWith('derived:'));
    };

    expect(hasToolDemandFor('patrician_family')).toBe(true);
    expect(hasToolDemandFor('common_household')).toBe(false);
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

  it('does not let urgent raw staple sellers chase a collapsed local price to zero', () => {
    const s = baseSettlement();
    const result = buildSettlementSchedules({
      settlement: s,
      stockpilesByOwner: new Map([[PLEBEIAN, new Map([[RES.grain, 100]])]]),
      resources: [RES.grain],
      recentLocalPrices: new Map([[RES.grain, 0.001]]),
      today: 0 as Day,
      season: 'spring',
      ownerKindByActor: new Map([[PLEBEIAN, 'hamlet_household']]),
    });
    const pair = result.schedulesByResource.get(RES.grain);
    if (!pair) throw new Error('missing grain schedule');
    const source = pair.supply.sources.find((src) => src.ownerActor === PLEBEIAN);
    if (!source) throw new Error('missing plebeian supply source');
    expect(source.reservationPrice).toBeCloseTo(0.335);
  });
});
