import { describe, expect, it } from 'vitest';
import { seedWorld, type WorldState } from './seed.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements } from './settlements.js';
import { seedCaravans } from './seedCaravans.js';
import { totalDemographics } from '../sim/population/demographics.js';

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

describe('seedCaravans — demographics wiring', () => {
  it('every seeded caravan crew entry has demographics summing to its count', () => {
    const w = buildWorld('demo-w');
    seedCaravans({ seed: 'demo-cs', world: w });
    expect(w.caravans.size).toBeGreaterThan(0);
    for (const c of w.caravans.values()) {
      for (const m of c.crew) {
        expect(totalDemographics(m.demographics)).toBe(m.count);
      }
    }
  });
});
