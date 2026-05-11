/**
 * Sub-hex road segment renderer.
 *
 * Per hex with a road, draws a road segment from the hex center to the
 * midpoint of every edge shared with a road-bearing neighbor. Half-segments
 * meet at the center; multiple connections form Y / T / X intersections
 * with a rounded "graded surface" hub at the meeting point so the road looks
 * continuous instead of like 6 sticks meeting at a vertex.
 *
 * Each half-segment uses the *local* hex's road grade — if a Roman road
 * (gold, double-line) abuts a dirt road (brown, single-line wavy), the
 * visual transition is exactly at the shared edge midpoint, which is
 * informative: you can see where the empire's stationarii stop maintaining
 * and the local cart-track picks up. We mark grade boundaries with a small
 * milestone dot at the edge midpoint so the change is obvious.
 *
 * A hex with road = 'none' contributes nothing. A road hex with no
 * road-bearing neighbors gets a small dot at its center as a terminus.
 *
 * Visual styles (docs/16-viewer §"Concrete improvements"):
 *   - Roman: two parallel lines (the paved roadway's outer edges), 0.6 px
 *     each, separated by 1.5 px. Color 0xe8c478.
 *   - Dirt:  single 0.8 px line with two organic mid-control points to wave
 *     it slightly. Color 0x9a7d4f.
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
  /** Total visual width (incl. both rails for Roman; the line width for dirt). */
  readonly width: number;
  readonly alpha: number;
}

const STYLE_BY_GRADE: Record<Exclude<RoadGrade, 'none'>, RoadStyle> = {
  // Pale gold/sand for Roman; visible against most terrains.
  roman: { color: 0xe8c478, width: 2.4, alpha: 1.0 },
  // Muted brown for dirt; lower alpha so it reads as humbler.
  dirt: { color: 0x9a7d4f, width: 1.3, alpha: 0.9 },
};

/**
 * Edge-midpoint angle for the i-th HEX_DIRECTIONS entry, in radians.
 *
 * Pointy-top: corners at 30°, 90°, …; edges (between corners) at 0°, 60°,
 * 120°, … Worked from `hexToPixel` so the angles match the real pixel
 * positions of neighbor hex centers.
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
  /**
   * Re-render the entire road layer from scratch. Cheap (~6,400 hex
   * scan + a few hundred Graphics nodes); call when road state has
   * changed (trail wear upgraded a hex, road reset fired,
   * road_unmaintained downgraded a hex). Not called per-tick — the
   * caller debounces (e.g., only on `road_upgraded`/`road_downgraded`/
   * `road_reset`/`road_unmaintained` events).
   */
  refresh(grid: HexGrid): void;
}

interface NeighborConn {
  readonly dir: number;
  readonly angle: number;
  /** Edge midpoint pixel position. */
  readonly ex: number;
  readonly ey: number;
  /** Neighbor's road grade — used to draw a milestone dot if it differs. */
  readonly neighborGrade: Exclude<RoadGrade, 'none'>;
}

