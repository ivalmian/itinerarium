/**
 * ASCII map dumper for the burn-in CLI and ad-hoc debugging.
 *
 * Renders a WorldState as ASCII so a human can squint at the procgen output
 * and the burn-in evolution without booting a graphical UI. Used by:
 *   - the burn-in CLI (T30) for periodic visual snapshots,
 *   - hand debugging during procgen tuning,
 *   - test fixtures that want a visual diff on changes.
 *
 * Coordinate system: we use plain (q, r) → (column, row) projection. This is
 * not a true pointy-top isometric layout (a hex's neighbours aren't all
 * adjacent in the ASCII grid), but it preserves locality well enough to make
 * roads/clusters/coastlines visible at a glance. Hex (q, r) renders at
 * column (q - bounds.qMin) of row (r - bounds.rMin).
 *
 * If the requested width exceeds `maxWidthChars`, we downsample columns by
 * stepping every Nth q-value. Rows are not currently downsampled (debug
 * output is usually wider than tall).
 */

import type { BanditCamp } from '../sim/bandit/camp.js';
import type { NewsCarrier } from '../sim/reputation/news.js';
import type { Hex } from '../sim/world/hex.js';
import { hexKey } from '../sim/world/hex.js';
import type { Settlement } from '../sim/world/settlement.js';
import type { HexTile, RoadGrade, Terrain } from '../sim/world/terrain.js';
import { resourceId, type SettlementId } from '../sim/types.js';
import type { WorldState } from '../procgen/seed.js';

export interface AsciiMapBounds {
  readonly qMin: number;
  readonly qMax: number;
  readonly rMin: number;
  readonly rMax: number;
}

export interface AsciiMapOpts {
  readonly bounds: AsciiMapBounds;
  /** Capitalize anchor, lowercase suburbs. Default true. */
  readonly showSettlements?: boolean;
  readonly showCaravans?: boolean;
  /** Roman roads switch to uppercase variant; dirt roads to underscore. Default true. */
  readonly showRoads?: boolean;
  readonly showBandits?: boolean;
  /** Width budget; columns downsample if exceeded. Default 120. */
  readonly maxWidthChars?: number;
}

/** Optional auxiliary data the renderer overlays on top of the WorldState. */
export interface AsciiMapAux {
  readonly banditCamps?: readonly BanditCamp[];
  readonly newsCarriers?: readonly NewsCarrier[];
}

// --- Glyph palette ----------------------------------------------------------

const TERRAIN_GLYPH: Record<Terrain, string> = {
  plains: '.',
  fertile_valley: ',',
  hills: '^',
  mountains: 'M',
  forest: 'f',
  dense_forest: 'F',
  marsh: '"',
  desert: '*',
  steppe: 's',
  coast: '_',
  river: '~',
  lake: '≈',
  urban: '#',
  ruin: 'r',
};

/**
 * Roman road overlay: uppercase the lowercase terrain glyphs to indicate the
 * paved arterial. Mountains/M are already uppercase, so we use '=' for any
 * already-upper terrain to mark the road. Dirt road = underscore overlay.
 */
const applyRoadOverlay = (base: string, road: RoadGrade): string => {
  if (road === 'none') return base;
  if (road === 'roman') {
    if (base === '.') return '=';
    if (base === ',') return '+';
    if (base === '^') return 'A';
    if (base === 'f') return 'F';
    if (base === '~') return '!';
    if (base === '_') return '-';
    return base.toUpperCase() === base ? '=' : base.toUpperCase();
  }
  // Dirt road.
  if (base === '.') return '_';
  if (base === ',') return ';';
  return base; // leave hilly/forest/water unchanged for dirt
};

// --- Caravan direction glyph -----------------------------------------------

const directionGlyph = (from: Hex, to: Hex | null): string => {
  if (to === null) return 'o';
  const dq = to.q - from.q;
  const dr = to.r - from.r;
  if (dq === 0 && dr === 0) return 'o';
  // Pointy-top hexes: r increases roughly southward, q increases eastward.
  if (Math.abs(dq) >= Math.abs(dr)) {
    return dq > 0 ? '>' : '<';
  }
  return dr > 0 ? 'v' : '^';
};

// --- Per-cell resolver ------------------------------------------------------

