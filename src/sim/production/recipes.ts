/**
 * Typed registry of every production recipe.
 *
 * Source: docs/03-production.md "Full recipe catalog" plus the worked
 * examples (mill_grain, bake_bread, smelt_iron, forge_tools, press_olives,
 * raise_sheep). Locked rule: a recipe needs BOTH a building of the right
 * type AND specialist labor; either missing → recipe does not run.
 *
 * All inputs/outputs are per recipe-instance per day; one day is one turn.
 * Numbers are first-pass per docs/03 ("the structure matters more than
 * the exact figures right now"). Tuning lives in burn-in.
 *
 * Pastoral recipes such as raise_sheep are modeled here with their daily
 * fractional outputs (annual yields divided over 365). Standing herd
 * stockpile is tracked separately by the population/livestock subsystem;
 * here we only model the steady production rate per herd unit.
 */

import { buildingId, jobId, recipeId, resourceId } from '../types.js';
import type { BuildingId, JobId, Quantity, RecipeId, ResourceId } from '../types.js';
import { SEASONS, type Season } from '../world/terrain.js';

export { SEASONS, type Season };

export interface RecipeDef {
  readonly id: RecipeId;
  readonly inputs: ReadonlyMap<ResourceId, Quantity>;
  /**
   * Resources that must be PRESENT in the owner's stockpile for the recipe
   * to run, but are NOT consumed. Modeling pattern: a standing herd is
   * present at the pasture and produces wool / milk per herd-unit per day,
   * but shearing or milking does not deplete the herd. See docs/03
   * "livestock are stocks, not flows".
   *
   * `requires[r]` factors into the fraction calculation (recipe scales down
   * if `requires[r] / available < 1`), but no deduction happens at run-time.
   */
  readonly requires: ReadonlyMap<ResourceId, Quantity>;
  readonly labor: ReadonlyMap<JobId, number>;
  readonly building: BuildingId;
  readonly outputs: ReadonlyMap<ResourceId, Quantity>;
  readonly seasonalMultiplier?: Readonly<Partial<Record<Season, number>>>;
  readonly notes?: string;
}

interface RecipeInput {
  readonly id: string;
  readonly inputs?: Readonly<Record<string, Quantity>>;
  readonly requires?: Readonly<Record<string, Quantity>>;
  readonly labor: Readonly<Record<string, number>>;
  readonly building: string;
  readonly outputs: Readonly<Record<string, Quantity>>;
  readonly seasonalMultiplier?: Readonly<Partial<Record<Season, number>>>;
  readonly notes?: string;
}

const NOMINAL_INPUT: Readonly<Record<string, Quantity>> = {};

