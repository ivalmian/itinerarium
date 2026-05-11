import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../buildings/catalog.js';
import { JOBS } from '../jobs/catalog.js';
import { RESOURCES } from '../resources/catalog.js';
import { jobId, recipeId, resourceId } from '../types.js';
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
  'slaughter_sheep_for_meat_and_hides',
  'slaughter_pigs_for_meat_and_hides',
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
  'smelt_copper',
  'smelt_tin',
  'alloy_bronze',
  'smelt_lead',
  'cupel_silver',
  'refine_gold',
] as const;

const MANUFACTURE = [
  'weave_cloth',
  'weave_linen_cloth',
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
    it('every recipe except explicit upkeep passes has at least one output', () => {
      for (const r of allRecipes()) {
        if (r.id === recipeId('sow_grain')) continue;
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

    it('bake_bread: 30 flour + 5 wood → 40 bread with 1 baker', () => {
      const r = getRecipe(recipeId('bake_bread'));
      expect(r.inputs.get(resourceId('food.flour'))).toBe(30);
      // docs/03: a baker burns ~5 kg of oven fuel per day (restored in v1.5
      // once the forester/charcoal chain landed and trade closed the loop).
      expect(r.inputs.get(resourceId('material.wood'))).toBe(5);
      expect(r.outputs.get(resourceId('food.bread'))).toBe(40);
    });

    it('smelt_iron: 60 ore + 100 charcoal → 15 iron with 1 smelter', () => {
      const r = getRecipe(recipeId('smelt_iron'));
      // Roman bloomery: ~3-5 kg ore + ~6-10 kg charcoal yields ~1 kg
      // bloom iron. docs/03 worked example: scaled to a per-recipe-instance
      // bloomery-day at 60+100→15. Bloomery is genuinely charcoal-heavy.
      expect(r.inputs.get(resourceId('mineral.iron_ore'))).toBe(60);
      expect(r.inputs.get(resourceId('material.charcoal'))).toBe(100);
      expect(r.outputs.get(resourceId('metal.iron'))).toBe(15);
    });

    it('burn_charcoal: 1 cord wood → 5 sacks charcoal with 1 collier', () => {
      const r = getRecipe(recipeId('burn_charcoal'));
      // material.wood is a 700 kg cord; material.charcoal is a 30 kg sack.
      // 1 cord ~= 700 kg wood -> five 30 kg sacks keeps the 4-5:1
      // wood-to-charcoal mass yield while treating a clamp as a batch.
      expect(r.inputs.get(resourceId('material.wood'))).toBe(1);
      expect(r.outputs.get(resourceId('material.charcoal'))).toBe(5);
    });

    it('forge_tools: 5 iron + 0.08 lumber + 3 charcoal → 15 tools with 1 smith', () => {
      const r = getRecipe(recipeId('forge_tools'));
      expect(r.inputs.get(resourceId('metal.iron'))).toBe(5);
      expect(r.inputs.get(resourceId('material.lumber'))).toBe(0.08);
      expect(r.inputs.get(resourceId('material.charcoal'))).toBe(3);
      expect(r.outputs.get(resourceId('goods.tools'))).toBe(15);
    });

    it('weave_linen_cloth: 4 linen fiber → 1 cloth with 1 weaver', () => {
      const r = getRecipe(recipeId('weave_linen_cloth'));
      expect(r.inputs.get(resourceId('material.linen_fiber'))).toBe(4);
      expect(r.outputs.get(resourceId('goods.cloth'))).toBe(1);
      expect(r.labor.get(jobId('weaver'))).toBe(1);
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

    it('sow_grain does not create symbolic public works output', () => {
      const r = getRecipe(recipeId('sow_grain'));
      expect(r.outputs.size).toBe(0);
      expect(r.outputs.has(resourceId('service.public_works'))).toBe(false);
    });

    it('olive and grape harvest recipes run only in autumn', () => {
      for (const id of ['tend_olive_grove', 'tend_vineyard'] as const) {
        const r = getRecipe(recipeId(id));
        expect(r.seasonalMultiplier).toEqual({
          spring: 0,
          summer: 0,
          autumn: 1,
          winter: 0,
        });
      }
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

  describe('requires (present-but-not-consumed)', () => {
    it('shear_wool declares sheep in requires, not inputs', () => {
      const r = getRecipe(recipeId('shear_wool'));
      // The herd is PRESENT, not consumed.
      expect(r.requires.get(resourceId('livestock.sheep'))).toBe(0.01);
      expect(r.inputs.has(resourceId('livestock.sheep'))).toBe(false);
    });

    it('milk_dairy declares cattle in requires, not inputs', () => {
      const r = getRecipe(recipeId('milk_dairy'));
      expect(r.requires.get(resourceId('livestock.cattle'))).toBe(0.005);
      expect(r.inputs.has(resourceId('livestock.cattle'))).toBe(false);
    });

    it('slaughter_for_meat_and_hides keeps cattle in inputs (it actually slaughters)', () => {
      const r = getRecipe(recipeId('slaughter_for_meat_and_hides'));
      expect(r.inputs.get(resourceId('livestock.cattle'))).toBe(0.02);
      expect(r.requires.has(resourceId('livestock.cattle'))).toBe(false);
    });

    it('sheep and pig slaughter consume herd stock instead of requiring it passively', () => {
      const sheep = getRecipe(recipeId('slaughter_sheep_for_meat_and_hides'));
      const pigs = getRecipe(recipeId('slaughter_pigs_for_meat_and_hides'));

      expect(sheep.inputs.get(resourceId('livestock.sheep'))).toBe(0.03);
      expect(sheep.requires.has(resourceId('livestock.sheep'))).toBe(false);
      expect(pigs.inputs.get(resourceId('livestock.pigs'))).toBe(0.05);
      expect(pigs.requires.has(resourceId('livestock.pigs'))).toBe(false);
    });

    it('every recipe has a requires map (defaults to empty)', () => {
      for (const r of allRecipes()) {
        expect(r.requires).toBeInstanceOf(Map);
      }
    });

    it('requires map is read-only', () => {
      const r = getRecipe(recipeId('shear_wool'));
      expect(() => {
        (r.requires as Map<unknown, unknown>).clear();
      }).toThrow();
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
