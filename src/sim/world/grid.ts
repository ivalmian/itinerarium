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

export interface HexGrid {
  size(): number;
  get(h: Hex): HexTile | undefined;
  has(h: Hex): boolean;
  set(h: Hex, tile: HexTile): void;
  hexes(): IterableIterator<Hex>;
  tiles(): IterableIterator<readonly [Hex, HexTile]>;
  /** Existing neighbors of `h` (1..6 entries). */
  neighborsOf(h: Hex): readonly (readonly [Hex, HexTile])[];
  /** Existing tiles within `radius` hex steps of `center` (inclusive). */
  withinRange(center: Hex, radius: number): readonly (readonly [Hex, HexTile])[];
}

class MapHexGrid implements HexGrid {
  private readonly store: Map<string, HexTile>;

  constructor(initial?: ReadonlyMap<string, HexTile>) {
    this.store = new Map();
    if (initial !== undefined) {
      for (const [key, tile] of initial) {
        // Validate the key by round-tripping. parseHexKey throws on garbage,
        // which surfaces malformed procgen output at construction time
        // rather than at first lookup.
        parseHexKey(key);
        this.store.set(key, tile);
      }
    }
  }

  size(): number {
    return this.store.size;
  }

  get(h: Hex): HexTile | undefined {
    return this.store.get(hexKey(h));
  }

  has(h: Hex): boolean {
    return this.store.has(hexKey(h));
  }

  set(h: Hex, tile: HexTile): void {
    this.store.set(hexKey(h), tile);
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
