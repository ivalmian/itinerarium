/**
 * Hex grid renderer with biome-edge transitions.
 *
 * Produces two layers under one container:
 *   - `fills`: a solid PIXI.Graphics polygon per hex, tintable by overlays.
 *   - `biomeEdges`: a polygon strip drawn along each shared edge whose neighbor
 *     belongs to a *different* terrain category. This softens the abrupt
 *     biome cut you'd otherwise see when, e.g., dense_forest abuts steppe.
 *
 * 80×80 grid → 6,400 hexes. Per-frame drawing of 6,400 small Graphics nodes is
 * comfortable for WebGL. If we scale to the full 500×500 (~250k hexes) we'll
 * want a single mesh + per-vertex color, but that is out of scope for v1
 * (docs/16-viewer §"Performance budget").
 *
 * Biome categories (for edge-detection purposes):
 *   agricultural: plains, fertile_valley
 *   forest:       forest, dense_forest
 *   water:        coast, lake, river
 *   highland:     hills, mountains
 *   wasteland:    desert, steppe, marsh
 *   built:        urban, ruin
 *
 * Edges *within* a category are silent (no strip); edges *across* categories
 * draw a darkened tint stripe ~10% of the apothem wide along the shared edge.
 */

import { Container, Graphics } from 'pixi.js';
import { HEX_DIRECTIONS, hexAdd, hexKey, type Hex } from '../../src/sim/world/hex.js';
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
  coast: 'water',
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

const SQRT3 = Math.sqrt(3);

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

/** Average two 0xrrggbb colors and darken the result by `darken` ∈ [0, 1]. */
const blendDarken = (a: number, b: number, darken: number): number => {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const k = 1 - darken;
  const r = Math.round(((ar + br) / 2) * k);
  const g = Math.round(((ag + bg) / 2) * k);
  const bl = Math.round(((ab + bb) / 2) * k);
  return (r << 16) | (g << 8) | bl;
};

export const createHexMap = (grid: HexGrid, hexSize: number): HexMap => {
  const container = new Container();
  container.label = 'hexMap';
  const fills = new Container();
  fills.label = 'hexFills';
  const biomeEdges = new Container();
  biomeEdges.label = 'biomeEdges';
  const detail = new Container();
  detail.label = 'terrainDetail';
  // Biome strips draw above the fill so they're visible, but the container
  // ordering here lives below the rivers/roads layers wired in app.ts.
  container.addChild(fills);
  container.addChild(biomeEdges);
  container.addChild(detail);

  const entries = new Map<string, HexEntry>();
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  for (const [h, tile] of grid.tiles()) {
    addHex(fills, entries, h, tile, hexSize, bounds);
    drawTerrainDetail(detail, h, tile, hexSize);
  }

  // Pass two: biome edge strips. Walk every (hex, neighbor) once by only
  // drawing when neighbor exists and we pick edges by the lower-keyed hex.
  drawBiomeEdges(biomeEdges, grid, hexSize);

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
  // Roads/rivers are now rendered by their dedicated layers; plain polygon here.
  drawHexPolygon(g, hexSize * 0.97, baseColor);
  g.position.set(px.x, px.y);
  container.addChild(g);
  entries.set(hexKey(h), { poly: g, baseColor });
  if (px.x < bounds.minX) bounds.minX = px.x;
  if (px.y < bounds.minY) bounds.minY = px.y;
  if (px.x > bounds.maxX) bounds.maxX = px.x;
  if (px.y > bounds.maxY) bounds.maxY = px.y;
};

/**
 * Sub-tile terrain detail: a few subtle glyphs per hex hint at what's
 * there (tree triangles on forest, ripple lines on water, dunes on
 * desert, etc.). Deterministic from the hex coords so the same world
 * looks identical on every reload.
 */
