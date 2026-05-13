/**
 * Edge-hub off-map trade phase (docs/06 + docs/08).
 *
 * Per docs/06 §"Edge-hub caravans" + docs/08 §"off-map global
 * market": exotic imports + high-value exports cross the map's
 * perimeter via real `Caravan` instances spawned at edge hexes
 * every `EDGE_HUB_DISPATCH_INTERVAL_DAYS` days.
 *
 * Why it's not "every passable perimeter hex": off-map trade
 * physically routes through a small number of abstract border
 * gates, not every coast or pass, so we choose ~8 evenly-spaced
 * gates from the buildable perimeter. This keeps imports/exports
 * a paced long-haul flow instead of random-looking perimeter
 * bursts.
 *
 * Also exported (used by the movement / caravan-arrival code still
 * inline in tick.ts):
 *   - `isEdgeHubImportCaravan(c)` — predicate for incoming-import
 *     caravans, used by the off-map-import-return arrival check
 *   - `edgeHubHomeGateForCaravan(c, edgeHexKeys)` — resolves an
 *     off-map-house caravan's owner-id back to the gate hex it
 *     came from
 *   - `EDGE_HUB_IMPORT_CARAVAN_PREFIX` / `_EXPORT_` — caravan-id
 *     prefixes (the caravan replan pass skips re-planning for
 *     these because they have hard-coded routes)
 */

import { createActor, removeStockAt, type Actor } from '../politics/actor.js';
import { MAX_ACTIVE_WORLD_CARAVANS } from '../caravan/limits.js';
import {
  tickEdgeHubs,
  DEFAULT_GLOBAL_PRICES,
  DEFAULT_IMPORT_PALETTE,
} from '../caravan/edgeHub.js';
import type { Caravan } from '../caravan/caravan.js';
import type { Rng } from '../rng.js';
import type {
  ActorId,
  Day,
  Quantity,
  ResourceId,
  SettlementId,
} from '../types.js';
import { hexKey, parseHexKey, type Hex } from '../world/hex.js';
import type { Season } from '../world/terrain.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

export const EDGE_HUB_IMPORT_CARAVAN_PREFIX = 'import-';
export const EDGE_HUB_EXPORT_CARAVAN_PREFIX = 'export-';
const OFF_MAP_HOUSE_OWNER_PREFIX = 'off-map-house-';
const EDGE_HUB_MAX_ACTIVE_IMPORT_CARAVANS = 12;
const EDGE_HUB_MAX_ACTIVE_EXPORT_CARAVANS = 8;
const EDGE_HUB_DISPATCH_INTERVAL_DAYS = 3;
const EDGE_HUB_GATE_COUNT = 8;

const EMPTY_RESOURCE_MAP: ReadonlyMap<ResourceId, Quantity> = new Map();

export const isEdgeHubImportCaravan = (caravan: Caravan): boolean =>
  String(caravan.id).startsWith(EDGE_HUB_IMPORT_CARAVAN_PREFIX) &&
  String(caravan.ownerActor).startsWith(OFF_MAP_HOUSE_OWNER_PREFIX);

export const edgeHubHomeGateForCaravan = (
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
): Hex | null => {
  const owner = String(caravan.ownerActor);
  if (!owner.startsWith(OFF_MAP_HOUSE_OWNER_PREFIX)) return null;
  const key = owner.slice(OFF_MAP_HOUSE_OWNER_PREFIX.length);
  let h: Hex;
  try {
    h = parseHexKey(key);
  } catch {
    return null;
  }
  return edgeHexKeys.has(hexKey(h)) ? h : null;
};

const activeEdgeHubCaravanCounts = (
  world: WorldState,
): { readonly imports: number; readonly exports: number } => {
  let imports = 0;
  let exports = 0;
  for (const caravan of world.caravans.values()) {
    const id = String(caravan.id);
    if (id.startsWith(EDGE_HUB_IMPORT_CARAVAN_PREFIX)) imports += 1;
    else if (id.startsWith(EDGE_HUB_EXPORT_CARAVAN_PREFIX)) exports += 1;
  }
  return { imports, exports };
};

const ensureCaravanOwnerActor = (world: WorldState, caravan: Caravan): void => {
  if (world.actors.has(caravan.ownerActor)) return;
  world.actors.set(
    caravan.ownerActor,
    createActor({
      id: caravan.ownerActor,
      kind: 'off_map_house',
      name: `Off-map merchant house ${String(caravan.ownerActor)}`,
      treasury: 100_000,
    }),
  );
};

const edgeHexCache: WeakMap<WorldState['grid'], readonly Hex[]> = new WeakMap();

/**
 * Buildable hexes on the grid's perimeter. Cached per-grid (the
 * caravan-arrival code calls this on every tick to check whether an
 * arriving caravan landed on a border gate).
 */
