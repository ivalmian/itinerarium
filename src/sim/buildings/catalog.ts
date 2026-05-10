/**
 * Typed registry of every building type in the game.
 *
 * Source: docs/05-settlements.md "Building catalog (v1)" plus the
 * worked production examples in docs/03-production.md. No shipyard
 * (sea trade is deferred per docs/10).
 *
 * Construction costs and maintenance are first-pass numbers — coarse
 * historical sanity, not tuned. The structure (which resources, what
 * order of magnitude) matters more than the exact figures: future
 * tuning lives in burn-in, not in this catalog.
 *
 * `capacityUnits` = recipe-instances per day at full staffing. A mill
 * with capacity 1 can consume one miller-day per day; a granary
 * (storage) carries no recipe load and uses 0 here — its real numbers
 * (volume, perishability multipliers) belong in a future storage
 * subsystem.
 */

import type { Quantity, ResourceId } from '../types.js';
import { buildingId, resourceId, type BuildingId } from '../types.js';

export type BuildingCategory = 'production' | 'storage' | 'civic' | 'military' | 'infrastructure';

export interface BuildingDef {
  readonly id: BuildingId;
  readonly category: BuildingCategory;
  readonly name: string;
  readonly capacityUnits: number;
  readonly constructionCost: ReadonlyMap<ResourceId, Quantity>;
  readonly maintenancePerDay: ReadonlyMap<ResourceId, Quantity>;
  readonly decayDaysIfUnmaintained: number;
  readonly notes?: string;
}

interface BuildingInput {
  readonly id: string;
  readonly category: BuildingCategory;
  readonly name: string;
  readonly capacityUnits: number;
  readonly constructionCost: Readonly<Record<string, Quantity>>;
  readonly maintenancePerDay?: Readonly<Record<string, Quantity>>;
  readonly decayDaysIfUnmaintained: number;
  readonly notes?: string;
}

