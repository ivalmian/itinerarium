import { describe, expect, it } from 'vitest';
import { actorId, resourceId } from '../types.js';
import {
  CLIMATE_BANDS,
  SEASONS,
  TERRAIN_TYPES,
  dayOfYearToSeason,
  fuelDemandMultiplier,
  isPassable,
  pastureCarryingCapacity,
  type Climate,
  type HexTile,
  type RoadGrade,
  type Season,
  type Terrain,
} from './terrain.js';

describe('terrain enumerations', () => {
  it('every terrain type is unique', () => {
    expect(new Set(TERRAIN_TYPES).size).toBe(TERRAIN_TYPES.length);
  });

  it('every climate band is unique', () => {
    expect(new Set(CLIMATE_BANDS).size).toBe(CLIMATE_BANDS.length);
  });

  it('every season is unique', () => {
    expect(new Set(SEASONS).size).toBe(SEASONS.length);
  });

  it('lists the terrain set defined in docs/07', () => {
    const expected: readonly Terrain[] = [
      'plains',
      'fertile_valley',
      'hills',
      'mountains',
      'forest',
      'dense_forest',
      'marsh',
      'desert',
      'steppe',
      'coast',
      'river',
      'lake',
      'urban',
      'ruin',
    ];
    for (const t of expected) {
      expect(TERRAIN_TYPES).toContain(t);
    }
    expect(TERRAIN_TYPES.length).toBe(expected.length);
  });

  it('lists the climate bands defined in docs/07', () => {
    const expected: readonly Climate[] = [
      'mediterranean',
      'temperate',
      'continental',
      'arid',
      'alpine',
    ];
    for (const c of expected) {
      expect(CLIMATE_BANDS).toContain(c);
    }
    expect(CLIMATE_BANDS.length).toBe(expected.length);
  });

  it('lists the four seasons in calendar order', () => {
    expect(SEASONS).toEqual(['spring', 'summer', 'autumn', 'winter']);
  });
});

describe('isPassable', () => {
  it('mountains are NOT passable in winter', () => {
    expect(isPassable('mountains', 'winter')).toBe(false);
  });

  it('mountains ARE passable in summer', () => {
    expect(isPassable('mountains', 'summer')).toBe(true);
  });

  it('plains are passable in every season', () => {
    for (const s of SEASONS) {
      expect(isPassable('plains', s)).toBe(true);
    }
  });

  it('lakes are not passable on foot in any season', () => {
    for (const s of SEASONS) {
      expect(isPassable('lake', s)).toBe(false);
    }
  });

  it('marshes are not passable in spring (wet) but passable in summer', () => {
    expect(isPassable('marsh', 'spring')).toBe(false);
    expect(isPassable('marsh', 'summer')).toBe(true);
  });
});

describe('fuelDemandMultiplier', () => {
  it('continental climates require more fuel than mediterranean', () => {
    expect(fuelDemandMultiplier('continental')).toBeGreaterThan(
      fuelDemandMultiplier('mediterranean'),
    );
  });

  it('alpine climates require more fuel than mediterranean', () => {
    expect(fuelDemandMultiplier('alpine')).toBeGreaterThan(fuelDemandMultiplier('mediterranean'));
  });

  it('every climate has a positive multiplier', () => {
    for (const c of CLIMATE_BANDS) {
      expect(fuelDemandMultiplier(c)).toBeGreaterThan(0);
    }
  });

  it('mediterranean is the baseline (multiplier = 1)', () => {
    expect(fuelDemandMultiplier('mediterranean')).toBe(1);
  });
});

