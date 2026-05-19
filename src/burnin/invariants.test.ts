/**
 * Invariant library tests.
 *
 * The library is a pure function over WorldState. We construct minimal
 * WorldStates using the real type constructors so the invariants can
 * never accidentally pass on a fake shape that production code would
 * never produce.
 */

import { describe, expect, it } from 'vitest';
import { createGrid } from '../sim/world/grid.js';
import { type HexTile } from '../sim/world/terrain.js';
import { createSettlement, type Settlement } from '../sim/world/settlement.js';
import { createActor } from '../sim/politics/actor.js';
import { createCharacter } from '../sim/politics/character.js';
import { createCaravan, type Caravan } from '../sim/caravan/caravan.js';
import { createReputationTable } from '../sim/reputation/table.js';
import {
  actorId,
  caravanId,
  characterId,
  factionId,
  resourceId,
  settlementId,
  type Day,
} from '../sim/types.js';
import { hex } from '../sim/world/hex.js';
import type { WorldState } from '../procgen/seed.js';
import {
  STANDARD_INVARIANTS,
  caravanCargoNonNegative,
  caravanCrewPositive,
  checkInvariants,
  marketClearedAtAllSettlements,
  noOrphanedActorRefs,
  noOrphanedHexRefs,
  populationNonNegative,
  populationSane,
  priceFinite,
  reputationClamped,
  stockpileNonNegative,
  summarizeForDay,
  treasuryNonNegative,
  type InvariantContext,
  type InvariantViolation,
} from './invariants.js';

const seedHex = hex(0, 0);

const makeTile = (): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 100,
  hasRiver: false,
  road: 'none',
  ownerActor: null,
});

const makeGrid = (
  hexes: readonly { q: number; r: number }[] = [seedHex],
): ReturnType<typeof createGrid> => {
  const grid = createGrid();
  for (const h of hexes) {
    grid.set(h, makeTile());
  }
  return grid;
};

const makeWorld = (overrides: Partial<WorldState> = {}): WorldState => ({
  day: 0 as Day,
  grid: overrides.grid ?? makeGrid(),
  settlements: overrides.settlements ?? new Map(),
  actors: overrides.actors ?? new Map(),
  factions: overrides.factions ?? new Map(),
  characters: overrides.characters ?? new Map(),
  caravans: overrides.caravans ?? new Map(),
  reputation: overrides.reputation ?? createReputationTable(),
  bySite: overrides.bySite ?? [],
  ...overrides,
});

const ctx = (world: WorldState, day: Day = 0 as Day): InvariantContext => ({ world, day });

const findViolation = (
  violations: readonly InvariantViolation[],
  invariantName: string,
): InvariantViolation | undefined => violations.find((v) => v.invariant === invariantName);

// --- Empty-world baseline ---------------------------------------------------

describe('checkInvariants — empty world', () => {
  it('passes every standard invariant', () => {
    const result = checkInvariants(ctx(makeWorld()));
    expect(result).toEqual([]);
  });
});

// --- populationNonNegative --------------------------------------------------

