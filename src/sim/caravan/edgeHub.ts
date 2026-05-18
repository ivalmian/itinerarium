/**
 * Edge-hub caravan generator.
 *
 * docs/06 §"Edge-hub caravans" + docs/08 §"The off-map global
 * market": exotic imports and high-value exports cross the map
 * border via real Caravan instances spawned at edge hexes. There
 * is no magic spawning — every ingot of silver and bolt of silk
 * arrived on a specific caravan with a specific crew, and every
 * exported amphora of fine wine left the same way.
 *
 * The critical emergent property is that bulk staples (grain,
 * ordinary cloth) don't pencil out as exports. The filter is just
 * the per-unit margin formula:
 *
 *   margin = (globalPrice - localPrice) - transportCostPerKg * roundTripHexes * weightKgPerUnit
 *
 * High-value-per-kg goods (silver, luxury_textiles, slaves,
 * spices) survive that subtraction; raw grain/cloth do not.
 *
 * Amphora-packed olive oil and wine sit in the middle: per docs/06
 * §"Exports" + docs/08 §"Why imports and exports are dominated by
 * luxuries (emergent)", they CAN export "in good years when quality
 * or scarcity makes the spread high enough". They are not hard-coded
 * out of the export filter; the same margin formula gates them, and
 * a depressed local price + sufficient global spread is what flips
 * them into exportable territory. Their global prices are calibrated
 * so that the formula yields a positive margin only when the local
 * surplus is real.
 */

