/**
 * River layer — SVG-sprite composed.
 *
 * For each river hex we look at its 6 axial neighbors and, for every
 * neighbor that's also water (river or lake), we add a directional
 * segment sprite (viewer/art/rivers/<dir>.svg). The segments are flat
 * solid-color water polygons; multiple segments on the same hex
 * overlap cleanly at the center (same color, no seam) and meet the
 * neighbor hex's mirrored segment at the shared edge midpoint.
 *
 * Z-order: above terrain + biome-edges, below roads (so a future
 * bridge tile can sit on top of the river). Wired by app.ts.
 */

import { Container, Sprite } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import { hexToPixel } from './coords.js';
import { type ArtRegistry, type EdgeDir, EDGE_DIRS } from '../art/index.js';

const SQRT3 = Math.sqrt(3);

export interface RiverLayer {
  readonly container: Container;
}

export const createRiverLayer = (
  grid: HexGrid,
  hexSize: number,
  art: ArtRegistry,
): RiverLayer => {
  const container = new Container();
  container.label = 'rivers';
  container.eventMode = 'none';
  const spriteW = SQRT3 * hexSize;
  const spriteH = 2 * hexSize;

  for (const [h, tile] of grid.tiles()) {
    if (tile.terrain !== 'river') continue;
    const px = hexToPixel(h, hexSize);
    for (let d = 0; d < 6; d++) {
      const dir = HEX_DIRECTIONS[d] as Hex;
      const nHex = hexAdd(h, dir);
      const nTile = grid.get(nHex);
      if (nTile === undefined) continue;
      if (nTile.terrain !== 'river' && nTile.terrain !== 'lake') continue;
      const dirName = EDGE_DIRS[d] as EdgeDir;
      const seg = new Sprite(art.river(dirName));
      seg.anchor.set(0.5, 0.5);
      seg.width = spriteW;
      seg.height = spriteH;
      seg.position.set(px.x, px.y);
      container.addChild(seg);
    }
  }

  return { container };
};
