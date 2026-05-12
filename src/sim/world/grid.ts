/**
 * Sparse hex grid storage.
 *
 * The map can be ~250,000 hexes (docs/01-simulation-frame.md), but only
 * ~15-20% are settled and the procgen layer may not place every hex up
 * front. So we store sparsely with a Map keyed by hex string ("q,r").
 *
 * A dense 500×500 array would waste memory on empty cells, lock us to a
 * fixed bounding box, and pre-commit to (q, r) → row/col layout that the
 * pointy-top axial system doesn't naturally fit. The Map approach iterates
 * in insertion order, which is fine: callers that need spatial order use
 * withinRange / neighborsOf rather than hex().
 *
 * Performance notes for future-us:
 *   - 250k Map entries is ~30 MB rough — acceptable.
 *   - Hot path lookups are O(1).
 *   - For tight inner loops, consider a Structure-of-Arrays layout indexed
 *     by a hex→u32 id assigned at procgen time; not needed for v1.
 */

import { hexKey, hexNeighbors, hexesWithinRange, parseHexKey } from './hex.js';
import type { Hex } from './hex.js';
import type { HexTile } from './terrain.js';

const COORD_KEY_OFFSET = 32768;

const coordKey = (q: number, r: number): number =>
  (((q + COORD_KEY_OFFSET) << 16) | (r + COORD_KEY_OFFSET)) >>> 0;

export interface HexGrid {
  readonly coordTiles: ReadonlyMap<number, HexTile>;
  readonly coordIndex: ReadonlyMap<number, number>;
  readonly coordKeysByIndex: readonly number[];
  readonly tilesByIndex: readonly HexTile[];
  readonly neighborIndicesByIndex: readonly (readonly number[])[];
  readonly tileVersion: number;
  size(): number;
  get(h: Hex): HexTile | undefined;
  getAt(q: number, r: number): HexTile | undefined;
  has(h: Hex): boolean;
  hasAt(q: number, r: number): boolean;
  set(h: Hex, tile: HexTile): void;
  markTileChanged(h: Hex): void;
  hexes(): IterableIterator<Hex>;
  tiles(): IterableIterator<readonly [Hex, HexTile]>;
  /** Existing neighbors of `h` (1..6 entries). */
  neighborsOf(h: Hex): readonly (readonly [Hex, HexTile])[];
  /** Existing tiles within `radius` hex steps of `center` (inclusive). */
  withinRange(center: Hex, radius: number): readonly (readonly [Hex, HexTile])[];
}

class MapHexGrid implements HexGrid {
  private readonly store: Map<string, HexTile>;
  private readonly coordStore: Map<number, HexTile>;
  private readonly coordIndexStore: Map<number, number>;
  private readonly coordKeys: number[];
  private readonly indexTiles: HexTile[];
  private readonly indexNeighbors: number[][];
  private version = 0;
  readonly coordTiles: ReadonlyMap<number, HexTile>;
  readonly coordIndex: ReadonlyMap<number, number>;
  readonly coordKeysByIndex: readonly number[];
  readonly tilesByIndex: readonly HexTile[];
  readonly neighborIndicesByIndex: readonly (readonly number[])[];

  get tileVersion(): number {
    return this.version;
  }

  constructor(initial?: ReadonlyMap<string, HexTile>) {
    this.store = new Map();
    this.coordStore = new Map();
    this.coordIndexStore = new Map();
    this.coordKeys = [];
    this.indexTiles = [];
    this.indexNeighbors = [];
    this.coordTiles = this.coordStore;
    this.coordIndex = this.coordIndexStore;
    this.coordKeysByIndex = this.coordKeys;
    this.tilesByIndex = this.indexTiles;
    this.neighborIndicesByIndex = this.indexNeighbors;
    if (initial !== undefined) {
      for (const [key, tile] of initial) {
        // Validate the key by round-tripping. parseHexKey throws on garbage,
        // which surfaces malformed procgen output at construction time
        // rather than at first lookup.
        const h = parseHexKey(key);
        const cKey = coordKey(h.q, h.r);
        this.store.set(key, tile);
        this.coordStore.set(cKey, tile);
        this.coordIndexStore.set(cKey, this.indexTiles.length);
        this.coordKeys.push(cKey);
        this.indexTiles.push(tile);
        this.indexNeighbors.push([]);
      }
      this.rebuildNeighborIndexes();
    }
  }

