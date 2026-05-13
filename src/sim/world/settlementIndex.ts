/**
 * Per-world settlement index, cached by WorldState identity.
 *
 * Several phases need to look up settlements by anchor hex or enumerate
 * the local-trade neighbour pairs more than once a tick:
 *   - `localTradePhase` iterates pairs every day.
 *   - `caravanReplanPhase` queries candidates when picking destinations.
 *   - `banditPhase` uses `byAnchorHex` to skip "caravan parked at a
 *     settlement" when scanning for raid targets.
 *
 * The index is invalidated by settlement count change — when towns get
 * abandoned (or, far in the future, founded), the cache rebuilds.
 *
 * `LOCAL_TRADE_MAX_HEX_DISTANCE` is the longest the neighbour-pair list
 * needs to cover; the per-resource cap from `localTradeMaxHexDistanceForResource`
 * narrows further inside the trade phase.
 */

import { hexDistance, hexesWithinRange, hexKey, type Hex } from './hex.js';
import type { Settlement } from './settlement.js';
import type { SettlementId } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';

export const LOCAL_TRADE_MAX_HEX_DISTANCE = 6;

export interface SettlementAnchorIndex {
  readonly settlementCount: number;
  readonly byAnchorHex: ReadonlyMap<string, readonly Settlement[]>;
  readonly localTradePairs: readonly {
    readonly a: Settlement;
    readonly b: Settlement;
    readonly dist: number;
  }[];
  readonly candidates: readonly {
    readonly id: SettlementId;
    readonly hex: Hex;
    readonly tier: Settlement['tier'];
  }[];
}

const settlementAnchorIndexCache: WeakMap<WorldState, SettlementAnchorIndex> = new WeakMap();

export const settlementAnchorIndexForWorld = (world: WorldState): SettlementAnchorIndex => {
  const cached = settlementAnchorIndexCache.get(world);
  if (cached !== undefined && cached.settlementCount === world.settlements.size) return cached;

  const byAnchorHex = new Map<string, Settlement[]>();
  const candidates: { id: SettlementId; hex: Hex; tier: Settlement['tier'] }[] = [];
  for (const s of world.settlements.values()) {
    candidates.push({ id: s.id, hex: s.anchor, tier: s.tier });
    const k = hexKey(s.anchor);
    let bucket = byAnchorHex.get(k);
    if (bucket === undefined) {
      bucket = [];
      byAnchorHex.set(k, bucket);
    }
    bucket.push(s);
  }

  const localTradePairs: { a: Settlement; b: Settlement; dist: number }[] = [];
  for (const a of world.settlements.values()) {
    for (const neighborHex of hexesWithinRange(a.anchor, LOCAL_TRADE_MAX_HEX_DISTANCE)) {
      const bucket = byAnchorHex.get(hexKey(neighborHex));
      if (bucket === undefined) continue;
      for (const b of bucket) {
        // Determinism: preserve the previous per-day pair order exactly.
        if (String(a.id) >= String(b.id)) continue;
        const dist = hexDistance(a.anchor, b.anchor);
        if (dist > LOCAL_TRADE_MAX_HEX_DISTANCE) continue;
        localTradePairs.push({ a, b, dist });
      }
    }
  }

  const index: SettlementAnchorIndex = {
    settlementCount: world.settlements.size,
    byAnchorHex,
    localTradePairs,
    candidates,
  };
  settlementAnchorIndexCache.set(world, index);
  return index;
};