const DEFS: readonly RecipeInput[] = [
  // --- Agriculture (seasonal) ---
  {
    id: 'sow_grain',
    inputs: { 'food.grain': 5, 'goods.tools': 0.05 },
    labor: { farmer: 1 },
    building: 'farm',
    outputs: { 'service.public_works': 0.001 },
    seasonalMultiplier: { spring: 1, summer: 0, autumn: 0, winter: 0 },
    notes:
      'Sowing consumes seed grain. Output here is symbolic; the real harvest comes from harvest_grain in summer/autumn.',
  },
  {
    id: 'harvest_grain',
    // Tools wear: ~1 sickle replaced per farmer per year ≈ 0.005/day
    // (working ~200 farmer-days per year per sickle). This restores the
    // realistic per-recipe wear rate and makes the smithy/forge_tools
    // chain load-bearing for the world's tool supply.
    inputs: { 'goods.tools': 0.005 },
    labor: { farmer: 1 },
    building: 'farm',
    outputs: { 'food.grain': 80 },
    seasonalMultiplier: { spring: 0.4, summer: 0.7, autumn: 1.0, winter: 0.3 },
    notes: 'Annualized average ~50 modii/farmer-day; autumn peaks at 80.',
  },
  {
    id: 'tend_olive_grove',
    inputs: { 'goods.tools': 0.02 },
    labor: { farmer: 0.3 },
    building: 'olive_grove',
    outputs: { 'food.olives': 30 },
    seasonalMultiplier: { spring: 0.2, summer: 0.2, autumn: 1, winter: 0.1 },
    notes: 'Year-round care; harvest concentrated in autumn.',
  },
  {
    id: 'tend_vineyard',
    inputs: { 'goods.tools': 0.02 },
    labor: { farmer: 0.4 },
    building: 'vineyard',
    outputs: { 'food.grapes': 40 },
    seasonalMultiplier: { spring: 0.3, summer: 0.4, autumn: 1, winter: 0.1 },
  },
  {
    id: 'grow_flax',
    inputs: { 'goods.tools': 0.05 },
    labor: { farmer: 1 },
    building: 'farm',
    outputs: { 'material.flax': 20 },
    seasonalMultiplier: { spring: 0.5, summer: 1, autumn: 0.2, winter: 0 },
  },
  {
    id: 'grow_legumes',
    inputs: { 'goods.tools': 0.05 },
    labor: { farmer: 1 },
    building: 'farm',
    outputs: { 'food.legumes': 50 },
    seasonalMultiplier: { spring: 0.5, summer: 1, autumn: 0.5, winter: 0 },
  },

  // --- Pastoral (steady annual flows divided to daily) ---
  {
    id: 'raise_sheep',
    inputs: NOMINAL_INPUT,
    labor: { shepherd: 0.2 },
    building: 'pasture',
    outputs: { 'livestock.sheep': 0.005 },
    notes: 'Per herd unit (~30 head). Steady-state herd growth; wool/milk via dedicated recipes.',
  },
  {
    id: 'raise_cattle',
    inputs: NOMINAL_INPUT,
    labor: { cattle_herder: 0.3 },
    building: 'pasture',
    outputs: { 'livestock.cattle': 0.003 },
  },
  {
    id: 'raise_pigs',
    inputs: { 'food.grain': 5 },
    labor: { swineherd: 0.2 },
    building: 'pasture',
    outputs: { 'livestock.pigs': 0.005 },
    notes: 'Pigs eat scraps and forage; small grain supplement.',
  },
  {
    id: 'raise_equines',
    inputs: { 'food.grain': 8 },
    labor: { cattle_herder: 0.3 },
    building: 'pasture',
    outputs: { 'livestock.equines': 0.002 },
  },
  {
    id: 'shear_wool',
    // Sheep are PRESENT in the pasture and provide a wool flow; shearing
    // does not consume the herd. Slaughter is the only herd-consuming
    // recipe. See docs/03 "livestock are stocks, not flows".
    requires: { 'livestock.sheep': 0.01 },
    labor: { shepherd: 0.1 },
    building: 'pasture',
    outputs: { 'material.wool': 0.55 },
    seasonalMultiplier: { spring: 1, summer: 0.2, autumn: 0, winter: 0 },
    notes: 'Annual ~200 kg wool per herd unit; concentrated in spring.',
  },
  {
    id: 'milk_dairy',
    // Cattle are PRESENT in the dairy and provide a milk flow; milking
    // does not consume the herd. See shear_wool above.
    requires: { 'livestock.cattle': 0.005 },
    labor: { dairy_worker: 1 },
    building: 'dairy',
    outputs: { 'food.cheese': 8 },
    notes: 'Milk → cheese in one step (raw milk not separately tracked in v1).',
  },
  {
    id: 'slaughter_for_meat_and_hides',
    inputs: { 'livestock.cattle': 0.02, 'mineral.salt': 2 },
    labor: { dairy_worker: 0.5 },
    building: 'dairy',
    outputs: { 'food.salted_meat': 60, 'material.hides': 3 },
    notes:
      'One slaughter event yields salted meat + hides. Modeled here on cattle; analog applies to other livestock.',
  },

  // --- Extraction ---
  {
    id: 'fell_timber',
    inputs: { 'goods.tools': 0.05 },
    labor: { forester: 1 },
    building: 'forester_camp',
    // Realistic: a Roman forester crew yields ~1.5 cords/day. The wood
    // chain is now load-bearing on multi-building forester operations
    // and inter-settlement trade circulating wood from forester villages
    // to charcoal/baker hubs (per docs/06 caravan re-routing).
    outputs: { 'material.wood': 1.5 },
    notes: 'One cord every ~16 hours of effort, scaled per-crew at v1.',
  },
  {
    id: 'quarry_stone',
    inputs: { 'goods.tools': 0.1 },
    labor: { quarryman: 1 },
    building: 'quarry',
    outputs: { 'material.stone': 1.2 },
  },
  {
    id: 'dig_clay',
    inputs: { 'goods.tools': 0.05 },
    labor: { quarryman: 1 },
    building: 'quarry',
    outputs: { 'material.clay': 5 },
  },
  {
    id: 'mine_iron',
    inputs: { 'goods.tools': 0.1 },
    labor: { miner: 1 },
    building: 'mine',
    outputs: { 'mineral.iron_ore': 4 },
  },
  {
    id: 'mine_copper',
    inputs: { 'goods.tools': 0.1 },
    labor: { miner: 1 },
    building: 'mine',
    outputs: { 'mineral.copper_ore': 3 },
  },
  {
    id: 'mine_tin',
    inputs: { 'goods.tools': 0.1 },
    labor: { miner: 1 },
    building: 'mine',
    outputs: { 'mineral.tin_ore': 1.5 },
  },
  {
    id: 'mine_lead',
    inputs: { 'goods.tools': 0.1 },
    labor: { miner: 1 },
    building: 'mine',
    outputs: { 'mineral.lead_ore': 3 },
  },
  {
    id: 'mine_silver',
    inputs: { 'goods.tools': 0.1 },
    labor: { miner: 1 },
    building: 'mine',
    outputs: { 'mineral.silver_ore': 0.6 },
  },
  {
    id: 'mine_gold',
    inputs: { 'goods.tools': 0.1 },
    labor: { miner: 1 },
    building: 'mine',
    outputs: { 'mineral.gold_ore': 0.1 },
  },
  {
    id: 'evaporate_salt',
    inputs: NOMINAL_INPUT,
    labor: { salt_worker: 1 },
    building: 'mine',
    outputs: { 'mineral.salt': 8 },
    seasonalMultiplier: { spring: 0.5, summer: 1, autumn: 0.5, winter: 0 },
    notes: 'Coastal pans; sun-driven, summer-dominated.',
  },
  {
    id: 'mine_salt',
    inputs: { 'goods.tools': 0.1 },
    labor: { salt_worker: 1 },
    building: 'mine',
    outputs: { 'mineral.salt': 6 },
  },
  {
    id: 'fish_river',
    inputs: { 'goods.tools': 0.02 },
    labor: { fisher: 1 },
    building: 'fishery',
    outputs: { 'food.fish': 6 },
  },
  {
    id: 'fish_lake',
    inputs: { 'goods.tools': 0.02 },
    labor: { fisher: 1 },
    building: 'fishery',
    outputs: { 'food.fish': 8 },
  },
  {
    id: 'fish_coast',
    inputs: { 'goods.tools': 0.02 },
    labor: { fisher: 1 },
    building: 'fishery',
    outputs: { 'food.fish': 10 },
  },
  {
    id: 'hunt_game',
    inputs: { 'goods.tools': 0.02 },
    labor: { hunter: 1 },
    building: 'forester_camp',
    outputs: { 'food.game': 4, 'material.hides': 0.3 },
  },
  {
    id: 'gather_oak_bark',
    inputs: NOMINAL_INPUT,
    labor: { forester: 0.5 },
    building: 'forester_camp',
    outputs: { 'material.wood': 0.2 },
    notes: 'Bark for tanning; modeled as a small wood-equivalent yield in v1.',
  },

  // --- Refining ---
  {
    id: 'mill_grain',
    inputs: { 'food.grain': 50 },
    labor: { miller: 1 },
    building: 'mill',
    outputs: { 'food.flour': 45 },
    notes: 'docs/03 worked example. ~10% loss to bran.',
  },
  {
    id: 'bake_bread',
    // A baker burns ~5 kg of oven fuel per day; we now restore the
    // realistic ratio so bakeries are real wood consumers (and the
    // forester/charcoal chain is genuinely load-bearing for the food
    // chain, per docs/03 worked example).
    inputs: { 'food.flour': 30, 'material.wood': 5 },
    labor: { baker: 1 },
    building: 'bakery',
    outputs: { 'food.bread': 40 },
    notes: 'Wood ~5 kg/day per baker (oven fuel). docs/03 worked example.',
  },
  {
    id: 'press_olives',
    inputs: { 'food.olives': 300, 'material.amphora': 5 },
    labor: { presser: 1 },
    building: 'oil_press',
    outputs: { 'food.olive_oil': 60 },
    seasonalMultiplier: { spring: 0, summer: 0, autumn: 1, winter: 0 },
    notes: 'docs/03 worked example. Autumn only.',
  },
  {
    id: 'make_wine',
    inputs: { 'food.grapes': 200, 'material.amphora': 4 },
    labor: { vintner: 1 },
    building: 'winery',
    outputs: { 'food.wine': 50 },
    seasonalMultiplier: { spring: 0, summer: 0, autumn: 1, winter: 0.2 },
  },
  {
    id: 'make_cheese',
    inputs: { 'mineral.salt': 0.5 },
    labor: { dairy_worker: 1 },
    building: 'dairy',
    outputs: { 'food.cheese': 6 },
    notes: 'Implicit milk supply through dairy + livestock; salt explicit.',
  },
  {
    id: 'salt_fish',
    inputs: { 'food.fish': 20, 'mineral.salt': 2 },
    labor: { fisher: 0.5 },
    building: 'fishery',
    outputs: { 'food.salted_fish': 18 },
  },
  {
    id: 'salt_meat',
    inputs: { 'food.game': 20, 'mineral.salt': 2 },
    labor: { hunter: 0.5 },
    building: 'fishery',
    outputs: { 'food.salted_meat': 18 },
    notes: 'Reuses fishery for v1; a butchery building can be added later.',
  },
  {
    id: 'ret_flax',
    inputs: { 'material.flax': 20 },
    labor: { weaver: 0.5 },
    building: 'tannery',
    outputs: { 'material.linen_fiber': 8 },
  },
  {
    id: 'tan_leather',
    inputs: { 'material.hides': 4, 'material.wood': 1 },
    labor: { tanner: 1 },
    building: 'tannery',
    outputs: { 'material.leather': 3 },
    notes: 'Oak-bark tanning takes weeks; modeled here as one-step daily flow.',
  },
  {
    id: 'burn_charcoal',
    // Historical: ~5 kg of wood yields ~1 kg of charcoal in a clamp burn.
    // We model 4 wood → 1 charcoal as a slightly generous Roman-era
    // production rate (closer to industrial-era kilns). The forester /
    // sawmill chain has to keep up.
    inputs: { 'material.wood': 4 },
    labor: { collier: 1 },
    building: 'charcoal_kiln',
    outputs: { 'material.charcoal': 1 },
    notes: 'Historical: clamp-burned charcoal at ~4-5 kg wood per kg charcoal.',
  },
  {
    id: 'saw_lumber',
    inputs: { 'material.wood': 2 },
    labor: { sawyer: 1 },
    building: 'sawmill',
    outputs: { 'material.lumber': 1.4 },
  },
  {
    id: 'dress_stone',
    inputs: { 'material.stone': 2, 'goods.tools': 0.1 },
    labor: { mason: 1 },
    building: 'quarry',
    outputs: { 'material.cut_stone': 1 },
  },
  {
    id: 'fire_bricks',
    inputs: { 'material.clay': 6, 'material.wood': 1 },
    labor: { brickmaker: 1 },
    building: 'kiln',
    outputs: { 'material.brick_tile': 3 },
  },
  {
    id: 'throw_pottery',
    inputs: { 'material.clay': 2, 'material.wood': 0.5 },
    labor: { potter: 1 },
    building: 'pottery',
    outputs: { 'material.pottery': 4 },
  },
  {
    id: 'throw_amphorae',
    inputs: { 'material.clay': 3, 'material.wood': 0.5 },
    labor: { potter: 1 },
    building: 'pottery',
    outputs: { 'material.amphora': 3 },
  },
  {
    id: 'smelt_iron',
    // Historical Roman bloomery: ~3-5 kg ore + ~6-10 kg charcoal yields
    // 1 kg of bloom iron (after slag loss). docs/03 worked example uses
    // a per-recipe-instance scale of 60 ore + 100 charcoal → 15 iron
    // (one bloomery-day at ~15 kg of usable bloom). Bloomery is genuinely
    // charcoal-heavy: each smelt draws ~7× its iron weight in fuel, so
    // the charcoal kiln + forester chain has to keep up.
    inputs: { 'mineral.iron_ore': 60, 'material.charcoal': 100 },
    labor: { smelter: 1 },
    building: 'bloomery',
    outputs: { 'metal.iron': 15 },
    notes:
      'Roman bloomery: ~60 kg ore + ~100 kg charcoal → ~15 kg bloom iron per smelter-day (docs/03 worked example).',
  },
  {
    id: 'alloy_bronze',
    inputs: { 'mineral.copper_ore': 40, 'mineral.tin_ore': 5, 'material.charcoal': 60 },
    labor: { smelter: 1 },
    building: 'bloomery',
    outputs: { 'metal.bronze': 12 },
  },
  {
    id: 'smelt_lead',
    inputs: { 'mineral.lead_ore': 50, 'material.charcoal': 30 },
    labor: { smelter: 1 },
    building: 'bloomery',
    outputs: { 'metal.lead': 30 },
  },
  {
    id: 'cupel_silver',
    inputs: { 'mineral.silver_ore': 30, 'metal.lead': 5, 'material.charcoal': 40 },
    labor: { smelter: 1 },
    building: 'bloomery',
    outputs: { 'metal.silver': 0.6 },
    notes: 'Lead-cupellation: silver ore + lead → bullion.',
  },
  {
    id: 'refine_gold',
    inputs: { 'mineral.gold_ore': 5, 'material.charcoal': 10 },
    labor: { smelter: 1 },
    building: 'bloomery',
    outputs: { 'metal.gold': 0.05 },
  },

  // --- Manufacture ---
  {
    id: 'weave_cloth',
    inputs: { 'material.wool': 4 },
    labor: { weaver: 1 },
    building: 'weaver_workshop',
    outputs: { 'goods.cloth': 1 },
    notes: 'Wool path; linen alternative would consume material.linen_fiber instead.',
  },
  {
    id: 'tailor_clothing',
    inputs: { 'goods.cloth': 1 },
    labor: { tailor: 1 },
    building: 'tailor_shop',
    outputs: { 'goods.clothing': 2 },
  },
  {
    id: 'forge_tools',
    inputs: { 'metal.iron': 5, 'material.lumber': 2, 'material.charcoal': 3 },
    labor: { smith: 1 },
    building: 'smithy',
    outputs: { 'goods.tools': 15 },
    notes: 'docs/03 worked example.',
  },
  {
    id: 'forge_weapons',
    inputs: { 'metal.iron': 4, 'material.lumber': 2, 'material.charcoal': 3 },
    labor: { smith: 1 },
    building: 'smithy',
    outputs: { 'goods.weapons': 6 },
  },
  {
    id: 'forge_armor',
    inputs: { 'metal.iron': 6, 'material.leather': 2, 'material.charcoal': 4 },
    labor: { smith: 1 },
    building: 'smithy',
    outputs: { 'goods.armor': 1 },
  },
  {
    id: 'make_shields',
    inputs: { 'material.lumber': 3, 'material.leather': 1, 'metal.bronze': 0.5 },
    labor: { carpenter: 1 },
    building: 'smithy',
    outputs: { 'goods.shields': 4 },
  },
  {
    id: 'build_cart',
    inputs: { 'material.lumber': 8, 'metal.iron': 2, 'material.leather': 1 },
    labor: { wright: 1 },
    building: 'cart_wright',
    outputs: { 'goods.cart': 0.05 },
    notes: 'A cart takes weeks of one wright; modeled as 0.05/day.',
  },
  {
    id: 'make_furniture',
    inputs: { 'material.lumber': 3 },
    labor: { carpenter: 1 },
    building: 'cart_wright',
    outputs: { 'goods.furniture': 1 },
  },
  {
    id: 'weave_luxury',
    inputs: { 'goods.cloth': 1, 'exotic.dyes': 0.2 },
    labor: { weaver: 1 },
    building: 'weaver_workshop',
    outputs: { 'goods.luxury_textiles': 0.5 },
    notes: 'Dyed, finely woven; requires exotic dyes.',
  },
  {
    id: 'mint_coin',
    inputs: { 'metal.silver': 0.4 },
    labor: { minter: 1 },
    building: 'mint',
    outputs: { 'goods.coin': 100 },
    notes: '~100 denarii / day per minter; ~3.9 g silver per denarius.',
  },
];

