import { describe, expect, it } from 'vitest';
import { hex, hexKey, type Hex } from './hex.js';
import {
  createSpatialIndex,
  indexFromWorld,
  type MoverRef,
  type SpatialIndex,
} from './spatialIndex.js';
import { actorId, caravanId, type Day } from '../types.js';
import { createCaravan, type Caravan } from '../caravan/caravan.js';
import { createReputationTable } from '../reputation/table.js';
import { createGrid } from './grid.js';
import type { WorldState } from '../../procgen/seed.js';

const cRef = (id: string): MoverRef => ({ kind: 'caravan', id });
const nRef = (id: string): MoverRef => ({ kind: 'news_carrier', id });
const pRef = (id: string): MoverRef => ({ kind: 'patrol', id });
const mRef = (id: string): MoverRef => ({ kind: 'migration_column', id });
const bRef = (id: string): MoverRef => ({ kind: 'bandit_camp', id });

describe('createSpatialIndex — empty state', () => {
  it('size is 0', () => {
    expect(createSpatialIndex().size()).toBe(0);
  });

  it('at(any hex) returns empty', () => {
    const idx = createSpatialIndex();
    expect(idx.at(hex(0, 0))).toEqual([]);
    expect(idx.at(hex(99, -42))).toEqual([]);
  });

  it('positionOf any ref returns undefined', () => {
    const idx = createSpatialIndex();
    expect(idx.positionOf(cRef('nope'))).toBeUndefined();
  });
});

describe('place + at', () => {
  it('round-trips a single placement', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(2, 3));
    expect(idx.at(hex(2, 3))).toEqual([cRef('c1')]);
    expect(idx.size()).toBe(1);
  });

  it('handles multiple distinct refs at the same hex', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(0, 0));
    idx.place(pRef('p1'), hex(0, 0));
    idx.place(nRef('n1'), hex(0, 0));
    const at = idx.at(hex(0, 0));
    expect(at.length).toBe(3);
    const kinds = at.map((r) => r.kind).sort();
    expect(kinds).toEqual(['caravan', 'news_carrier', 'patrol']);
  });

  it('place same ref at a new hex moves it (only the new hex returns the ref)', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(0, 0));
    idx.place(cRef('c1'), hex(5, 5));
    expect(idx.at(hex(0, 0))).toEqual([]);
    expect(idx.at(hex(5, 5))).toEqual([cRef('c1')]);
    expect(idx.size()).toBe(1);
  });

  it('placing the same ref at the same hex twice is a no-op (no duplicates)', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(0, 0));
    idx.place(cRef('c1'), hex(0, 0));
    expect(idx.at(hex(0, 0))).toEqual([cRef('c1')]);
    expect(idx.size()).toBe(1);
  });

  it('treats different kinds with the same id as distinct', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('shared'), hex(0, 0));
    idx.place(pRef('shared'), hex(0, 0));
    expect(idx.at(hex(0, 0)).length).toBe(2);
    expect(idx.size()).toBe(2);
  });
});

describe('remove', () => {
  it('drops the ref entirely', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(0, 0));
    idx.remove(cRef('c1'));
    expect(idx.at(hex(0, 0))).toEqual([]);
    expect(idx.positionOf(cRef('c1'))).toBeUndefined();
    expect(idx.size()).toBe(0);
  });

  it('is a no-op if the ref was never placed', () => {
    const idx = createSpatialIndex();
    idx.remove(cRef('ghost'));
    expect(idx.size()).toBe(0);
  });

  it('only removes the targeted ref, not other refs at the same hex', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(0, 0));
    idx.place(pRef('p1'), hex(0, 0));
    idx.remove(cRef('c1'));
    expect(idx.at(hex(0, 0))).toEqual([pRef('p1')]);
    expect(idx.size()).toBe(1);
  });
});

describe('positionOf', () => {
  it('returns the placed hex', () => {
    const idx = createSpatialIndex();
    idx.place(nRef('n1'), hex(7, -3));
    expect(idx.positionOf(nRef('n1'))).toEqual(hex(7, -3));
  });

  it('reflects updates after a place-move', () => {
    const idx = createSpatialIndex();
    idx.place(nRef('n1'), hex(0, 0));
    idx.place(nRef('n1'), hex(1, 1));
    expect(idx.positionOf(nRef('n1'))).toEqual(hex(1, 1));
  });
});

