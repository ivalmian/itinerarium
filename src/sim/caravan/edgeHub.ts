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
import { createCaravan, type Caravan, type CrewMember } from './caravan.js';

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
export const DEFAULT_GLOBAL_PRICES: ReadonlyMap<ResourceId, number> = new Map<ResourceId, number>([
  // Bulk — ordinary trade
  [resourceId('food.grain'), 1.5],
  // Amphora-packed: heavy per unit but command long-haul prices
  // when surplus depresses the local market (docs/08 §"luxuries").
  [resourceId('food.olive_oil'), 150],
  [resourceId('food.wine'), 200],
  [resourceId('food.cheese'), 5],
  // Manufactured ordinary
  [resourceId('goods.cloth'), 12],
  [resourceId('goods.tools'), 25],
  [resourceId('goods.weapons'), 40],
  [resourceId('goods.armor'), 80],
  // Status / luxury
  [resourceId('goods.luxury_textiles'), 100],
  [resourceId('metal.silver'), 700],
  [resourceId('metal.gold'), 8000],
  // Exotics (imports priced as what they fetch in-province; imports buy
  // these from off-map at lower prices and land them at this number).
  [resourceId('exotic.spices'), 80],
  [resourceId('exotic.silk'), 200],
  [resourceId('exotic.incense'), 60],
  [resourceId('exotic.dyes'), 120],
  // People as cargo
  [resourceId('people.slave'), 600],
]);

export interface ImportPaletteEntry {
  readonly resource: ResourceId;
  readonly weight: number;
  /** Cargo amount in resource UNITS (not kg), drawn uniformly per spawn. */
  readonly cargoKg: readonly [min: number, max: number];
}

/**
 * Default palette of exotic imports. Cargo amounts are in *units*
 * of the resource (matching c.cargo's unit convention). Spices,
 * silk, incense are 1 kg/unit so units ≈ kg.
 */
export const DEFAULT_IMPORT_PALETTE: readonly ImportPaletteEntry[] = [
  { resource: resourceId('exotic.spices'), weight: 4, cargoKg: [200, 800] },
  { resource: resourceId('exotic.silk'), weight: 2, cargoKg: [100, 400] },
  { resource: resourceId('exotic.incense'), weight: 3, cargoKg: [200, 600] },
  { resource: resourceId('exotic.dyes'), weight: 2, cargoKg: [200, 500] },
  { resource: resourceId('people.slave'), weight: 2, cargoKg: [10, 40] },
];

// --- Types -----------------------------------------------------------------

export interface EdgeHubConfig {
  readonly edgeHexes: readonly Hex[];
  readonly globalPrices: ReadonlyMap<ResourceId, number>;
  readonly baseImportSpawnProbPerDay: number;
  readonly baseExportSpawnProbPerDay: number;
  readonly importPalette: readonly ImportPaletteEntry[];
}

export interface CityImportTarget {
  readonly settlementId: SettlementId;
  readonly hex: Hex;
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

const weightedPick = (rng: Rng, entries: readonly ImportPaletteEntry[]): ImportPaletteEntry => {
  let total = 0;
  for (const e of entries) total += e.weight;
  let roll = rng.next() * total;
  for (const e of entries) {
    roll -= e.weight;
    if (roll <= 0) return e;
  }
  // Fallback for floating-point drift: last entry.
  return entries[entries.length - 1] as ImportPaletteEntry;
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

const trySpawnImport = (edgeHex: Hex, inputs: EdgeHubTickInputs, rng: Rng): Caravan | null => {
  const target = nearest(inputs.cityImportTargets, edgeHex, (t) => t.hex);
  if (target === null) return null;

  const palette = inputs.config.importPalette;
  if (palette.length === 0) return null;
  const pick = weightedPick(rng, palette);
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
  // Cap export size at what one mule train of plausible size can carry —
  // otherwise a city with mountains of silver would spawn caravans the
  // size of small armies. Use a simple cap of 1.5 t cargo.
  const def = getResource(choice.resource);
  const maxKg = 1500;
  const maxUnits = Math.max(1, Math.floor(maxKg / def.weightKgPerUnit));
  const qty = Math.min(available, maxUnits);
  if (qty <= 0) return null;

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
  });
  caravan.cargo.set(choice.resource, qty);
  return caravan;
};

// --- Tick ------------------------------------------------------------------

export const tickEdgeHubs = (inputs: EdgeHubTickInputs): EdgeHubResult => {
  const importsRng = inputs.rng.derive('edge-hub-imports');
  const exportsRng = inputs.rng.derive('edge-hub-exports');

  const newCaravans: Caravan[] = [];

  // Imports: roll per edge hex.
  const importP = inputs.config.baseImportSpawnProbPerDay * seasonalImportMultiplier(inputs.season);
  for (let i = 0; i < inputs.config.edgeHexes.length; i++) {
    const edge = inputs.config.edgeHexes[i] as Hex;
    const subRng = importsRng.derive(`edge-${i}`);
    if (!subRng.chance(importP)) continue;
    const caravan = trySpawnImport(edge, inputs, subRng);
    if (caravan !== null) newCaravans.push(caravan);
  }

  // Exports: roll per city source.
  const exportP = inputs.config.baseExportSpawnProbPerDay * seasonalExportMultiplier(inputs.season);
  for (let i = 0; i < inputs.cityExportSources.length; i++) {
    const src = inputs.cityExportSources[i] as CityExportSource;
    const subRng = exportsRng.derive(`city-${i}-${String(src.settlementId)}`);
    if (!subRng.chance(exportP)) continue;
    const caravan = trySpawnExport(src, inputs, subRng);
    if (caravan !== null) newCaravans.push(caravan);
  }

  return {
    newCaravans,
    returnEvents: [],
  };
};