export const createRoadLayer = (grid: HexGrid, hexSize: number): RoadLayer => {
  const container = new Container();
  container.label = 'roads';
  // Apothem = center-to-edge-midpoint distance for a pointy-top hex.
  const apothem = hexSize * (SQRT3 / 2);
  // Roman-rail spacing: keep the visual at the spec width even on small hexes.
  const romanRailGap = Math.max(1.0, Math.min(1.5, hexSize * 0.18));
  const romanRailWidth = 0.6;
  const dirtLineWidth = 0.8;

  const drawAll = (gridArg: HexGrid): void => {
    container.removeChildren();
    for (const [h, tile] of gridArg.tiles()) {
      if (tile.road === 'none') continue;
      const grade = tile.road;
      const style = STYLE_BY_GRADE[grade];
      const { x: cx, y: cy } = hexToPixel(h, hexSize);

      const conns: NeighborConn[] = [];
      for (let i = 0; i < 6; i++) {
        const dir = HEX_DIRECTIONS[i] as Hex;
        const neighbor = hexAdd(h, dir);
        const ntile = gridArg.get(neighbor);
        if (ntile === undefined) continue;
        if (ntile.road === 'none') continue;
        const angle = EDGE_ANGLES_RAD[i] as number;
        const ex = cx + Math.cos(angle) * apothem;
        const ey = cy + Math.sin(angle) * apothem;
        conns.push({ dir: i, angle, ex, ey, neighborGrade: ntile.road });
      }

      if (conns.length === 0) {
        const dot = new Graphics();
        dot.circle(cx, cy, Math.max(1.2, style.width)).fill({ color: style.color, alpha: style.alpha });
        container.addChild(dot);
        continue;
      }

      for (const c of conns) {
        if (grade === 'roman') {
          drawRomanHalfSegment(container, cx, cy, c.ex, c.ey, style, romanRailWidth, romanRailGap);
        } else {
          drawDirtHalfSegment(container, cx, cy, c.ex, c.ey, style, dirtLineWidth);
        }
      }

      const hubR = grade === 'roman' ? romanRailGap * 0.9 + romanRailWidth : dirtLineWidth * 1.0;
      const hubG = new Graphics();
      hubG.circle(cx, cy, hubR).fill({ color: style.color, alpha: style.alpha });
      container.addChild(hubG);

      for (const c of conns) {
        if (c.neighborGrade === grade) continue;
        const milestoneColor = 0xf2e2b8;
        const dotR = Math.max(0.9, hexSize * 0.12);
        const dot = new Graphics();
        dot.circle(c.ex, c.ey, dotR).fill({ color: milestoneColor, alpha: 1.0 });
        dot.circle(c.ex, c.ey, dotR).stroke({ color: 0x3a2e1b, width: 0.3, alpha: 0.9 });
        container.addChild(dot);
      }
    }
  };

  drawAll(grid);

  return {
    container,
    refresh: drawAll,
  };
};

/**
 * Draw a Roman road half-segment as two parallel rails offset perpendicular
 * to the segment direction by ±romanRailGap/2.
 */
const drawRomanHalfSegment = (
  container: Container,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  style: RoadStyle,
  railWidth: number,
  railGap: number,
): void => {
  const dx = ex - cx;
  const dy = ey - cy;
  const len = Math.hypot(dx, dy) || 1;
  // Unit perpendicular (rotate 90°).
  const px = -dy / len;
  const py = dx / len;
  const off = railGap / 2;
  for (const sign of [-1, 1]) {
    const ax = cx + px * off * sign;
    const ay = cy + py * off * sign;
    const bx = ex + px * off * sign;
    const by = ey + py * off * sign;
    const g = new Graphics();
    g.moveTo(ax, ay).lineTo(bx, by);
    g.stroke({ color: style.color, width: railWidth, alpha: style.alpha });
    container.addChild(g);
  }
};

/**
 * Draw a dirt road half-segment as a single quadratic curve with one organic
 * mid-control point — so a long dirt road meanders subtly rather than running
 * arrow-straight. The curve is deterministic: derived from the segment
 * geometry so the same pair of hexes produces the same wave on every reload.
 */
const drawDirtHalfSegment = (
  container: Container,
  cx: number,
  cy: number,
  ex: number,
  ey: number,
  style: RoadStyle,
  width: number,
): void => {
  const dx = ex - cx;
  const dy = ey - cy;
  const len = Math.hypot(dx, dy) || 1;
  // Unit perpendicular for the wave displacement.
  const px = -dy / len;
  const py = dx / len;
  // Deterministic offset: quantize the midpoint coordinates into a small
  // hash so neighboring hex pairs vary independently. Magnitude ≤ ~12% of
  // segment length so it doesn't leave the half-hex.
  const mx0 = (cx + ex) / 2;
  const my0 = (cy + ey) / 2;
  const seed = Math.sin(mx0 * 12.9898 + my0 * 78.233) * 43758.5453;
  const wave = (seed - Math.floor(seed)) - 0.5; // ∈ [-0.5, 0.5]
  const ampl = len * 0.18 * wave;
  const mx = mx0 + px * ampl;
  const my = my0 + py * ampl;

  const g = new Graphics();
  g.moveTo(cx, cy).quadraticCurveTo(mx, my, ex, ey);
  g.stroke({ color: style.color, width, alpha: style.alpha });
  container.addChild(g);
};
