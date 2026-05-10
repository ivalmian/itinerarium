/**
 * Hex grid renderer.
 *
 * Each terrain hex is a single PIXI.Graphics primitive (a hex polygon) added
 * to a Container we mount under the world's pan/zoom transform. Tints are
 * mutated in place by the overlay layer, so the geometry is fixed at boot.
 *
 * 80×80 grid → 6,400 hexes. Per-frame drawing of 6,400 small Graphics nodes is
 * comfortable for WebGL. If we scale to the full 500×500 (~250k hexes) we'll
 * want a single mesh + per-vertex color, but that is out of scope for v1
 * (docs/16-viewer §"Performance budget").
 */

import { Container, Graphics } from 'pixi.js';
import { hexKey, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import type { HexTile, Terrain } from '../../src/sim/world/terrain.js';
import { hexToPixel } from './coords.js';

/**
 * Terrain palette. Picked to be readable next to the dark background and to
 * cluster naturally — earth tones for cropland, blues for water, greys for
 * mountain. Kept in one place so the legend (TODO) stays in sync.
 */
const TERRAIN_COLOR: Record<Terrain, number> = {
  plains: 0x8a8a4d,
  fertile_valley: 0x6f8b3a,
  hills: 0x9b7d4d,
  mountains: 0x6e6963,
  forest: 0x355a2f,
  dense_forest: 0x223d1e,
  marsh: 0x4f5a3a,
  desert: 0xc9b079,
  steppe: 0xa39768,
  coast: 0x6e8aa0,
  river: 0x3b6a8c,
  lake: 0x2c5670,
  urban: 0x6a5b3d,
  ruin: 0x55483a,
};

const ROAD_OUTLINE = 0xd2a44b;

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
  readonly poly: Graphics;
  readonly baseColor: number;
}

const drawHexPolygon = (g: Graphics, size: number, fill: number): void => {
  g.clear();
  // Pointy-top: corners at angles 30°, 90°, 150°, 210°, 270°, 330°.
  const path: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    path.push(size * Math.cos(angle), size * Math.sin(angle));
  }
  g.poly(path).fill({ color: fill });
};

const drawHexWithRoad = (g: Graphics, size: number, fill: number, roadColor: number): void => {
  g.clear();
  const path: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    path.push(size * Math.cos(angle), size * Math.sin(angle));
  }
  g.poly(path).fill({ color: fill }).stroke({ color: roadColor, width: 1.2 });
};

export const createHexMap = (grid: HexGrid, hexSize: number): HexMap => {
  const container = new Container();
  container.label = 'hexMap';
  const entries = new Map<string, HexEntry>();
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  for (const [h, tile] of grid.tiles()) {
    addHex(container, entries, h, tile, hexSize, bounds);
  }

  const setTint = (h: Hex, color: number | null): void => {
    const e = entries.get(hexKey(h));
    if (e === undefined) return;
    e.poly.tint = color === null ? 0xffffff : color;
  };

  const clearTints = (): void => {
    for (const e of entries.values()) e.poly.tint = 0xffffff;
  };

  return { container, setTint, clearTints, bounds };
};

const addHex = (
  container: Container,
  entries: Map<string, HexEntry>,
  h: Hex,
  tile: HexTile,
  hexSize: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): void => {
  const px = hexToPixel(h, hexSize);
  const g = new Graphics();
  const baseColor = TERRAIN_COLOR[tile.terrain];
  if (tile.road !== 'none') {
    drawHexWithRoad(g, hexSize * 0.97, baseColor, ROAD_OUTLINE);
  } else {
    drawHexPolygon(g, hexSize * 0.97, baseColor);
  }
  g.position.set(px.x, px.y);
  container.addChild(g);
  entries.set(hexKey(h), { poly: g, baseColor });
  if (px.x < bounds.minX) bounds.minX = px.x;
  if (px.y < bounds.minY) bounds.minY = px.y;
  if (px.x > bounds.maxX) bounds.maxX = px.x;
  if (px.y > bounds.maxY) bounds.maxY = px.y;
};