export const computeEdgeHexes = (grid: WorldState['grid']): readonly Hex[] => {
  const cached = edgeHexCache.get(grid);
  if (cached !== undefined) return cached;

  let minQ = Infinity,
    maxQ = -Infinity,
    minR = Infinity,
    maxR = -Infinity;
  for (const [h] of grid.tiles()) {
    if (h.q < minQ) minQ = h.q;
    if (h.q > maxQ) maxQ = h.q;
    if (h.r < minR) minR = h.r;
    if (h.r > maxR) maxR = h.r;
  }
  const out: Hex[] = [];
  for (const [h, t] of grid.tiles()) {
    if (h.q === minQ || h.q === maxQ || h.r === minR || h.r === maxR) {
      if (t.terrain === 'lake' || t.terrain === 'mountains') continue;
      out.push({ q: h.q, r: h.r });
    }
  }
  edgeHexCache.set(grid, out);
  return out;
};

const selectEdgeHubGates = (edgeHexes: readonly Hex[]): readonly Hex[] => {
  if (edgeHexes.length <= EDGE_HUB_GATE_COUNT) return edgeHexes;
  const sorted = edgeHexes.slice().sort((a, b) => {
    if (a.q !== b.q) return a.q - b.q;
    return a.r - b.r;
  });
  const out: Hex[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < EDGE_HUB_GATE_COUNT; i++) {
    const idx = Math.round((i * (sorted.length - 1)) / (EDGE_HUB_GATE_COUNT - 1));
    const h = sorted[Math.min(sorted.length - 1, Math.max(0, idx))] as Hex;
    const key = hexKey(h);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ q: h.q, r: h.r });
  }
  return out;
};

const remainingWorldCaravanSlots = (world: WorldState, plannedSpawns = 0): number =>
  Math.max(0, MAX_ACTIVE_WORLD_CARAVANS - world.caravans.size - plannedSpawns);

export const edgeHubPhase = (
  world: WorldState,
  season: Season,
  today: Day,
  rng: Rng,
  events: TickEvent[],
): void => {
  if (today % EDGE_HUB_DISPATCH_INTERVAL_DAYS !== 0) return;

  const edgeHexes = selectEdgeHubGates(computeEdgeHexes(world.grid));
  if (edgeHexes.length === 0) return;

  const cityImportTargets: {
    settlementId: SettlementId;
    hex: Hex;
    localPrices: ReadonlyMap<ResourceId, number>;
  }[] = [];
  const cityExportSources: {
    settlementId: SettlementId;
    hex: Hex;
    ownerActor: ActorId;
    localPrices: ReadonlyMap<ResourceId, number>;
    availableForExport: ReadonlyMap<ResourceId, Quantity>;
  }[] = [];
  for (const s of world.settlements.values()) {
    if (s.tier !== 'small_city' && s.tier !== 'large_city') continue;
    cityImportTargets.push({
      settlementId: s.id,
      hex: s.anchor,
      localPrices: s.market.lastClearingPrice,
    });
    // Pick the wealthiest patrician/city-corp owner as the export source.
    let owner: Actor | undefined;
    let bestTreasury = -1;
    for (const oId of s.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      if (a.kind !== 'patrician_family' && a.kind !== 'city_corporation') continue;
      if (a.treasury <= bestTreasury) continue;
      owner = a;
      bestTreasury = a.treasury;
    }
    if (owner === undefined) continue;
    cityExportSources.push({
      settlementId: s.id,
      hex: s.anchor,
      ownerActor: owner.id,
      localPrices: s.market.lastClearingPrice,
      availableForExport: owner.stockpile.get(s.id) ?? EMPTY_RESOURCE_MAP,
    });
  }
  if (cityImportTargets.length === 0 && cityExportSources.length === 0) return;

  const activeEdgeCaravans = activeEdgeHubCaravanCounts(world);
  const worldRoom = remainingWorldCaravanSlots(world);
  if (worldRoom <= 0) return;
  const result = tickEdgeHubs({
    config: {
      edgeHexes,
      globalPrices: DEFAULT_GLOBAL_PRICES,
      baseImportSpawnProbPerDay: 0.02,
      baseExportSpawnProbPerDay: 0.01,
      activeImportCaravans: activeEdgeCaravans.imports,
      activeExportCaravans: activeEdgeCaravans.exports,
      maxImportSpawnsPerDay: 1,
      maxExportSpawnsPerDay: 1,
      maxTotalSpawnsPerDay: Math.min(1, worldRoom),
      maxActiveImportCaravans: EDGE_HUB_MAX_ACTIVE_IMPORT_CARAVANS,
      maxActiveExportCaravans: EDGE_HUB_MAX_ACTIVE_EXPORT_CARAVANS,
      importPalette: DEFAULT_IMPORT_PALETTE,
    },
    today,
    season,
    cityImportTargets,
    cityExportSources,
    rng,
  });

  for (const c of result.newCaravans) {
    ensureCaravanOwnerActor(world, c);
    world.caravans.set(c.id, c);
    // For exports, drain the cargo from the owner's slice at their
    // home city (the city that supplied the export goods).
    const owner = world.actors.get(c.ownerActor);
    if (owner === undefined) continue;
    const sourceSettlement = owner.homeSettlement;
    if (sourceSettlement === undefined) continue;
    for (const [res, qty] of c.cargo) {
      removeStockAt(owner, sourceSettlement, res, qty);
    }
  }

  if (result.newCaravans.length > 0) {
    events.push({
      type: 'edge_hub_spawned',
      newCaravans: result.newCaravans.length,
    });
  }
};
