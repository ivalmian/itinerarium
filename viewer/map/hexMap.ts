/**
 * Hex grid renderer — SVG-sprite based.
 *
 * Each tile gets a Sprite of its terrain texture (viewer/art/terrain/<t>.svg).
 * Urban hexes use the tier-specific variant based on the settlement that
 * owns the hex. Sub-tile detail (trees on forests, ripples on water, etc.)
 * is baked into the SVGs so we no longer draw it procedurally.
 *
 * Adjacent hexes blend at their shared edges naturally — the painterly-vector
 * SVGs fill their hex shape exactly, with no explicit dark outline or
 * darkening feather. Lake shores are still painted as composited overlay
 * sprites (viewer/art/lake_shore/<dir>.svg) for each lake edge where the
 * neighbor is land, because the sandy shore adds a distinct visual feature
 * rather than just darkening the boundary.
 *
 * Tints applied externally (heat-map overlays, selection highlight) still
 * use Sprite.tint and play nicely with the terrain texture.
 */

import { Container, Sprite } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, hexKey, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import type { Terrain } from '../../src/sim/world/terrain.js';
import type { Settlement } from '../../src/sim/world/settlement.js';
import { hexToPixel } from './coords.js';
import { type ArtRegistry, type EdgeDir, EDGE_DIRS, terrainArtKey } from '../art/index.js';

const SQRT3 = Math.sqrt(3);

/** Categories used only to decide whether a lake hex needs a shore overlay
 *  on a given edge. */
const WATER_TERRAINS: ReadonlySet<Terrain> = new Set(['river', 'lake']);

export interface HexMap {
  readonly container: Container;
  /** Mutate the tint of a single hex (0xrrggbb). null restores terrain color. */
  setTint(h: Hex, color: number | null): void;
  /** Bulk reset all tints to terrain colors. */
  clearTints(): void;
  /** Bounds of the hex layer in container-local pixels. */
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface HexEntry {
  readonly sprite: Sprite;
}

/**
 * Build a per-hex map of settlement tier for urban hexes. A hex belongs to
 * at most one settlement's urban footprint; if multiple claim it (shouldn't
 * happen) we pick the largest by population.
 */
const buildUrbanTierLookup = (
  settlements: readonly Settlement[],
): Map<string, Settlement['tier']> => {
  const out = new Map<string, Settlement['tier']>();
  const sorted = settlements.slice().sort((a, b) => b.population.total() - a.population.total());
  for (const s of sorted) {
    for (const h of s.urbanHexes) {
      const k = hexKey(h);
      if (!out.has(k)) out.set(k, s.tier);
    }
  }
  return out;
};

export const createHexMap = (
  grid: HexGrid,
  hexSize: number,
  art: ArtRegistry,
  settlements: Iterable<Settlement>,
): HexMap => {
  const container = new Container();
  container.label = 'hexMap';
  const fills = new Container();
  fills.label = 'hexFills';
  const shores = new Container();
  shores.label = 'lakeShores';
  shores.eventMode = 'none';
  container.addChild(fills);
  container.addChild(shores);

  const entries = new Map<string, HexEntry>();
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  // Hex sprite dimensions on screen (pointy-top, radius = hexSize).
  const spriteW = SQRT3 * hexSize;
  const spriteH = 2 * hexSize;

  const urbanTierByHex = buildUrbanTierLookup(Array.from(settlements));

  for (const [h, tile] of grid.tiles()) {
    const px = hexToPixel(h, hexSize);
    const key = hexKey(h);
    const urbanTier = tile.terrain === 'urban' ? urbanTierByHex.get(key) : undefined;
    const tex = art.terrain(terrainArtKey(tile.terrain, urbanTier));
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    sprite.width = spriteW;
    sprite.height = spriteH;
    sprite.position.set(px.x, px.y);
    fills.addChild(sprite);
    entries.set(key, { sprite });
    if (px.x < bounds.minX) bounds.minX = px.x;
    if (px.y < bounds.minY) bounds.minY = px.y;
    if (px.x > bounds.maxX) bounds.maxX = px.x;
    if (px.y > bounds.maxY) bounds.maxY = px.y;
  }

  // Lake shores: for each lake edge where the neighbor is land, overlay
  // the sandy shore band. (No biome-edge darkening — terrain SVGs already
  // blend at their shared edges naturally.)
  for (const [h, tile] of grid.tiles()) {
    if (tile.terrain !== 'lake') continue;
    const px = hexToPixel(h, hexSize);
    for (let d = 0; d < 6; d++) {
      const dir = HEX_DIRECTIONS[d] as Hex;
      const nHex = hexAdd(h, dir);
      const nTile = grid.get(nHex);
      if (nTile === undefined) continue;
      if (WATER_TERRAINS.has(nTile.terrain)) continue;
      const dirName = EDGE_DIRS[d] as EdgeDir;
      const shore = new Sprite(art.lakeShore(dirName));
      shore.anchor.set(0.5, 0.5);
      shore.width = spriteW;
      shore.height = spriteH;
      shore.position.set(px.x, px.y);
      shores.addChild(shore);
    }
  }

  const setTint = (h: Hex, color: number | null): void => {
    const e = entries.get(hexKey(h));
    if (e === undefined) return;
    e.sprite.tint = color === null ? 0xffffff : color;
  };

  const clearTints = (): void => {
    for (const e of entries.values()) e.sprite.tint = 0xffffff;
  };

  return { container, setTint, clearTints, bounds };
};
