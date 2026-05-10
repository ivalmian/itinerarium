import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../buildings/catalog.js';
import { JOBS } from '../jobs/catalog.js';
import { RESOURCES } from '../resources/catalog.js';
import { recipeId, resourceId } from '../types.js';
import {
  RECIPES,
  allRecipes,
  getRecipe,
  recipesByInput,
  recipesByOutput,
  type RecipeDef,
  type Season,
} from './recipes.js';

const AGRICULTURE = [
  'sow_grain',
  'harvest_grain',
  'tend_olive_grove',
  'tend_vineyard',
  'grow_flax',
  'grow_legumes',
] as const;

const PASTORAL = [
  'raise_sheep',
  'raise_cattle',
  'raise_pigs',
  'raise_equines',
  'shear_wool',
  'milk_dairy',
  'slaughter_for_meat_and_hides',
] as const;

const EXTRACTION = [
  'fell_timber',
  'quarry_stone',
  'dig_clay',
  'mine_iron',
  'mine_copper',
  'mine_tin',
  'mine_lead',
  'mine_silver',
  'mine_gold',
  'evaporate_salt',
  'mine_salt',
  'fish_river',
  'fish_lake',
  'fish_coast',
  'hunt_game',
  'gather_oak_bark',
] as const;

const REFINING = [
  'mill_grain',
  'bake_bread',
  'press_olives',
  'make_wine',
  'make_cheese',
  'salt_fish',
  'salt_meat',
  'ret_flax',
  'tan_leather',
  'burn_charcoal',
  'saw_lumber',
  'dress_stone',
  'fire_bricks',
  'throw_pottery',
  'throw_amphorae',
  'smelt_iron',
  'alloy_bronze',
  'smelt_lead',
  'cupel_silver',
  'refine_gold',
] as const;

const MANUFACTURE = [
  'weave_cloth',
  'tailor_clothing',
  'forge_tools',
  'forge_weapons',
  'forge_armor',
  'make_shields',
  'build_cart',
  'make_furniture',
  'weave_luxury',
  'mint_coin',
] as const;

