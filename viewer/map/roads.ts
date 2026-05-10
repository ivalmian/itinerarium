/**
 * Sub-hex road segment renderer.
 *
 * Per hex with a road, draws a line segment from the hex center to the
 * midpoint of every edge shared with a road-bearing neighbor. The result
 * looks like a continuous road threading through hexes (rather than a
 * per-hex outline that doesn't actually connect).
 *
 * Each half-segment uses the *local* hex's road grade — if a Roman road
 * (gold, thick) abuts a dirt road (brown, thin), the visual transition is
 * exactly at the shared edge midpoint, which is informative: you can see
 * where the empire's stationarii stop maintaining and the local cart-track
 * picks up.
 *
 * A hex with road = 'none' contributes nothing. A road hex with no
 * road-bearing neighbors gets a small dot at its center as a terminus.
 *
 * Geometry is fixed at boot; a separate Container under the world transform
 * so caravans/settlements draw on top.
 */

import { Container, Graphics } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import type { RoadGrade } from '../../src/sim/world/terrain.js';
import { hexToPixel } from './coords.js';

const SQRT3 = Math.sqrt(3);

interface RoadStyle {
  readonly color: number;
  readonly width: number;
  readonly alpha: number;
}

const STYLE_BY_GRADE: Record<Exclude<RoadGrade, 'none'>, RoadStyle> = {
  roman: { color: 0xe8c478, width: 2.4, alpha: 1.0 },
  dirt: { color: 0x9a7d4f, width: 1.3, alpha: 0.9 },
};

/**
 * Edge-midpoint angle for the i-th HEX_DIRECTIONS entry, in radians.
 *
 * Pointy-top: corners at 30°, 90°, …; edges (between corners) at 0°, 60°,
 * 120°, … Worked from `hexToPixel` so the angles match the real pixel
 * positions of neighbor hex centers — see derivation in PR comments.
 */
const EDGE_ANGLES_RAD: readonly number[] = [
  0, // [0] E:  q+1, r
  -Math.PI / 3, // [1] NE: q+1, r-1   → 300°
  (-2 * Math.PI) / 3, // [2] NW: q,   r-1   → 240°
  Math.PI, // [3] W:  q-1, r
  (2 * Math.PI) / 3, // [4] SW: q-1, r+1   → 120°
  Math.PI / 3, // [5] SE: q,   r+1   → 60°
];

export interface RoadLayer {
  readonly container: Container;
}

export const createRoadLayer = (grid: HexGrid, hexSize: number): RoadLayer => {
  const container = new Container();
  container.label = 'roads';
  // Apothem = center-to-edge-midpoint distance for a pointy-top hex.
  const apothem = hexSize * (SQRT3 / 2);

  for (const [h, tile] of grid.tiles()) {
    if (tile.road === 'none') continue;
    const style = STYLE_BY_GRADE[tile.road];
    const { x: cx, y: cy } = hexToPixel(h, hexSize);

    let segmentDrawn = false;
    for (let i = 0; i < 6; i++) {
      const dir = HEX_DIRECTIONS[i] as Hex;
      const neighbor = hexAdd(h, dir);
      const ntile = grid.get(neighbor);
      if (ntile === undefined) continue;
      if (ntile.road === 'none') continue;

      const angle = EDGE_ANGLES_RAD[i] as number;
      const ex = cx + Math.cos(angle) * apothem;
      const ey = cy + Math.sin(angle) * apothem;

      const g = new Graphics();
      g.moveTo(cx, cy);
      g.lineTo(ex, ey);
      g.stroke({ color: style.color, width: style.width, alpha: style.alpha });
      container.addChild(g);
      segmentDrawn = true;
    }

    if (!segmentDrawn) {
      // Isolated road hex — draw a small dot so it's still visible.
      const dot = new Graphics();
      dot.circle(cx, cy, Math.max(1.2, style.width)).fill({ color: style.color, alpha: style.alpha });
      container.addChild(dot);
    }
  }

  return { container };
};