import type { Rng } from '../rng.js';
import { getResource } from '../resources/index.js';
import {
  caravanId as makeCaravanId,
  actorId,
  resourceId,
  type ActorId,
  type CaravanId,
  type Coin,
  type Day,
  type Quantity,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { hexDistance, hexKey, type Hex } from '../world/hex.js';
import type { Season } from '../world/terrain.js';
import {
  ANIMAL_SPECS,
  CARRIED_FODDER_RESERVE_SHARE,
  createCaravan,
  dailyCarriedFoodReserveKg,
  totalCarryKg,
  totalCargoWeightKg,
  type Caravan,
  type CrewMember,
} from './caravan.js';

// --- Tunables --------------------------------------------------------------

/**
 * Coin per kg per hex of one-way travel. Calibrated so that:
 *   - grain (6.7 kg, ~1 coin/unit) over 100 hex round-trip ≈ 33 coin
 *     of cost per unit, dwarfing any plausible spread.
 *   - silver (5 kg, ~700 coin/unit) over 100 hex round-trip ≈ 25 coin
 *     of cost per unit, leaving ~hundreds of coin of margin.
 *
 * The number aggregates crew rations + animal fodder + wear + risk
 * premium amortized over the caravan's cargo capacity. It is
 * deliberately uniform per kg — that's what makes weight the
 * dominant filter.
 */
export const TRANSPORT_COST_COIN_PER_KG_PER_HEX = 0.05;

const CREW_RATION_RESERVE_DAYS = 21;
const CREW_RATION_RESOURCE = resourceId('food.grain');
const IMPORT_OPERATING_TREASURY_DAYS = 60;
const LOAD_EPSILON_KG = 1e-6;
const MAX_LOAD_FIT_ITERATIONS = 32;
const NET_CARGO_KG_PER_EXTRA_MULE_WITH_RESERVE =
  ANIMAL_SPECS.mule.carryKg -
  ANIMAL_SPECS.mule.fodderKgPerDay * CARRIED_FODDER_RESERVE_SHARE * CREW_RATION_RESERVE_DAYS;

const addCrewRationReserve = (caravan: Caravan): void => {
  const grain = getResource(CREW_RATION_RESOURCE);
  if (grain.weightKgPerUnit <= 0) return;
  const units =
    (dailyCarriedFoodReserveKg(caravan) * CREW_RATION_RESERVE_DAYS) / grain.weightKgPerUnit;
  const current = caravan.cargo.get(CREW_RATION_RESOURCE) ?? 0;
  if (current + LOAD_EPSILON_KG < units) caravan.cargo.set(CREW_RATION_RESOURCE, units);
};

const fitCaravanLoadWithRations = (caravan: Caravan): boolean => {
  for (let i = 0; i < MAX_LOAD_FIT_ITERATIONS; i++) {
    addCrewRationReserve(caravan);
    const carryKg = totalCarryKg(caravan);
    const cargoKg = totalCargoWeightKg(caravan);
    if (cargoKg <= carryKg + LOAD_EPSILON_KG) return true;
    const deficitKg = cargoKg - carryKg;
    const extraMules = Math.max(
      1,
      Math.ceil(deficitKg / Math.max(1, NET_CARGO_KG_PER_EXTRA_MULE_WITH_RESERVE)),
    );
    caravan.animals.mule = (caravan.animals.mule ?? 0) + extraMules;
  }
  addCrewRationReserve(caravan);
  return totalCargoWeightKg(caravan) <= totalCarryKg(caravan) + LOAD_EPSILON_KG;
};

const addImportOperatingTreasury = (caravan: Caravan): void => {
  // Off-map merchant houses do not send import convoys with empty purses.
  // This is operating cash for rations and minor repairs after the first
  // delivery, not profit. Without it, an import caravan that cannot sell
  // enough cargo immediately can starve even in a food-bearing market.
  caravan.treasury = Math.max(
    Math.round(caravan.treasury),
    Math.round(dailyCarriedFoodReserveKg(caravan) * IMPORT_OPERATING_TREASURY_DAYS),
  );
};

/**
 * Slowly-drifting global market prices. Numbers are first-pass;
 * tunable. The ordering is what matters: silver >> luxury_textiles
 * >> spices ≈ silk ≈ incense >> amphora wine/oil >> grain ≈ cloth.
 *
 * Amphora-packed oil/wine prices reflect long-distance Roman trade
 * values (an amphora of decent wine in a distant province fetched
 * roughly 10–20× the local grain price per amphora). At 26 kg/unit
 * the per-kg cost is still well above grain so these only export
 * when local surplus depresses prices enough — the same margin
 * filter as everything else.
 */
// Off-map landed prices. 5× scaled vs. the pre-realism-pass baseline
// (realism pass 8) so the integer-coin quote rule + scaled local
// salvage floors line up: the same gradient between cheap bulk goods
// and high-value luxuries, but with enough headroom over the 1-coin
// floor that staple chains keep a price ladder.
// Per docs/00 Pillar 8 and docs/10 decision 41 (v1.6): every tradable
// catalog resource has a global reference price. Missing entries
// previously caused the export pipeline to silently drop the resource —
// cities accumulated multi-year stockpiles of salted_meat, salted_fish,
// clothing, furniture, and pottery with no off-map outlet. The full
// table below covers every food / material / mineral / metal / good /
// exotic resource. Services and goods.coin are excluded by intent
// (services don't ship; coin IS the unit of account).
//
// Values are 5×-scaled Roman-era reference prices (realism pass 8).
export const DEFAULT_GLOBAL_PRICES: ReadonlyMap<ResourceId, number> = new Map<ResourceId, number>([
  // --- Food: raw produce, perishable -------------------------------------
  [resourceId('food.grain'), 7.5],
  [resourceId('food.olives'), 25],
  [resourceId('food.grapes'), 20],
  [resourceId('food.fish'), 40],
  [resourceId('food.game'), 50],
  [resourceId('food.legumes'), 10],
  [resourceId('food.milk'), 30],
  // --- Food: processed / preserved ---------------------------------------
  [resourceId('food.flour'), 18],
  [resourceId('food.bread'), 12],
  [resourceId('food.olive_oil'), 750],
  [resourceId('food.wine'), 1000],
  [resourceId('food.cheese'), 25],
  [resourceId('food.salted_fish'), 60],
  [resourceId('food.salted_meat'), 200],
  // --- Livestock capital goods (Pillar 8) --------------------------------
  // Equines / cattle / sheep / pigs are pasture output traded into urban
  // demand (caravan owners need equines, city kitchens buy cattle for
  // slaughter, etc.). Without a global ref both sides peg to the maxPrice
  // ceiling, killing the spread local trade needs.
  [resourceId('livestock.equines'), 3000],
  [resourceId('livestock.cattle'), 1200],
  [resourceId('livestock.sheep'), 250],
  [resourceId('livestock.pigs'), 200],
  // --- Carts: caravan capital --------------------------------------------
  [resourceId('goods.cart'), 1500],
  // --- Raw materials & minerals ------------------------------------------
  [resourceId('material.wood'), 60],   // 1 cord of green wood = 700 kg
  [resourceId('material.stone'), 25],  // 1 quarry block = 1500 kg (cheap bulk)
  [resourceId('material.clay'), 8],    // 1 unit = 100 kg riverbank clay
  [resourceId('material.flax'), 40],
  [resourceId('material.hides'), 120],
  [resourceId('mineral.iron_ore'), 20],
  [resourceId('mineral.copper_ore'), 65],
  [resourceId('mineral.tin_ore'), 120],
  [resourceId('mineral.lead_ore'), 25],
  [resourceId('mineral.silver_ore'), 650],
  [resourceId('mineral.gold_ore'), 4000],
  [resourceId('mineral.salt'), 40],
  // --- Intermediates -----------------------------------------------------
  [resourceId('material.wool'), 50],
  [resourceId('material.linen_fiber'), 60],
  [resourceId('material.leather'), 140],
  [resourceId('material.charcoal'), 60],   // 1 sack = 30 kg
  [resourceId('material.lumber'), 150],    // 1 stack = 500 kg sawn timber
  [resourceId('material.cut_stone'), 120], // 1 dressed block = 1500 kg
  [resourceId('material.brick_tile'), 60], // 1 pallet = 200 kg
  [resourceId('material.pottery'), 20],
  [resourceId('material.amphora'), 40],
  // --- Metals (refined) --------------------------------------------------
  [resourceId('metal.iron'), 60],
  [resourceId('metal.copper'), 150],
  [resourceId('metal.tin'), 300],
  [resourceId('metal.bronze'), 200],
  [resourceId('metal.lead'), 50],
  [resourceId('metal.silver'), 3500],
  [resourceId('metal.gold'), 40000],
  // --- Manufactured ordinary ---------------------------------------------
  [resourceId('goods.cloth'), 60],
  [resourceId('goods.clothing'), 150],
  [resourceId('goods.tools'), 125],
  [resourceId('goods.furniture'), 800],
  // --- Weapon archetypes (docs/03) ---------------------------------------
  [resourceId('goods.gladius'), 250],
  [resourceId('goods.hasta'), 150],
  [resourceId('goods.pilum'), 175],
  [resourceId('goods.dagger'), 100],
  [resourceId('goods.bow'), 275],
  [resourceId('goods.arrow'), 20],
  [resourceId('goods.sling'), 40],
  [resourceId('goods.sling_bullet'), 5],
  [resourceId('goods.helmet'), 300],
  [resourceId('goods.body_armor'), 1000],
  [resourceId('goods.shield'), 225],
  // --- Status / luxury ---------------------------------------------------
  [resourceId('goods.luxury_textiles'), 500],
  // --- Exotics (off-map sources) -----------------------------------------
  [resourceId('exotic.spices'), 400],
  [resourceId('exotic.silk'), 1000],
  [resourceId('exotic.incense'), 300],
  [resourceId('exotic.dyes'), 600],
  // --- People as cargo ---------------------------------------------------
  [resourceId('people.slave'), 3000],
  [resourceId('people.migrants'), 1500],
]);

export interface ImportPaletteEntry {
  readonly resource: ResourceId;
  readonly weight: number;
  /** Cargo amount in resource UNITS (not kg), drawn uniformly per spawn. */
  readonly cargoKg: readonly [min: number, max: number];
}

/**
 * Default palette of off-map imports. Cargo amounts are in *units*
 * of the resource (matching c.cargo's unit convention). Strategic
 * inputs get real wagon-loads, not token luxury parcels: if iron/tools
 * are locally scarce enough to clear transport cost, off-map houses
 * should help unblock production rather than only flooding the province
 * with spices.
 */
export const DEFAULT_IMPORT_PALETTE: readonly ImportPaletteEntry[] = [
  { resource: resourceId('mineral.salt'), weight: 3, cargoKg: [60, 180] },
  { resource: resourceId('metal.iron'), weight: 12, cargoKg: [150, 420] },
  { resource: resourceId('goods.tools'), weight: 7, cargoKg: [80, 220] },
  { resource: resourceId('goods.cloth'), weight: 1, cargoKg: [80, 240] },
  // Military archetype imports — total weight matches the old combined
  // weapons/armor share (~0.75) but spread across the kit so a city
  // with a specific shortage can pull the right item via the
  // price-responsive selection in chooseImportCargoFor().
  { resource: resourceId('goods.gladius'), weight: 0.2, cargoKg: [10, 30] },
  { resource: resourceId('goods.hasta'), weight: 0.1, cargoKg: [10, 25] },
  { resource: resourceId('goods.pilum'), weight: 0.05, cargoKg: [8, 20] },
  { resource: resourceId('goods.dagger'), weight: 0.05, cargoKg: [20, 50] },
  { resource: resourceId('goods.bow'), weight: 0.05, cargoKg: [10, 20] },
  { resource: resourceId('goods.arrow'), weight: 0.05, cargoKg: [200, 500] },
  { resource: resourceId('goods.sling'), weight: 0.03, cargoKg: [20, 50] },
  { resource: resourceId('goods.sling_bullet'), weight: 0.03, cargoKg: [400, 1000] },
  { resource: resourceId('goods.helmet'), weight: 0.05, cargoKg: [5, 15] },
  { resource: resourceId('goods.body_armor'), weight: 0.05, cargoKg: [2, 8] },
  { resource: resourceId('goods.shield'), weight: 0.1, cargoKg: [10, 25] },
  { resource: resourceId('exotic.spices'), weight: 2, cargoKg: [200, 800] },
  { resource: resourceId('exotic.silk'), weight: 2, cargoKg: [100, 400] },
  { resource: resourceId('exotic.incense'), weight: 1.5, cargoKg: [200, 600] },
  { resource: resourceId('exotic.dyes'), weight: 2, cargoKg: [200, 500] },
  { resource: resourceId('people.slave'), weight: 2, cargoKg: [10, 40] },
];

// --- Types -----------------------------------------------------------------

export interface EdgeHubConfig {
  readonly edgeHexes: readonly Hex[];
  readonly globalPrices: ReadonlyMap<ResourceId, number>;
  readonly baseImportSpawnProbPerDay: number;
  readonly baseExportSpawnProbPerDay: number;
  /** Currently active import caravans. Used to apply outstanding-fleet back-pressure. */
  readonly activeImportCaravans?: number;
  /** Currently active export caravans. Used to apply outstanding-fleet back-pressure. */
  readonly activeExportCaravans?: number;
  readonly maxImportSpawnsPerDay?: number;
  readonly maxExportSpawnsPerDay?: number;
  readonly maxTotalSpawnsPerDay?: number;
  readonly maxActiveImportCaravans?: number;
  readonly maxActiveExportCaravans?: number;
  readonly importPalette: readonly ImportPaletteEntry[];
}

export interface CityImportTarget {
  readonly settlementId: SettlementId;
  readonly hex: Hex;
  /** Last local clearing prices. Imports require a positive landed margin. */
  readonly localPrices?: ReadonlyMap<ResourceId, number>;
}

export interface CityExportSource {
  readonly settlementId: SettlementId;
  readonly hex: Hex;
  readonly ownerActor: ActorId;
  readonly localPrices: ReadonlyMap<ResourceId, number>;
  /**
   * Resources the owner is willing to release into export trade,
   * in resource UNITS. Mutated by tickEdgeHubs only via the
   * returned newCaravans (caller drains the actor's stockpile).
   */
  readonly availableForExport: ReadonlyMap<ResourceId, Quantity>;
}

export interface EdgeHubTickInputs {
  readonly config: EdgeHubConfig;
  readonly today: Day;
  readonly season: Season;
  readonly cityImportTargets: readonly CityImportTarget[];
  readonly cityExportSources: readonly CityExportSource[];
  readonly rng: Rng;
}

export interface EdgeHubReturnEvent {
  readonly caravanId: CaravanId;
  readonly coinReceived: Coin;
  readonly cargoReceived: ReadonlyMap<ResourceId, Quantity>;
}

export interface EdgeHubResult {
  readonly newCaravans: readonly Caravan[];
  readonly returnEvents: readonly EdgeHubReturnEvent[];
}

// --- Margin math -----------------------------------------------------------

/**
 * Per-unit transport cost for one round trip of `oneWayHexes`
 * each way. Carted cargo pays the per-kg rate (crew rations +
 * fodder + wear amortized over kg-hexes); people-as-cargo (slaves,
 * migrants) walk under guard and only cost their own rations,
 * which is far cheaper per unit than carrying their body weight in
 * spices would be.
 */
const transportCostPerUnit = (resource: ResourceId, oneWayHexes: number): number => {
  const def = getResource(resource);
  if (def.category === 'people') {
    // ~0.4 kg grain per day × ~1 day per hex × ~3 coin per kg of grain
    // ≈ 1.2 coin per hex per person, doubled for the round trip and the
    // guard who walks alongside.
    return oneWayHexes * 2 * 1.2;
  }
  return TRANSPORT_COST_COIN_PER_KG_PER_HEX * oneWayHexes * 2 * def.weightKgPerUnit;
};

/**
 * Per-unit profit margin of exporting `resource` from a city to
 * the off-map market and back. Positive means the long-haul
 * merchant should export; negative means it'd lose money. The
 * round-trip approximation is good enough for the spawn decision.
 */
export const estimateExportMargin = (
  resource: ResourceId,
  oneWayHexes: number,
  localPrices: ReadonlyMap<ResourceId, number>,
  globalPrices: ReadonlyMap<ResourceId, number> = DEFAULT_GLOBAL_PRICES,
): number => {
  const local = localPrices.get(resource);
  const global = globalPrices.get(resource);
  if (local === undefined || global === undefined) return Number.NEGATIVE_INFINITY;
  return global - local - transportCostPerUnit(resource, oneWayHexes);
};

const seasonalImportMultiplier = (season: Season): number => {
  switch (season) {
    case 'spring':
      return 0.8;
    case 'summer':
      return 1.0;
    case 'autumn':
      return 0.9;
    case 'winter':
      return 0.3;
  }
};

const seasonalExportMultiplier = seasonalImportMultiplier;

const nearest = <T>(items: readonly T[], origin: Hex, getHex: (t: T) => Hex): T | null => {
  if (items.length === 0) return null;
  let best: T | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const d = hexDistance(origin, getHex(it));
    if (d < bestDist) {
      bestDist = d;
      best = it;
    }
  }
  return best;
};

