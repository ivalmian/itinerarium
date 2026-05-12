/// <reference types="vite/client" />

/**
 * SVG art registry. Loads every painterly-vector SVG under viewer/art/
 * at viewer startup, rasterizes each into a PixiJS Texture, and exposes
 * typed lookup functions used by the map layers.
 *
 * The SVGs are imported as raw strings via Vite's `import.meta.glob`,
 * then turned into blob URLs which Pixi's Assets pipeline reads as
 * SVG and rasterizes to a Texture. Resolution is multiplied so the
 * tile looks crisp at zoom-in (we author at 128×148 viewBox; Pixi
 * downsamples for typical hex sizes around 8 px and upsamples for
 * close zoom).
 *
 * Per CLAUDE.md "no hidden hands" — these are world entities (terrain,
 * buildings, settlements, units, rivers, roads, lake shores, biome
 * edges). Analytical overlays (catchment shading, heat maps, selection
 * highlight) stay procedural in their existing layer files.
 */

import { Texture } from 'pixi.js';
import type { Terrain } from '../../src/sim/world/terrain.js';
import type { SettlementTier } from '../../src/sim/world/settlement.js';
import type { BuildingId } from '../../src/sim/types.js';

export type EdgeDir = 'e' | 'ne' | 'nw' | 'w' | 'sw' | 'se';
export const EDGE_DIRS: readonly EdgeDir[] = ['e', 'ne', 'nw', 'w', 'sw', 'se'];

export type UnitKind =
  | 'caravan'
  | 'villager_caravan'
  | 'migrant_column'
  | 'news_carrier'
  | 'patrol'
  | 'legion'
  | 'bandit_raid'
  | 'bandit_camp';

export type ScatterKind =
  | 'tree-oak'
  | 'tree-pine'
  | 'tree-cypress'
  | 'rock-small'
  | 'rock-medium'
  | 'grass-tuft'
  | 'flower-yellow'
  | 'flower-purple'
  | 'bush-small'
  | 'mushroom'
  | 'fern'
  | 'log'
  | 'cactus';

export interface ArtRegistry {
  /** Per-terrain hex tile. For urban hexes, the caller passes a tier-resolved
   *  key like 'urban_town'; bare 'urban' falls back to urban_town. */
  terrain(key: TerrainKey): Texture;
  /** Per-building glyph. Falls back to a neutral placeholder if missing. */
  building(id: BuildingId): Texture;
  /** Per-settlement-tier glyph. */
  settlement(tier: SettlementTier): Texture;
  /** Per-unit-kind glyph. */
  unit(kind: UnitKind): Texture;
  /** River network for a given 6-bit connection bitmask (bit d = edge d
   *  has a connected neighbor). Pre-rendered full-tile shape with bends
   *  and junctions; meets every connected edge midpoint at a fixed width
   *  and color so neighbors match seamlessly. */
  river(bitmask: number): Texture;
  /** Dirt road network for a given 6-bit connection bitmask. */
  dirtRoad(bitmask: number): Texture;
  /** Roman road network for a given 6-bit connection bitmask. */
  romanRoad(bitmask: number): Texture;
  /** Lake shore strip along the given edge (composited over lake base when
   *  the neighbor on that edge is land). */
  lakeShore(dir: EdgeDir): Texture;
  /** Biome-edge feather strip along the given edge. The SVG uses
   *  currentColor for its fill so the caller tints by setting Sprite.tint
   *  to the source-terrain color. */
  biomeEdge(dir: EdgeDir): Texture;
  /** Per-biome decorative scatter sprites (trees / rocks / flowers / etc.)
   *  that the hex renderer places at deterministic random positions to
   *  break up the visible grid. */
  scatter(kind: ScatterKind): Texture;
}

/** Terrain keys cover both base terrains and urban tier variants. */
export type TerrainKey =
  | Terrain
  | 'urban_hamlet'
  | 'urban_village'
  | 'urban_town'
  | 'urban_small_city'
  | 'urban_large_city';

/** Resolve a sim Terrain + (optional) settlement tier into a TerrainKey
 *  for art lookup. Urban hexes pick the tier-specific tile; all other
 *  terrains pass through unchanged. */
export const terrainArtKey = (terrain: Terrain, urbanTier?: SettlementTier): TerrainKey => {
  if (terrain !== 'urban') return terrain;
  if (urbanTier === undefined) return 'urban_town';
  return `urban_${urbanTier}` as TerrainKey;
};

// --- SVG ingestion ---------------------------------------------------------

// Vite glob: import every .svg under viewer/art/ as a raw string at build
// time. The key is the relative path including the './' prefix.
const RAW_SVGS = import.meta.glob<string>('./**/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const svgToBlobUrl = (svg: string): string => {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  return URL.createObjectURL(blob);
};