const drawTerrainDetail = (container: Container, h: Hex, tile: HexTile, hexSize: number): void => {
  const { x: cx, y: cy } = hexToPixel(h, hexSize);
  // Pseudo-random in [0,1] derived from hex coords (stable per world).
  const rand = (salt: number): number => {
    const x = Math.sin(h.q * 91 + h.r * 173 + salt * 311) * 9999;
    return x - Math.floor(x);
  };
  const t = tile.terrain;

  if (t === 'forest' || t === 'dense_forest') {
    const count = t === 'dense_forest' ? 4 : 2;
    const treeColor = t === 'dense_forest' ? 0x1a2e15 : 0x2a4520;
    for (let i = 0; i < count; i++) {
      const angle = rand(i) * Math.PI * 2;
      const r = rand(i + 100) * hexSize * 0.45;
      const tx = cx + Math.cos(angle) * r;
      const ty = cy + Math.sin(angle) * r;
      const tree = new Graphics();
      const sz = hexSize * 0.18;
      tree.moveTo(tx, ty - sz).lineTo(tx + sz * 0.6, ty + sz * 0.4).lineTo(tx - sz * 0.6, ty + sz * 0.4).closePath();
      tree.fill({ color: treeColor, alpha: 0.85 });
      container.addChild(tree);
    }
  } else if (t === 'hills') {
    // Two soft mounds — small arcs.
    const mound = new Graphics();
    const w = hexSize * 0.45;
    const moundColor = 0x7a5e35;
    mound.moveTo(cx - w, cy + w * 0.2).bezierCurveTo(cx - w * 0.4, cy - w * 0.4, cx + w * 0.4, cy - w * 0.4, cx + w, cy + w * 0.2);
    mound.stroke({ color: moundColor, width: 0.8, alpha: 0.7 });
    container.addChild(mound);
  } else if (t === 'mountains') {
    // Caret peaks.
    const peak = new Graphics();
    const w = hexSize * 0.5;
    peak.moveTo(cx - w * 0.7, cy + w * 0.3)
      .lineTo(cx - w * 0.2, cy - w * 0.3)
      .lineTo(cx + w * 0.1, cy + w * 0.05)
      .lineTo(cx + w * 0.4, cy - w * 0.4)
      .lineTo(cx + w * 0.7, cy + w * 0.3);
    peak.stroke({ color: 0x4d4844, width: 1.0, alpha: 0.9 });
    container.addChild(peak);
  } else if (t === 'lake' || t === 'river' || t === 'coast') {
    // Ripple lines.
    const ripple = new Graphics();
    const lineColor = t === 'coast' ? 0xa9c4d6 : 0x6b9bbb;
    for (let i = 0; i < 2; i++) {
      const y = cy - hexSize * 0.15 + i * hexSize * 0.25;
      ripple
        .moveTo(cx - hexSize * 0.4, y)
        .bezierCurveTo(cx - hexSize * 0.1, y - hexSize * 0.05, cx + hexSize * 0.1, y + hexSize * 0.05, cx + hexSize * 0.4, y);
    }
    ripple.stroke({ color: lineColor, width: 0.6, alpha: 0.8 });
    container.addChild(ripple);
  } else if (t === 'desert') {
    // Dune crests.
    const dune = new Graphics();
    dune
      .moveTo(cx - hexSize * 0.4, cy + hexSize * 0.1)
      .bezierCurveTo(cx - hexSize * 0.15, cy - hexSize * 0.1, cx + hexSize * 0.15, cy - hexSize * 0.1, cx + hexSize * 0.4, cy + hexSize * 0.1);
    dune.stroke({ color: 0xa68c5a, width: 0.6, alpha: 0.7 });
    container.addChild(dune);
  } else if (t === 'marsh') {
    // Reed tufts: a few short vertical lines.
    for (let i = 0; i < 3; i++) {
      const reed = new Graphics();
      const angle = rand(i) * Math.PI * 2;
      const r = rand(i + 200) * hexSize * 0.35;
      const rx = cx + Math.cos(angle) * r;
      const ry = cy + Math.sin(angle) * r;
      reed.moveTo(rx, ry).lineTo(rx, ry - hexSize * 0.2);
      reed.stroke({ color: 0x4a5a30, width: 0.6, alpha: 0.8 });
      container.addChild(reed);
    }
  } else if (t === 'fertile_valley') {
    // Crop rows.
    for (let i = 0; i < 3; i++) {
      const y = cy - hexSize * 0.25 + i * hexSize * 0.25;
      const row = new Graphics();
      row.moveTo(cx - hexSize * 0.35, y).lineTo(cx + hexSize * 0.35, y);
      row.stroke({ color: 0x4d6b25, width: 0.4, alpha: 0.6 });
      container.addChild(row);
    }
  } else if (t === 'steppe') {
    // Sparse dots (grass tufts).
    for (let i = 0; i < 4; i++) {
      const angle = rand(i) * Math.PI * 2;
      const r = rand(i + 300) * hexSize * 0.4;
      const tx = cx + Math.cos(angle) * r;
      const ty = cy + Math.sin(angle) * r;
      const dot = new Graphics();
      dot.circle(tx, ty, hexSize * 0.04).fill({ color: 0x6f6238, alpha: 0.7 });
      container.addChild(dot);
    }
  }
};

