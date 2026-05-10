import { describe, expect, it } from 'vitest';
import { actorId, buildingId, factionId, resourceId, settlementId } from '../types.js';
import { hex, hexEquals } from './hex.js';
import {
  addBuilding,
  createSettlement,
  expectedCatchmentRadius,
  expectedUrbanHexCount,
  recordClearingPrice,
  recordInflow,
  recordOutflow,
  removeBuilding,
  settlementContainsHex,
  tierOfPopulation,
  type Settlement,
  type SettlementBuilding,
  type SettlementTier,
} from './settlement.js';

const aquileiaId = settlementId('aquileia');
const family = actorId('vibian');
const grain = resourceId('grain');
const wine = resourceId('wine');
const farm = buildingId('farm');
const granary = buildingId('granary');

const baseSettlement = (
  overrides: Partial<Parameters<typeof createSettlement>[0]> = {},
): Settlement =>
  createSettlement({
    id: aquileiaId,
    tier: 'small_city',
    name: 'Aquileia',
    anchor: hex(0, 0),
    urbanHexes: [hex(0, 0), hex(1, 0)],
    catchmentHexes: [hex(2, 0), hex(-1, 1), hex(0, -2), hex(2, -1)],
    ...overrides,
  });

describe('createSettlement', () => {
  it('populates the required fields', () => {
    const s = baseSettlement();
    expect(s.id).toBe(aquileiaId);
    expect(s.tier).toBe('small_city');
    expect(s.name).toBe('Aquileia');
    expect(hexEquals(s.anchor, hex(0, 0))).toBe(true);
    expect(s.urbanHexes).toHaveLength(2);
    expect(s.catchmentHexes).toHaveLength(4);
    expect(s.buildings).toEqual([]);
    expect(s.factions).toEqual([]);
    expect(s.stockpileOwners).toEqual([]);
    expect(s.population.total()).toBe(0);
    expect(s.market.recentInflows.size).toBe(0);
    expect(s.market.recentOutflows.size).toBe(0);
    expect(s.market.lastClearingPrice.size).toBe(0);
  });

  it('rejects empty name', () => {
    expect(() =>
      createSettlement({
        id: aquileiaId,
        tier: 'village',
        name: '',
        anchor: hex(0, 0),
        urbanHexes: [hex(0, 0)],
        catchmentHexes: [],
      }),
    ).toThrow();
  });

  it('rejects empty urbanHexes', () => {
    expect(() =>
      createSettlement({
        id: aquileiaId,
        tier: 'village',
        name: 'X',
        anchor: hex(0, 0),
        urbanHexes: [],
        catchmentHexes: [],
      }),
    ).toThrow();
  });

  it('rejects when anchor is not in urbanHexes', () => {
    expect(() =>
      createSettlement({
        id: aquileiaId,
        tier: 'village',
        name: 'X',
        anchor: hex(0, 0),
        urbanHexes: [hex(1, 0)],
        catchmentHexes: [],
      }),
    ).toThrow();
  });

  it('rejects overlap between urban hexes and catchment hexes', () => {
    expect(() =>
      createSettlement({
        id: aquileiaId,
        tier: 'village',
        name: 'X',
        anchor: hex(0, 0),
        urbanHexes: [hex(0, 0)],
        catchmentHexes: [hex(0, 0)],
      }),
    ).toThrow();
  });

  it('accepts initial factions and stockpile owners', () => {
    const s = baseSettlement({
      factions: [factionId('curia'), factionId('vibian-house')],
      stockpileOwners: [family],
    });
    expect(s.factions).toEqual([factionId('curia'), factionId('vibian-house')]);
    expect(s.stockpileOwners).toEqual([family]);
  });
});

describe('settlementContainsHex', () => {
  const s = baseSettlement();

  it('returns true for the anchor hex', () => {
    expect(settlementContainsHex(s, hex(0, 0))).toBe(true);
  });

  it('returns true for any urban hex', () => {
    expect(settlementContainsHex(s, hex(1, 0))).toBe(true);
  });

  it('returns true for any catchment hex', () => {
    expect(settlementContainsHex(s, hex(2, 0))).toBe(true);
    expect(settlementContainsHex(s, hex(-1, 1))).toBe(true);
  });

  it('returns false for unrelated hexes', () => {
    expect(settlementContainsHex(s, hex(99, 99))).toBe(false);
    expect(settlementContainsHex(s, hex(-5, 5))).toBe(false);
  });
});

describe('tierOfPopulation', () => {
  it('classifies population by docs/05 ranges', () => {
    expect(tierOfPopulation(0)).toBe<SettlementTier>('hamlet');
    expect(tierOfPopulation(100)).toBe<SettlementTier>('hamlet');
    expect(tierOfPopulation(149)).toBe<SettlementTier>('hamlet');
    expect(tierOfPopulation(150)).toBe<SettlementTier>('village');
    expect(tierOfPopulation(500)).toBe<SettlementTier>('village');
    expect(tierOfPopulation(799)).toBe<SettlementTier>('village');
    expect(tierOfPopulation(1000)).toBe<SettlementTier>('town');
    expect(tierOfPopulation(3000)).toBe<SettlementTier>('town');
    expect(tierOfPopulation(4999)).toBe<SettlementTier>('town');
    expect(tierOfPopulation(5000)).toBe<SettlementTier>('small_city');
    expect(tierOfPopulation(10000)).toBe<SettlementTier>('small_city');
    expect(tierOfPopulation(14999)).toBe<SettlementTier>('small_city');
    expect(tierOfPopulation(15000)).toBe<SettlementTier>('large_city');
    expect(tierOfPopulation(30000)).toBe<SettlementTier>('large_city');
    expect(tierOfPopulation(50000)).toBe<SettlementTier>('large_city');
  });

  it('rejects negative populations', () => {
    expect(() => tierOfPopulation(-1)).toThrow();
  });
});

