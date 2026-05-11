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

describe('seedWorld — patrol demographics wiring', () => {
  it('every seeded patrol has demographics summing to unit.count', () => {
    const w = buildWorld('patrol-demo');
    expect(w.patrols?.size ?? 0).toBeGreaterThan(0);
    for (const p of (w.patrols ?? new Map()).values()) {
      expect(totalDemographics(p.demographics)).toBe(p.unit.count);
    }
  });
});
