/**
 * River sub-hex flow renderer.
 *
 * For each tile with terrain == 'river' we look at its 6 axial neighbors and
 * find the ones whose terrain is also water (river or lake). We draw a
 * smooth curve through this hex that connects each pair of in-flowing edge
 * midpoints. Width scales with how many water-neighbors meet here:
 *
 *   1 neighbor   → terminal stub from edge to center, narrow.
 *   2 neighbors  → through-flow chord, normal width.
 *   3+ neighbors → confluence: every pair of edges connected through the
 *                  hub at the center, thicker (mainstem).
 *
 * Lakes are *terminals* for the river layer: they themselves are drawn by
 * the terrain layer (deep blue fill), but a river hex adjacent to a lake
 * still sees that neighbor as a connection sink, so we render the river
 * flowing into the lake's edge midpoint.
 *
 * Z-order: above terrain + biome-edges, BELOW roads (so a future bridge tile
 * can sit on top of the river). Wired by app.ts.
 *
 * Color palette:
 *   base:      0x3b6a8c (matches Terrain.river fill)
 *   tributary: 0x4d7da5 (slightly lighter — used when only 1 connection)
 *
 * Width derivation (in pixels at default hex size):
 *   k = max(2, neighborCount)        // a 1-neighbor stub still gets visible width
 *   base width = hexSize * 0.18 * (k / 3)  capped at hexSize*0.35
 *
 * The width is clamped so a 6-neighbor "ridiculous river" doesn't fill the
 * entire hex; it just looks like a fat trunk.
 */

import { Container, Graphics } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, type Hex } from '../../src/sim/world/hex.js';
import type { HexGrid } from '../../src/sim/world/grid.js';
import { hexToPixel } from './coords.js';

const SQRT3 = Math.sqrt(3);

// River-channel colors are intentionally a step lighter than the river
// terrain fill (TERRAIN_COLOR.river = 0x3b6a8c) so the flowing channel reads
// as a visible ribbon on top of the tile. Tributaries are lighter still.
const RIVER_BASE = 0x5588ad;
const RIVER_TRIBUTARY = 0x6fa0c4;

const EDGE_ANGLES_RAD: readonly number[] = [
  0,
  -Math.PI / 3,
  (-2 * Math.PI) / 3,
  Math.PI,
  (2 * Math.PI) / 3,
  Math.PI / 3,
];

export interface RiverLayer {
  readonly container: Container;
}

export const createRiverLayer = (grid: HexGrid, hexSize: number): RiverLayer => {
  const container = new Container();
  container.label = 'rivers';
  const apothem = hexSize * (SQRT3 / 2);

  for (const [h, tile] of grid.tiles()) {
    if (tile.terrain !== 'river') continue;
    const { x: cx, y: cy } = hexToPixel(h, hexSize);

    // Find water-neighbor edges.
    const conns: { ex: number; ey: number; angle: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const dir = HEX_DIRECTIONS[i] as Hex;
      const nHex = hexAdd(h, dir);
      const nTile = grid.get(nHex);
      if (nTile === undefined) continue;
      if (nTile.terrain !== 'river' && nTile.terrain !== 'lake') continue;
      const angle = EDGE_ANGLES_RAD[i] as number;
      const ex = cx + Math.cos(angle) * apothem;
      const ey = cy + Math.sin(angle) * apothem;
      conns.push({ ex, ey, angle });
    }

    const k = conns.length;
    // Width scales with neighbor count; tributary color when isolated stub.
    const widthScale = Math.max(2, k) / 3;
    const widthPx = Math.min(hexSize * 0.35, hexSize * 0.18 * widthScale);
    const color = k <= 1 ? RIVER_TRIBUTARY : RIVER_BASE;

    if (k === 0) {
      // Pond-like river hex with no water neighbors. Render a tiny puddle
      // disc so it doesn't look like a single dry tile mid-stream.
      const g = new Graphics();
      g.circle(cx, cy, hexSize * 0.18).fill({ color: RIVER_BASE, alpha: 0.95 });
      container.addChild(g);
      continue;
    }

    if (k === 1) {
      // Tributary stub: from neighbor edge midpoint to hex center.
      const c = conns[0] as { ex: number; ey: number; angle: number };
      const g = new Graphics();
      g.moveTo(c.ex, c.ey).quadraticCurveTo(
        // Slight pull toward the center so it tapers naturally.
        (c.ex + cx) / 2,
        (c.ey + cy) / 2,
        cx,
        cy,
      );
      g.stroke({ color, width: widthPx, alpha: 0.95, cap: 'round' });
      container.addChild(g);
      continue;
    }

    if (k === 2) {
      // Through-flow: a single quadratic chord from one edge midpoint to the
      // other, control point at the hex center. This bends the river around
      // the geometry of the two edges naturally.
      const a = conns[0] as { ex: number; ey: number; angle: number };
      const b = conns[1] as { ex: number; ey: number; angle: number };
      const g = new Graphics();
      g.moveTo(a.ex, a.ey).quadraticCurveTo(cx, cy, b.ex, b.ey);
      g.stroke({ color, width: widthPx, alpha: 0.95, cap: 'round' });
      container.addChild(g);
      continue;
    }

    // k >= 3: confluence. Draw each branch from edge midpoint into a central
    // hub. A small filled disc at the center merges everything visually.
    for (const c of conns) {
      const g = new Graphics();
      g.moveTo(c.ex, c.ey).quadraticCurveTo(
        (c.ex + cx) / 2,
        (c.ey + cy) / 2,
        cx,
        cy,
      );
      g.stroke({ color, width: widthPx, alpha: 0.95, cap: 'round' });
      container.addChild(g);
    }
    const hub = new Graphics();
    hub.circle(cx, cy, widthPx * 0.6).fill({ color, alpha: 1.0 });
    container.addChild(hub);
  }

  return { container };
};