  size(): number {
    return this.store.size;
  }

  get(h: Hex): HexTile | undefined {
    return this.store.get(hexKey(h));
  }

  getAt(q: number, r: number): HexTile | undefined {
    return this.coordStore.get(coordKey(q, r));
  }

  has(h: Hex): boolean {
    return this.store.has(hexKey(h));
  }

  hasAt(q: number, r: number): boolean {
    return this.coordStore.has(coordKey(q, r));
  }

  set(h: Hex, tile: HexTile): void {
    const key = hexKey(h);
    const cKey = coordKey(h.q, h.r);
    this.store.set(key, tile);
    this.coordStore.set(cKey, tile);
    const index = this.coordIndexStore.get(cKey);
    if (index === undefined) {
      this.coordIndexStore.set(cKey, this.indexTiles.length);
      this.coordKeys.push(cKey);
      this.indexTiles.push(tile);
      this.indexNeighbors.push([]);
      const newIndex = this.indexTiles.length - 1;
      this.refreshNeighborIndex(newIndex);
      for (const neighbor of hexNeighbors(h)) {
        const neighborIndex = this.coordIndexStore.get(coordKey(neighbor.q, neighbor.r));
        if (neighborIndex !== undefined) this.refreshNeighborIndex(neighborIndex);
      }
    } else {
      this.indexTiles[index] = tile;
    }
    this.version++;
  }

  markTileChanged(h: Hex): void {
    if (this.coordIndexStore.has(coordKey(h.q, h.r))) {
      this.version++;
    }
  }

  private rebuildNeighborIndexes(): void {
    for (let index = 0; index < this.coordKeys.length; index++) {
      this.refreshNeighborIndex(index);
    }
  }

  private refreshNeighborIndex(index: number): void {
    const cKey = this.coordKeys[index];
    if (cKey === undefined) return;
    const h = { q: (cKey >>> 16) - COORD_KEY_OFFSET, r: (cKey & 0xffff) - COORD_KEY_OFFSET };
    const neighbors = this.indexNeighbors[index] ?? [];
    neighbors.length = 0;
    for (const neighbor of hexNeighbors(h)) {
      const neighborIndex = this.coordIndexStore.get(coordKey(neighbor.q, neighbor.r));
      if (neighborIndex !== undefined) neighbors.push(neighborIndex);
    }
    this.indexNeighbors[index] = neighbors;
  }

  *hexes(): IterableIterator<Hex> {
    for (const key of this.store.keys()) {
      yield parseHexKey(key);
    }
  }

  *tiles(): IterableIterator<readonly [Hex, HexTile]> {
    for (const [key, tile] of this.store) {
      yield [parseHexKey(key), tile];
    }
  }

  neighborsOf(h: Hex): readonly (readonly [Hex, HexTile])[] {
    const out: (readonly [Hex, HexTile])[] = [];
    for (const n of hexNeighbors(h)) {
      const tile = this.store.get(hexKey(n));
      if (tile !== undefined) {
        out.push([n, tile] as const);
      }
    }
    return out;
  }

  withinRange(center: Hex, radius: number): readonly (readonly [Hex, HexTile])[] {
    if (radius < 0) return [];
    const out: (readonly [Hex, HexTile])[] = [];
    for (const h of hexesWithinRange(center, radius)) {
      const tile = this.store.get(hexKey(h));
      if (tile !== undefined) {
        out.push([h, tile] as const);
      }
    }
    return out;
  }
}

export const createGrid = (): HexGrid => new MapHexGrid();

export const gridFromMap = (initial: ReadonlyMap<string, HexTile>): HexGrid =>
  new MapHexGrid(initial);