// Construction-cost shorthand. All quantities are in the units declared
// in src/sim/resources/catalog.ts (modius for grain, sack for flour, bolt
// for cloth, etc).
const DEFS: readonly BuildingInput[] = [
  // --- Production: agriculture & extraction ---
  {
    id: 'farm',
    category: 'production',
    name: 'Farm',
    // 50 = enough farmer-days to feed a small village. A village of 500
    // needs ~25 modii/day; harvest_grain at autumn 80 modii/instance →
    // 5 instances cover a village; full 50-cap supports a small city.
    // Larger settlements need multiple farms (seedWorld Phase 9 scales).
    capacityUnits: 50,
    constructionCost: { 'material.lumber': 2, 'material.brick_tile': 4, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 365,
    notes: 'Field plus farmstead. Hosts sow/harvest/legume recipes.',
  },
  {
    id: 'pasture',
    category: 'production',
    name: 'Pasture',
    // 50 herd-units' worth of recipe-instances per day; a single pasture
    // supports significant pastoral output (wool, milk, salted meat
    // year-round — a critical winter food source per consumption priority).
    capacityUnits: 50,
    constructionCost: { 'material.lumber': 1, 'goods.tools': 1 },
    maintenancePerDay: {},
    decayDaysIfUnmaintained: 730,
    notes: 'Fenced grazing land. Hosts pastoral recipes.',
  },
  {
    id: 'vineyard',
    category: 'production',
    name: 'Vineyard',
    capacityUnits: 2,
    constructionCost: { 'material.lumber': 4, 'goods.tools': 2, 'material.stone': 2 },
    maintenancePerDay: { 'goods.tools': 0.01 },
    decayDaysIfUnmaintained: 365,
    notes: 'Vines mature over years; capacity reflects mature plot.',
  },
  {
    id: 'olive_grove',
    category: 'production',
    name: 'Olive grove',
    capacityUnits: 2,
    constructionCost: { 'material.lumber': 2, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.01 },
    decayDaysIfUnmaintained: 365,
    notes: 'Trees take years to mature.',
  },
  {
    id: 'orchard',
    category: 'production',
    name: 'Orchard',
    capacityUnits: 2,
    constructionCost: { 'material.lumber': 2, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.01 },
    decayDaysIfUnmaintained: 365,
    notes: 'Mixed fruit, including figs. v1 abstracted into food.legumes/foods.',
  },
  {
    id: 'fishery',
    category: 'production',
    name: 'Fishery',
    capacityUnits: 3,
    constructionCost: { 'material.lumber': 6, 'material.linen_fiber': 2, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Boats, nets, drying racks. Coast/river/lake hex.',
  },
  {
    id: 'mine',
    category: 'production',
    name: 'Mine',
    capacityUnits: 3,
    constructionCost: { 'material.lumber': 8, 'material.cut_stone': 2, 'goods.tools': 4 },
    maintenancePerDay: { 'material.lumber': 0.05, 'goods.tools': 0.05 },
    decayDaysIfUnmaintained: 90,
    notes: 'Shafts, props, hoist. Hosts iron/copper/tin/lead/silver/gold/salt recipes.',
  },
  {
    id: 'quarry',
    category: 'production',
    name: 'Quarry',
    capacityUnits: 3,
    constructionCost: { 'material.lumber': 2, 'goods.tools': 4 },
    maintenancePerDay: { 'goods.tools': 0.04 },
    decayDaysIfUnmaintained: 180,
    notes: 'Open pit. Hosts quarry_stone.',
  },
  {
    id: 'forester_camp',
    category: 'production',
    name: 'Forester camp',
    capacityUnits: 3,
    constructionCost: { 'material.lumber': 4, 'goods.tools': 3 },
    maintenancePerDay: { 'goods.tools': 0.03 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts fell_timber and gather_oak_bark.',
  },

  // --- Production: refining & manufacture ---
  {
    id: 'mill',
    category: 'production',
    name: 'Mill',
    // 50 = enough miller-days to convert all of one farm's grain output.
    capacityUnits: 50,
    constructionCost: { 'material.cut_stone': 8, 'material.lumber': 6, 'goods.tools': 2 },
    maintenancePerDay: { 'material.lumber': 0.05 },
    decayDaysIfUnmaintained: 180,
    notes: 'Water- or animal-powered. Hosts mill_grain.',
  },
  {
    id: 'bakery',
    category: 'production',
    name: 'Bakery',
    // 50 = enough oven-days to bake the flour of one mill.
    capacityUnits: 50,
    constructionCost: { 'material.brick_tile': 8, 'material.cut_stone': 2, 'material.lumber': 2 },
    maintenancePerDay: { 'material.brick_tile': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Oven. Hosts bake_bread; bread is consumed locally.',
  },
  {
    id: 'oil_press',
    category: 'production',
    name: 'Oil press',
    capacityUnits: 1,
    constructionCost: { 'material.cut_stone': 4, 'material.lumber': 4, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 365,
    notes: 'Seasonal — autumn pressing only.',
  },
  {
    id: 'winery',
    category: 'production',
    name: 'Winery',
    capacityUnits: 2,
    constructionCost: { 'material.cut_stone': 4, 'material.lumber': 6, 'material.amphora': 8 },
    maintenancePerDay: { 'material.amphora': 0.05 },
    decayDaysIfUnmaintained: 365,
    notes: 'Press and fermentation vessels.',
  },
  {
    id: 'dairy',
    category: 'production',
    name: 'Dairy',
    capacityUnits: 2,
    constructionCost: { 'material.lumber': 4, 'material.pottery': 4, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.01 },
    decayDaysIfUnmaintained: 180,
    notes: 'Cheese-making facility.',
  },
  {
    id: 'tannery',
    category: 'production',
    name: 'Tannery',
    capacityUnits: 2,
    constructionCost: { 'material.lumber': 4, 'material.cut_stone': 4, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Tanning pits. Smelly — usually downwind of city.',
  },
  {
    id: 'charcoal_kiln',
    category: 'production',
    name: 'Charcoal kiln',
    capacityUnits: 2,
    constructionCost: { 'material.brick_tile': 6, 'material.cut_stone': 2 },
    maintenancePerDay: { 'material.brick_tile': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts burn_charcoal.',
  },
  {
    id: 'sawmill',
    category: 'production',
    name: 'Sawmill',
    capacityUnits: 2,
    constructionCost: { 'material.lumber': 4, 'material.cut_stone': 2, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts saw_lumber.',
  },
  {
    id: 'kiln',
    category: 'production',
    name: 'Brick & tile kiln',
    capacityUnits: 2,
    constructionCost: { 'material.brick_tile': 6, 'material.cut_stone': 2 },
    maintenancePerDay: { 'material.brick_tile': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts fire_bricks.',
  },
  {
    id: 'pottery',
    category: 'production',
    name: 'Pottery workshop',
    capacityUnits: 2,
    constructionCost: { 'material.brick_tile': 4, 'material.lumber': 2, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts throw_pottery and throw_amphorae.',
  },
  {
    id: 'bloomery',
    category: 'production',
    name: 'Bloomery',
    capacityUnits: 1,
    constructionCost: { 'material.cut_stone': 6, 'material.brick_tile': 4, 'goods.tools': 2 },
    maintenancePerDay: { 'material.brick_tile': 0.05 },
    decayDaysIfUnmaintained: 90,
    notes: 'Smelts iron ore. Charcoal-heavy.',
  },
  {
    id: 'smithy',
    category: 'production',
    name: 'Smithy',
    capacityUnits: 2,
    constructionCost: { 'material.brick_tile': 4, 'material.cut_stone': 2, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.05 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts forge_tools/weapons/armor.',
  },
  {
    id: 'weaver_workshop',
    category: 'production',
    name: 'Weaver workshop',
    capacityUnits: 4,
    constructionCost: { 'material.lumber': 4, 'goods.tools': 2 },
    maintenancePerDay: { 'goods.tools': 0.02 },
    decayDaysIfUnmaintained: 365,
    notes: 'Looms. Hosts weave_cloth and weave_luxury.',
  },
  {
    id: 'tailor_shop',
    category: 'production',
    name: 'Tailor shop',
    capacityUnits: 3,
    constructionCost: { 'material.lumber': 2, 'goods.tools': 1 },
    maintenancePerDay: { 'goods.tools': 0.01 },
    decayDaysIfUnmaintained: 365,
    notes: 'Hosts tailor_clothing.',
  },
  {
    id: 'cart_wright',
    category: 'production',
    name: 'Cart wright',
    capacityUnits: 1,
    constructionCost: { 'material.lumber': 6, 'material.cut_stone': 2, 'goods.tools': 4 },
    maintenancePerDay: { 'goods.tools': 0.05 },
    decayDaysIfUnmaintained: 180,
    notes: 'Hosts build_cart.',
  },
  {
    id: 'mint',
    category: 'production',
    name: 'Mint',
    capacityUnits: 1,
    constructionCost: { 'material.cut_stone': 8, 'material.brick_tile': 4, 'goods.tools': 4 },
    maintenancePerDay: { 'goods.tools': 0.05 },
    decayDaysIfUnmaintained: 90,
    notes: 'Hosts mint_coin. Politically restricted — usually city or governor.',
  },

  // --- Storage ---
  {
    id: 'granary',
    category: 'storage',
    name: 'Granary',
    capacityUnits: 0,
    constructionCost: { 'material.cut_stone': 8, 'material.brick_tile': 6, 'material.lumber': 4 },
    maintenancePerDay: { 'material.brick_tile': 0.02 },
    decayDaysIfUnmaintained: 365,
    notes: 'Bulk grain storage. Reduces grain spoilage.',
  },
  {
    id: 'warehouse',
    category: 'storage',
    name: 'Warehouse',
    capacityUnits: 0,
    constructionCost: { 'material.lumber': 8, 'material.brick_tile': 4, 'material.cut_stone': 2 },
    maintenancePerDay: { 'material.lumber': 0.02 },
    decayDaysIfUnmaintained: 365,
    notes: 'General-purpose storage; used by merchants and patrons.',
  },
  {
    id: 'cistern',
    category: 'storage',
    name: 'Cistern',
    capacityUnits: 0,
    constructionCost: { 'material.cut_stone': 12, 'material.brick_tile': 4 },
    maintenancePerDay: { 'material.brick_tile': 0.02 },
    decayDaysIfUnmaintained: 730,
    notes: 'Stored water. Cushions drought.',
  },

  // --- Civic ---
  {
    id: 'temple',
    category: 'civic',
    name: 'Temple',
    capacityUnits: 1,
    constructionCost: { 'material.cut_stone': 20, 'material.brick_tile': 8, 'material.lumber': 4 },
    maintenancePerDay: { 'material.cut_stone': 0.01 },
    decayDaysIfUnmaintained: 730,
    notes: 'Hosts priesthood. Festivals shift demand.',
  },
  {
    id: 'forum_market',
    category: 'civic',
    name: 'Forum / market',
    capacityUnits: 0,
    constructionCost: { 'material.cut_stone': 12, 'material.brick_tile': 8, 'material.lumber': 4 },
    maintenancePerDay: { 'material.cut_stone': 0.01 },
    decayDaysIfUnmaintained: 730,
    notes: 'Where the daily market clears. Anchors a settlement.',
  },

  // --- Military ---
  {
    id: 'walls',
    category: 'military',
    name: 'Walls',
    capacityUnits: 0,
    constructionCost: { 'material.cut_stone': 40, 'material.brick_tile': 8, 'material.lumber': 4 },
    maintenancePerDay: { 'material.cut_stone': 0.02 },
    decayDaysIfUnmaintained: 1825,
    notes: 'Defensive perimeter. Long decay — even unmaintained, walls last decades.',
  },
  {
    id: 'barracks',
    category: 'military',
    name: 'Barracks',
    capacityUnits: 1,
    constructionCost: { 'material.cut_stone': 8, 'material.lumber': 8, 'material.brick_tile': 4 },
    maintenancePerDay: { 'material.lumber': 0.05 },
    decayDaysIfUnmaintained: 365,
    notes: 'Houses garrison. Backs service.garrison capacity.',
  },

  // --- Infrastructure ---
  {
    id: 'aqueduct_segment',
    category: 'infrastructure',
    name: 'Aqueduct segment',
    capacityUnits: 0,
    constructionCost: { 'material.cut_stone': 20, 'material.brick_tile': 4 },
    maintenancePerDay: { 'material.cut_stone': 0.01 },
    decayDaysIfUnmaintained: 1825,
    notes: 'One hex-length of aqueduct. Lifts city size cap.',
  },
  {
    id: 'road_segment',
    category: 'infrastructure',
    name: 'Road segment',
    capacityUnits: 0,
    constructionCost: { 'material.cut_stone': 6, 'material.stone': 4 },
    maintenancePerDay: { 'material.cut_stone': 0.005 },
    decayDaysIfUnmaintained: 1825,
    notes: 'One hex-length of paved road. Caravan movement bonus.',
  },
];

const buildCatalog = (): ReadonlyMap<BuildingId, BuildingDef> => {
  const map = new Map<BuildingId, BuildingDef>();
  for (const input of DEFS) {
    const id = buildingId(input.id);
    if (map.has(id)) {
      throw new Error(`Duplicate building id: ${input.id}`);
    }
    const construction = new Map<ResourceId, Quantity>();
    for (const [resKey, qty] of Object.entries(input.constructionCost)) {
      construction.set(resourceId(resKey), qty);
    }
    const maintenance = new Map<ResourceId, Quantity>();
    if (input.maintenancePerDay !== undefined) {
      for (const [resKey, qty] of Object.entries(input.maintenancePerDay)) {
        maintenance.set(resourceId(resKey), qty);
      }
    }
    const def: BuildingDef = Object.freeze({
      id,
      category: input.category,
      name: input.name,
      capacityUnits: input.capacityUnits,
      constructionCost: freezeMap(construction),
      maintenancePerDay: freezeMap(maintenance),
      decayDaysIfUnmaintained: input.decayDaysIfUnmaintained,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    map.set(id, def);
  }
  return map;
};

// Disable mutating methods on a Map so a misbehaving caller throws
// instead of silently corrupting catalog state.
const freezeMap = <K, V>(m: Map<K, V>): ReadonlyMap<K, V> => {
  const denied = (op: string): never => {
    throw new Error(`Catalog map is read-only (${op})`);
  };
  m.set = (): never => denied('set');
  m.delete = (): never => denied('delete');
  m.clear = (): never => denied('clear');
  return m;
};

export const BUILDINGS: ReadonlyMap<BuildingId, BuildingDef> = buildCatalog();

const ALL_BUILDINGS: readonly BuildingDef[] = Object.freeze(Array.from(BUILDINGS.values()));

export const allBuildings = (): readonly BuildingDef[] => ALL_BUILDINGS;

export const getBuilding = (id: BuildingId): BuildingDef => {
  const def = BUILDINGS.get(id);
  if (def === undefined) {
    throw new Error(`Unknown building id: ${String(id)}`);
  }
  return def;
};