interface OverlayState {
  // Higher priority wins. From low to high:
  //   terrain (always shown)
  //   road overlay
  //   news carrier (i)
  //   bandit camp (b)
  //   caravan (>v<^o)
  //   settlement (X / x)
  glyph: string;
  priority: number;
}

const PR_BASE = 0;
const PR_NEWS = 10;
const PR_BANDIT = 20;
const PR_CARAVAN = 30;
const PR_SETTLEMENT_SUBURB = 40;
const PR_SETTLEMENT_ANCHOR = 50;

const setIfHigher = (cell: OverlayState, glyph: string, priority: number): void => {
  if (priority >= cell.priority) {
    cell.glyph = glyph;
    cell.priority = priority;
  }
};

const renderTileGlyph = (tile: HexTile, showRoads: boolean): string => {
  const base = TERRAIN_GLYPH[tile.terrain];
  return showRoads ? applyRoadOverlay(base, tile.road) : base;
};

// --- Main renderer ----------------------------------------------------------

const DEFAULT_MAX_WIDTH = 120;

export const renderAsciiMap = (
  world: WorldState,
  opts: AsciiMapOpts,
  aux: AsciiMapAux = {},
): string => {
  const showSettlements = opts.showSettlements !== false;
  const showCaravans = opts.showCaravans !== false;
  const showRoads = opts.showRoads !== false;
  const showBandits = opts.showBandits !== false;
  const maxWidth = Math.max(10, Math.floor(opts.maxWidthChars ?? DEFAULT_MAX_WIDTH));

  const { qMin, qMax, rMin, rMax } = opts.bounds;
  const fullW = Math.max(1, qMax - qMin + 1);
  const fullH = Math.max(1, rMax - rMin + 1);
  // Downsample step in q so output ≤ maxWidth chars wide. We do not
  // downsample r — debug output usually wants to see every row.
  const colStep = Math.max(1, Math.ceil(fullW / maxWidth));
  const cols = Math.ceil(fullW / colStep);

  // Build the per-cell overlay buffer. Default glyph is space (no tile).
  const cells: OverlayState[][] = [];
  for (let row = 0; row < fullH; row++) {
    const rowCells: OverlayState[] = [];
    for (let col = 0; col < cols; col++) {
      rowCells.push({ glyph: ' ', priority: -1 });
    }
    cells.push(rowCells);
  }

  // Map (q, r) → (col, row). Returns null if the hex is outside the bounds or
  // doesn't survive downsampling.
  const project = (h: Hex): { col: number; row: number } | null => {
    if (h.q < qMin || h.q > qMax) return null;
    if (h.r < rMin || h.r > rMax) return null;
    const dq = h.q - qMin;
    if (dq % colStep !== 0) return null;
    const col = Math.floor(dq / colStep);
    const row = h.r - rMin;
    return { col, row };
  };

  // 1. Base terrain layer.
  for (const [h, tile] of world.grid.tiles()) {
    const p = project(h);
    if (p === null) continue;
    const cell = cells[p.row]?.[p.col];
    if (cell === undefined) continue;
    setIfHigher(cell, renderTileGlyph(tile, showRoads), PR_BASE);
  }

  // 2. News carriers (low priority — can be overdrawn by anything).
  if (aux.newsCarriers !== undefined) {
    for (const c of aux.newsCarriers) {
      const p = project(c.position);
      if (p === null) continue;
      const cell = cells[p.row]?.[p.col];
      if (cell === undefined) continue;
      setIfHigher(cell, 'i', PR_NEWS);
    }
  }

  // 3. Bandit camps.
  if (showBandits && aux.banditCamps !== undefined) {
    for (const camp of aux.banditCamps) {
      const p = project(camp.hex);
      if (p === null) continue;
      const cell = cells[p.row]?.[p.col];
      if (cell === undefined) continue;
      setIfHigher(cell, 'b', PR_BANDIT);
    }
  }

  // 4. Caravans.
  if (showCaravans) {
    for (const c of world.caravans.values()) {
      const p = project(c.position);
      if (p === null) continue;
      const cell = cells[p.row]?.[p.col];
      if (cell === undefined) continue;
      setIfHigher(cell, directionGlyph(c.position, c.destination), PR_CARAVAN);
    }
  }

  // 5. Settlements (highest priority — they're what the player tracks).
  if (showSettlements) {
    for (const s of world.settlements.values()) {
      const initial = s.name.charAt(0);
      const upper = initial.toUpperCase();
      const lower = initial.toLowerCase();
      // Anchor uppercase.
      const anchorP = project(s.anchor);
      if (anchorP !== null) {
        const cell = cells[anchorP.row]?.[anchorP.col];
        if (cell !== undefined) setIfHigher(cell, upper, PR_SETTLEMENT_ANCHOR);
      }
      // Other urban hexes lowercase.
      for (const u of s.urbanHexes) {
        if (u.q === s.anchor.q && u.r === s.anchor.r) continue;
        const p = project(u);
        if (p === null) continue;
        const cell = cells[p.row]?.[p.col];
        if (cell === undefined) continue;
        setIfHigher(cell, lower, PR_SETTLEMENT_SUBURB);
      }
    }
  }

  return cells.map((row) => row.map((c) => c.glyph).join('')).join('\n');
};

