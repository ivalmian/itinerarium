import { describe, expect, it } from 'vitest';
import { resourceId } from '../types.js';
import {
  RESOURCES,
  allResources,
  getResource,
  type ResourceCategory,
  type ResourceDef,
} from './catalog.js';

describe('resource catalog', () => {
  describe('coverage', () => {
    it('includes every resource enumerated in docs/02', () => {
      const expected: readonly string[] = [
        // Tier 0 — raw
        'food.grain',
        'food.olives',
        'food.grapes',
        'food.fish',
        'food.game',
        'food.legumes',
        'livestock.sheep',
        'livestock.cattle',
        'livestock.pigs',
        'livestock.equines',
        'material.wood',
        'material.stone',
        'material.clay',
        'material.flax',
        'material.hides',
        'mineral.iron_ore',
        'mineral.copper_ore',
        'mineral.tin_ore',
        'mineral.lead_ore',
        'mineral.silver_ore',
        'mineral.gold_ore',
        'mineral.salt',
        // Tier 1 — refined
        'food.flour',
        'food.bread',
        'food.olive_oil',
        'food.wine',
        'food.cheese',
        'food.salted_fish',
        'food.salted_meat',
        'material.wool',
        'material.linen_fiber',
        'material.leather',
        'material.charcoal',
        'material.lumber',
        'material.cut_stone',
        'material.brick_tile',
        'material.pottery',
        'material.amphora',
        'metal.iron',
        'metal.bronze',
        'metal.lead',
        'metal.silver',
        'metal.gold',
        // Tier 2 — manufactured
        'goods.cloth',
        'goods.clothing',
        'goods.tools',
        'goods.gladius',
        'goods.hasta',
        'goods.pilum',
        'goods.dagger',
        'goods.bow',
        'goods.arrow',
        'goods.sling',
        'goods.sling_bullet',
        'goods.helmet',
        'goods.body_armor',
        'goods.shield',
        'goods.cart',
        'goods.furniture',
        'goods.luxury_textiles',
        'goods.coin',
        // Tier 2b — exotic imports
        'exotic.spices',
        'exotic.silk',
        'exotic.incense',
        'exotic.dyes',
        // Tier 2c — people as cargo
        'people.slave',
        'people.migrants',
        // Tier 3 — institutional
        'service.garrison',
        'service.administration',
        'service.priesthood',
        'service.public_works',
      ];
      for (const id of expected) {
        expect(RESOURCES.has(resourceId(id))).toBe(true);
      }
    });

    it('exposes the same set via allResources()', () => {
      const all = allResources();
      expect(all.length).toBe(RESOURCES.size);
      const ids = new Set(all.map((r) => r.id));
      expect(ids.size).toBe(all.length);
    });
  });

  describe('uniqueness', () => {
    it('every resource id is unique', () => {
      const ids = allResources().map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('getResource', () => {
    it('returns the matching definition', () => {
      const r = getResource(resourceId('food.bread'));
      expect(r.id).toBe(resourceId('food.bread'));
      expect(r.name).toMatch(/bread/i);
    });

    it('throws on unknown id', () => {
      expect(() => getResource(resourceId('bogus.thing'))).toThrow();
    });
  });

  describe('tier assignment', () => {
    it('assigns tier 0 to raw materials', () => {
      expect(getResource(resourceId('food.grain')).tier).toBe(0);
      expect(getResource(resourceId('material.wood')).tier).toBe(0);
      expect(getResource(resourceId('mineral.iron_ore')).tier).toBe(0);
      expect(getResource(resourceId('livestock.sheep')).tier).toBe(0);
    });

    it('assigns tier 1 to refined goods', () => {
      expect(getResource(resourceId('food.bread')).tier).toBe(1);
      expect(getResource(resourceId('food.flour')).tier).toBe(1);
      expect(getResource(resourceId('metal.iron')).tier).toBe(1);
      expect(getResource(resourceId('material.charcoal')).tier).toBe(1);
    });

    it('assigns tier 2 to manufactured and exotic goods', () => {
      expect(getResource(resourceId('goods.cloth')).tier).toBe(2);
      expect(getResource(resourceId('goods.gladius')).tier).toBe(2);
      // Tier 2b exotics are modeled as tier 2 with category 'exotic'.
      expect(getResource(resourceId('exotic.spices')).tier).toBe(2);
      expect(getResource(resourceId('exotic.silk')).tier).toBe(2);
    });

    it('assigns tier 3 to institutional outputs', () => {
      expect(getResource(resourceId('service.garrison')).tier).toBe(3);
      expect(getResource(resourceId('service.administration')).tier).toBe(3);
    });
  });

  describe('category assignment', () => {
    it('exotics use category exotic', () => {
      expect(getResource(resourceId('exotic.spices')).category).toBe('exotic');
      expect(getResource(resourceId('exotic.dyes')).category).toBe('exotic');
    });

    it('people-as-cargo use category people', () => {
      expect(getResource(resourceId('people.slave')).category).toBe('people');
      expect(getResource(resourceId('people.migrants')).category).toBe('people');
    });

    it('institutional outputs use category service', () => {
      expect(getResource(resourceId('service.priesthood')).category).toBe('service');
    });

    it('matches the id namespace for the common cases', () => {
      const namespaceMatchesCategory: ReadonlyMap<string, ResourceCategory> = new Map([
        ['food', 'food'],
        ['material', 'material'],
        ['livestock', 'livestock'],
        ['mineral', 'mineral'],
        ['metal', 'metal'],
        ['goods', 'goods'],
        ['exotic', 'exotic'],
        ['people', 'people'],
        ['service', 'service'],
      ]);
      for (const r of allResources()) {
        const ns = r.id.split('.')[0];
        expect(ns).toBeDefined();
        const expected = namespaceMatchesCategory.get(ns as string);
        expect(expected).toBeDefined();
        expect(r.category).toBe(expected);
      }
    });
  });

  describe('weight', () => {
    it('every resource has positive weight per unit', () => {
      for (const r of allResources()) {
        expect(r.weightKgPerUnit).toBeGreaterThan(0);
      }
    });
  });

  describe('perishability', () => {
    it('bread and other clearly perishable items have perishableDays', () => {
      const bread = getResource(resourceId('food.bread'));
      expect(bread.perishableDays).toBeDefined();
      expect(bread.perishableDays).toBeGreaterThan(0);
    });

    it('stable goods have no perishableDays', () => {
      expect(getResource(resourceId('metal.iron')).perishableDays).toBeUndefined();
      expect(getResource(resourceId('material.stone')).perishableDays).toBeUndefined();
      expect(getResource(resourceId('goods.tools')).perishableDays).toBeUndefined();
    });

    it('when defined, perishableDays is a positive integer', () => {
      for (const r of allResources()) {
        if (r.perishableDays !== undefined) {
          expect(r.perishableDays).toBeGreaterThan(0);
          expect(Number.isInteger(r.perishableDays)).toBe(true);
        }
      }
    });
  });

  describe('immutability', () => {
    it('catalog entries cannot be mutated through the public API', () => {
      const def: ResourceDef = getResource(resourceId('food.bread'));
      // Per `as const` / Readonly contract, mutation must be a TS error;
      // at runtime, attempting to mutate a frozen object should also throw
      // in strict mode. The catalog freezes its definitions.
      expect(() => {
        (def as { name: string }).name = 'mutated';
      }).toThrow();
    });
  });
});
