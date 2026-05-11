/**
 * Road layer — atlas-based.
 *
 * For each road hex we compute a 6-bit connection bitmask (bit d = the
 * neighbor on direction d has the SAME road grade) and draw a single
 * Sprite of the pre-rendered network shape for that bitmask
 * (viewer/art/roads/{dirt,roman}/c<bitmask>.svg). Mixed-grade boundaries
 * are intentionally not bridged in the bitmask — each side draws only
 * its own grade's network. Both sides' channels meet the shared hex
 * edge midpoint at the same width and color so the visual handoff
 * still looks continuous.
 *
 * Exposes refresh(grid) so the road network can be re-rendered after
 * sim events (trail wear upgrades, demolition, etc.).
 */

import { Container, Sprite } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry } from '../art/index.js';

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
      let bitmask = 0;
      for (let d = 0; d < 6; d++) {
        const dir = HEX_DIRECTIONS[d] as Hex;
        const n = g.get(hexAdd(h, dir));
        if (n === undefined) continue;
        if (n.road === grade) bitmask |= 1 << d;
      }
      if (bitmask === 0) continue;
      const px = hexToPixel(h, hexSize);
      const tex = grade === 'roman' ? art.romanRoad(bitmask) : art.dirtRoad(bitmask);
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5, 0.5);
      sprite.width = spriteW;
      sprite.height = spriteH;
      sprite.position.set(px.x, px.y);
      container.addChild(sprite);
    }
  };

  drawAll(grid);

  return { container, refresh: drawAll };
};
