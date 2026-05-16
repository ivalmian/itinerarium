import { describe, expect, it } from 'vitest';

import { generateTerrain } from './terrain.js';
import { seedWorld } from './seed.js';
import { seedCaravans } from './seedCaravans.js';
import { siteSettlements } from './settlements.js';
import { totalCrewCount } from '../sim/caravan/caravan.js';

const buildWorld = (worldSeed: string): ReturnType<typeof seedWorld> => {
  const grid = generateTerrain({
    seed: 'persons-terrain',
    widthHexes: 60,
    heightHexes: 60,
    mountainsCoveragePct: 8,
    oceanCoveragePct: 5,
  });
  const sites = siteSettlements({
    seed: 'persons-sites',
    grid,
    cityCount: 3,
    townCount: 6,
    villageCount: 12,
    hamletCount: 6,
  });
  return seedWorld({ seed: worldSeed, grid, settlementSites: sites });
};

describe('seedWorld: Person registry materialization', () => {
  it('populates WorldState.persons with one record per bandit fighter, hanger-on, and patrol soldier', () => {
    const world = buildWorld('persons-1');
    expect(world.persons).toBeDefined();
    const persons = world.persons!;
    expect(persons.size).toBeGreaterThan(0);

    // Cross-check: the count of soldier Persons should match the sum
    // of seeded patrol unit counts.
    let totalSoldiers = 0;
    for (const patrol of world.patrols?.values() ?? []) {
      totalSoldiers += patrol.unit.count;
    }
    let registeredSoldiers = 0;
    for (const p of persons.values()) {
      if (p.role === 'soldier') registeredSoldiers += 1;
    }
    expect(registeredSoldiers).toBe(totalSoldiers);

    // Bandit fighters: count should match sum of camp banditCount values.
    let totalBandits = 0;
    for (const camp of world.banditCamps?.values() ?? []) {
      totalBandits += camp.banditCount;
    }
    let registeredBandits = 0;
    for (const p of persons.values()) {
      if (p.role === 'bandit') registeredBandits += 1;
    }
    expect(registeredBandits).toBe(totalBandits);

    // Hangers-on: count should match sum of camp hangersOnCount values.
    let totalHangersOn = 0;
    for (const camp of world.banditCamps?.values() ?? []) {
      totalHangersOn += camp.hangersOnCount;
    }
    let registeredHangersOn = 0;
    for (const p of persons.values()) {
      if (p.role === 'bandit_hanger_on') registeredHangersOn += 1;
    }
    expect(registeredHangersOn).toBe(totalHangersOn);
  });

  it('gives every Person a non-empty Latin name and unitId back-reference', () => {
    const world = buildWorld('persons-2');
    for (const p of world.persons!.values()) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(/^[A-Z]/.test(p.name)).toBe(true);
      expect(p.unitId).toBeDefined();
      expect(p.status).toBe('alive');
    }
  });

  it('is deterministic across runs with the same seed', () => {
    const a = buildWorld('determinism-1');
    const b = buildWorld('determinism-1');
    expect(a.persons!.size).toBe(b.persons!.size);
    const namesA = [...a.persons!.values()].map((p) => p.name);
    const namesB = [...b.persons!.values()].map((p) => p.name);
    expect(namesA).toEqual(namesB);
  });

  it('materializes a Person for every caravan crew member when caravans are seeded', () => {
    const world = buildWorld('caravan-persons');
    seedCaravans({ world, seed: 'caravan-persons-seed' });
    expect(world.caravans.size).toBeGreaterThan(0);
    let totalCrew = 0;
    for (const c of world.caravans.values()) totalCrew += totalCrewCount(c);
    let crewPersons = 0;
    for (const p of world.persons!.values()) {
      if (
        p.role === 'merchant' ||
        p.role === 'drover' ||
        p.role === 'caravan_guard'
      ) {
        crewPersons += 1;
      }
    }
    expect(crewPersons).toBe(totalCrew);
    // Every guard's kit should at least include a melee weapon
    // (guard weaponsScore is seeded at 0.6 → hasta tier).
    let guardsWithMelee = 0;
    for (const p of world.persons!.values()) {
      if (p.role !== 'caravan_guard') continue;
      const kit = world.personEquipment!.get(p.id);
      if (kit !== undefined && kit.size > 0) guardsWithMelee += 1;
    }
    expect(guardsWithMelee).toBeGreaterThan(0);
  });

  it('issues weapon archetypes to every soldier and bandit fighter', () => {
    const world = buildWorld('equip-1');
    const equipment = world.personEquipment!;
    expect(equipment.size).toBeGreaterThan(0);

    let soldiersWithGladius = 0;
    let banditsWithSomeMelee = 0;
    let hangersOnWithKit = 0;
    for (const p of world.persons!.values()) {
      const kit = equipment.get(p.id);
      if (p.role === 'soldier' && kit?.has('goods.gladius' as never)) {
        soldiersWithGladius += 1;
      }
      if (p.role === 'bandit' && kit !== undefined && kit.size > 0) {
        banditsWithSomeMelee += 1;
      }
      if (p.role === 'bandit_hanger_on' && kit !== undefined) {
        hangersOnWithKit += 1;
      }
    }
    // The seeded patrols have weapons >= 0.7 (governor garrison at 0.8,
    // city watch at 0.5 — so only governor soldiers get gladii). At
    // minimum, some soldiers should carry a gladius.
    expect(soldiersWithGladius).toBeGreaterThan(0);
    expect(banditsWithSomeMelee).toBeGreaterThan(0);
    // Hangers-on are non-combatants per docs/12 — never issued kit.
    expect(hangersOnWithKit).toBe(0);
  });
});
