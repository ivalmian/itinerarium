import { describe, expect, it } from 'vitest';
import { RESOURCES } from '../resources/catalog.js';
import { buildingId } from '../types.js';
import {
  BUILDINGS,
  allBuildings,
  getBuilding,
  type BuildingCategory,
  type BuildingDef,
} from './catalog.js';

const PRODUCTION_BUILDINGS = [
  'farm',
  'pasture',
  'vineyard',
  'olive_grove',
  'orchard',
  'fishery',
  'mine',
  'quarry',
  'forester_camp',
  'mill',
  'bakery',
  'oil_press',
  'winery',
  'dairy',
  'tannery',
  'charcoal_kiln',
  'sawmill',
  'kiln',
  'pottery',
  'bloomery',
  'smithy',
  'weaver_workshop',
  'tailor_shop',
  'cart_wright',
  'mint',
] as const;

const STORAGE_CIVIC_BUILDINGS = [
  'granary',
  'warehouse',
  'cistern',
  'aqueduct_segment',
  'temple',
  'forum_market',
  'walls',
  'barracks',
  'road_segment',
] as const;

describe('building catalog', () => {
  describe('coverage', () => {
    it('includes every building enumerated in docs/05', () => {
      const expected = [...PRODUCTION_BUILDINGS, ...STORAGE_CIVIC_BUILDINGS];
      for (const id of expected) {
        expect(BUILDINGS.has(buildingId(id))).toBe(true);
      }
    });

    it('does not include shipyard (sea trade deferred)', () => {
      expect(BUILDINGS.has(buildingId('shipyard'))).toBe(false);
    });

    it('exposes the same set via allBuildings()', () => {
      const all = allBuildings();
      expect(all.length).toBe(BUILDINGS.size);
      const ids = new Set(all.map((b) => b.id));
      expect(ids.size).toBe(all.length);
    });
  });

  describe('uniqueness', () => {
    it('every building id is unique', () => {
      const ids = allBuildings().map((b) => b.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('getBuilding', () => {
    it('returns the matching definition', () => {
      const b = getBuilding(buildingId('mill'));
      expect(b.id).toBe(buildingId('mill'));
      expect(b.name).toMatch(/mill/i);
    });

    it('throws on unknown id', () => {
      expect(() => getBuilding(buildingId('not-a-real-building'))).toThrow();
    });
  });

  describe('categories', () => {
    it('production buildings are categorized as production', () => {
      const productionLike: readonly string[] = [
        'farm',
        'mill',
        'bakery',
        'smithy',
        'mine',
        'quarry',
      ];
      for (const id of productionLike) {
        expect(getBuilding(buildingId(id)).category).toBe('production');
      }
    });

    it('granary and warehouse are storage', () => {
      expect(getBuilding(buildingId('granary')).category).toBe('storage');
      expect(getBuilding(buildingId('warehouse')).category).toBe('storage');
      expect(getBuilding(buildingId('cistern')).category).toBe('storage');
    });

    it('temple, forum_market are civic', () => {
      expect(getBuilding(buildingId('temple')).category).toBe('civic');
      expect(getBuilding(buildingId('forum_market')).category).toBe('civic');
    });

    it('walls and barracks are military', () => {
      expect(getBuilding(buildingId('walls')).category).toBe('military');
      expect(getBuilding(buildingId('barracks')).category).toBe('military');
    });

    it('road_segment and aqueduct_segment are infrastructure', () => {
      expect(getBuilding(buildingId('road_segment')).category).toBe('infrastructure');
      expect(getBuilding(buildingId('aqueduct_segment')).category).toBe('infrastructure');
    });

    it('every category is one of the declared union members', () => {
      const allowed = new Set<BuildingCategory>([
        'production',
        'storage',
        'civic',
        'military',
        'infrastructure',
      ]);
      for (const b of allBuildings()) {
        expect(allowed.has(b.category)).toBe(true);
      }
    });
  });

  describe('capacity', () => {
    it('production buildings have positive capacityUnits', () => {
      for (const id of PRODUCTION_BUILDINGS) {
        const b = getBuilding(buildingId(id));
        expect(b.capacityUnits).toBeGreaterThan(0);
      }
    });

    it('non-production buildings still have non-negative capacityUnits', () => {
      for (const b of allBuildings()) {
        expect(b.capacityUnits).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('construction costs', () => {
    it('every cost references a real resource', () => {
      for (const b of allBuildings()) {
        for (const resId of b.constructionCost.keys()) {
          expect(RESOURCES.has(resId)).toBe(true);
        }
      }
    });

    it('every cost amount is positive', () => {
      for (const b of allBuildings()) {
        for (const qty of b.constructionCost.values()) {
          expect(qty).toBeGreaterThan(0);
        }
      }
    });

    it('every building has at least one construction input', () => {
      for (const b of allBuildings()) {
        expect(b.constructionCost.size).toBeGreaterThan(0);
      }
    });
  });

  describe('maintenance', () => {
    it('every maintenance entry references a real resource and is non-negative', () => {
      for (const b of allBuildings()) {
        for (const [resId, qty] of b.maintenancePerDay) {
          expect(RESOURCES.has(resId)).toBe(true);
          expect(qty).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('decayDaysIfUnmaintained is positive', () => {
      for (const b of allBuildings()) {
        expect(b.decayDaysIfUnmaintained).toBeGreaterThan(0);
        expect(Number.isFinite(b.decayDaysIfUnmaintained)).toBe(true);
      }
    });
  });

  describe('immutability', () => {
    it('catalog entries cannot be mutated through the public API', () => {
      const def: BuildingDef = getBuilding(buildingId('mill'));
      expect(() => {
        (def as { name: string }).name = 'mutated';
      }).toThrow();
    });

    it('construction cost map is read-only', () => {
      const def = getBuilding(buildingId('mill'));
      expect(() => {
        (def.constructionCost as Map<unknown, unknown>).clear();
      }).toThrow();
    });
  });
});