interface WeightedImportEntry {
  readonly entry: ImportPaletteEntry;
  readonly weight: number;
}

const weightedPick = (rng: Rng, entries: readonly WeightedImportEntry[]): ImportPaletteEntry => {
  let total = 0;
  for (const e of entries) total += e.weight;
  if (total <= 0) return entries[entries.length - 1]!.entry;
  let roll = rng.next() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll <= 0) return e.entry;
  }
  // Fallback for floating-point drift: last entry.
  return entries[entries.length - 1]!.entry;
};

const standardImportCrew = (): CrewMember[] => [
  { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
  { kind: 'drover', count: 6, weapons: 0, armor: 0 },
  { kind: 'caravan_guard', count: 8, weapons: 1, armor: 0.5 },
];

const standardExportCrew = (): CrewMember[] => [
  { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
  { kind: 'drover', count: 4, weapons: 0, armor: 0 },
  { kind: 'caravan_guard', count: 6, weapons: 1, armor: 0.5 },
];

const generateCaravanId = (prefix: string, today: Day, edgeHex: Hex, rng: Rng): CaravanId => {
  // RNG-derived suffix keeps the ID stable for the same seed/sequence.
  // Collisions across same-tick spawns are avoided because each spawn
  // gets its own derived sub-RNG (see tickEdgeHubs).
  const tag = Math.floor(rng.next() * 1_000_000_000);
  return makeCaravanId(`${prefix}-${today}-${hexKey(edgeHex)}-${tag}`);
};

const offMapHouse = (edgeHex: Hex): ActorId => {
  return actorId(`off-map-house-${hexKey(edgeHex)}`);
};

// --- Imports ---------------------------------------------------------------

const IMPORT_MARGIN_WEIGHT_SCALE = 0.02;
const MAX_IMPORT_SCARCITY_MULTIPLIER = 12;
const IMPORT_SPAWN_MARGIN_SCALE = 0.01;
const MAX_IMPORT_SPAWN_SCARCITY_MULTIPLIER = 4;

const importMargin = (
  entry: ImportPaletteEntry,
  target: CityImportTarget,
  oneWayHexes: number,
  globalPrices: ReadonlyMap<ResourceId, number>,
): number | null => {
  const local = target.localPrices?.get(entry.resource);
  if (local === undefined || !Number.isFinite(local) || local <= 0) return null;
  const global = globalPrices.get(entry.resource);
  if (global === undefined || !Number.isFinite(global) || global <= 0) return null;
  return local - global - transportCostPerUnit(entry.resource, oneWayHexes);
};

const bestImportMarginForTarget = (
  edgeHex: Hex,
  target: CityImportTarget,
  palette: readonly ImportPaletteEntry[],
  globalPrices: ReadonlyMap<ResourceId, number>,
): number | null => {
  const oneWay = hexDistance(edgeHex, target.hex);
  let best: number | null = null;
  for (const entry of palette) {
    if (entry.weight <= 0) continue;
    const margin = importMargin(entry, target, oneWay, globalPrices);
    if (margin === null || margin <= 0) continue;
    if (best === null || margin > best) best = margin;
  }
  return best;
};

const pickImportTarget = (
  edgeHex: Hex,
  targets: readonly CityImportTarget[],
  palette: readonly ImportPaletteEntry[],
  globalPrices: ReadonlyMap<ResourceId, number>,
): CityImportTarget | null => {
  if (targets.length === 0) return null;

  const profitable = targets
    .map((target) => ({
      target,
      margin: bestImportMarginForTarget(edgeHex, target, palette, globalPrices),
      distance: hexDistance(edgeHex, target.hex),
    }))
    .filter(
      (candidate): candidate is { target: CityImportTarget; margin: number; distance: number } =>
        candidate.margin !== null,
    );

  if (profitable.length > 0) {
    profitable.sort((a, b) => {
      if (b.margin !== a.margin) return b.margin - a.margin;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return String(a.target.settlementId).localeCompare(String(b.target.settlementId));
    });
    return profitable[0]?.target ?? null;
  }

  return null;
};

const pickImportCargo = (
  edgeHex: Hex,
  target: CityImportTarget,
  palette: readonly ImportPaletteEntry[],
  globalPrices: ReadonlyMap<ResourceId, number>,
  rng: Rng,
): ImportPaletteEntry | null => {
  if (palette.length === 0) return null;
  const oneWay = hexDistance(edgeHex, target.hex);
  const profitable: WeightedImportEntry[] = [];
  for (const entry of palette) {
    if (entry.weight <= 0) continue;
    const margin = importMargin(entry, target, oneWay, globalPrices);
    if (margin === null || margin <= 0) continue;
    const scarcityMultiplier = Math.min(
      MAX_IMPORT_SCARCITY_MULTIPLIER,
      1 + margin * IMPORT_MARGIN_WEIGHT_SCALE,
    );
    profitable.push({ entry, weight: entry.weight * scarcityMultiplier });
  }
  if (profitable.length > 0) return weightedPick(rng, profitable);
  return null;
};

const importSpawnProbabilityForEdge = (edgeHex: Hex, inputs: EdgeHubTickInputs): number => {
  let bestMargin = 0;
  for (const target of inputs.cityImportTargets) {
    const margin = bestImportMarginForTarget(
      edgeHex,
      target,
      inputs.config.importPalette,
      inputs.config.globalPrices,
    );
    if (margin !== null && margin > bestMargin) bestMargin = margin;
  }
  if (bestMargin <= 0) return 0;
  const scarcityMultiplier =
    1 + Math.min(MAX_IMPORT_SPAWN_SCARCITY_MULTIPLIER, bestMargin * IMPORT_SPAWN_MARGIN_SCALE);
  return Math.min(
    1,
    inputs.config.baseImportSpawnProbPerDay *
      seasonalImportMultiplier(inputs.season) *
      scarcityMultiplier,
  );
};

const trySpawnImport = (edgeHex: Hex, inputs: EdgeHubTickInputs, rng: Rng): Caravan | null => {
  const target = pickImportTarget(
    edgeHex,
    inputs.cityImportTargets,
    inputs.config.importPalette,
    inputs.config.globalPrices,
  );
  if (target === null) return null;

  const palette = inputs.config.importPalette;
  const pick = pickImportCargo(edgeHex, target, palette, inputs.config.globalPrices, rng);
  if (pick === null) return null;
  const [minQty, maxQty] = pick.cargoKg;
  // Discrete units; round to integer for cargo bookkeeping.
  const qty = Math.max(1, Math.round(rng.float(minQty, maxQty + 1)));

  const def = getResource(pick.resource);
  const totalKg = def.weightKgPerUnit * qty;
  // Mules carry 100 kg each; size the train for the cargo + a 30% buffer.
  const muleCount = Math.max(8, Math.ceil((totalKg * 1.3) / 100));

  const caravan = createCaravan({
    id: generateCaravanId('import', inputs.today, edgeHex, rng),
    ownerActor: offMapHouse(edgeHex),
    position: edgeHex,
    destination: target.hex,
    crew: standardImportCrew(),
    animals: { mule: muleCount },
    vehicles: {},
  });
  caravan.cargo.set(pick.resource, qty);
  if (!fitCaravanLoadWithRations(caravan)) return null;
  addImportOperatingTreasury(caravan);
  return caravan;
};

// --- Exports ---------------------------------------------------------------

const bestExportFor = (
  source: CityExportSource,
  oneWayHexes: number,
  globalPrices: ReadonlyMap<ResourceId, number>,
): { resource: ResourceId; margin: number } | null => {
  let best: { resource: ResourceId; margin: number } | null = null;
  for (const [res, qty] of source.availableForExport) {
    if (qty <= 0) continue;
    const margin = estimateExportMargin(res, oneWayHexes, source.localPrices, globalPrices);
    if (margin <= 0) continue;
    if (best === null || margin > best.margin) {
      best = { resource: res, margin };
    }
  }
  return best;
};

/**
 * v1.6 venture dispatch threshold per docs/06 §"Venture dispatch
 * criterion (3× transport cost)" and docs/10 decision 39.
 *
 * A venture dispatches only when expected gross margin (qty × per-unit
 * margin) covers the round-trip transport cost three times over. The
 * 3× reflects real Roman merchant reluctance to commit capital +
 * months of time + cargo-loss risk to long-haul trade unless the
 * upside is well above bare break-even. The check uses the same
 * estimateExportMargin numbers the legacy spawn path used, but now
 * gates dispatch on the cumulative-over-cargo margin rather than the
 * per-unit margin being positive.
 */
const VENTURE_PROFIT_MULTIPLIER = 3;

const trySpawnExport = (
  source: CityExportSource,
  inputs: EdgeHubTickInputs,
  rng: Rng,
): Caravan | null => {
  const edge = nearest(inputs.config.edgeHexes, source.hex, (h) => h);
  if (edge === null) return null;
  const oneWay = hexDistance(source.hex, edge);
  const choice = bestExportFor(source, oneWay, inputs.config.globalPrices);
  if (choice === null) return null;

  const available = source.availableForExport.get(choice.resource) ?? 0;
  // Cap export size at what one large-caravan-class mule train + wagons
  // can plausibly carry. Per docs/06 a heavy-wagon ox-team holds ~1.2 t
  // and a full caravan with multiple wagons + 30+ mules can move several
  // tonnes. A 6-tonne cap gives the export pipeline enough drain rate
  // to handle bloat without making caravans the size of armies. Pre-
  // v1.6 this was 1.5 t — too small to drain stockpiles measured in
  // thousands of tonnes, so cities accumulated multi-year reserves.
  const def = getResource(choice.resource);
  const maxKg = 6000;
  const maxUnits = Math.max(1, Math.floor(maxKg / def.weightKgPerUnit));
  const qty = Math.min(available, maxUnits);
  if (qty <= 0) return null;

  // v1.6 3× transport-cost dispatch threshold (docs/06 §"Venture
  // dispatch criterion", docs/10 decision 39). estimateExportMargin
  // returns per-unit margin = global - local - transport_per_unit;
  // total expected profit = qty × (global - local) - qty × transport.
  // Round-trip transport cost is qty × transportCostPerUnit. Dispatch
  // requires gross_profit >= 3 × transport_cost, i.e. the per-unit
  // margin must be >= 3 × transport_per_unit MINUS the savings from
  // already pricing transport into margin. Equivalent rearrangement:
  //   global - local >= 4 × transport_per_unit
  // which is what we check below. Without this gate any positive-
  // margin route would fire, including razor-thin opportunities that
  // don't justify the multi-month round trip.
  const tCostPerUnit = transportCostPerUnit(choice.resource, oneWay);
  const grossPerUnit = choice.margin + tCostPerUnit; // = global - local
  if (grossPerUnit < (VENTURE_PROFIT_MULTIPLIER + 1) * tCostPerUnit) return null;

  const totalKg = def.weightKgPerUnit * qty;
  const muleCount = Math.max(6, Math.ceil((totalKg * 1.3) / 100));

  const caravan = createCaravan({
    id: generateCaravanId('export', inputs.today, edge, rng),
    ownerActor: source.ownerActor,
    position: source.hex,
    destination: edge,
    crew: standardExportCrew(),
    animals: { mule: muleCount },
    vehicles: {},
    // Per v1.6 docs/06 §"International ventures": export caravans round-
    // trip - they walk to the edge hex, conduct the 20-tick off-map
    // sojourn, and walk back to the dispatching settlement. Capture
    // the origin so the post-sojourn re-routing can send them home.
    originSettlement: source.settlementId,
  });
  caravan.cargo.set(choice.resource, qty);
  if (!fitCaravanLoadWithRations(caravan)) return null;
  return caravan;
};

// --- Tick ------------------------------------------------------------------

export const tickEdgeHubs = (inputs: EdgeHubTickInputs): EdgeHubResult => {
  const importsRng = inputs.rng.derive('edge-hub-imports');
  const exportsRng = inputs.rng.derive('edge-hub-exports');
  const importRoom =
    inputs.config.maxActiveImportCaravans === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          inputs.config.maxActiveImportCaravans - (inputs.config.activeImportCaravans ?? 0),
        );
  const exportRoom =
    inputs.config.maxActiveExportCaravans === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          inputs.config.maxActiveExportCaravans - (inputs.config.activeExportCaravans ?? 0),
        );
  const maxImports = Math.min(
    inputs.config.maxImportSpawnsPerDay ?? Number.POSITIVE_INFINITY,
    importRoom,
  );
  const maxExports = Math.min(
    inputs.config.maxExportSpawnsPerDay ?? Number.POSITIVE_INFINITY,
    exportRoom,
  );
  const maxTotal = inputs.config.maxTotalSpawnsPerDay ?? Number.POSITIVE_INFINITY;

  const newCaravans: Caravan[] = [];
  let importSpawns = 0;
  let exportSpawns = 0;

  // Imports: roll per edge hex. The base cadence is seasonal, then scarcity
  // raises it when landed margins are high. Daily and active-fleet caps below
  // still prevent burst spawns.
  for (let i = 0; i < inputs.config.edgeHexes.length; i++) {
    if (importSpawns >= maxImports || newCaravans.length >= maxTotal) break;
    const edge = inputs.config.edgeHexes[i] as Hex;
    const subRng = importsRng.derive(`edge-${i}`);
    const importP = importSpawnProbabilityForEdge(edge, inputs);
    if (importP <= 0) continue;
    if (!subRng.chance(importP)) continue;
    const caravan = trySpawnImport(edge, inputs, subRng);
    if (caravan !== null) {
      newCaravans.push(caravan);
      importSpawns += 1;
    }
  }

  // Exports: roll per city source.
  const exportP = inputs.config.baseExportSpawnProbPerDay * seasonalExportMultiplier(inputs.season);
  for (let i = 0; i < inputs.cityExportSources.length; i++) {
    if (exportSpawns >= maxExports || newCaravans.length >= maxTotal) break;
    const src = inputs.cityExportSources[i] as CityExportSource;
    const subRng = exportsRng.derive(`city-${i}-${String(src.settlementId)}`);
    if (!subRng.chance(exportP)) continue;
    const caravan = trySpawnExport(src, inputs, subRng);
    if (caravan !== null) {
      newCaravans.push(caravan);
      exportSpawns += 1;
    }
  }

  return {
    newCaravans,
    returnEvents: [],
  };
};