/**
 * Rasterize one SVG string into a Pixi Texture.
 *
 * Pixi v8's Assets.load can't reliably auto-detect SVG when handed a blob
 * URL (no file extension, MIME hint not always honored), so we load the
 * SVG through an HTMLImageElement and let the browser's native SVG
 * rasterizer handle it.
 *
 * Critically, the HTMLImageElement's `load` event only guarantees that
 * the bytes are parsed — the image may not yet be decoded into a
 * pixel buffer the GPU can read. Handing such an image to
 * `Texture.from(img)` triggers WebGL's `texImage2D: bad image data`
 * warning and leaves the texture transparent (which renders as solid
 * black hexes). We work around this by rasterizing the SVG into a
 * fully-realized `ImageBitmap` first, which the spec guarantees is
 * decoded by the time the promise resolves.
 */
const loadTexture = async (svg: string, alias: string): Promise<Texture> => {
  // Parse the viewBox so we can give the SVG explicit pixel dimensions
  // before rasterizing. Without this, some browsers report the SVG
  // as having no natural size, and `createImageBitmap` then refuses
  // to rasterize it ("InvalidStateError: ... without natural
  // dimensions"). The viewBox is authoritative for our painterly art.
  const viewBox = parseViewBox(svg);
  const sized = ensureSvgPixelDimensions(svg, viewBox);
  const url = svgToBlobUrl(sized);
  try {
    const img = new Image();
    img.width = viewBox.width;
    img.height = viewBox.height;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Art: failed to load SVG ${alias}`));
      img.src = url;
    });
    // Rasterize to a fully-decoded ImageBitmap. The HTMLImageElement's
    // `load` event only guarantees the bytes are parsed — for SVG it
    // does NOT guarantee a usable raster. WebGL's texImage2D then
    // fails with `bad image data` and the texture renders solid
    // black. `createImageBitmap` forces a full decode.
    const bitmap = await createImageBitmap(img, {
      resizeWidth: viewBox.width,
      resizeHeight: viewBox.height,
    });
    return Texture.from(bitmap);
  } finally {
    URL.revokeObjectURL(url);
  }
};

interface ViewBox {
  readonly width: number;
  readonly height: number;
}

const VIEW_BOX_RE = /viewBox\s*=\s*"\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*"/;

const parseViewBox = (svg: string): ViewBox => {
  const match = VIEW_BOX_RE.exec(svg);
  if (match !== null) {
    const w = Number(match[3]);
    const h = Number(match[4]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  // Fallback: 128×148 matches the hex viewBox used by every painterly
  // asset in this project. If a future asset ships without a viewBox,
  // adopting the project default keeps it visible at the right scale.
  return { width: 128, height: 148 };
};

/**
 * If the SVG's root element lacks `width=`/`height=` attributes, splice
 * the viewBox-derived dimensions onto it. Browsers that compute natural
 * size from `<svg>` element attributes (rather than the viewBox) then
 * treat the image as sized and `createImageBitmap` succeeds.
 */
const ensureSvgPixelDimensions = (svg: string, viewBox: ViewBox): string => {
  if (/<svg\b[^>]*\bwidth\s*=/.test(svg) && /<svg\b[^>]*\bheight\s*=/.test(svg)) {
    return svg;
  }
  return svg.replace(/<svg\b/, `<svg width="${viewBox.width}" height="${viewBox.height}"`);
};

const lookupRaw = (relPath: string): string => {
  const raw = RAW_SVGS[relPath];
  if (raw === undefined) {
    throw new Error(
      `Art: missing SVG at ${relPath}. Available keys: ${Object.keys(RAW_SVGS).slice(0, 5).join(', ')}…`,
    );
  }
  return raw;
};

const TERRAIN_KEYS: readonly TerrainKey[] = [
  'plains',
  'fertile_valley',
  'hills',
  'mountains',
  'forest',
  'dense_forest',
  'marsh',
  'desert',
  'steppe',
  'river',
  'lake',
  'ruin',
  'urban_hamlet',
  'urban_village',
  'urban_town',
  'urban_small_city',
  'urban_large_city',
];

const BUILDING_IDS: readonly string[] = [
  'farm',
  'pasture',
  'mine',
  'quarry',
  'forester_camp',
  'sawmill',
  'mill',
  'bakery',
  'bloomery',
  'kiln',
  'pottery',
  'charcoal_kiln',
  'granary',
  'warehouse',
  'cistern',
  'smithy',
  'weaver_workshop',
  'tailor_shop',
  'winery',
  'oil_press',
  'dairy',
  'tannery',
  'fishery',
  'vineyard',
  'olive_grove',
  'orchard',
  'cart_wright',
  'mint',
  'temple',
  'forum_market',
  'walls',
  'barracks',
  'aqueduct_segment',
  'road_segment',
];

const SETTLEMENT_TIERS: readonly SettlementTier[] = [
  'hamlet',
  'village',
  'town',
  'small_city',
  'large_city',
];

const UNIT_KINDS: readonly UnitKind[] = [
  'caravan',
  'villager_caravan',
  'migrant_column',
  'news_carrier',
  'patrol',
  'legion',
  'bandit_raid',
  'bandit_camp',
];

const SCATTER_KINDS: readonly ScatterKind[] = [
  'tree-oak',
  'tree-pine',
  'tree-cypress',
  'rock-small',
  'rock-medium',
  'grass-tuft',
  'flower-yellow',
  'flower-purple',
  'bush-small',
  'mushroom',
  'fern',
  'log',
  'cactus',
];

export interface LoadArtOpts {
  /** Optional progress callback for the boot splash. */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Load every SVG in the art directory into Pixi Textures and return a
 * lookup registry. Call once at viewer startup, await before building
 * any map layer.
 */
export const loadArt = async (opts: LoadArtOpts = {}): Promise<ArtRegistry> => {
  const terrain = new Map<TerrainKey, Texture>();
  const building = new Map<string, Texture>();
  const settlement = new Map<SettlementTier, Texture>();
  const unit = new Map<UnitKind, Texture>();
  const river: Texture[] = new Array(64);
  const dirtRoad: Texture[] = new Array(64);
  const romanRoad: Texture[] = new Array(64);
  const lakeShore = new Map<EdgeDir, Texture>();
  const biomeEdge = new Map<EdgeDir, Texture>();
  const scatter = new Map<ScatterKind, Texture>();

  const total =
    TERRAIN_KEYS.length +
    BUILDING_IDS.length +
    SETTLEMENT_TIERS.length +
    UNIT_KINDS.length +
    SCATTER_KINDS.length +
    EDGE_DIRS.length * 2 + // lake_shore + biome_edge
    64 * 3; // 64-bitmask river / dirt / roman atlases
  let loaded = 0;
  const tick = (): void => {
    loaded++;
    opts.onProgress?.(loaded, total);
  };

  // Sequential loads keep peak memory bounded; the SVGs are tiny so this is
  // fast even on a slow machine. If startup becomes a bottleneck we can
  // promise.all the categories independently.
  for (const k of TERRAIN_KEYS) {
    terrain.set(k, await loadTexture(lookupRaw(`./terrain/${k}.svg`), `art-terrain-${k}`));
    tick();
  }
  for (const id of BUILDING_IDS) {
    building.set(id, await loadTexture(lookupRaw(`./buildings/${id}.svg`), `art-building-${id}`));
    tick();
  }
  for (const t of SETTLEMENT_TIERS) {
    settlement.set(
      t,
      await loadTexture(lookupRaw(`./settlements/${t}.svg`), `art-settlement-${t}`),
    );
    tick();
  }
  for (const u of UNIT_KINDS) {
    unit.set(u, await loadTexture(lookupRaw(`./units/${u}.svg`), `art-unit-${u}`));
    tick();
  }
  for (let bm = 0; bm < 64; bm++) {
    river[bm] = await loadTexture(lookupRaw(`./rivers/c${bm}.svg`), `art-river-c${bm}`);
    tick();
  }
  for (let bm = 0; bm < 64; bm++) {
    dirtRoad[bm] = await loadTexture(lookupRaw(`./roads/dirt/c${bm}.svg`), `art-roaddirt-c${bm}`);
    tick();
  }
  for (let bm = 0; bm < 64; bm++) {
    romanRoad[bm] = await loadTexture(
      lookupRaw(`./roads/roman/c${bm}.svg`),
      `art-roadroman-c${bm}`,
    );
    tick();
  }
  for (const d of EDGE_DIRS) {
    lakeShore.set(d, await loadTexture(lookupRaw(`./lake_shore/${d}.svg`), `art-shore-${d}`));
    tick();
  }
  for (const d of EDGE_DIRS) {
    biomeEdge.set(d, await loadTexture(lookupRaw(`./biome_edges/${d}.svg`), `art-biomeedge-${d}`));
    tick();
  }
  for (const s of SCATTER_KINDS) {
    scatter.set(s, await loadTexture(lookupRaw(`./scatter/${s}.svg`), `art-scatter-${s}`));
    tick();
  }

  const placeholderBuilding =
    building.get('warehouse') ?? building.get('forum_market') ?? building.get('farm')!;

  return {
    terrain: (key) => {
      const t = terrain.get(key);
      if (t === undefined) throw new Error(`Art: no terrain texture for "${key}"`);
      return t;
    },
    building: (id) => building.get(String(id)) ?? placeholderBuilding,
    settlement: (tier) => settlement.get(tier)!,
    unit: (kind) => unit.get(kind)!,
    river: (bm) => river[bm & 0x3f]!,
    dirtRoad: (bm) => dirtRoad[bm & 0x3f]!,
    romanRoad: (bm) => romanRoad[bm & 0x3f]!,
    lakeShore: (dir) => lakeShore.get(dir)!,
    biomeEdge: (dir) => biomeEdge.get(dir)!,
    scatter: (kind) => scatter.get(kind)!,
  };
};
