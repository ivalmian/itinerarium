import { describe, expect, it } from 'vitest';
import { actorId, buildingId, factionId, resourceId, settlementId } from '../types.js';
import { createGrid } from './grid.js';
import { hex, hexEquals, hexKey } from './hex.js';
import {
  addBuilding,
  createSettlement,
  expectedCatchmentRadius,
  expectedUrbanHexCount,
  recomputeCatchment,
  recordClearingPrice,
  recordInflow,
  recordOutflow,
  removeBuilding,
  setHexOwner,
  settlementContainsHex,
  shouldRecomputeCatchment,
  targetCatchmentRadius,
  tierOfPopulation,
  typicalPopForTier,
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

describe('typicalPopForTier', () => {
  it('matches docs/05 §"Dynamic catchment recompute" tier table', () => {
    expect(typicalPopForTier('hamlet')).toBe(100);
    expect(typicalPopForTier('village')).toBe(500);
    expect(typicalPopForTier('town')).toBe(2000);
    expect(typicalPopForTier('small_city')).toBe(10000);
    expect(typicalPopForTier('large_city')).toBe(30000);
  });
});

describe('targetCatchmentRadius', () => {
  it('returns the base radius when pop matches the typical pop', () => {
    expect(targetCatchmentRadius('village', 500)).toBe(2);
    expect(targetCatchmentRadius('town', 2000)).toBe(3);
    expect(targetCatchmentRadius('small_city', 10000)).toBe(5);
  });

  it('grows with sqrt(pop) — doubling pop increases r by ~sqrt(2)', () => {
    // village base=2 typical=500. pop=2000 → r = 2 * sqrt(4) = 4
    expect(targetCatchmentRadius('village', 2000)).toBe(4);
    // small_city base=5 typical=10000. pop=40000 → r = 5 * sqrt(4) = 10
    expect(targetCatchmentRadius('small_city', 40000)).toBe(10);
  });

  it('shrinks when pop falls below typical', () => {
    // town base=3 typical=2000. pop=200 → r = 3 * sqrt(0.1) ≈ 0.95 → clamp to 1
    expect(targetCatchmentRadius('town', 200)).toBe(1);
  });

  it('clamps to MIN/MAX', () => {
    // pop=0 should land on min (1).
    expect(targetCatchmentRadius('village', 0)).toBe(1);
    // very large pop should clamp at 15.
    expect(targetCatchmentRadius('large_city', 10_000_000)).toBe(15);
  });
});

describe('shouldRecomputeCatchment', () => {
  it('returns false when baseline pop is 0 (test stub)', () => {
    const s = baseSettlement(); // baseline defaults to 0
    expect(shouldRecomputeCatchment(s, 1000, 400)).toBe(false);
  });

  it('returns false when within ±25% of baseline', () => {
    const s = baseSettlement({ catchmentBaselinePop: 1000, catchmentDayLastChanged: 0 });
    // 24% growth — under threshold.
    expect(shouldRecomputeCatchment(s, 1240, 400)).toBe(false);
    // 24% shrink — under threshold.
    expect(shouldRecomputeCatchment(s, 760, 400)).toBe(false);
  });

  it('returns false when cooldown has not elapsed', () => {
    const s = baseSettlement({ catchmentBaselinePop: 1000, catchmentDayLastChanged: 100 });
    // 50% growth but only 200 days passed — still cooling down.
    expect(shouldRecomputeCatchment(s, 1500, 200)).toBe(false);
  });

  it('returns true when pop has grown >25% AND cooldown elapsed', () => {
    const s = baseSettlement({ catchmentBaselinePop: 1000, catchmentDayLastChanged: 0 });
    expect(shouldRecomputeCatchment(s, 1500, 400)).toBe(true);
  });

  it('returns true when pop has shrunk >25% AND cooldown elapsed', () => {
    const s = baseSettlement({ catchmentBaselinePop: 1000, catchmentDayLastChanged: 0 });
    expect(shouldRecomputeCatchment(s, 700, 400)).toBe(true);
  });
});

describe('recomputeCatchment', () => {
  // Build a minimal grid covering a wide enough disk to host any test
  // settlement's potential catchment growth. All tiles are blank wilderness.
  const buildGrid = (radius: number): ReturnType<typeof createGrid> => {
    const grid = createGrid();
    for (let q = -radius; q <= radius; q++) {
      const rMin = Math.max(-radius, -q - radius);
      const rMax = Math.min(radius, -q + radius);
      for (let r = rMin; r <= rMax; r++) {
        grid.set(
          { q, r },
          {
            terrain: 'plains',
            climate: 'temperate',
            elevation: 100,
            hasRiver: false,
            hasCoast: false,
            road: 'none',
            ownerActor: null,
          },
        );
      }
    }
    return grid;
  };

  it('claims new hexes when population grows beyond threshold', () => {
    // village pop 500, urban hex (0,0), initial catchment radius 2.
    // grow to 4000 → target radius = 2 * sqrt(4000/500) ≈ 5.66 → 6.
    const grid = buildGrid(8);
    const s = createSettlement({
      id: settlementId('vicus'),
      tier: 'village',
      name: 'Vicus',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      // Radius-2 catchment (excluding anchor).
      catchmentHexes: [
        hex(1, 0), hex(-1, 0), hex(0, 1), hex(0, -1), hex(1, -1), hex(-1, 1),
        hex(2, 0), hex(-2, 0), hex(0, 2), hex(0, -2), hex(2, -1), hex(-2, 1),
        hex(2, -2), hex(-2, 2), hex(1, 1), hex(-1, -1), hex(1, -2), hex(-1, 2),
      ],
      catchmentBaselinePop: 500,
    });
    // Mark grid ownership to match.
    setHexOwner(grid, hex(0, 0), family);
    for (const c of s.catchmentHexes) setHexOwner(grid, c, family);

    const result = recomputeCatchment({
      settlement: s,
      currentPop: 4000,
      today: 400,
      grid,
      ownerActorForClaimed: family,
      otherSettlements: [],
    });

    expect(result.resized).toBe(true);
    expect(result.newRadius).toBeGreaterThan(result.oldRadius);
    expect(result.claimed.length).toBeGreaterThan(0);
    expect(result.released.length).toBe(0);
    expect(s.catchmentBaselinePop).toBe(4000);
    expect(s.catchmentDayLastChanged).toBe(400);
    // Newly claimed hexes should now be owned by `family` in the grid.
    for (const c of result.claimed) {
      expect(grid.get(c)?.ownerActor).toBe(family);
    }
  });

  it('releases hexes when population shrinks beyond threshold', () => {
    // village starting at pop 2000, then crashes to 100.
    // target radius = 2 * sqrt(100/500) ≈ 0.89 → clamps to 1.
    const grid = buildGrid(6);
    const initialCatchment = [
      hex(1, 0), hex(-1, 0), hex(0, 1), hex(0, -1), hex(1, -1), hex(-1, 1),
      hex(2, 0), hex(-2, 0), hex(0, 2), hex(0, -2), hex(2, -1), hex(-2, 1),
      hex(2, -2), hex(-2, 2), hex(1, 1), hex(-1, -1), hex(1, -2), hex(-1, 2),
    ];
    const s = createSettlement({
      id: settlementId('vicus2'),
      tier: 'village',
      name: 'Vicus2',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: initialCatchment,
      catchmentBaselinePop: 2000,
    });
    for (const c of s.catchmentHexes) setHexOwner(grid, c, family);

    const result = recomputeCatchment({
      settlement: s,
      currentPop: 100,
      today: 500,
      grid,
      ownerActorForClaimed: family,
      otherSettlements: [],
    });

    expect(result.resized).toBe(true);
    expect(result.newRadius).toBe(1);
    expect(result.released.length).toBeGreaterThan(0);
    // Released hexes should now have null owner in the grid.
    for (const r of result.released) {
      expect(grid.get(r)?.ownerActor).toBeNull();
    }
    // Surviving catchment hexes should all still be at distance ≤ 1.
    for (const c of s.catchmentHexes) {
      const d = (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('does not claim hexes already owned by another settlement (contested → defer)', () => {
    const grid = buildGrid(8);
    // Settlement A at (0,0) — wants to grow.
    const a = createSettlement({
      id: settlementId('alpha'),
      tier: 'village',
      name: 'Alpha',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: [hex(1, 0), hex(-1, 0)],
      catchmentBaselinePop: 500,
    });
    // Settlement B sits at (3,0) and already owns (2,0) and (3,0) urban + a few catchment hexes.
    const b = createSettlement({
      id: settlementId('beta'),
      tier: 'village',
      name: 'Beta',
      anchor: hex(3, 0),
      urbanHexes: [hex(3, 0)],
      catchmentHexes: [hex(2, 0), hex(4, 0)],
      catchmentBaselinePop: 500,
    });

    const result = recomputeCatchment({
      settlement: a,
      currentPop: 4000, // forces growth
      today: 400,
      grid,
      ownerActorForClaimed: family,
      otherSettlements: [b],
    });

    // a should NOT claim hex (2,0) (B's catchment) or hex (3,0) (B's urban).
    const claimedKeys = new Set(result.claimed.map(hexKey));
    expect(claimedKeys.has(hexKey(hex(2, 0)))).toBe(false);
    expect(claimedKeys.has(hexKey(hex(3, 0)))).toBe(false);
    // But it should still claim some uncontested neighbors.
    expect(result.claimed.length).toBeGreaterThan(0);
  });

  it('keeps existing buildings even when their hex is released', () => {
    const grid = buildGrid(6);
    const farB: SettlementBuilding = {
      buildingId: buildingId('farm'),
      hex: hex(2, 0),
      ownerActor: family,
      capacity: 5,
      daysSinceMaintained: 0,
    };
    const s = createSettlement({
      id: settlementId('shrinker'),
      tier: 'village',
      name: 'Shrinker',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: [
        hex(1, 0), hex(2, 0), hex(0, 1), hex(0, 2),
      ],
      catchmentBaselinePop: 2000,
    });
    addBuilding(s, farB);
    expect(s.buildings.length).toBe(1);

    const result = recomputeCatchment({
      settlement: s,
      currentPop: 50,
      today: 400,
      grid,
      ownerActorForClaimed: family,
      otherSettlements: [],
    });
    expect(result.resized).toBe(true);
    // Building list is untouched even if its hex is no longer in the catchment.
    expect(s.buildings.length).toBe(1);
    expect(s.buildings[0]?.buildingId).toBe(buildingId('farm'));
  });
});
