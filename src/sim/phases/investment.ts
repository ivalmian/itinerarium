/**
 * Quarterly investment phase (docs/15 §C4 — Stage 2 specialization).
 *
 * For each settlement, find a single owner-actor and a single recipe
 * such that:
 *   1. The recipe's building isn't already at full daily capacity in
 *      the settlement (saturation cap = `MAX_BUILDINGS_OF_TYPE`).
 *   2. Expected daily profit (revenue − input cost) at the last
 *      observed clearing prices is positive AND the
 *      `profit / coinCost` ratio is above `INVESTMENT_ROI_THRESHOLD`.
 *   3. The actor has the resources in stockpile to pay the building's
 *      construction cost (at THIS settlement, per docs/15 §C30).
 *   4. Mining + ore-refining is geology-gated: a mine investment
 *      must go on a matching finite deposit hex, and ore refineries
 *      require local ore stock or a deposit-backed mine already
 *      present / under construction.
 *
 * If multiple recipes qualify the picker takes the highest
 * `profit / construction-cost-in-coin` ratio. One investment per
 * settlement per quarter so a runaway profitable recipe doesn't
 * balloon a city with a hundred bakeries in one year.
 *
 * The chosen building goes on a settlement-owned hex picked by the
 * terrain-affinity placer in `src/sim/buildings/placement.ts`
 * (free urban-core hexes preferred for workshops, catchment hexes
 * preferred for farms / pastures / vineyards / forester camps /
 * mines / quarries / fisheries). Mines must land on a matching
 * deposit hex.
 *
 * Per docs/08 §"Construction is heavy" + docs/15 §C8: don't add the
 * building immediately. Push a `pendingBuilding`; the construction
 * phase drains mason + carpenter worker-days each tick until done.
 * Per docs/15 §C14 the worker-days split into mason (stone/brick
 * work) vs. carpenter (lumber work) pools per the construction-cost
 * mix.
 *
 * Also exports the helpers the investment placer relies on
 * (`pickBuildingHex`, `pickInvestor`, `scoreInvestmentCandidates`,
 * `LAND_USE_BUILDINGS`, …) so future passes can share them.
 */

import { getBuilding } from '../buildings/catalog.js';
import { pickBestHex, type PlacementCandidate } from '../buildings/placement.js';
import { getResource } from '../resources/catalog.js';
import { allRecipes, type RecipeDef } from '../production/recipes.js';
import { getStockAt, removeStockAt, type Actor } from '../politics/actor.js';
import type { BuildingId, Day, ResourceId } from '../types.js';
import { buildingId } from '../types.js';
import { hexKey, hexesWithinRange, type Hex } from '../world/hex.js';
import type { Settlement } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const MINE_BUILDING_ID = buildingId('mine');

/** ROI threshold (profit per coin per day). 0.005 ≈ ~180% APR — a
 *  reasonable Roman-era ROI for new productive capacity. */
const INVESTMENT_ROI_THRESHOLD = 0.005;

/** Saturation cap: any one settlement won't pile on more than this
 *  many copies of the same building type via investmentPhase. */
const MAX_BUILDINGS_OF_TYPE = 6;

const ORE_RESOURCE_SUFFIX = '_ore';

const PROFITABLE_OWNER_KINDS: readonly Actor['kind'][] = [
  'patrician_family',
  'free_village',
  'city_corporation',
  'governor_office',
  'hamlet_household',
];

/** Building types that need productive land — placed on a catchment
 *  hex. Everything else is a workshop / store and lives in the
 *  urban core. */
export const LAND_USE_BUILDINGS = new Set<string>([
  'farm',
  'pasture',
  'olive_grove',
  'vineyard',
  'orchard',
  'fishery',
  'mine',
  'quarry',
  'forester_camp',
]);

interface ScoredInvestment {
  readonly buildingId: BuildingId;
  readonly profitPerDay: number;
  readonly coinCost: number;
  readonly preferredDeposit?: ResourceId;
}

// --- Investor + recipe scoring -------------------------------------------

const pickInvestor = (world: WorldState, settlement: Settlement): Actor | undefined => {
  let best: Actor | undefined;
  let bestTreasury = -1;
  for (const oId of settlement.stockpileOwners) {
    const a = world.actors.get(oId);
    if (a === undefined) continue;
    if (!PROFITABLE_OWNER_KINDS.includes(a.kind)) continue;
    if (a.treasury <= bestTreasury) continue;
    best = a;
    bestTreasury = a.treasury;
  }
  return best;
};

