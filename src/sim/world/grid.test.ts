import { describe, expect, it } from 'vitest';
import { hex, hexKey, hexNeighbors, hexesWithinRange } from './hex.js';
import { createGrid, gridFromMap } from './grid.js';
import type { HexTile } from './terrain.js';

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 0,
  hasRiver: false,
  hasCoast: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

describe('createGrid', () => {
  it('starts empty', () => {
    const g = createGrid();
    expect(g.size()).toBe(0);
    expect(g.has(hex(0, 0))).toBe(false);
    expect(g.get(hex(0, 0))).toBeUndefined();
  });

  it('round-trips set/get', () => {
    const g = createGrid();
    const t = tile({ terrain: 'forest' });
    g.set(hex(2, -1), t);
    expect(g.has(hex(2, -1))).toBe(true);
    expect(g.get(hex(2, -1))).toBe(t);
  });

  it('grows in size as new tiles are added', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    g.set(hex(1, 0), tile());
    g.set(hex(0, 1), tile());
    expect(g.size()).toBe(3);
  });

  it('overwrites a tile when set is called with the same hex twice', () => {
    const g = createGrid();
    const a = tile({ terrain: 'plains' });
    const b = tile({ terrain: 'mountains' });
    g.set(hex(5, 5), a);
    g.set(hex(5, 5), b);
    expect(g.size()).toBe(1);
    expect(g.get(hex(5, 5))).toBe(b);
  });

  it('treats axial coordinates correctly (q, r are independent dimensions)', () => {
    const g = createGrid();
    g.set(hex(1, 0), tile({ terrain: 'forest' }));
    g.set(hex(0, 1), tile({ terrain: 'desert' }));
    expect(g.get(hex(1, 0))?.terrain).toBe('forest');
    expect(g.get(hex(0, 1))?.terrain).toBe('desert');
  });
});

describe('iteration', () => {
  it('hexes() yields each set hex exactly once', () => {
    const g = createGrid();
    const coords = [hex(0, 0), hex(1, 0), hex(2, -1), hex(-3, 4)];
    for (const c of coords) g.set(c, tile());
    const seen = new Set<string>();
    for (const h of g.hexes()) {
      const key = hexKey(h);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(coords.length);
    for (const c of coords) {
      expect(seen.has(hexKey(c))).toBe(true);
    }
  });

  it('tiles() yields [hex, tile] pairs for each set tile', () => {
    const g = createGrid();
    const t1 = tile({ terrain: 'plains' });
    const t2 = tile({ terrain: 'mountains' });
    g.set(hex(0, 0), t1);
    g.set(hex(1, -1), t2);
    const collected = new Map<string, HexTile>();
    for (const [h, t] of g.tiles()) {
      collected.set(hexKey(h), t);
    }
    expect(collected.size).toBe(2);
    expect(collected.get(hexKey(hex(0, 0)))).toBe(t1);
    expect(collected.get(hexKey(hex(1, -1)))).toBe(t2);
  });

  it('iteration produces no entries on an empty grid', () => {
    const g = createGrid();
    expect(Array.from(g.hexes())).toEqual([]);
    expect(Array.from(g.tiles())).toEqual([]);
  });
});

describe('neighborsOf', () => {
  it('returns existing neighbors only (skips missing ones)', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    // Set only two of the six neighbors
    g.set(hex(1, 0), tile({ terrain: 'forest' }));
    g.set(hex(-1, 0), tile({ terrain: 'mountains' }));
    const ns = g.neighborsOf(hex(0, 0));
    expect(ns.length).toBe(2);
    const terrains = ns.map(([, t]) => t.terrain).sort();
    expect(terrains).toEqual(['forest', 'mountains']);
  });

  it('returns all six neighbors when they exist', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    for (const n of hexNeighbors(hex(0, 0))) {
      g.set(n, tile());
    }
    expect(g.neighborsOf(hex(0, 0)).length).toBe(6);
  });

  it('returns empty when the center has no neighbors set', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    expect(g.neighborsOf(hex(0, 0))).toEqual([]);
  });

  it('returns empty when the center hex itself is not in the grid (still works for queries)', () => {
    const g = createGrid();
    g.set(hex(1, 0), tile());
    // The queried center isn't required to be in the grid; we just want the neighbors.
    const ns = g.neighborsOf(hex(0, 0));
    expect(ns.length).toBe(1);
  });
});

describe('withinRange', () => {
  it('returns just the center for radius 0 if it exists', () => {
    const g = createGrid();
    g.set(hex(2, 2), tile({ terrain: 'urban' }));
    const r = g.withinRange(hex(2, 2), 0);
    expect(r.length).toBe(1);
    expect(r[0]?.[1].terrain).toBe('urban');
  });

  it('returns nothing if the center exists in the grid but radius 0 query misses it', () => {
    const g = createGrid();
    // Empty grid; center not in grid.
    expect(g.withinRange(hex(0, 0), 0)).toEqual([]);
  });

  it('returns only existing tiles within the radius', () => {
    const g = createGrid();
    // Fill a small patch.
    for (const h of hexesWithinRange(hex(0, 0), 2)) {
      g.set(h, tile());
    }
    // Add a tile outside the queried radius — should NOT show up.
    g.set(hex(10, -5), tile());
    const inRadius1 = g.withinRange(hex(0, 0), 1);
    expect(inRadius1.length).toBe(7);
  });

  it('skips holes inside the radius', () => {
    const g = createGrid();
    g.set(hex(0, 0), tile());
    g.set(hex(1, 0), tile());
    // hex(0, 1) intentionally missing
    g.set(hex(-1, 1), tile());
    const r = g.withinRange(hex(0, 0), 1);
    expect(r.length).toBe(3);
  });
});

describe('gridFromMap', () => {
  it('initializes from a ReadonlyMap of hexKey → tile', () => {
    const initial = new Map<string, HexTile>([
      [hexKey(hex(0, 0)), tile({ terrain: 'plains' })],
      [hexKey(hex(1, 0)), tile({ terrain: 'forest' })],
      [hexKey(hex(-1, 1)), tile({ terrain: 'mountains' })],
    ]);
    const g = gridFromMap(initial);
    expect(g.size()).toBe(3);
    expect(g.get(hex(0, 0))?.terrain).toBe('plains');
    expect(g.get(hex(1, 0))?.terrain).toBe('forest');
    expect(g.get(hex(-1, 1))?.terrain).toBe('mountains');
  });

  it('throws on a malformed key in the initial map', () => {
    const initial = new Map<string, HexTile>([['not-a-hex-key', tile()]]);
    expect(() => gridFromMap(initial)).toThrow();
  });
});

describe('scale sanity', () => {
  it('handles 10k tiles without breaking iteration', () => {
    const g = createGrid();
    const N = 100;
    for (let q = 0; q < N; q++) {
      for (let r = 0; r < N; r++) {
        g.set(hex(q, r), tile());
      }
    }
    expect(g.size()).toBe(N * N);
    let count = 0;
    for (const _ of g.hexes()) count++;
    expect(count).toBe(N * N);
  });
});