describe('populationNonNegative', () => {
  it('passes for an empty population pool', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'village',
      name: 'Quietus',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    expect(populationNonNegative({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when a cohort count is forced negative via direct map mutation', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'village',
      name: 'Brokenburg',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    // PopulationPool.set throws on negative, so we bypass via the underlying
    // counts map by re-introducing a negative entry through a custom pool
    // shim. We monkeypatch only the iteration the invariant uses.
    const brokenPool = {
      count: () => 0,
      set: () => {
        throw new Error('not used');
      },
      total: () => -3,
      cohorts: function* () {
        yield [{ age: '20-24', sex: 'male', class: 'plebeian' }, -3] as readonly [
          { age: '20-24'; sex: 'male'; class: 'plebeian' },
          number,
        ];
      },
    };
    const settlementWithBrokenPool = {
      ...settlement,
      population: brokenPool,
    } as unknown as Settlement;
    const world = makeWorld({
      settlements: new Map([[settlement.id, settlementWithBrokenPool]]),
    });
    const violations = populationNonNegative({ world, day: 0 as Day });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.severity).toBe('fatal');
    expect(violations[0]?.detail).toContain('-3');
  });
});

// --- stockpileNonNegative ---------------------------------------------------

describe('stockpileNonNegative', () => {
  it('passes for an actor with empty stockpile', () => {
    const actor = createActor({
      id: actorId('a1'),
      kind: 'patrician_family',
      name: 'Vibian',
    });
    const world = makeWorld({ actors: new Map([[actor.id, actor]]) });
    expect(stockpileNonNegative({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when an actor has a negative stockpile entry', () => {
    const actor = createActor({
      id: actorId('a1'),
      kind: 'patrician_family',
      name: 'Vibian',
    });
    // Manually inject a negative entry so the invariant has something to
    // catch. Per docs/15 §C30 the outer key is SettlementId.
    actor.stockpile.set(settlementId('s1'), new Map([[resourceId('food.grain'), -5]]));
    const world = makeWorld({ actors: new Map([[actor.id, actor]]) });
    const violations = stockpileNonNegative({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    const v = violations[0];
    if (!v) throw new Error('expected one violation');
    expect(v.severity).toBe('fatal');
    expect(v.detail).toContain('food.grain');
    expect(v.detail).toContain('-5');
  });
});

// --- treasuryNonNegative ----------------------------------------------------

describe('treasuryNonNegative', () => {
  it('passes for an actor with non-negative treasury', () => {
    const actor = createActor({
      id: actorId('a1'),
      kind: 'patrician_family',
      name: 'Vibian',
      treasury: 100,
    });
    const world = makeWorld({ actors: new Map([[actor.id, actor]]) });
    expect(treasuryNonNegative({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires (warn) when an actor has negative treasury (debt)', () => {
    const actor = createActor({
      id: actorId('a1'),
      kind: 'patrician_family',
      name: 'Vibian',
    });
    actor.treasury = -50;
    const world = makeWorld({ actors: new Map([[actor.id, actor]]) });
    const violations = treasuryNonNegative({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    const v = violations[0];
    if (!v) throw new Error('expected one violation');
    expect(v.severity).toBe('warn');
    expect(v.detail).toContain('-50');
  });
});

// --- caravanCrewPositive ----------------------------------------------------

const baseCaravan = (id = 'c1'): Caravan =>
  createCaravan({
    id: caravanId(id),
    ownerActor: actorId('a1'),
    position: seedHex,
    crew: [{ kind: 'merchant', count: 2, weapons: 0, armor: 0 }],
    animals: { donkey: 4 },
    vehicles: {},
  });

describe('caravanCrewPositive', () => {
  it('passes for a caravan with positive crew', () => {
    const c = baseCaravan();
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    expect(caravanCrewPositive({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when a caravan has been emptied of crew (should have been removed)', () => {
    const c = baseCaravan();
    c.crew = [];
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    const violations = caravanCrewPositive({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    expect(violations[0]?.severity).toBe('error');
  });
});

// --- caravanCargoNonNegative ------------------------------------------------

describe('caravanCargoNonNegative', () => {
  it('passes for a caravan with no cargo', () => {
    const c = baseCaravan();
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    expect(caravanCargoNonNegative({ world, day: 0 as Day })).toEqual([]);
  });

  it('passes for a caravan loaded under capacity', () => {
    const c = baseCaravan();
    c.cargo.set(resourceId('food.grain'), 1);
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    expect(caravanCargoNonNegative({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when a cargo entry is negative', () => {
    const c = baseCaravan();
    c.cargo.set(resourceId('food.grain'), -2);
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    const violations = caravanCargoNonNegative({ world, day: 0 as Day });
    expect(violations.some((v) => v.detail.includes('-2'))).toBe(true);
  });

  it('fires when total cargo weight exceeds total carry capacity', () => {
    const c = baseCaravan();
    // 4 donkeys × 80kg = 320kg capacity. Wine is 26kg/unit; 100 units = 2600kg.
    c.cargo.set(resourceId('food.wine'), 100);
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    const violations = caravanCargoNonNegative({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    const v = violations[0];
    if (!v) throw new Error('expected one violation');
    expect(v.detail.toLowerCase()).toContain('capacity');
  });
});

// --- priceFinite ------------------------------------------------------------

describe('priceFinite', () => {
  const settlementWithPrice = (price: number): Settlement => {
    const s = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'Aquileia',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    s.market.lastClearingPrice.set(resourceId('food.grain'), price);
    return s;
  };

  it('passes when prices are finite', () => {
    const s = settlementWithPrice(3.5);
    const world = makeWorld({ settlements: new Map([[s.id, s]]) });
    expect(priceFinite({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires for NaN', () => {
    const s = settlementWithPrice(Number.NaN);
    const world = makeWorld({ settlements: new Map([[s.id, s]]) });
    const violations = priceFinite({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    expect(violations[0]?.severity).toBe('fatal');
  });

  it('fires for +Infinity', () => {
    const s = settlementWithPrice(Number.POSITIVE_INFINITY);
    const world = makeWorld({ settlements: new Map([[s.id, s]]) });
    const violations = priceFinite({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
  });

  it('fires for negative prices (still finite, but nonsensical)', () => {
    const s = settlementWithPrice(-1);
    const world = makeWorld({ settlements: new Map([[s.id, s]]) });
    const violations = priceFinite({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    expect(violations[0]?.detail).toContain('-1');
  });
});

// --- reputationClamped ------------------------------------------------------

describe('reputationClamped', () => {
  it('passes when all reputation values are in [-1, 1]', () => {
    const rep = createReputationTable();
    rep.set(actorId('a1'), actorId('a2'), 0.8);
    rep.set(actorId('a1'), actorId('a3'), -1);
    const world = makeWorld({ reputation: rep });
    expect(reputationClamped({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when an entry exceeds 1.0 via internal corruption', () => {
    // The table validates inputs, so we simulate live corruption by passing a
    // surrogate that yields an out-of-range entry. The invariant must catch
    // it regardless of how the corruption arose.
    const surrogate = {
      get: () => 0,
      set: () => {
        throw new Error('not used');
      },
      apply: () => 0,
      decayTick: () => undefined,
      size: () => 1,
      *entries() {
        yield {
          holder: actorId('a1'),
          subject: actorId('a2'),
          value: 2.0,
        };
      },
    };
    const world = makeWorld({ reputation: surrogate });
    const violations = reputationClamped({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.detail).toContain('2');
  });
});

// --- populationSane ---------------------------------------------------------

describe('populationSane', () => {
  it('passes when no previousSummary is provided (no comparison possible)', () => {
    const world = makeWorld();
    expect(populationSane({ world, day: 0 as Day })).toEqual([]);
  });

  it('passes when annualized growth is within bounds (1% per year)', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'Steady',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1010);
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    const c: InvariantContext = {
      world,
      day: 365 as Day,
      previousSummary: { day: 0 as Day, totalPop: 1000 },
    };
    expect(populationSane(c)).toEqual([]);
  });

  it('fires when population shrinks more than 50% over a year (instant collapse)', () => {
    // Build a world with a settlement of 100 plebeians.
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'Doomed',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    const c: InvariantContext = {
      world,
      day: 365 as Day,
      previousSummary: { day: 0 as Day, totalPop: 1000 },
    };
    const violations = populationSane(c);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.severity).toBe('error');
  });

  it('fires when population grows more than 5% per year (compound runaway)', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'Boomtown',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 10000);
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    const c: InvariantContext = {
      world,
      day: 365 as Day,
      previousSummary: { day: 0 as Day, totalPop: 1000 },
    };
    const violations = populationSane(c);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.detail.toLowerCase()).toContain('grew');
  });
});

// --- noOrphanedActorRefs ---------------------------------------------------

describe('noOrphanedActorRefs', () => {
  it('passes when every referenced actor exists', () => {
    const owner = createActor({ id: actorId('a1'), kind: 'caravan_owner', name: 'Owner' });
    const c = createCaravan({
      id: caravanId('c1'),
      ownerActor: owner.id,
      position: seedHex,
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { donkey: 1 },
      vehicles: {},
    });
    const world = makeWorld({
      actors: new Map([[owner.id, owner]]),
      caravans: new Map([[c.id, c]]),
    });
    expect(noOrphanedActorRefs({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when a caravan references a non-existent actor', () => {
    const c = createCaravan({
      id: caravanId('c1'),
      ownerActor: actorId('ghost'),
      position: seedHex,
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { donkey: 1 },
      vehicles: {},
    });
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    const violations = noOrphanedActorRefs({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    expect(violations[0]?.detail).toContain('ghost');
    expect(violations[0]?.severity).toBe('error');
  });

  it('fires when a settlement.stockpileOwners points at a missing actor', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'village',
      name: 'V',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
      stockpileOwners: [actorId('ghost')],
    });
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    const violations = noOrphanedActorRefs({ world, day: 0 as Day });
    expect(violations.some((v) => v.detail.includes('ghost'))).toBe(true);
  });
});

// --- noOrphanedHexRefs ------------------------------------------------------

describe('noOrphanedHexRefs', () => {
  it('passes when every referenced hex exists', () => {
    const grid = makeGrid([hex(0, 0), hex(1, 0)]);
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'village',
      name: 'V',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0)],
      catchmentHexes: [hex(1, 0)],
    });
    const world = makeWorld({
      grid,
      settlements: new Map([[settlement.id, settlement]]),
    });
    expect(noOrphanedHexRefs({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when a settlement.urbanHex is off-grid', () => {
    const grid = makeGrid([hex(0, 0)]);
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'village',
      name: 'V',
      anchor: hex(0, 0),
      urbanHexes: [hex(0, 0), hex(99, 99)],
      catchmentHexes: [],
    });
    const world = makeWorld({
      grid,
      settlements: new Map([[settlement.id, settlement]]),
    });
    const violations = noOrphanedHexRefs({ world, day: 0 as Day });
    expect(violations.some((v) => v.detail.includes('99,99'))).toBe(true);
  });

  it('fires when a caravan position is off-grid', () => {
    const grid = makeGrid([hex(0, 0)]);
    const c = createCaravan({
      id: caravanId('c1'),
      ownerActor: actorId('a1'),
      position: hex(50, 50),
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { donkey: 1 },
      vehicles: {},
    });
    const world = makeWorld({
      grid,
      caravans: new Map([[c.id, c]]),
    });
    const violations = noOrphanedHexRefs({ world, day: 0 as Day });
    expect(violations.some((v) => v.detail.includes('50,50'))).toBe(true);
  });

  it('fires when a character is at an off-grid hex', () => {
    const grid = makeGrid([hex(0, 0)]);
    const character = createCharacter({
      id: characterId('ch1'),
      name: 'Marcus',
      age: 30,
      sex: 'male',
      class: 'plebeian',
      faction: factionId('f1'),
      location: hex(7, 7),
    });
    const world = makeWorld({
      grid,
      characters: new Map([[character.id, character]]),
    });
    const violations = noOrphanedHexRefs({ world, day: 0 as Day });
    expect(violations.some((v) => v.detail.includes('7,7'))).toBe(true);
  });
});

// --- marketClearedAtAllSettlements ------------------------------------------

describe('marketClearedAtAllSettlements', () => {
  it('passes when there are no recorded inflows/outflows yet', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'village',
      name: 'V',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    expect(marketClearedAtAllSettlements({ world, day: 0 as Day })).toEqual([]);
  });

  it('passes when a settlement has a resource outflow AND has a clearing price for it', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'V',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    settlement.market.recentOutflows.set(resourceId('food.grain'), 100);
    settlement.market.lastClearingPrice.set(resourceId('food.grain'), 3.5);
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    expect(marketClearedAtAllSettlements({ world, day: 0 as Day })).toEqual([]);
  });

  it('fires when a settlement has a resource outflow but has no clearing price for it', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'V',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    settlement.market.recentOutflows.set(resourceId('food.grain'), 100);
    // No lastClearingPrice for food.grain.
    const world = makeWorld({ settlements: new Map([[settlement.id, settlement]]) });
    const violations = marketClearedAtAllSettlements({ world, day: 0 as Day });
    expect(violations.length).toBe(1);
    expect(violations[0]?.severity).toBe('warn');
    expect(violations[0]?.detail).toContain('food.grain');
  });
});

// --- summarizeForDay --------------------------------------------------------

describe('summarizeForDay', () => {
  it('returns zeroed counts for an empty world', () => {
    const summary = summarizeForDay(makeWorld(), 0 as Day);
    expect(summary).toEqual({
      day: 0,
      totalPop: 0,
      totalSettlements: 0,
      activeCaravans: 0,
      banditCamps: 0,
      recentDeaths: 0,
    });
  });

  it('counts settlements, populations, and caravans', () => {
    const settlement = createSettlement({
      id: settlementId('s1'),
      tier: 'town',
      name: 'Aquileia',
      anchor: seedHex,
      urbanHexes: [seedHex],
      catchmentHexes: [],
    });
    settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 50);
    settlement.population.set({ age: '20-24', sex: 'female', class: 'plebeian' }, 50);
    const c = baseCaravan();
    const world = makeWorld({
      settlements: new Map([[settlement.id, settlement]]),
      caravans: new Map([[c.id, c]]),
    });
    const summary = summarizeForDay(world, 100 as Day);
    expect(summary.day).toBe(100);
    expect(summary.totalPop).toBe(100);
    expect(summary.totalSettlements).toBe(1);
    expect(summary.activeCaravans).toBe(1);
  });
});

// --- checkInvariants integration --------------------------------------------

describe('checkInvariants', () => {
  it('runs the standard set by default', () => {
    expect(STANDARD_INVARIANTS.length).toBeGreaterThan(5);
    const result = checkInvariants(ctx(makeWorld()));
    expect(result).toEqual([]);
  });

  it('aggregates violations across multiple invariants', () => {
    const owner = createActor({ id: actorId('a1'), kind: 'caravan_owner', name: 'O' });
    owner.stockpile.set(settlementId('s1'), new Map([[resourceId('food.grain'), -1]]));
    owner.treasury = -100;
    const c = baseCaravan();
    c.crew = [];
    const world = makeWorld({
      actors: new Map([[owner.id, owner]]),
      caravans: new Map([[c.id, c]]),
    });
    const violations = checkInvariants(ctx(world));
    expect(findViolation(violations, 'stockpileNonNegative')).toBeDefined();
    expect(findViolation(violations, 'treasuryNonNegative')).toBeDefined();
    expect(findViolation(violations, 'caravanCrewPositive')).toBeDefined();
  });

  it('respects a custom invariant subset', () => {
    const c = baseCaravan();
    c.crew = [];
    const world = makeWorld({ caravans: new Map([[c.id, c]]) });
    // Only run priceFinite — the empty-crew caravan should not trigger anything.
    const result = checkInvariants(ctx(world), [priceFinite]);
    expect(result).toEqual([]);
  });

  it('is deterministic — same input → same output', () => {
    const c1 = baseCaravan('c1');
    c1.cargo.set(resourceId('food.grain'), -3);
    const c2 = baseCaravan('c2');
    c2.cargo.set(resourceId('food.grain'), -7);
    const world = makeWorld({
      caravans: new Map([
        [c1.id, c1],
        [c2.id, c2],
      ]),
    });
    const a = checkInvariants(ctx(world));
    const b = checkInvariants(ctx(world));
    expect(a).toEqual(b);
  });
});