const minedResourceForRecipe = (recipe: RecipeDef): ResourceId | undefined => {
  if (recipe.building !== MINE_BUILDING_ID) return undefined;
  for (const resource of recipe.outputs.keys()) {
    if (getResource(resource).category === 'mineral') return resource;
  }
  return undefined;
};

const recipeOreInputs = (recipe: RecipeDef): readonly ResourceId[] =>
  Array.from(recipe.inputs.keys()).filter((resource) => {
    return (
      getResource(resource).category === 'mineral' &&
      String(resource).endsWith(ORE_RESOURCE_SUFFIX)
    );
  });

const settlementBuildHexes = (settlement: Settlement): readonly Hex[] => [
  ...settlement.catchmentHexes,
  ...settlement.urbanHexes,
];

const occupiedHexesForBuilding = (
  settlement: Settlement,
  buildingId: BuildingId,
): Set<string> => {
  const occupied = new Set<string>();
  for (const b of settlement.buildings) {
    if (b.buildingId === buildingId) occupied.add(hexKey(b.hex));
  }
  for (const b of settlement.pendingBuildings) {
    if (b.buildingId === buildingId) occupied.add(hexKey(b.hex));
  }
  return occupied;
};

const findFreeDepositHexForResource = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
): Hex | null => {
  const occupied = occupiedHexesForBuilding(settlement, MINE_BUILDING_ID);
  for (const h of settlementBuildHexes(settlement)) {
    if (occupied.has(hexKey(h))) continue;
    const tile = world.grid.get(h);
    const deposit = tile?.deposit;
    if (deposit === undefined || deposit.remaining <= 0 || deposit.resource !== resource) continue;
    return h;
  }
  return null;
};

const settlementHasDepositBackedMine = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
): boolean => {
  for (const b of settlement.buildings) {
    if (b.buildingId !== MINE_BUILDING_ID) continue;
    const deposit = world.grid.get(b.hex)?.deposit;
    if (deposit !== undefined && deposit.remaining > 0 && deposit.resource === resource)
      return true;
  }
  for (const b of settlement.pendingBuildings) {
    if (b.buildingId !== MINE_BUILDING_ID) continue;
    const deposit = world.grid.get(b.hex)?.deposit;
    if (deposit !== undefined && deposit.remaining > 0 && deposit.resource === resource)
      return true;
  }
  return false;
};

const localStockForResource = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
): number => {
  let total = 0;
  for (const ownerId of settlement.stockpileOwners) {
    const a = world.actors.get(ownerId);
    if (a === undefined) continue;
    total += getStockAt(a, settlement.id, resource);
  }
  return total;
};

/**
 * Investment is capital allocation, not magic spawning. Mines
 * require a matching local deposit; ore refineries require either
 * local ore stock or a deposit-backed mine already present / under
 * construction.
 */
const investmentResourceGate = (
  world: WorldState,
  settlement: Settlement,
  owner: Actor,
  recipe: RecipeDef,
): ResourceId | null | undefined => {
  const minedResource = minedResourceForRecipe(recipe);
  if (minedResource !== undefined) {
    return findFreeDepositHexForResource(world, settlement, minedResource) === null
      ? null
      : minedResource;
  }

  for (const ore of recipeOreInputs(recipe)) {
    const needed = recipe.inputs.get(ore) ?? 0;
    const ownerHasOre = getStockAt(owner, settlement.id, ore) >= needed;
    const localHasOre = localStockForResource(world, settlement, ore) >= needed;
    const mineCanFeedOre = settlementHasDepositBackedMine(world, settlement, ore);
    if (!ownerHasOre && !localHasOre && !mineCanFeedOre) return null;
  }
  return undefined;
};

