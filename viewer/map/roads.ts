/**
 * Road layer — SVG-sprite composed.
 *
 * For each road tile (dirt or roman) we look at its 6 axial neighbors. For
 * every neighbor that has the SAME road grade we add a directional segment
 * sprite (viewer/art/roads/<grade>/<dir>.svg). A road tile that has only
 * different-grade neighbors still draws nothing in those directions; mixed
 * boundaries get the visual handoff from each side's own segment which
 * extends past the shared hex edge.
 *
 * Exposes refresh(grid) so the road network can be re-rendered after sim
 * events (trail wear upgrades, demolition, etc.) without recreating the
 * container.
 */

import { Container, Sprite } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import { hexToPixel } from './coords.js';
import { type ArtRegistry, type EdgeDir, EDGE_DIRS } from '../art/index.js';

const SQRT3 = Math.sqrt(3);

export interface RoadLayer {
  readonly container: Container;
  /** Wipe + redraw all road segments based on the current grid state. */
  refresh(grid: HexGrid): void;
}

export const createRoadLayer = (
  grid: HexGrid,
  hexSize: number,
  art: ArtRegistry,
): RoadLayer => {
  const container = new Container();
  container.label = 'roads';
  container.eventMode = 'none';
  const spriteW = SQRT3 * hexSize;
  const spriteH = 2 * hexSize;

  const drawAll = (g: HexGrid): void => {
    for (const child of container.removeChildren()) child.destroy();

    for (const [h, tile] of g.tiles()) {
      if (tile.road === 'none') continue;
      const grade = tile.road;
      const px = hexToPixel(h, hexSize);

      for (let d = 0; d < 6; d++) {
        const dir = HEX_DIRECTIONS[d] as Hex;
        const nHex = hexAdd(h, dir);
        const nTile = g.get(nHex);
        if (nTile === undefined || nTile.road === 'none') continue;
        if (nTile.road !== grade) continue;
        const dirName = EDGE_DIRS[d] as EdgeDir;
        const tex = grade === 'roman' ? art.romanRoad(dirName) : art.dirtRoad(dirName);
        const seg = new Sprite(tex);
        seg.anchor.set(0.5, 0.5);
        seg.width = spriteW;
        seg.height = spriteH;
        seg.position.set(px.x, px.y);
        container.addChild(seg);
      }
    }
  };

  drawAll(grid);

  return {
    container,
    refresh: drawAll,
  };
};
