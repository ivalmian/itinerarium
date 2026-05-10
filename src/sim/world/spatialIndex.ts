/**
 * Spatial index for movers (caravans, news carriers, patrols, migration
 * columns, bandit camps).
 *
 * Without this, every tick that needs "what's at hex X" or "what's near
 * hex X" must scan every entity in the world. With it, a single hex
 * lookup is O(1) and a small-radius lookup is O(neighbours), regardless
 * of how many movers exist globally.
 *
 * Storage:
 *   - `posByRef: Map<refKey, Hex>` — current hex of each known ref.
 *   - `refsByHex: Map<hexKey, MoverRef[]>` — refs at each hex (insertion
 *     order, no duplicates because place() removes-then-adds).
 *
 * The two structures are kept in sync by all mutation paths (place,
 * remove). Iteration order from `at()` and `withinRange()` is stable
 * across calls — important because the tick loop's encounter resolution
 * must be deterministic.
 *
 * The set of mover kinds is closed (`MoverKind`); to add new ones you
 * extend the union and the indexFromWorld() switch. We deliberately
 * avoid a generic Map<unknown> bag so that callers get a TS error rather
 * than silently using untyped strings.
 */

import { hexKey, hexesWithinRange, type Hex } from './hex.js';
import type { WorldState } from '../../procgen/seed.js';

export type MoverKind = 'caravan' | 'news_carrier' | 'patrol' | 'migration_column' | 'bandit_camp';

export interface MoverRef {
  readonly kind: MoverKind;
  readonly id: string;
}

export interface SpatialIndex {
  /** O(1): place a ref at a hex (removes it from any prior hex first). */
  place(ref: MoverRef, hex: Hex): void;
  /** Remove a ref from the index entirely. No-op if not present. */
  remove(ref: MoverRef): void;
  /** Refs at exactly `hex`. Empty if none. */
  at(hex: Hex): readonly MoverRef[];
  /** Refs within `radius` hex steps of `center` (inclusive). */
  withinRange(
    center: Hex,
    radius: number,
  ): readonly { readonly ref: MoverRef; readonly hex: Hex }[];
  /** Current hex of `ref`, or undefined if not in the index. */
  positionOf(ref: MoverRef): Hex | undefined;
  /** Number of distinct refs in the index. */
  size(): number;
}

const refKey = (ref: MoverRef): string => `${ref.kind}|${ref.id}`;

class MapSpatialIndex implements SpatialIndex {
  private readonly posByRef: Map<string, Hex> = new Map();
  private readonly refsByHex: Map<string, MoverRef[]> = new Map();

  place(ref: MoverRef, hex: Hex): void {
    const rk = refKey(ref);
    const prior = this.posByRef.get(rk);
    if (prior !== undefined) {
      if (prior.q === hex.q && prior.r === hex.r) {
        // Same hex — nothing to do; preserves "no duplicates" invariant.
        return;
      }
      this.removeFromHex(rk, prior);
    }
    const hk = hexKey(hex);
    let list = this.refsByHex.get(hk);
    if (list === undefined) {
      list = [];
      this.refsByHex.set(hk, list);
    }
    list.push({ kind: ref.kind, id: ref.id });
    this.posByRef.set(rk, { q: hex.q, r: hex.r });
  }

  remove(ref: MoverRef): void {
    const rk = refKey(ref);
    const prior = this.posByRef.get(rk);
    if (prior === undefined) return;
    this.removeFromHex(rk, prior);
    this.posByRef.delete(rk);
  }

  at(hex: Hex): readonly MoverRef[] {
    const list = this.refsByHex.get(hexKey(hex));
    if (list === undefined) return [];
    return list.slice();
  }

  withinRange(
    center: Hex,
    radius: number,
  ): readonly { readonly ref: MoverRef; readonly hex: Hex }[] {
    if (radius < 0) return [];
    const out: { ref: MoverRef; hex: Hex }[] = [];
    for (const h of hexesWithinRange(center, radius)) {
      const list = this.refsByHex.get(hexKey(h));
      if (list === undefined) continue;
      for (const ref of list) {
        out.push({ ref: { kind: ref.kind, id: ref.id }, hex: h });
      }
    }
    return out;
  }

  positionOf(ref: MoverRef): Hex | undefined {
    const p = this.posByRef.get(refKey(ref));
    if (p === undefined) return undefined;
    return { q: p.q, r: p.r };
  }

  size(): number {
    return this.posByRef.size;
  }

  private removeFromHex(rk: string, hex: Hex): void {
    const hk = hexKey(hex);
    const list = this.refsByHex.get(hk);
    if (list === undefined) return;
    for (let i = 0; i < list.length; i++) {
      const r = list[i] as MoverRef;
      if (refKey(r) === rk) {
        list.splice(i, 1);
        break;
      }
    }
    if (list.length === 0) this.refsByHex.delete(hk);
  }
}

export const createSpatialIndex = (): SpatialIndex => new MapSpatialIndex();

/**
 * Build a spatial index from a WorldState snapshot. Today only caravans
 * are tracked on WorldState; as news carriers, patrols, migration
 * columns, and bandit camps get integrated into WorldState in later
 * tasks, this function should grow to index them too. Callers that hold
 * those entities outside WorldState can use `place()` directly to add
 * them after construction.
 */
export const indexFromWorld = (world: WorldState): SpatialIndex => {
  const idx = createSpatialIndex();
  for (const c of world.caravans.values()) {
    idx.place({ kind: 'caravan', id: String(c.id) }, c.position);
  }
  return idx;
};
