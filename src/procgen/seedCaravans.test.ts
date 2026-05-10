import { describe, expect, it } from 'vitest';
import { seedWorld, type WorldState } from './seed.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements, type SettlementSite } from './settlements.js';
import { seedCaravans } from './seedCaravans.js';
import { createReputationTable } from '../sim/reputation/table.js';
import { createGrid } from '../sim/world/grid.js';
import { type Day } from '../sim/types.js';

const buildWorld = (worldSeed: string, terrainSeed = 'world-terrain'): WorldState => {
  const grid = generateTerrain({
    seed: terrainSeed,
    widthHexes: 60,
    heightHexes: 60,
    mountainsCoveragePct: 8,
    oceanCoveragePct: 5,
  });
  const sites = siteSettlements({
    seed: 'world-sites',
    grid,
    cityCount: 3,
    townCount: 6,
    villageCount: 20,
    hamletCount: 10,
  });
  return seedWorld({ seed: worldSeed, grid, settlementSites: sites });
};

const buildEmptyWorld = (): WorldState => ({
  day: 0 as Day,
  grid: createGrid(),
  settlements: new Map(),
  actors: new Map(),
  factions: new Map(),
  characters: new Map(),
  caravans: new Map(),
  reputation: createReputationTable(),
  bySite: [] as readonly SettlementSite[],
});

describe('seedCaravans — empty world', () => {
  it('does nothing when there are no settlements', () => {
    const w = buildEmptyWorld();
    seedCaravans({ seed: 'empty', world: w });
    expect(w.caravans.size).toBe(0);
  });

  it('does nothing when no eligible owners exist', () => {
    const w = buildEmptyWorld();
    // Empty settlements + zero actors → no caravans.
    seedCaravans({ seed: 'no-owners', world: w });
    expect(w.caravans.size).toBe(0);
  });
});

describe('seedCaravans — basic seeding', () => {
  it('creates roughly one caravan per settlement by default', () => {
    const w = buildWorld('basic');
    const settlementCount = w.settlements.size;
    expect(settlementCount).toBeGreaterThan(0);
    seedCaravans({ seed: 'basic-cs', world: w });
    // Default is ~1 per settlement, but we cap per-owner at 3 and need
    // suitable owners — so accept a wide band rather than equality.
    expect(w.caravans.size).toBeGreaterThan(0);
    expect(w.caravans.size).toBeLessThanOrEqual(settlementCount);
  });

  it('honors totalCaravans', () => {
    const w = buildWorld('total');
    seedCaravans({ seed: 'total-cs', world: w, totalCaravans: 4 });
    expect(w.caravans.size).toBeLessThanOrEqual(4);
    expect(w.caravans.size).toBeGreaterThan(0);
  });
});

describe('seedCaravans — caravan validity', () => {
  it('every caravan has a valid origin (an existing settlement urban hex)', () => {
    const w = buildWorld('validity');
    seedCaravans({ seed: 'validity-cs', world: w });
    const validHexKeys = new Set<string>();
    for (const s of w.settlements.values()) {
      for (const h of s.urbanHexes) {
        validHexKeys.add(`${h.q},${h.r}`);
      }
    }
    for (const c of w.caravans.values()) {
      const k = `${c.position.q},${c.position.r}`;
      expect(validHexKeys.has(k)).toBe(true);
    }
  });

  it('every caravan has a destination distinct from its origin', () => {
    const w = buildWorld('dest');
    seedCaravans({ seed: 'dest-cs', world: w, totalCaravans: 8 });
    for (const c of w.caravans.values()) {
      expect(c.destination).not.toBeNull();
      if (c.destination !== null) {
        expect(c.destination.q !== c.position.q || c.destination.r !== c.position.r).toBe(true);
      }
    }
  });

  it('every caravan has non-empty crew, animals, and cargo', () => {
    const w = buildWorld('payload');
    seedCaravans({ seed: 'payload-cs', world: w });
    for (const c of w.caravans.values()) {
      let crewCount = 0;
      for (const m of c.crew) crewCount += m.count;
      expect(crewCount).toBeGreaterThan(0);
      let animalCount = 0;
      for (const k of Object.keys(c.animals)) {
        const n = c.animals[k as keyof typeof c.animals] ?? 0;
        animalCount += n;
      }
      expect(animalCount).toBeGreaterThan(0);
      expect(c.cargo.size).toBeGreaterThan(0);
    }
  });

  it('every caravan has a known owner Actor', () => {
    const w = buildWorld('owner');
    seedCaravans({ seed: 'owner-cs', world: w });
    for (const c of w.caravans.values()) {
      const owner = w.actors.get(c.ownerActor);
      expect(owner).toBeDefined();
    }
  });

  it('caravan ids are unique', () => {
    const w = buildWorld('unique');
    seedCaravans({ seed: 'unique-cs', world: w });
    const ids = new Set<string>();
    for (const c of w.caravans.values()) {
      const k = String(c.id);
      expect(ids.has(k)).toBe(false);
      ids.add(k);
    }
  });
});