const scoreInvestmentCandidates = (
  world: WorldState,
  settlement: Settlement,
  owner: Actor,
): ScoredInvestment[] => {
  const out: ScoredInvestment[] = [];
  const existingByType = new Map<BuildingId, number>();
  for (const b of settlement.buildings) {
    existingByType.set(b.buildingId, (existingByType.get(b.buildingId) ?? 0) + 1);
  }
  for (const b of settlement.pendingBuildings) {
    existingByType.set(b.buildingId, (existingByType.get(b.buildingId) ?? 0) + 1);
  }

  for (const recipe of allRecipes()) {
    const preferredDeposit = investmentResourceGate(world, settlement, owner, recipe);
    if (preferredDeposit === null) continue;

    // Revenue at last clearing prices.
    let revenue = 0;
    let revenueValid = true;
    for (const [resId, qty] of recipe.outputs) {
      const price = settlement.market.lastClearingPrice.get(resId);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        revenueValid = false;
        break;
      }
      revenue += qty * price;
    }
    if (!revenueValid) continue;

    let cost = 0;
    let costValid = true;
    for (const [resId, qty] of recipe.inputs) {
      const price = settlement.market.lastClearingPrice.get(resId);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        costValid = false;
        break;
      }
      cost += qty * price;
    }
    if (!costValid) continue;

    const profitPerDay = revenue - cost;
    if (profitPerDay <= 0) continue;

    // Construction cost in coin (using local prices). Per docs/15
    // §C30 construction materials must be at THIS settlement.
    const def = getBuilding(recipe.building);
    let coinCost = 0;
    let payable = true;
    for (const [resId, qty] of def.constructionCost) {
      const have = getStockAt(owner, settlement.id, resId);
      if (have < qty) {
        payable = false;
        break;
      }
      const price = settlement.market.lastClearingPrice.get(resId) ?? 1;
      coinCost += qty * price;
    }
    if (!payable) continue;

    const existingCount = existingByType.get(recipe.building) ?? 0;
    if (existingCount >= MAX_BUILDINGS_OF_TYPE) continue;

    out.push({
      buildingId: recipe.building,
      profitPerDay,
      coinCost,
      ...(preferredDeposit !== undefined ? { preferredDeposit } : {}),
    });
  }

  out.sort(
    (a, b) =>
      b.profitPerDay / Math.max(1, b.coinCost) - a.profitPerDay / Math.max(1, a.coinCost),
  );
  return out;
};

// --- Construction worker-day estimation ----------------------------------

/**
 * Worker-days required to construct a building. Heuristic by
 * construction-cost mass: sum of cost units × ~5 worker-days, floored
 * at 30 and capped at 90 so a typo in constructionCost can't make a
 * building take a year. Per docs/08 §"Construction is heavy" +
 * docs/15 §C8.
 */
export const constructionWorkerDays = (id: BuildingId): number => {
  const def = getBuilding(id);
  let totalUnits = 0;
  for (const qty of def.constructionCost.values()) totalUnits += qty;
  const raw = Math.round(totalUnits * 5);
  return Math.max(30, Math.min(90, raw));
};

/**
 * Per docs/15 §C14: fraction of a building's construction labor
 * that masons (stone/brick) handle vs. carpenters (lumber).
 * Default 0.5 if the construction cost has neither.
 */
export const computeMasonShare = (id: BuildingId): number => {
  const def = getBuilding(id);
  let masonWeight = 0;
  let carpenterWeight = 0;
  for (const [r, qty] of def.constructionCost) {
    const k = String(r);
    if (k === 'material.stone' || k === 'material.cut_stone' || k === 'material.brick_tile') {
      masonWeight += qty;
    } else if (k === 'material.lumber' || k === 'material.wood') {
      carpenterWeight += qty;
    }
  }
  const total = masonWeight + carpenterWeight;
  if (total <= 0) return 0.5;
  return masonWeight / total;
};

// --- Building-hex placement ----------------------------------------------

const isPassableForBuilding = (world: WorldState, hex: Hex): boolean => {
  const t = world.grid.get(hex);
  if (t === undefined) return false;
  if (t.terrain === 'lake') return false;
  if (t.terrain === 'mountains') return false;
  if (t.terrain === 'dense_forest') return false;
  return true;
};

const isBuildableForBuilding = (
  world: WorldState,
  hex: Hex,
  buildingId: BuildingId,
  preferredDeposit?: ResourceId,
): boolean => {
  const t = world.grid.get(hex);
  if (t === undefined) return false;
  if (buildingId === MINE_BUILDING_ID) {
    const deposit = t.deposit;
    return (
      deposit !== undefined &&
      deposit.remaining > 0 &&
      (preferredDeposit === undefined || deposit.resource === preferredDeposit) &&
      t.terrain !== 'lake'
    );
  }
  return isPassableForBuilding(world, hex);
};

