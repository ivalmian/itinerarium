/**
 * Typed registry of every resource in the game.
 *
 * The full enumeration and tier/category model live in docs/02-resources.md.
 * Tier 0 = raw extraction, 1 = refined, 2 = manufactured (incl. exotic
 * imports — modeled here as tier 2 with category 'exotic'), 3 = institutional.
 *
 * Weight is per game unit. Units are intentionally documented per resource
 * here rather than per-recipe; for grain a unit is one modius (~6.7 kg dry),
 * for cloth a bolt, for livestock a herd unit, etc. The numbers are coarse
 * historical sanity checks, not precise loads — recipes and trade economics
 * tune the actual production/consumption rates.
 */

import { resourceId, type ResourceId } from '../types.js';

export type ResourceTier = 0 | 1 | 2 | 3;

export type ResourceCategory =
  | 'food'
  | 'material'
  | 'livestock'
  | 'mineral'
  | 'metal'
  | 'goods'
  | 'exotic'
  | 'people'
  | 'service';

export interface ResourceDef {
  readonly id: ResourceId;
  readonly tier: ResourceTier;
  readonly category: ResourceCategory;
  readonly name: string;
  readonly weightKgPerUnit: number;
  readonly perishableDays?: number;
  readonly notes?: string;
}

interface ResourceInput {
  readonly id: string;
  readonly tier: ResourceTier;
  readonly category: ResourceCategory;
  readonly name: string;
  readonly weightKgPerUnit: number;
  readonly perishableDays?: number;
  readonly notes?: string;
}