/**
 * For each existing tile and each of its six neighbors, if both tiles exist
 * and belong to different biome categories, draw a thin polygonal strip along
 * the shared edge tinted to the average of both terrains, darkened.
 *
 * To avoid drawing each edge twice, we only emit when the local hex has the
 * lexicographically smaller hexKey. (Edge geometry is symmetric so either side
 * would do; this just deduplicates.)
 */
const drawBiomeEdges = (container: Container, grid: HexGrid, hexSize: number): void => {
  const apothem = hexSize * (SQRT3 / 2);
  const stripDepth = apothem * 0.1; // ~10% of apothem
  // Pre-compute the six corner offsets (pointy-top, indexed 0..5 at 30°+60°·i).
  const cornerOffsets: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    cornerOffsets.push({ x: hexSize * Math.cos(angle), y: hexSize * Math.sin(angle) });
  }
  // For axial dir index `d` (HEX_DIRECTIONS), the shared edge is between two
  // adjacent corners. Corner `c` sits at angle (60·c - 30)°; consecutive
  // corners (c, c+1) bracket an edge whose midpoint is at angle 60·c°. So:
  //   d=0 (E):  midpoint   0° → corners 0, 1
  //   d=1 (NE): midpoint -60° → corners 5, 0
  //   d=2 (NW): midpoint-120° → corners 4, 5
  //   d=3 (W):  midpoint 180° → corners 3, 4
  //   d=4 (SW): midpoint 120° → corners 2, 3
  //   d=5 (SE): midpoint  60° → corners 1, 2
  // Consistent with EDGE_ANGLES_RAD in roads.ts.
  const dirCornerPairs: [number, number][] = [
    [0, 1],
    [5, 0],
    [4, 5],
    [3, 4],
    [2, 3],
    [1, 2],
  ];

  for (const [h, tile] of grid.tiles()) {
    const myKey = hexKey(h);
    const myCat = TERRAIN_CATEGORY[tile.terrain];
    const myColor = TERRAIN_COLOR[tile.terrain];
    const center = hexToPixel(h, hexSize);
    for (let d = 0; d < 6; d++) {
      const dir = HEX_DIRECTIONS[d] as Hex;
      const nHex = hexAdd(h, dir);
      const nTile = grid.get(nHex);
      if (nTile === undefined) continue;
      const nCat = TERRAIN_CATEGORY[nTile.terrain];
      if (nCat === myCat) continue;
      // Dedup — only the smaller-keyed hex draws the edge.
      if (myKey > hexKey(nHex)) continue;
      const pair = dirCornerPairs[d] as [number, number];
      const cA = cornerOffsets[pair[0]] as { x: number; y: number };
      const cB = cornerOffsets[pair[1]] as { x: number; y: number };
      // Outer two vertices: the two shared corners (in this hex's local frame).
      const ax = center.x + cA.x;
      const ay = center.y + cA.y;
      const bx = center.x + cB.x;
      const by = center.y + cB.y;
      // Inner two vertices: pull each corner inward toward the hex center by
      // `stripDepth`. We construct a thin trapezoidal strip that straddles
      // the shared edge — half-depth on each side gives roughly equal coverage
      // even though we only draw on the local-side trapezoid, since the
      // neighbor's biome on the other side is what we're hinting at.
      const blend = blendDarken(myColor, TERRAIN_COLOR[nTile.terrain], 0.2);
      // Compute inward unit normal (from edge midpoint toward this hex's center).
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const nxRaw = center.x - mx;
      const nyRaw = center.y - my;
      const nLen = Math.hypot(nxRaw, nyRaw) || 1;
      const nx = nxRaw / nLen;
      const ny = nyRaw / nLen;
      const ix = ax + nx * stripDepth;
      const iy = ay + ny * stripDepth;
      const jx = bx + nx * stripDepth;
      const jy = by + ny * stripDepth;
      const g = new Graphics();
      g.poly([ax, ay, bx, by, jx, jy, ix, iy]).fill({ color: blend, alpha: 0.85 });
      container.addChild(g);
    }
  }
};