describe('pastureCarryingCapacity', () => {
  it('fertile valley supports more herd units than mountains', () => {
    expect(pastureCarryingCapacity('fertile_valley', 'temperate')).toBeGreaterThan(
      pastureCarryingCapacity('mountains', 'temperate'),
    );
  });

  it('plains support more than steppe in temperate climate', () => {
    expect(pastureCarryingCapacity('plains', 'temperate')).toBeGreaterThan(
      pastureCarryingCapacity('steppe', 'temperate'),
    );
  });

  it('non-pasture terrain (lake, urban) carries no herds', () => {
    expect(pastureCarryingCapacity('lake', 'temperate')).toBe(0);
    expect(pastureCarryingCapacity('urban', 'temperate')).toBe(0);
  });

  it('arid climate reduces carrying capacity vs. temperate on the same terrain', () => {
    expect(pastureCarryingCapacity('plains', 'arid')).toBeLessThan(
      pastureCarryingCapacity('plains', 'temperate'),
    );
  });

  it('every result is non-negative', () => {
    for (const t of TERRAIN_TYPES) {
      for (const c of CLIMATE_BANDS) {
        expect(pastureCarryingCapacity(t, c)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('dayOfYearToSeason', () => {
  it('day 0 is spring (year begins at vernal equinox in our convention)', () => {
    expect(dayOfYearToSeason(0)).toBe('spring');
  });

  it('partitions the year into four ~91-day seasons', () => {
    // Spring: 0..90, Summer: 91..181, Autumn: 182..272, Winter: 273..364
    expect(dayOfYearToSeason(0)).toBe('spring');
    expect(dayOfYearToSeason(90)).toBe('spring');
    expect(dayOfYearToSeason(91)).toBe('summer');
    expect(dayOfYearToSeason(181)).toBe('summer');
    expect(dayOfYearToSeason(182)).toBe('autumn');
    expect(dayOfYearToSeason(272)).toBe('autumn');
    expect(dayOfYearToSeason(273)).toBe('winter');
    expect(dayOfYearToSeason(364)).toBe('winter');
  });

  it('cycles correctly across multi-year day indices', () => {
    expect(dayOfYearToSeason(365)).toBe('spring');
    expect(dayOfYearToSeason(365 * 3 + 100)).toBe('summer');
  });

  it('handles negative day indices by wrapping (defensive)', () => {
    // -1 wraps to day 364 → winter
    expect(dayOfYearToSeason(-1)).toBe('winter');
  });

  it('returns one of the four seasons for any integer day', () => {
    const samples = [0, 1, 50, 91, 200, 364, 365, 1000, 99999];
    for (const d of samples) {
      const s: Season = dayOfYearToSeason(d);
      expect(SEASONS).toContain(s);
    }
  });
});

describe('HexTile shape', () => {
  it('accepts a minimal wilderness tile (no owner, no deposit)', () => {
    const t: HexTile = {
      terrain: 'forest',
      climate: 'temperate',
      elevation: 320,
      hasRiver: false,
      hasCoast: false,
      road: 'none',
      ownerActor: null,
    };
    expect(t.terrain).toBe('forest');
    expect(t.ownerActor).toBeNull();
    expect(t.deposit).toBeUndefined();
    expect(t.hiddenFeature).toBeUndefined();
  });

  it('accepts a settled, road-bearing tile with an owner', () => {
    const t: HexTile = {
      terrain: 'plains',
      climate: 'mediterranean',
      elevation: 50,
      hasRiver: true,
      hasCoast: false,
      road: 'roman',
      ownerActor: actorId('actor.house.cornelii'),
    };
    expect(t.road satisfies RoadGrade).toBe('roman');
    expect(t.ownerActor).not.toBeNull();
  });

  it('accepts a mining tile with a deposit', () => {
    const t: HexTile = {
      terrain: 'mountains',
      climate: 'alpine',
      elevation: 1800,
      hasRiver: false,
      hasCoast: false,
      road: 'dirt',
      ownerActor: null,
      deposit: { resource: resourceId('mineral.iron_ore'), remaining: 500 },
    };
    expect(t.deposit?.remaining).toBe(500);
  });

  it('accepts an undiscovered hidden feature', () => {
    const t: HexTile = {
      terrain: 'ruin',
      climate: 'temperate',
      elevation: 200,
      hasRiver: false,
      hasCoast: false,
      road: 'none',
      ownerActor: null,
      hiddenFeature: 'ruin',
      hiddenFeatureDiscovered: false,
    };
    expect(t.hiddenFeature).toBe('ruin');
    expect(t.hiddenFeatureDiscovered).toBe(false);
  });
});
