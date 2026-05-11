/**
 * Hex grid renderer — SVG-sprite based.
 *
 * Each tile gets a Sprite of its terrain texture (viewer/art/terrain/<t>.svg).
 * Urban hexes use the tier-specific variant based on the settlement that
 * owns the hex. Sub-tile detail (trees on forests, ripples on water, etc.)
 * is baked into the SVGs so we no longer draw it procedurally.
 *
 * Biome edges and lake shores are painted as composited overlay sprites
 * (viewer/art/biome_edges/<dir>.svg and viewer/art/lake_shore/<dir>.svg)
 * for each hex edge where the neighbor differs. Biome-edge sprites are
 * tinted to the source-terrain color via Pixi's `Sprite.tint`.
 *
 * Tints applied externally (heat-map overlays, selection highlight) still
 * use Sprite.tint and play nicely with the terrain texture.
 */

import { Container, Sprite } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, hexKey, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import type { HexTile, Terrain } from '../../src/sim/world/terrain.js';
import type { Settlement } from '../../src/sim/world/settlement.js';
import { hexToPixel } from './coords.js';
import { type ArtRegistry, type EdgeDir, EDGE_DIRS, terrainArtKey } from '../art/index.js';

const SQRT3 = Math.sqrt(3);

/** Tint color used to colorize each biome-edge feather strip (currentColor
 *  in the SVG → Pixi tint). Picked to match the terrain palette so the
 *  feather reads as "this neighbor's biome is bleeding in." */
const TERRAIN_TINT: Record<Terrain, number> = {
  plains: 0xb8b067,
  fertile_valley: 0x8aa848,
  hills: 0xb59067,
  mountains: 0x8a847e,
  forest: 0x5b7d3e,
  dense_forest: 0x365a2a,
  marsh: 0x586a3e,
  desert: 0xe8c98a,
  steppe: 0xc3b07a,
  river: 0x4a86a8,
  lake: 0x4a82a8,
  urban: 0xa08c63,
  ruin: 0x7c6e54,
};

type BiomeCategory =
  | 'agricultural'
  | 'forest'
  | 'water'
  | 'highland'
  | 'wasteland'
  | 'built';

const TERRAIN_CATEGORY: Record<Terrain, BiomeCategory> = {
  plains: 'agricultural',
  fertile_valley: 'agricultural',
  forest: 'forest',
  dense_forest: 'forest',
  lake: 'water',
  river: 'water',
  hills: 'highland',
  mountains: 'highland',
  desert: 'wasteland',
  steppe: 'wasteland',
  marsh: 'wasteland',
  urban: 'built',
  ruin: 'built',
};

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
  // Sort largest-first so a later (smaller) settlement doesn't overwrite a
  // bigger one if they happen to share a hex.
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
  const edges = new Container();
  edges.label = 'biomeEdges';
  edges.eventMode = 'none';
  container.addChild(fills);
  container.addChild(edges);

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

  // Biome edges + lake shores. Iterate every (tile, direction) pair once.
  // - Biome edge: when the neighbor is a different biome category we add a
  //   feather strip tinted to the source terrain color.
  // - Lake shore: when this tile is a lake AND the neighbor is land, we
  //   add a sandy shore band along the shared edge.
  for (const [h, tile] of grid.tiles()) {
    const px = hexToPixel(h, hexSize);
    const myCat = TERRAIN_CATEGORY[tile.terrain];
    for (let d = 0; d < 6; d++) {
      const dir = HEX_DIRECTIONS[d] as Hex;
      const nHex = hexAdd(h, dir);
      const nTile = grid.get(nHex);
      if (nTile === undefined) continue;
      const dirName = EDGE_DIRS[d] as EdgeDir;

      // Biome-edge feather (skip same-category boundaries).
      const nCat = TERRAIN_CATEGORY[nTile.terrain];
      if (nCat !== myCat) {
        const feather = new Sprite(art.biomeEdge(dirName));
        feather.anchor.set(0.5, 0.5);
        feather.width = spriteW;
        feather.height = spriteH;
        feather.position.set(px.x, px.y);
        feather.tint = TERRAIN_TINT[tile.terrain];
        edges.addChild(feather);
      }

      // Lake shore (this tile is lake, neighbor is land).
      if (tile.terrain === 'lake' && nCat !== 'water') {
        const shore = new Sprite(art.lakeShore(dirName));
        shore.anchor.set(0.5, 0.5);
        shore.width = spriteW;
        shore.height = spriteH;
        shore.position.set(px.x, px.y);
        edges.addChild(shore);
      }
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

const _suppressUnused = (_t: HexTile): void => undefined;
void _suppressUnused;
