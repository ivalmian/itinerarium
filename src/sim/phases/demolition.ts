/**
 * Demolition phase (docs/15 §C8 demolition).
 *
 * Drains mason + carpenter worker-days each tick toward the
 * settlement's `pendingDemolitions`. When a pending demolition's
 * `workerDaysRemaining` hits 0:
 *   1. `removeBuilding(settlement, hex, buildingId)` strips the
 *      building from the settlement's `buildings` array (no-op if
 *      the building was already gone — e.g. raced with abandonment).
 *   2. 50 % of the original `constructionCost` is refunded into the
 *      owner's stockpile slice at *this* settlement (per docs/15
 *      §C30).
 *   3. A `building_demolished` event fires for telemetry.
 *
 * The single mason+carpenter daily budget is consumed greedily in
 * pending-list order — first pending entry drains first. Future
 * work might let owners prioritize specific entries; current model
 * is FIFO.
 */

import { getBuilding } from '../buildings/catalog.js';
import { CARPENTER_JOB, MASON_JOB } from '../buildings/constructionJobs.js';
import { addStockAt } from '../politics/actor.js';
import { hexEquals } from '../world/hex.js';
import { removeBuilding, type PendingDemolition } from '../world/settlement.js';
import type { Day } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

export const demolitionPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  void _today;
  for (const settlement of world.settlements.values()) {
    if (settlement.pendingDemolitions.length === 0) continue;
    let masonBudget = settlement.jobAllocations.get(MASON_JOB) ?? 0;
    let carpenterBudget = settlement.jobAllocations.get(CARPENTER_JOB) ?? 0;
    let budget = masonBudget + carpenterBudget;
    if (budget <= 0) continue;

    const completed: number[] = [];
    for (let i = 0; i < settlement.pendingDemolitions.length && budget > 0; i++) {
      const pd = settlement.pendingDemolitions[i] as PendingDemolition;
      const apply = Math.min(budget, pd.workerDaysRemaining);
      pd.workerDaysRemaining -= apply;
      budget -= apply;
      if (pd.workerDaysRemaining <= 0) completed.push(i);
    }
    void masonBudget;
    void carpenterBudget;

    for (let j = completed.length - 1; j >= 0; j--) {
      const idx = completed[j] as number;
      const pd = settlement.pendingDemolitions[idx] as PendingDemolition;
      settlement.pendingDemolitions.splice(idx, 1);
      // Remove the building if still present.
      const stillPresent = settlement.buildings.some(
        (b) => b.buildingId === pd.buildingId && hexEquals(b.hex, pd.hex),
      );
      if (stillPresent) {
        try {
          removeBuilding(settlement, pd.hex, pd.buildingId);
        } catch {
          // Already gone (raced); ignore.
        }
      }
      // Refund 50 % of materials, landing back in the owner's slice
      // at THIS settlement (where the building stood) per docs/15
      // §C30.
      const def = getBuilding(pd.buildingId);
      const owner = world.actors.get(pd.ownerActor);
      if (owner !== undefined) {
        for (const [r, qty] of def.constructionCost) {
          const refund = qty * 0.5;
          if (refund <= 0) continue;
          addStockAt(owner, settlement.id, r, refund);
        }
      }
      events.push({
        type: 'building_demolished',
        settlement: settlement.id,
        building: pd.buildingId,
        ownerActor: pd.ownerActor,
      });
    }
  }
};