export const pickBuildingHex = (
  world: WorldState,
  settlement: Settlement,
  buildingId: BuildingId,
  preferredDeposit?: ResourceId,
): Hex | null => {
  const occupied = occupiedHexesForBuilding(settlement, buildingId);
  if (buildingId === MINE_BUILDING_ID && preferredDeposit !== undefined) {
    return findFreeDepositHexForResource(world, settlement, preferredDeposit);
  }

  const isLandUse = LAND_USE_BUILDINGS.has(String(buildingId));
  const buildPool = (hexes: readonly Hex[], isUrban: boolean): PlacementCandidate[] => {
    const out: PlacementCandidate[] = [];
    for (const h of hexes) {
      if (occupied.has(hexKey(h))) continue;
      const tile = world.grid.get(h);
      if (tile === undefined) continue;
      if (!isBuildableForBuilding(world, h, buildingId, preferredDeposit)) continue;
      let waterAdjacent =
        tile.hasRiver || tile.terrain === 'river' || tile.terrain === 'lake';
      if (!waterAdjacent) {
        for (const n of hexesWithinRange(h, 1)) {
          const nt = world.grid.get(n);
          if (nt === undefined) continue;
          if (nt.hasRiver || nt.terrain === 'river' || nt.terrain === 'lake') {
            waterAdjacent = true;
            break;
          }
        }
      }
      out.push({ hex: h, tile, waterAdjacent, isUrban });
    }
    return out;
  };

  const urbanPool = buildPool(settlement.urbanHexes, true);
  const catchmentPool = buildPool(settlement.catchmentHexes, false);
  const combined = isLandUse
    ? [...catchmentPool, ...urbanPool]
    : [...urbanPool, ...catchmentPool];
  const pick = pickBestHex(buildingId, combined);
  return pick === null ? null : pick.hex;
};

// --- Phase entry -----------------------------------------------------------

export const investmentPhase = (
  world: WorldState,
  today: Day,
  events: TickEvent[],
): void => {
  for (const settlement of world.settlements.values()) {
    const owner = pickInvestor(world, settlement);
    if (owner === undefined) continue;

    const candidates = scoreInvestmentCandidates(world, settlement, owner);
    if (candidates.length === 0) continue;
    const best = candidates[0] as ScoredInvestment;
    if (best.profitPerDay <= 0) continue;
    if (best.profitPerDay / Math.max(1, best.coinCost) < INVESTMENT_ROI_THRESHOLD) continue;

    const placement = pickBuildingHex(world, settlement, best.buildingId, best.preferredDeposit);
    if (placement === null) continue;

    const def = getBuilding(best.buildingId);

    // Pay construction: drain inputs from owner's slice at this
    // settlement (per docs/15 §C30). Already confirmed sufficiency
    // in scoreInvestmentCandidates; do it unconditionally here.
    for (const [resId, qty] of def.constructionCost) {
      removeStockAt(owner, settlement.id, resId, qty);
    }

    // Per docs/08 §"Construction is heavy" + docs/15 §C8: don't add
    // the building immediately. Push a pendingBuilding; the
    // construction phase drains mason + carpenter worker-days each
    // tick until done. Per docs/15 §C14 the worker-days split into
    // mason (stone/brick work) vs. carpenter (lumber work) pools
    // per the construction-cost mix.
    const totalDays = constructionWorkerDays(def.id);
    const masonShare = computeMasonShare(def.id);
    const masonDays = Math.round(totalDays * masonShare);
    const carpenterDays = totalDays - masonDays;
    settlement.pendingBuildings.push({
      buildingId: def.id,
      hex: placement,
      ownerActor: owner.id,
      beganOnDay: today,
      workerDaysRemaining: totalDays,
      workerDaysTotal: totalDays,
      masonDaysRemaining: masonDays,
      carpenterDaysRemaining: carpenterDays,
    });

    events.push({
      type: 'building_invested',
      settlement: settlement.id,
      building: def.id,
      ownerActor: owner.id,
      costCoin: best.coinCost,
    });
  }
};

