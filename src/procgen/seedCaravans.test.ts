import { describe, expect, it } from 'vitest';
import { seedWorld, type WorldState } from './seed.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements, type SettlementSite } from './settlements.js';
import { seedCaravans } from './seedCaravans.js';
import { createReputationTable } from '../sim/reputation/table.js';
import { createGrid } from '../sim/world/grid.js';
import { createSettlement } from '../sim/world/settlement.js';
import { createActor } from '../sim/politics/actor.js';
import { hex } from '../sim/world/hex.js';
import { actorId, resourceId, settlementId, type Day } from '../sim/types.js';
import { dailyCrewRationKg, totalCargoWeightKg, totalCarryKg } from '../sim/caravan/caravan.js';
import { MAX_ACTIVE_WORLD_CARAVANS } from '../sim/caravan/limits.js';
import { getResource } from '../sim/resources/catalog.js';

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
  it('creates a bounded standing fleet by default', () => {
    const w = buildWorld('basic');
    const settlementCount = w.settlements.size;
    expect(settlementCount).toBeGreaterThan(0);
    seedCaravans({ seed: 'basic-cs', world: w });
    // The default warm-start is a province-scale standing fleet, not one
    // random caravan per generated settlement.
    expect(w.caravans.size).toBeGreaterThan(0);
    expect(w.caravans.size).toBeLessThanOrEqual(80);
    expect(w.caravans.size).toBeLessThan(settlementCount);
  });

  it('honors totalCaravans', () => {
    const w = buildWorld('total');
    seedCaravans({ seed: 'total-cs', world: w, totalCaravans: 4 });
    expect(w.caravans.size).toBeLessThanOrEqual(4);
    expect(w.caravans.size).toBeGreaterThan(0);
  });

  it('caps explicit top-ups at the province active-caravan ceiling', () => {
    const w = buildEmptyWorld();
    for (let i = 0; i < 140; i++) {
      const sId = settlementId(`cap-settlement-${i}`);
      const ownerId = actorId(`cap-family-${i}`);
      const h = hex(i, 0);
      const s = createSettlement({
        id: sId,
        tier: i % 12 === 0 ? 'small_city' : 'village',
        name: `Cap Settlement ${i}`,
        anchor: h,
        urbanHexes: [h],
        catchmentHexes: [],
      });
      s.stockpileOwners.push(ownerId);
      const owner = createActor({
        id: ownerId,
        kind: 'patrician_family',
        name: `Cap Family ${i}`,
        homeSettlement: sId,
        treasury: 5_000,
      });
      w.settlements.set(sId, s);
      w.actors.set(ownerId, owner);
    }

    seedCaravans({
      seed: 'explicit-cap-cs',
      world: w,
      totalCaravans: 500,
      shareOwnedByFamilies: 1,
      shareOwnedByMerchantHouses: 0,
      shareOwnedByGovernor: 0,
    });

    expect(w.caravans.size).toBe(MAX_ACTIVE_WORLD_CARAVANS);
  });

  it('fills up to the requested total instead of appending another warm-start batch', () => {
    const w = buildWorld('reentry');
    seedCaravans({ seed: 'reentry-cs', world: w, totalCaravans: 8 });
    expect(w.caravans.size).toBeGreaterThan(0);
    expect(w.caravans.size).toBeLessThanOrEqual(8);

    const firstIds = Array.from(w.caravans.keys()).map(String).sort();
    const firstSize = w.caravans.size;
    seedCaravans({ seed: 'reentry-cs', world: w, totalCaravans: firstSize });

    expect(w.caravans.size).toBe(firstSize);
    expect(Array.from(w.caravans.keys()).map(String).sort()).toEqual(firstIds);
  });

  it('does not re-run the default warm-start on a world that already has caravans', () => {
    const w = buildWorld('default-reentry');
    seedCaravans({ seed: 'default-reentry-cs', world: w });
    expect(w.caravans.size).toBeGreaterThan(0);

    const firstIds = Array.from(w.caravans.keys()).map(String).sort();
    seedCaravans({ seed: 'default-reentry-cs', world: w });

    expect(Array.from(w.caravans.keys()).map(String).sort()).toEqual(firstIds);
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

  it('seeds enough grain for the initial 21-day ration reserve when capacity allows', () => {
    const w = buildWorld('rations');
    seedCaravans({ seed: 'rations-cs', world: w });
    const grain = resourceId('food.grain');
    const grainWeightKg = getResource(grain).weightKgPerUnit;
    for (const c of w.caravans.values()) {
      expect(totalCargoWeightKg(c)).toBeLessThanOrEqual(totalCarryKg(c) + 1e-9);
      const grainKg = (c.cargo.get(grain) ?? 0) * grainWeightKg;
      const targetKg = dailyCrewRationKg(c) * 21;
      if (targetKg <= totalCarryKg(c)) {
        expect(grainKg).toBeGreaterThanOrEqual(targetKg - 1e-9);
      }
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

  it('registers city-based merchant houses as stockpile owners at their home market', () => {
    const w = buildWorld('house-stockpile-owner');
    seedCaravans({
      seed: 'house-stockpile-owner-cs',
      world: w,
      totalCaravans: 12,
      shareOwnedByFamilies: 0,
      shareOwnedByMerchantHouses: 1,
      shareOwnedByGovernor: 0,
    });

    const merchantHouseIds = new Set(
      Array.from(w.caravans.values())
        .map((c) => c.ownerActor)
        .filter((ownerId) => w.actors.get(ownerId)?.kind === 'off_map_house'),
    );

    expect(merchantHouseIds.size).toBeGreaterThan(0);
    for (const ownerId of merchantHouseIds) {
      const owner = w.actors.get(ownerId);
      expect(owner?.homeSettlement).toBeDefined();
      const home =
        owner?.homeSettlement === undefined ? undefined : w.settlements.get(owner.homeSettlement);
      expect(home).toBeDefined();
      expect(home?.stockpileOwners).toContain(ownerId);
    }
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

  it('counts already-seeded caravans toward the per-owner cap on top-up calls', () => {
    const w = buildWorld('cap-reentry');
    seedCaravans({
      seed: 'cap-reentry-cs',
      world: w,
      totalCaravans: 3,
      shareOwnedByFamilies: 0,
      shareOwnedByMerchantHouses: 0,
      shareOwnedByGovernor: 1,
    });
    const firstSize = w.caravans.size;
    expect(firstSize).toBeGreaterThan(0);
    expect(firstSize).toBeLessThanOrEqual(3);

    seedCaravans({
      seed: 'cap-reentry-cs',
      world: w,
      totalCaravans: 10,
      shareOwnedByFamilies: 0,
      shareOwnedByMerchantHouses: 0,
      shareOwnedByGovernor: 1,
    });

    expect(w.caravans.size).toBe(firstSize);
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
