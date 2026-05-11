import { describe, expect, it } from 'vitest';
import { seedWorld, type WorldState } from './seed.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements } from './settlements.js';
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

describe('seedWorld — bandit demographics wiring', () => {
  it('every seeded bandit camp has bandit + hangers-on demographics', () => {
    const w = buildWorld('bandit-demo');
    expect(w.banditCamps?.size ?? 0).toBeGreaterThan(0);
    for (const c of (w.banditCamps ?? new Map()).values()) {
      expect(totalDemographics(c.banditDemographics)).toBe(c.banditCount);
      expect(totalDemographics(c.hangersOnDemographics)).toBe(c.hangersOnCount);
    }
  });
});
