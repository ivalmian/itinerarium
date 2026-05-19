/**
 * Phase 0: age every settlement's recent-flow counters.
 *
 * `Settlement.market.recentImports / recentExports / recentProduction
 * / recentConsumption / recentInflows / recentOutflows` are
 * exponentially-decaying ~30-day rolling windows of market activity.
 * Without this daily decay they would grow monotonically from world
 * start — the viewer's "recent volume" displays would read lifetime
 * totals, and the imbalance between recorded inflows and unrecorded
 * consumption would produce pathological numbers on long-running
 * worlds.
 *
 * Decay factor `exp(-1/30) ≈ 0.967` gives the steady-state
 * interpretation `recentInflows[r] ≈ (daily rate) × 30`. Entries
 * that drift below `RECENT_FLOW_PRUNE_BELOW` are deleted so the
 * maps stay tidy.
 *
 * Runs FIRST in the tick (before any new flow is recorded today)
 * so the day's own production / trade / consumption add to a freshly
 * decayed baseline.
 */

import type { ResourceId } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';

export const RECENT_FLOW_DECAY_FACTOR = Math.exp(-1 / 30);
const RECENT_FLOW_PRUNE_BELOW = 0.5;

const decayFlowMap = (m: Map<ResourceId, number>): void => {
  for (const [r, v] of m) {
    const next = v * RECENT_FLOW_DECAY_FACTOR;
    if (next < RECENT_FLOW_PRUNE_BELOW) m.delete(r);
    else m.set(r, next);
  }
};

export const ageRecentFlowsPhase = (world: WorldState): void => {
  for (const settlement of world.settlements.values()) {
    const m = settlement.market;
    // Decay all six counters in lockstep so the aggregate identities
    //   recentInflows  == recentImports + recentProduction
    //   recentOutflows == recentExports + recentConsumption
    // keep holding tick-to-tick (modulo float rounding).
    decayFlowMap(m.recentImports);
    decayFlowMap(m.recentExports);
    decayFlowMap(m.recentProduction);
    decayFlowMap(m.recentConsumption);
    decayFlowMap(m.recentInflows);
    decayFlowMap(m.recentOutflows);
  }
};