// --- Settlement summary -----------------------------------------------------

const GRAIN_KG_PER_DAY = 0.4;
const KG_PER_MODIUS = 6.7;

const grainDaysOfReserve = (world: WorldState, settlement: Settlement): number => {
  const totalPop = settlement.population.total();
  if (totalPop <= 0) return 0;
  let totalModii = 0;
  for (const ownerId of settlement.stockpileOwners) {
    const actor = world.actors.get(ownerId);
    if (actor === undefined) continue;
    const grain = actor.stockpile.get(resourceId('food.grain')) ?? 0;
    totalModii += grain;
  }
  const kg = totalModii * KG_PER_MODIUS;
  const dailyKg = totalPop * GRAIN_KG_PER_DAY;
  if (dailyKg <= 0) return 0;
  return Math.floor(kg / dailyKg);
};

const caravanCountAtSettlement = (world: WorldState, settlement: Settlement): number => {
  const urbanKeys = new Set(settlement.urbanHexes.map(hexKey));
  let count = 0;
  for (const c of world.caravans.values()) {
    if (urbanKeys.has(hexKey(c.position))) count++;
  }
  return count;
};

const factionAbbreviations = (world: WorldState, settlement: Settlement): string => {
  const initials: string[] = [];
  for (const fId of settlement.factions) {
    const f = world.factions.get(fId);
    if (f === undefined) continue;
    initials.push(f.name.charAt(0).toUpperCase());
  }
  return `{${initials.join(',')}}`;
};

const tierLabel: Record<Settlement['tier'], string> = {
  hamlet: 'Hamlet',
  village: 'Village',
  town: 'Town',
  small_city: 'City',
  large_city: 'City',
};

export const renderSettlementSummary = (world: WorldState, id: SettlementId): string => {
  const s = world.settlements.get(id);
  if (s === undefined) {
    throw new Error(`renderSettlementSummary: unknown settlement ${String(id)}`);
  }
  const pop = s.population.total();
  const grainDays = grainDaysOfReserve(world, s);
  const caravans = caravanCountAtSettlement(world, s);
  const factions = factionAbbreviations(world, s);
  return `${tierLabel[s.tier]} ${s.name} (${pop}) [g:${grainDays}d c:${caravans}] ${factions}`;
};

// --- Whole-snapshot convenience --------------------------------------------

const computeWorldBounds = (world: WorldState): AsciiMapBounds => {
  let qMin = Infinity;
  let qMax = -Infinity;
  let rMin = Infinity;
  let rMax = -Infinity;
  let any = false;
  for (const h of world.grid.hexes()) {
    any = true;
    if (h.q < qMin) qMin = h.q;
    if (h.q > qMax) qMax = h.q;
    if (h.r < rMin) rMin = h.r;
    if (h.r > rMax) rMax = h.r;
  }
  if (!any) return { qMin: 0, qMax: 0, rMin: 0, rMax: 0 };
  return { qMin, qMax, rMin, rMax };
};

export const renderWorldSnapshot = (world: WorldState, aux: AsciiMapAux = {}): string => {
  const bounds = computeWorldBounds(world);
  const map = renderAsciiMap(world, { bounds }, aux);
  const header = `Day ${world.day} — ${world.settlements.size} settlements, ${world.caravans.size} caravans`;
  // Sort settlements by name so the summary is deterministic.
  const summaries = [...world.settlements.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => renderSettlementSummary(world, s.id));
  return [header, map, ...summaries].join('\n');
};