const freezeMap = <K, V>(m: Map<K, V>): ReadonlyMap<K, V> => {
  const denied = (op: string): never => {
    throw new Error(`Recipe map is read-only (${op})`);
  };
  m.set = (): never => denied('set');
  m.delete = (): never => denied('delete');
  m.clear = (): never => denied('clear');
  return m;
};

const buildCatalog = (): ReadonlyMap<RecipeId, RecipeDef> => {
  const map = new Map<RecipeId, RecipeDef>();
  for (const input of DEFS) {
    const id = recipeId(input.id);
    if (map.has(id)) {
      throw new Error(`Duplicate recipe id: ${input.id}`);
    }
    const inputs = new Map<ResourceId, Quantity>();
    for (const [resKey, qty] of Object.entries(input.inputs ?? {})) {
      inputs.set(resourceId(resKey), qty);
    }
    const requires = new Map<ResourceId, Quantity>();
    for (const [resKey, qty] of Object.entries(input.requires ?? {})) {
      requires.set(resourceId(resKey), qty);
    }
    const labor = new Map<JobId, number>();
    for (const [jobKey, wd] of Object.entries(input.labor)) {
      labor.set(jobId(jobKey), wd);
    }
    const outputs = new Map<ResourceId, Quantity>();
    for (const [resKey, qty] of Object.entries(input.outputs)) {
      outputs.set(resourceId(resKey), qty);
    }
    const def: RecipeDef = Object.freeze({
      id,
      inputs: freezeMap(inputs),
      requires: freezeMap(requires),
      labor: freezeMap(labor),
      building: buildingId(input.building),
      outputs: freezeMap(outputs),
      ...(input.seasonalMultiplier !== undefined
        ? { seasonalMultiplier: Object.freeze({ ...input.seasonalMultiplier }) }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    map.set(id, def);
  }
  return map;
};

export const RECIPES: ReadonlyMap<RecipeId, RecipeDef> = buildCatalog();

const ALL_RECIPES: readonly RecipeDef[] = Object.freeze(Array.from(RECIPES.values()));

export const allRecipes = (): readonly RecipeDef[] => ALL_RECIPES;

export const getRecipe = (id: RecipeId): RecipeDef => {
  const def = RECIPES.get(id);
  if (def === undefined) {
    throw new Error(`Unknown recipe id: ${String(id)}`);
  }
  return def;
};

const buildOutputIndex = (): ReadonlyMap<ResourceId, readonly RecipeDef[]> => {
  const idx = new Map<ResourceId, RecipeDef[]>();
  for (const r of ALL_RECIPES) {
    for (const resId of r.outputs.keys()) {
      const list = idx.get(resId);
      if (list === undefined) {
        idx.set(resId, [r]);
      } else {
        list.push(r);
      }
    }
  }
  const frozen = new Map<ResourceId, readonly RecipeDef[]>();
  for (const [k, v] of idx) {
    frozen.set(k, Object.freeze(v));
  }
  return frozen;
};

const buildInputIndex = (): ReadonlyMap<ResourceId, readonly RecipeDef[]> => {
  const idx = new Map<ResourceId, RecipeDef[]>();
  for (const r of ALL_RECIPES) {
    for (const resId of r.inputs.keys()) {
      const list = idx.get(resId);
      if (list === undefined) {
        idx.set(resId, [r]);
      } else {
        list.push(r);
      }
    }
  }
  const frozen = new Map<ResourceId, readonly RecipeDef[]>();
  for (const [k, v] of idx) {
    frozen.set(k, Object.freeze(v));
  }
  return frozen;
};

const OUTPUT_INDEX = buildOutputIndex();
const INPUT_INDEX = buildInputIndex();
const EMPTY: readonly RecipeDef[] = Object.freeze([]);

export const recipesByOutput = (resource: ResourceId): readonly RecipeDef[] =>
  OUTPUT_INDEX.get(resource) ?? EMPTY;

export const recipesByInput = (resource: ResourceId): readonly RecipeDef[] =>
  INPUT_INDEX.get(resource) ?? EMPTY;
