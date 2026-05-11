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
import {
  type ArtRegistry,
  type EdgeDir,
  EDGE_DIRS,
  type ScatterKind,
  terrainArtKey,
} from '../art/index.js';

const SQRT3 = Math.sqrt(3);
const ROT_60 = Math.PI / 3;

/** Categories used only to decide whether a lake hex needs a shore overlay
 *  on a given edge. */
const WATER_TERRAINS: ReadonlySet<Terrain> = new Set(['river', 'lake']);

/**
 * Deterministic per-hex rotation index in {0..5} so the same world looks
 * identical on every reload but the regular grid pattern is broken up.
 * A pointy-top regular hexagon has 6-fold rotational symmetry so a
 * 60° rotation step leaves the silhouette unchanged while shuffling the
 * interior detail (trees, ripples, grass tufts, dunes) to a different
 * orientation.
 */
const hexRotationIndex = (h: Hex): number => {
  // FNV-1a-ish on (q, r). Stable, fast, well-distributed across small ints.
  let x = (h.q * 73856093) ^ (h.r * 19349663);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = x ^ (x >>> 16);
  return (x >>> 0) % 6;
};

/**
 * Terrains whose baked-in detail has no directional "up" — safe to rotate
 * per hex. Mountains have peaks pointing up + NW-light shading, hills
 * have light/shadow sides, lake/river have water highlights assuming a
 * fixed light direction, urban tiles have grid orientation, ruins have
 * a recognizable silhouette. Those keep their authored orientation so
 * the directional features (peak, shadow, glint) read correctly.
 */
const ROTATABLE_TERRAINS: ReadonlySet<Terrain> = new Set<Terrain>([
  'plains',
  'fertile_valley',
  'forest',
  'dense_forest',
  'marsh',
  'desert',
  'steppe',
]);

/**
 * Mulberry32 PRNG seeded by a per-hex integer so scatter placement is
 * deterministic across reloads but distinct per hex.
 */