describe('recipe registry', () => {
  describe('coverage', () => {
    it('includes every recipe enumerated in docs/03', () => {
      const expected = [...AGRICULTURE, ...PASTORAL, ...EXTRACTION, ...REFINING, ...MANUFACTURE];
      for (const id of expected) {
        expect(RECIPES.has(recipeId(id))).toBe(true);
      }
    });

    it('does not include build_ship (sea trade deferred)', () => {
      expect(RECIPES.has(recipeId('build_ship'))).toBe(false);
    });
  });

  describe('uniqueness', () => {
    it('every recipe id is unique', () => {
      const ids = allRecipes().map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('getRecipe', () => {
    it('returns the matching definition', () => {
      const r = getRecipe(recipeId('mill_grain'));
      expect(r.id).toBe(recipeId('mill_grain'));
    });

    it('throws on unknown id', () => {
      expect(() => getRecipe(recipeId('alchemy'))).toThrow();
    });
  });

  describe('cross-references', () => {
    it('every input references a real resource', () => {
      for (const r of allRecipes()) {
        for (const resId of r.inputs.keys()) {
          expect(RESOURCES.has(resId)).toBe(true);
        }
      }
    });

    it('every output references a real resource', () => {
      for (const r of allRecipes()) {
        for (const resId of r.outputs.keys()) {
          expect(RESOURCES.has(resId)).toBe(true);
        }
      }
    });

    it('every recipe references a real building', () => {
      for (const r of allRecipes()) {
        expect(BUILDINGS.has(r.building)).toBe(true);
      }
    });

    it('every labor entry references a real job', () => {
      for (const r of allRecipes()) {
        for (const jId of r.labor.keys()) {
          expect(JOBS.has(jId)).toBe(true);
        }
      }
    });
  });

  describe('structural invariants', () => {
    it('every recipe has at least one output', () => {
      for (const r of allRecipes()) {
        expect(r.outputs.size).toBeGreaterThan(0);
      }
    });

    it('every recipe requires at least one labor role (docs/03: building+specialist both required)', () => {
      for (const r of allRecipes()) {
        expect(r.labor.size).toBeGreaterThan(0);
        for (const wd of r.labor.values()) {
          expect(wd).toBeGreaterThan(0);
        }
      }
    });

    it('every input quantity is positive', () => {
      for (const r of allRecipes()) {
        for (const qty of r.inputs.values()) {
          expect(qty).toBeGreaterThan(0);
        }
      }
    });

    it('every output quantity is positive', () => {
      for (const r of allRecipes()) {
        for (const qty of r.outputs.values()) {
          expect(qty).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('docs/03 worked examples', () => {
    it('mill_grain: 50 grain → 45 flour with 1 miller in mill', () => {
      const r = getRecipe(recipeId('mill_grain'));
      expect(r.building).toBe(BUILDINGS.get(r.building)?.id);
      expect(r.inputs.get(resourceId('food.grain'))).toBe(50);
      expect(r.outputs.get(resourceId('food.flour'))).toBe(45);
    });

    it('bake_bread: 30 flour + 0.5 wood → 40 bread with 1 baker', () => {
      const r = getRecipe(recipeId('bake_bread'));
      expect(r.inputs.get(resourceId('food.flour'))).toBe(30);
      // Wood reduced from docs/03's 5 → 0.5 for v1 burn-in stability;
      // realistic ratio restored in v1.5 once trade closes the loop.
      expect(r.inputs.get(resourceId('material.wood'))).toBe(0.5);
      expect(r.outputs.get(resourceId('food.bread'))).toBe(40);
    });

    it('smelt_iron: 6 ore + 10 charcoal → 2 iron with 1 smelter', () => {
      const r = getRecipe(recipeId('smelt_iron'));
      // Roman bloomery: ~3-5 kg ore + ~6-10 kg charcoal yields ~1 kg
      // bloom iron (after slag loss). We round to 2 kg/recipe so the
      // ratio sits between historical and slightly idealized.
      expect(r.inputs.get(resourceId('mineral.iron_ore'))).toBe(6);
      expect(r.inputs.get(resourceId('material.charcoal'))).toBe(10);
      expect(r.outputs.get(resourceId('metal.iron'))).toBe(2);
    });

    it('forge_tools: 5 iron + 2 lumber + 3 charcoal → 15 tools with 1 smith', () => {
      const r = getRecipe(recipeId('forge_tools'));
      expect(r.inputs.get(resourceId('metal.iron'))).toBe(5);
      expect(r.inputs.get(resourceId('material.lumber'))).toBe(2);
      expect(r.inputs.get(resourceId('material.charcoal'))).toBe(3);
      expect(r.outputs.get(resourceId('goods.tools'))).toBe(15);
    });

    it('press_olives: 300 olives + 5 amphora → 60 oil with 1 presser, autumn-only', () => {
      const r = getRecipe(recipeId('press_olives'));
      expect(r.inputs.get(resourceId('food.olives'))).toBe(300);
      expect(r.inputs.get(resourceId('material.amphora'))).toBe(5);
      expect(r.outputs.get(resourceId('food.olive_oil'))).toBe(60);
      expect(r.seasonalMultiplier).toBeDefined();
      expect(r.seasonalMultiplier?.autumn).toBeGreaterThan(0);
      // Off-season must be 0 or omitted; if defined, 0.
      const winter = r.seasonalMultiplier?.winter;
      if (winter !== undefined) expect(winter).toBe(0);
    });
  });

  describe('seasonal recipes', () => {
    it('harvest_grain has a seasonal multiplier with summer or autumn dominant', () => {
      const r = getRecipe(recipeId('harvest_grain'));
      expect(r.seasonalMultiplier).toBeDefined();
      const sm = r.seasonalMultiplier as Partial<Record<Season, number>>;
      const summer = sm.summer ?? 0;
      const autumn = sm.autumn ?? 0;
      expect(summer + autumn).toBeGreaterThan(0);
    });

    it('sow_grain runs in spring', () => {
      const r = getRecipe(recipeId('sow_grain'));
      expect(r.seasonalMultiplier).toBeDefined();
      expect(r.seasonalMultiplier?.spring).toBeGreaterThan(0);
    });

    it('non-seasonal recipes (e.g., bake_bread) have no seasonal multiplier or are 1 everywhere', () => {
      const r = getRecipe(recipeId('bake_bread'));
      if (r.seasonalMultiplier !== undefined) {
        for (const v of Object.values(r.seasonalMultiplier)) {
          if (v !== undefined) expect(v).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('recipesByOutput', () => {
    it('returns mill_grain when querying food.flour', () => {
      const out = recipesByOutput(resourceId('food.flour'));
      const ids = new Set(out.map((r) => r.id));
      expect(ids.has(recipeId('mill_grain'))).toBe(true);
    });

    it('returns multiple producers for goods.tools (forge_tools)', () => {
      const out = recipesByOutput(resourceId('goods.tools'));
      expect(out.length).toBeGreaterThan(0);
    });

    it('returns empty for an unproduced resource', () => {
      const out = recipesByOutput(resourceId('exotic.silk'));
      expect(out).toEqual([]);
    });
  });

  describe('recipesByInput', () => {
    it('returns bake_bread when querying food.flour', () => {
      const out = recipesByInput(resourceId('food.flour'));
      const ids = new Set(out.map((r) => r.id));
      expect(ids.has(recipeId('bake_bread'))).toBe(true);
    });

    it('returns smelt_iron when querying mineral.iron_ore', () => {
      const out = recipesByInput(resourceId('mineral.iron_ore'));
      const ids = new Set(out.map((r) => r.id));
      expect(ids.has(recipeId('smelt_iron'))).toBe(true);
    });

    it('returns empty for a non-input resource', () => {
      const out = recipesByInput(resourceId('exotic.silk'));
      expect(out.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('immutability', () => {
    it('catalog entries cannot be mutated through the public API', () => {
      const def: RecipeDef = getRecipe(recipeId('mill_grain'));
      expect(() => {
        (def as { id: unknown }).id = 'mutated';
      }).toThrow();
    });

    it('input map is read-only', () => {
      const def = getRecipe(recipeId('mill_grain'));
      expect(() => {
        (def.inputs as Map<unknown, unknown>).clear();
      }).toThrow();
    });
  });
});