describe('expectedCatchmentRadius', () => {
  it('matches docs/05 table', () => {
    expect(expectedCatchmentRadius('hamlet')).toBe(1);
    expect(expectedCatchmentRadius('village')).toBe(2);
    expect(expectedCatchmentRadius('town')).toBe(3);
    expect(expectedCatchmentRadius('small_city')).toBe(5);
    expect(expectedCatchmentRadius('large_city')).toBe(5);
  });
});

describe('expectedUrbanHexCount', () => {
  it('matches docs/05 table', () => {
    expect(expectedUrbanHexCount('hamlet')).toEqual({ min: 1, max: 1 });
    expect(expectedUrbanHexCount('village')).toEqual({ min: 1, max: 1 });
    expect(expectedUrbanHexCount('town')).toEqual({ min: 1, max: 2 });
    expect(expectedUrbanHexCount('small_city')).toEqual({ min: 2, max: 3 });
    expect(expectedUrbanHexCount('large_city')).toEqual({ min: 3, max: 10 });
  });
});

describe('addBuilding / removeBuilding', () => {
  const newBuilding = (h: ReturnType<typeof hex>): SettlementBuilding => ({
    buildingId: farm,
    hex: h,
    ownerActor: family,
    capacity: 4,
    daysSinceMaintained: 0,
  });

  it('addBuilding appends to the buildings list', () => {
    const s = baseSettlement();
    const b: SettlementBuilding = newBuilding(hex(2, 0));
    addBuilding(s, b);
    expect(s.buildings).toHaveLength(1);
    expect(s.buildings[0]?.buildingId).toBe(farm);
  });

  it('addBuilding rejects buildings whose hex is not in the settlement', () => {
    const s = baseSettlement();
    expect(() => addBuilding(s, newBuilding(hex(99, 99)))).toThrow();
  });

  it('addBuilding allows multiple buildings on the same hex (different types)', () => {
    const s = baseSettlement();
    addBuilding(s, newBuilding(hex(0, 0)));
    addBuilding(s, {
      buildingId: granary,
      hex: hex(0, 0),
      ownerActor: family,
      capacity: 0,
      daysSinceMaintained: 0,
    });
    expect(s.buildings).toHaveLength(2);
  });

  it('addBuilding rejects exact duplicates (same hex + same buildingId + same owner)', () => {
    const s = baseSettlement();
    addBuilding(s, newBuilding(hex(0, 0)));
    expect(() => addBuilding(s, newBuilding(hex(0, 0)))).toThrow();
  });

  it('removeBuilding removes a building at the given hex', () => {
    const s = baseSettlement();
    addBuilding(s, newBuilding(hex(2, 0)));
    addBuilding(s, {
      buildingId: granary,
      hex: hex(0, 0),
      ownerActor: family,
      capacity: 0,
      daysSinceMaintained: 0,
    });
    removeBuilding(s, hex(2, 0), farm);
    expect(s.buildings).toHaveLength(1);
    expect(s.buildings[0]?.buildingId).toBe(granary);
  });

  it('removeBuilding throws if no matching building exists', () => {
    const s = baseSettlement();
    expect(() => removeBuilding(s, hex(0, 0), farm)).toThrow();
  });
});

describe('market snapshot', () => {
  it('recordInflow accumulates per-resource', () => {
    const s = baseSettlement();
    recordInflow(s, grain, 100);
    recordInflow(s, grain, 50);
    recordInflow(s, wine, 10);
    expect(s.market.recentInflows.get(grain)).toBe(150);
    expect(s.market.recentInflows.get(wine)).toBe(10);
  });

  it('recordOutflow accumulates per-resource', () => {
    const s = baseSettlement();
    recordOutflow(s, grain, 30);
    recordOutflow(s, grain, 10);
    expect(s.market.recentOutflows.get(grain)).toBe(40);
  });

  it('recordClearingPrice overwrites the previous price for a resource', () => {
    const s = baseSettlement();
    recordClearingPrice(s, grain, 5);
    recordClearingPrice(s, grain, 7);
    expect(s.market.lastClearingPrice.get(grain)).toBe(7);
  });

  it('inflow/outflow reject non-positive quantities', () => {
    const s = baseSettlement();
    expect(() => recordInflow(s, grain, 0)).toThrow();
    expect(() => recordInflow(s, grain, -1)).toThrow();
    expect(() => recordOutflow(s, grain, 0)).toThrow();
    expect(() => recordOutflow(s, grain, -1)).toThrow();
  });

  it('clearing price rejects negative price', () => {
    const s = baseSettlement();
    expect(() => recordClearingPrice(s, grain, -1)).toThrow();
  });
});

describe('settlement integration with population', () => {
  it('the embedded PopulationPool is mutable independently of construction', () => {
    const s = baseSettlement();
    s.population.set({ age: '20-24', sex: 'female', class: 'plebeian' }, 100);
    expect(s.population.total()).toBe(100);
  });

  it('two settlements have independent population pools', () => {
    const a = baseSettlement();
    const b = baseSettlement({ id: settlementId('other') });
    a.population.set({ age: '20-24', sex: 'female', class: 'plebeian' }, 50);
    expect(b.population.total()).toBe(0);
  });
});

describe('factions and stockpile owners', () => {
  it('factions and stockpileOwners can be added later', () => {
    const s: Settlement = baseSettlement();
    s.factions.push(factionId('curia'));
    s.stockpileOwners.push(family);
    expect(s.factions).toEqual([factionId('curia')]);
    expect(s.stockpileOwners).toEqual([family]);
  });
});