const hexRng = (h: Hex, salt: number): (() => number) => {
  let s = (((h.q * 374761393) ^ (h.r * 668265263)) ^ (salt * 1442695040)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Scatter content per biome. Each entry is a list of (kind, weight) pairs
 * and a count range. Per hex we pick `count` scatter items, sampling kinds
 * by weight. Positions are deterministic-random within the hex bounding
 * box (with a slight bleed past hex edges, so adjacent same-biome hexes'
 * scatter visually merges across the boundary).
 *
 * Density tuned per biome so:
 *  - dense_forest reads as densely wooded
 *  - forest as scattered trees
 *  - plains as mostly empty with occasional tufts
 *  - mountain/hills get rocks
 *  - desert gets cactus
 *  - marsh gets ferns
 *  - rivers/lakes/urban/ruin get no scatter (content is baked in)
 */
interface ScatterEntry {
  readonly kind: ScatterKind;
  readonly weight: number;
}

interface ScatterPool {
  readonly entries: readonly ScatterEntry[];
  readonly minCount: number;
  readonly maxCount: number;
  readonly scale: number;
}

const SCATTER_BY_BIOME: Partial<Record<Terrain, ScatterPool>> = {
  plains: {
    entries: [
      { kind: 'grass-tuft', weight: 6 },
      { kind: 'flower-yellow', weight: 1 },
      { kind: 'flower-purple', weight: 1 },
    ],
    minCount: 1,
    maxCount: 3,
    scale: 0.45,
  },
  fertile_valley: {
    entries: [
      { kind: 'grass-tuft', weight: 4 },
      { kind: 'flower-yellow', weight: 3 },
      { kind: 'flower-purple', weight: 2 },
    ],
    minCount: 2,
    maxCount: 4,
    scale: 0.45,
  },
  forest: {
    entries: [
      { kind: 'tree-oak', weight: 5 },
      { kind: 'tree-pine', weight: 2 },
      { kind: 'bush-small', weight: 2 },
      { kind: 'mushroom', weight: 1 },
    ],
    minCount: 3,
    maxCount: 5,
    scale: 0.75,
  },
  dense_forest: {
    entries: [
      { kind: 'tree-oak', weight: 4 },
      { kind: 'tree-pine', weight: 5 },
      { kind: 'tree-cypress', weight: 2 },
      { kind: 'fern', weight: 2 },
      { kind: 'mushroom', weight: 1 },
    ],
    minCount: 5,
    maxCount: 8,
    scale: 0.85,
  },
  hills: {
    entries: [
      { kind: 'rock-medium', weight: 2 },
      { kind: 'rock-small', weight: 3 },
      { kind: 'tree-pine', weight: 1 },
      { kind: 'grass-tuft', weight: 2 },
    ],
    minCount: 2,
    maxCount: 4,
    scale: 0.6,
  },
  mountains: {
    entries: [
      { kind: 'rock-medium', weight: 4 },
      { kind: 'rock-small', weight: 3 },
    ],
    minCount: 2,
    maxCount: 4,
    scale: 0.7,
  },
  desert: {
    entries: [
      { kind: 'cactus', weight: 3 },
      { kind: 'rock-small', weight: 2 },
    ],
    minCount: 1,
    maxCount: 3,
    scale: 0.55,
  },
  steppe: {
    entries: [
      { kind: 'grass-tuft', weight: 4 },
      { kind: 'rock-small', weight: 1 },
    ],
    minCount: 1,
    maxCount: 3,
    scale: 0.45,
  },
  marsh: {
    entries: [
      { kind: 'fern', weight: 4 },
      { kind: 'log', weight: 1 },
      { kind: 'mushroom', weight: 1 },
    ],
    minCount: 2,
    maxCount: 4,
    scale: 0.6,
  },
};

const pickWeighted = (entries: readonly ScatterEntry[], r: number): ScatterKind => {
  let total = 0;
  for (const e of entries) total += e.weight;
  let pick = r * total;
  for (const e of entries) {
    pick -= e.weight;
    if (pick <= 0) return e.kind;
  }
  return entries[entries.length - 1]!.kind;
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
  const scatterLayer = new Container();
  scatterLayer.label = 'scatter';
  scatterLayer.eventMode = 'none';
  container.addChild(fills);
  container.addChild(shores);
  container.addChild(scatterLayer);

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
    // Per-hex rotation in 60° steps for terrains with no directional "up".
    // Mountains/hills/water/urban/ruin keep their authored orientation so
    // their directional shading (peak up, NW light, water glint) reads
    // correctly across the map.
    if (ROTATABLE_TERRAINS.has(tile.terrain)) {
      sprite.rotation = hexRotationIndex(h) * ROT_60;
    }
    fills.addChild(sprite);
    entries.set(key, { sprite });
    if (px.x < bounds.minX) bounds.minX = px.x;
    if (px.y < bounds.minY) bounds.minY = px.y;
    if (px.x > bounds.maxX) bounds.maxX = px.x;
    if (px.y > bounds.maxY) bounds.maxY = px.y;
  }

  // Scatter pass: per-biome decorative sprites (trees / rocks / flowers /
  // tufts) placed at deterministic-random positions inside each hex. The
  // sprites can bleed slightly past the hex boundary so adjacent same-biome
  // hexes' scatter visually merges across the seam, breaking up the grid.
  const SCATTER_BLEED = 1.1; // 1.0 = no bleed; > 1 lets sprites extend past hex.
  for (const [h, tile] of grid.tiles()) {
    const pool = SCATTER_BY_BIOME[tile.terrain];
    if (pool === undefined) continue;
    const px = hexToPixel(h, hexSize);
    const rng = hexRng(h, 1);
    const count = pool.minCount + Math.floor(rng() * (pool.maxCount - pool.minCount + 1));
    const items: { x: number; y: number; kind: ScatterKind }[] = [];
    for (let i = 0; i < count; i++) {
      // Uniform random within the hex bounding box; sample-and-reject for
      // points slightly outside the hex polygon would be cleaner but the
      // bounding-box approach is good enough and most points land inside.
      const dx = (rng() - 0.5) * spriteW * SCATTER_BLEED;
      const dy = (rng() - 0.5) * spriteH * SCATTER_BLEED;
      const kind = pickWeighted(pool.entries, rng());
      items.push({ x: dx, y: dy, kind });
    }
    // Sort by y so back-sprites draw under front-sprites (a tiny 2.5-D feel).
    items.sort((a, b) => a.y - b.y);
    for (const it of items) {
      const sprite = new Sprite(art.scatter(it.kind));
      sprite.anchor.set(0.5, 0.85);
      const sz = pool.scale * hexSize * 2;
      sprite.width = sz;
      sprite.height = sz;
      sprite.position.set(px.x + it.x, px.y + it.y);
      scatterLayer.addChild(sprite);
    }
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