const DEFS: readonly ResourceInput[] = [
  // Tier 0 — raw materials (extracted from terrain).
  {
    id: 'food.grain',
    tier: 0,
    category: 'food',
    name: 'Grain',
    weightKgPerUnit: 6.7,
    notes: 'Modius of wheat/barley/spelt. Subsistence backbone.',
  },
  {
    id: 'food.olives',
    tier: 0,
    category: 'food',
    name: 'Olives',
    weightKgPerUnit: 25,
    perishableDays: 14,
    notes: 'Annual autumn harvest. Pressed for oil within weeks.',
  },
  {
    id: 'food.grapes',
    tier: 0,
    category: 'food',
    name: 'Grapes',
    weightKgPerUnit: 25,
    perishableDays: 7,
    notes: 'Annual autumn harvest. Mostly pressed for wine immediately.',
  },
  {
    id: 'food.fish',
    tier: 0,
    category: 'food',
    name: 'Fresh fish',
    weightKgPerUnit: 10,
    perishableDays: 2,
    notes: 'Continuous catch. Salted for trade; fresh stays local.',
  },
  {
    id: 'food.game',
    tier: 0,
    category: 'food',
    name: 'Game meat',
    weightKgPerUnit: 10,
    perishableDays: 3,
    notes: 'Hunted in forests/hills. Marginal subsistence supply.',
  },
  {
    id: 'food.legumes',
    tier: 0,
    category: 'food',
    name: 'Legumes',
    weightKgPerUnit: 6.7,
    notes: 'Beans/lentils/peas. Rotation partner with grain.',
  },
  {
    id: 'livestock.sheep',
    tier: 0,
    category: 'livestock',
    name: 'Sheep (herd unit)',
    weightKgPerUnit: 1500,
    notes: 'Herd unit ≈ 30 head. Wool, milk, meat, hide.',
  },
  {
    id: 'livestock.cattle',
    tier: 0,
    category: 'livestock',
    name: 'Cattle (herd unit)',
    weightKgPerUnit: 4500,
    notes: 'Herd unit ≈ 10 head. Meat, milk, hide, draft.',
  },
  {
    id: 'livestock.pigs',
    tier: 0,
    category: 'livestock',
    name: 'Pigs (herd unit)',
    weightKgPerUnit: 1200,
    notes: 'Herd unit ≈ 12 head. Meat; eat scraps.',
  },
  {
    id: 'livestock.equines',
    tier: 0,
    category: 'livestock',
    name: 'Equines (herd unit)',
    weightKgPerUnit: 2400,
    notes: 'Herd unit ≈ 6 horses/mules/donkeys. Caravan + military.',
  },
  {
    id: 'material.wood',
    tier: 0,
    category: 'material',
    name: 'Raw wood',
    weightKgPerUnit: 700,
    notes: 'One cord of green wood. Renewable but depletable.',
  },
  {
    id: 'material.stone',
    tier: 0,
    category: 'material',
    name: 'Quarry stone',
    weightKgPerUnit: 1500,
    notes: 'Rough block. Effectively infinite per deposit.',
  },
  {
    id: 'material.clay',
    tier: 0,
    category: 'material',
    name: 'Clay',
    weightKgPerUnit: 100,
    notes: 'Riverbank clay. Effectively infinite.',
  },
  {
    id: 'material.flax',
    tier: 0,
    category: 'material',
    name: 'Flax',
    weightKgPerUnit: 50,
    notes: 'Annual; produces fiber and linseed oil.',
  },
  {
    id: 'material.hides',
    tier: 0,
    category: 'material',
    name: 'Raw hides',
    weightKgPerUnit: 12,
    perishableDays: 5,
    notes: 'Co-output of slaughter. Spoils unless tanned.',
  },
  {
    id: 'mineral.iron_ore',
    tier: 0,
    category: 'mineral',
    name: 'Iron ore',
    weightKgPerUnit: 50,
    notes: 'Finite deposit per hex. Heavy; smelted near mine.',
  },
  {
    id: 'mineral.copper_ore',
    tier: 0,
    category: 'mineral',
    name: 'Copper ore',
    weightKgPerUnit: 50,
    notes: 'Finite. Smelted to metal.copper-equivalent (metal.bronze input).',
  },
  {
    id: 'mineral.tin_ore',
    tier: 0,
    category: 'mineral',
    name: 'Tin ore',
    weightKgPerUnit: 50,
    notes: 'Rare. Strategic — needed for bronze.',
  },
  {
    id: 'mineral.lead_ore',
    tier: 0,
    category: 'mineral',
    name: 'Lead ore',
    weightKgPerUnit: 50,
    notes: 'Often co-located with silver.',
  },
  {
    id: 'mineral.silver_ore',
    tier: 0,
    category: 'mineral',
    name: 'Silver ore',
    weightKgPerUnit: 50,
    notes: 'Coinage + luxury input.',
  },
  {
    id: 'mineral.gold_ore',
    tier: 0,
    category: 'mineral',
    name: 'Gold ore',
    weightKgPerUnit: 50,
    notes: 'Rare mountain/river hexes. Coinage + status.',
  },
  {
    id: 'mineral.salt',
    tier: 0,
    category: 'mineral',
    name: 'Salt',
    weightKgPerUnit: 25,
    notes: 'Coastal pans / mines. Essential for preservation.',
  },

  // Tier 1 — refined / processed.
  {
    id: 'food.flour',
    tier: 1,
    category: 'food',
    name: 'Flour',
    weightKgPerUnit: 25,
    perishableDays: 120,
    notes: 'Sack. Shelf life of months if dry.',
  },
  {
    id: 'food.bread',
    tier: 1,
    category: 'food',
    name: 'Bread',
    weightKgPerUnit: 1,
    perishableDays: 4,
    notes: 'A loaf. Spoils in days; produced where consumed.',
  },
  {
    id: 'food.olive_oil',
    tier: 1,
    category: 'food',
    name: 'Olive oil',
    weightKgPerUnit: 26,
    notes: 'Amphora ≈ 26 L. Cooking, lighting, soap.',
  },
  {
    id: 'food.wine',
    tier: 1,
    category: 'food',
    name: 'Wine',
    weightKgPerUnit: 26,
    notes: 'Amphora ≈ 26 L. Improves over years; major trade good.',
  },
  {
    id: 'food.milk',
    tier: 0,
    category: 'food',
    name: 'Raw milk',
    weightKgPerUnit: 1,
    perishableDays: 2,
    notes: 'Daily output of dairy herds. Short shelf life — typically processed into cheese same day or sold to a neighboring town. Per docs/15 §C12.',
  },
  {
    id: 'food.cheese',
    tier: 1,
    category: 'food',
    name: 'Cheese',
    weightKgPerUnit: 5,
    perishableDays: 90,
    notes: 'Wheel. Stores well, especially hard cheese.',
  },
  {
    id: 'food.salted_fish',
    tier: 1,
    category: 'food',
    name: 'Salted fish',
    weightKgPerUnit: 10,
    perishableDays: 180,
    notes: 'Cask. Stores months; major Roman trade good.',
  },
  {
    id: 'food.salted_meat',
    tier: 1,
    category: 'food',
    name: 'Salted meat',
    weightKgPerUnit: 10,
    perishableDays: 180,
    notes: 'Cask. Stores months.',
  },
  {
    id: 'material.wool',
    tier: 1,
    category: 'material',
    name: 'Wool',
    weightKgPerUnit: 10,
    notes: 'Fleece bundle. Annual yield per herd unit.',
  },
  {
    id: 'material.linen_fiber',
    tier: 1,
    category: 'material',
    name: 'Linen fiber',
    weightKgPerUnit: 10,
    notes: 'Retted flax fiber. Linen textile input.',
  },
  {
    id: 'material.leather',
    tier: 1,
    category: 'material',
    name: 'Leather',
    weightKgPerUnit: 8,
    notes: 'Tanned hide. Tanning takes turns to complete.',
  },
  {
    id: 'material.charcoal',
    tier: 1,
    category: 'material',
    name: 'Charcoal',
    weightKgPerUnit: 30,
    notes: 'Sack. Required for smelting; wood-intensive.',
  },
  {
    id: 'material.lumber',
    tier: 1,
    category: 'material',
    name: 'Lumber',
    weightKgPerUnit: 500,
    notes: 'Sawn timber stack. Building material.',
  },
  {
    id: 'material.cut_stone',
    tier: 1,
    category: 'material',
    name: 'Cut stone',
    weightKgPerUnit: 1500,
    notes: 'Dressed block. Construction.',
  },
  {
    id: 'material.brick_tile',
    tier: 1,
    category: 'material',
    name: 'Brick & tile',
    weightKgPerUnit: 200,
    notes: 'Pallet. Construction.',
  },
  {
    id: 'material.pottery',
    tier: 1,
    category: 'material',
    name: 'Pottery',
    weightKgPerUnit: 15,
    notes: 'Crate of ware. Storage and daily use.',
  },
  {
    id: 'material.amphora',
    tier: 1,
    category: 'material',
    name: 'Amphora',
    weightKgPerUnit: 30,
    notes: 'Empty vessel. Required to ship liquids.',
  },
  {
    id: 'metal.iron',
    tier: 1,
    category: 'metal',
    name: 'Iron bar',
    weightKgPerUnit: 25,
    notes: 'Bar stock. Smith input.',
  },
  {
    id: 'metal.copper',
    tier: 1,
    category: 'metal',
    name: 'Copper ingot',
    weightKgPerUnit: 25,
    notes: 'Smelted from copper ore. Bronze precursor + plumbing/wire. Per docs/15 §C13.',
  },
  {
    id: 'metal.tin',
    tier: 1,
    category: 'metal',
    name: 'Tin ingot',
    weightKgPerUnit: 25,
    notes: 'Smelted from tin ore. Scarce — bronze precursor. Per docs/15 §C13.',
  },
  {
    id: 'metal.bronze',
    tier: 1,
    category: 'metal',
    name: 'Bronze bar',
    weightKgPerUnit: 25,
    notes: 'Bar stock. Fittings, decorative work.',
  },
  {
    id: 'metal.lead',
    tier: 1,
    category: 'metal',
    name: 'Lead pig',
    weightKgPerUnit: 30,
    notes: 'Pig. Plumbing, weights, sling bullets.',
  },
  {
    id: 'metal.silver',
    tier: 1,
    category: 'metal',
    name: 'Silver bar',
    weightKgPerUnit: 5,
    notes: 'Bar stock. Coinage and plate.',
  },
  {
    id: 'metal.gold',
    tier: 1,
    category: 'metal',
    name: 'Gold bar',
    weightKgPerUnit: 1,
    notes: 'Small bar. Coinage and status.',
  },

  // Tier 2 — manufactured goods.
  {
    id: 'goods.cloth',
    tier: 2,
    category: 'goods',
    name: 'Cloth',
    weightKgPerUnit: 5,
    notes: 'Bolt of fabric. Wool or linen input.',
  },
  {
    id: 'goods.clothing',
    tier: 2,
    category: 'goods',
    name: 'Clothing',
    weightKgPerUnit: 2,
    notes: 'Set. Wears out at population consumption rate.',
  },
  {
    id: 'goods.tools',
    tier: 2,
    category: 'goods',
    name: 'Tools',
    weightKgPerUnit: 8,
    notes: 'Required input for most production jobs. Wear out.',
  },
  // --- Weapons (per docs/02 Tier 2 + docs/03 weapon archetypes) ---
  // Roman archetype split. Each weapon is its own resource so the
  // production chain, military procurement, and combat math can all
  // address specific kit instead of a generic "weapons" placeholder.
  {
    id: 'goods.gladius',
    tier: 2,
    category: 'goods',
    name: 'Gladius',
    weightKgPerUnit: 2,
    notes: 'Roman short sword. Primary infantry melee weapon.',
  },
  {
    id: 'goods.hasta',
    tier: 2,
    category: 'goods',
    name: 'Hasta',
    weightKgPerUnit: 3,
    notes: 'Thrusting spear. Cheaper alternative melee weapon.',
  },
  {
    id: 'goods.pilum',
    tier: 2,
    category: 'goods',
    name: 'Pilum',
    weightKgPerUnit: 4,
    notes: 'Heavy throwing javelin. Issued in pairs to a soldier.',
  },
  {
    id: 'goods.dagger',
    tier: 2,
    category: 'goods',
    name: 'Dagger',
    weightKgPerUnit: 0.5,
    notes: 'Pugio short blade. Sidearm / utility weapon.',
  },
  {
    id: 'goods.bow',
    tier: 2,
    category: 'goods',
    name: 'Bow',
    weightKgPerUnit: 1,
    notes: 'Composite or self bow. Ranged weapon.',
  },
  {
    id: 'goods.arrow',
    tier: 2,
    category: 'goods',
    name: 'Arrow',
    weightKgPerUnit: 0.05,
    notes: 'Ammunition for bows. Issued in quivers of ~30.',
  },
  {
    id: 'goods.sling',
    tier: 2,
    category: 'goods',
    name: 'Sling',
    weightKgPerUnit: 0.2,
    notes: 'Strap-and-pouch ranged weapon. Cheap.',
  },
  {
    id: 'goods.sling_bullet',
    tier: 2,
    category: 'goods',
    name: 'Sling bullet',
    weightKgPerUnit: 0.04,
    notes: 'Cast lead glandes (~40 g each). Bundles of ~50.',
  },
  {
    id: 'goods.helmet',
    tier: 2,
    category: 'goods',
    name: 'Helmet',
    weightKgPerUnit: 2,
    notes: 'Galea. Single-piece head protection.',
  },
  {
    id: 'goods.body_armor',
    tier: 2,
    category: 'goods',
    name: 'Body armor',
    weightKgPerUnit: 10,
    notes: 'Lorica (mail or scale shirt). Trunk protection.',
  },
  {
    id: 'goods.shield',
    tier: 2,
    category: 'goods',
    name: 'Shield',
    weightKgPerUnit: 6,
    notes: 'Scutum or parma. Single-handed defense.',
  },
  {
    id: 'goods.cart',
    tier: 2,
    category: 'goods',
    name: 'Cart',
    weightKgPerUnit: 200,
    notes: 'Caravan capacity unit. Wears out.',
  },
  {
    id: 'goods.furniture',
    tier: 2,
    category: 'goods',
    name: 'Furniture',
    weightKgPerUnit: 30,
    notes: 'Comfort/status good.',
  },
  {
    id: 'goods.luxury_textiles',
    tier: 2,
    category: 'goods',
    name: 'Luxury textiles',
    weightKgPerUnit: 3,
    notes: 'Dyed, finely woven. Elite demand.',
  },
  {
    id: 'goods.coin',
    tier: 2,
    category: 'goods',
    name: 'Coin',
    weightKgPerUnit: 0.005,
    notes: 'A single denarius (~3.9 g silver). Treated as a goods unit for transport math.',
  },

  // Tier 2b — exotic imports (modeled as tier 2, category 'exotic').
  {
    id: 'exotic.spices',
    tier: 2,
    category: 'exotic',
    name: 'Spices',
    weightKgPerUnit: 1,
    notes: 'Pepper, cinnamon, etc. Status + comfort demand.',
  },
  {
    id: 'exotic.silk',
    tier: 2,
    category: 'exotic',
    name: 'Silk',
    weightKgPerUnit: 1,
    notes: 'Pure status good. Bolt or finished cloth.',
  },
  {
    id: 'exotic.incense',
    tier: 2,
    category: 'exotic',
    name: 'Incense',
    weightKgPerUnit: 1,
    notes: 'Religious + status use.',
  },
  {
    id: 'exotic.dyes',
    tier: 2,
    category: 'exotic',
    name: 'Exotic dyes',
    weightKgPerUnit: 1,
    notes: 'Murex purple, indigo. Input for goods.luxury_textiles.',
  },

  // Tier 2c — people as cargo. Modeled as tier 2 because they're transported
  // alongside other manufactured/exotic cargo, but flagged via category 'people'.
  {
    id: 'people.slave',
    tier: 2,
    category: 'people',
    name: 'Enslaved person',
    weightKgPerUnit: 70,
    notes: 'Walks under guard rather than being carted; consumes rations.',
  },
  {
    id: 'people.migrants',
    tier: 2,
    category: 'people',
    name: 'Migrant',
    weightKgPerUnit: 70,
    notes: 'Free person relocating with their belongings; same physics as slave.',
  },

  // Tier 3 — institutional outputs (standing capacities, not cargo).
  {
    id: 'service.garrison',
    tier: 3,
    category: 'service',
    name: 'Garrison',
    weightKgPerUnit: 1,
    notes: 'Capacity unit ≈ one century-equivalent. Suppresses banditry, defends raids.',
  },
  {
    id: 'service.administration',
    tier: 3,
    category: 'service',
    name: 'Administration',
    weightKgPerUnit: 1,
    notes: 'Capacity unit. Enables taxation, edicts, public works.',
  },
  {
    id: 'service.priesthood',
    tier: 3,
    category: 'service',
    name: 'Priesthood',
    weightKgPerUnit: 1,
    notes: 'Capacity unit. Festivals shift demand; population happiness.',
  },
  {
    id: 'service.public_works',
    tier: 3,
    category: 'service',
    name: 'Public works',
    weightKgPerUnit: 1,
    notes: 'Accumulated capacity. Roads, aqueducts, walls.',
  },
];

const buildCatalog = (): ReadonlyMap<ResourceId, ResourceDef> => {
  const map = new Map<ResourceId, ResourceDef>();
  for (const input of DEFS) {
    const id = resourceId(input.id);
    if (map.has(id)) {
      throw new Error(`Duplicate resource id: ${input.id}`);
    }
    const def: ResourceDef = Object.freeze({
      id,
      tier: input.tier,
      category: input.category,
      name: input.name,
      weightKgPerUnit: input.weightKgPerUnit,
      ...(input.perishableDays !== undefined ? { perishableDays: input.perishableDays } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    map.set(id, def);
  }
  return map;
};

export const RESOURCES: ReadonlyMap<ResourceId, ResourceDef> = buildCatalog();

const ALL_RESOURCES: readonly ResourceDef[] = Object.freeze(Array.from(RESOURCES.values()));

export const allResources = (): readonly ResourceDef[] => ALL_RESOURCES;

export const getResource = (id: ResourceId): ResourceDef => {
  const def = RESOURCES.get(id);
  if (def === undefined) {
    throw new Error(`Unknown resource id: ${String(id)}`);
  }
  return def;
};