describe('withinRange', () => {
  it('returns the single ref at radius 0 if it exists', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c1'), hex(2, 2));
    const found = idx.withinRange(hex(2, 2), 0);
    expect(found.length).toBe(1);
    expect(found[0]?.ref).toEqual(cRef('c1'));
    expect(found[0]?.hex).toEqual(hex(2, 2));
  });

  it('aggregates refs from multiple hexes within radius', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('center'), hex(0, 0));
    idx.place(pRef('east'), hex(1, 0));
    idx.place(nRef('south'), hex(0, 1));
    idx.place(bRef('far'), hex(5, 5)); // outside radius 2
    const found = idx.withinRange(hex(0, 0), 2);
    const ids = found.map((f) => f.ref.id).sort();
    expect(ids).toEqual(['center', 'east', 'south']);
  });

  it('returns empty when nothing is in range', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('far'), hex(20, 20));
    expect(idx.withinRange(hex(0, 0), 5)).toEqual([]);
  });

  it('is order-stable across calls (deterministic)', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('a'), hex(0, 0));
    idx.place(pRef('b'), hex(1, 0));
    idx.place(nRef('c'), hex(0, 1));
    idx.place(mRef('d'), hex(-1, 0));
    const r1 = idx.withinRange(hex(0, 0), 1);
    const r2 = idx.withinRange(hex(0, 0), 1);
    expect(r1.map((x) => `${x.ref.kind}:${x.ref.id}:${hexKey(x.hex)}`)).toEqual(
      r2.map((x) => `${x.ref.kind}:${x.ref.id}:${hexKey(x.hex)}`),
    );
  });

  it('treats negative radius as empty', () => {
    const idx = createSpatialIndex();
    idx.place(cRef('c'), hex(0, 0));
    expect(idx.withinRange(hex(0, 0), -1)).toEqual([]);
  });
});

describe('indexFromWorld', () => {
  const buildEmptyWorld = (): WorldState => ({
    day: 0 as Day,
    grid: createGrid(),
    settlements: new Map(),
    actors: new Map(),
    factions: new Map(),
    characters: new Map(),
    caravans: new Map(),
    reputation: createReputationTable(),
    bySite: [],
  });

  it('builds an empty index from an empty world', () => {
    const idx = indexFromWorld(buildEmptyWorld());
    expect(idx.size()).toBe(0);
  });

  it('indexes every caravan by its current position', () => {
    const w = buildEmptyWorld();
    const c1 = createCaravan({
      id: caravanId('c1'),
      ownerActor: actorId('a'),
      position: hex(3, 4),
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 5 },
      vehicles: { pack_saddle: 1 },
    });
    const c2 = createCaravan({
      id: caravanId('c2'),
      ownerActor: actorId('a'),
      position: hex(0, 0),
      crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
      animals: { mule: 5 },
      vehicles: { pack_saddle: 1 },
    });
    w.caravans.set(c1.id, c1);
    w.caravans.set(c2.id, c2);
    const idx = indexFromWorld(w);
    expect(idx.size()).toBe(2);
    expect(idx.at(hex(3, 4))).toEqual([cRef('c1')]);
    expect(idx.at(hex(0, 0))).toEqual([cRef('c2')]);
  });

  it('handles two caravans on the same hex', () => {
    const w = buildEmptyWorld();
    const mk = (cid: string, pos: Hex): Caravan =>
      createCaravan({
        id: caravanId(cid),
        ownerActor: actorId('a'),
        position: pos,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 5 },
        vehicles: { pack_saddle: 1 },
      });
    const a = mk('a', hex(2, 2));
    const b = mk('b', hex(2, 2));
    w.caravans.set(a.id, a);
    w.caravans.set(b.id, b);
    const idx = indexFromWorld(w);
    expect(idx.at(hex(2, 2)).length).toBe(2);
  });
});

describe('performance smoke', () => {
  it('handles 10,000 placements + 1,000 lookups well under 500ms', () => {
    const idx: SpatialIndex = createSpatialIndex();
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const q = i % 100;
      const r = Math.floor(i / 100) % 100;
      idx.place(cRef(`c${i}`), hex(q, r));
    }
    expect(idx.size()).toBe(N);
    const t0 = performance.now();
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      const q = i % 100;
      const r = Math.floor(i / 100) % 100;
      total += idx.at(hex(q, r)).length;
    }
    const elapsed = performance.now() - t0;
    expect(total).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});