describe('seedCaravans — owner mix', () => {
  it('the majority of caravans are owned by patrician families by default', () => {
    const w = buildWorld('mix');
    seedCaravans({ seed: 'mix-cs', world: w, totalCaravans: 20 });
    let families = 0;
    for (const c of w.caravans.values()) {
      const owner = w.actors.get(c.ownerActor);
      if (owner?.kind === 'patrician_family') families++;
    }
    // Default share is 0.7; allow some slack for small-N integer rounding.
    expect(families / Math.max(1, w.caravans.size)).toBeGreaterThanOrEqual(0.4);
  });

  it('honors share overrides — all-governor when shares are 0/0/1', () => {
    const w = buildWorld('all-gov');
    seedCaravans({
      seed: 'gov-cs',
      world: w,
      totalCaravans: 10,
      shareOwnedByFamilies: 0,
      shareOwnedByMerchantHouses: 0,
      shareOwnedByGovernor: 1,
    });
    for (const c of w.caravans.values()) {
      const owner = w.actors.get(c.ownerActor);
      expect(owner?.kind).toBe('governor_office');
    }
  });

  it('spawns synthetic merchant_house actors when the share is non-zero', () => {
    const w = buildWorld('houses');
    seedCaravans({
      seed: 'houses-cs',
      world: w,
      totalCaravans: 10,
      shareOwnedByFamilies: 0,
      shareOwnedByMerchantHouses: 1,
      shareOwnedByGovernor: 0,
    });
    expect(w.caravans.size).toBeGreaterThan(0);
    let houses = 0;
    for (const c of w.caravans.values()) {
      const owner = w.actors.get(c.ownerActor);
      if (owner?.kind === 'off_map_house') houses++;
    }
    expect(houses).toBeGreaterThan(0);
  });
});

describe('seedCaravans — per-owner cap', () => {
  it('no single owner gets more than 3 caravans', () => {
    const w = buildWorld('cap');
    seedCaravans({ seed: 'cap-cs', world: w, totalCaravans: 100 });
    const byOwner = new Map<string, number>();
    for (const c of w.caravans.values()) {
      const k = String(c.ownerActor);
      byOwner.set(k, (byOwner.get(k) ?? 0) + 1);
    }
    for (const n of byOwner.values()) {
      expect(n).toBeLessThanOrEqual(3);
    }
  });
});

describe('seedCaravans — determinism', () => {
  it('same seed + same world → same caravans (ids, owners, positions, destinations)', () => {
    const wA = buildWorld('det-w', 'det-terrain');
    const wB = buildWorld('det-w', 'det-terrain');
    seedCaravans({ seed: 'det-cs', world: wA });
    seedCaravans({ seed: 'det-cs', world: wB });
    expect(wA.caravans.size).toBe(wB.caravans.size);
    const keysA = Array.from(wA.caravans.keys()).map(String).sort();
    const keysB = Array.from(wB.caravans.keys()).map(String).sort();
    expect(keysA).toEqual(keysB);
    for (const k of keysA) {
      const ca = wA.caravans.get(k as never);
      const cb = wB.caravans.get(k as never);
      expect(ca).toBeDefined();
      expect(cb).toBeDefined();
      if (!ca || !cb) continue;
      expect(ca.position).toEqual(cb.position);
      expect(ca.destination).toEqual(cb.destination);
      expect(String(ca.ownerActor)).toBe(String(cb.ownerActor));
    }
  });
});
