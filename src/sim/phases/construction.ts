/**
 * Daily construction phase.
 *
 * Drains mason + carpenter worker-days from each settlement into
 * its `pendingBuildings`. Per docs/15 §C14 mason and carpenter
 * pools are independent — a granary (heavy stone+brick) bottlenecks
 * on masons, a smithy (heavy lumber) bottlenecks on carpenters.
 *
 * Wages for the work applied here flow through the shared
 * `payProductionWages` (see `src/sim/world/productionWages.ts`) so
 * that production + construction stay on the same coin/in-kind
 * cascade.
 *
 * Pending builds whose `workerDaysRemaining` hits zero materialize
 * via `addBuilding` and emit a `building_completed` event.
 * Catchment may have shrunk while the build was queued; the
 * still-valid check skips materialization onto a hex that's no
 * longer owned by this settlement.
 */

import { getBuilding } from '../buildings/catalog.js';
import { CARPENTER_JOB, MASON_JOB } from '../buildings/constructionJobs.js';
import {
  allocatedWorkersForJob,
  type LaborClassContext,
} from '../jobs/laborEconomics.js';
import { laborCostPerWorkerDay } from '../market/scheduleBuilder.js';
import type { Day } from '../types.js';
import { hexEquals } from '../world/hex.js';
import {
  payProductionWages,
  wagePriceSignalForSettlement,
} from '../world/productionWages.js';
import {
  addBuilding,
  type PendingBuilding,
  type Settlement,
} from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

export const constructionPhase = (
  world: WorldState,
  today: Day,
  events: TickEvent[],
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.pendingBuildings.length === 0) continue;
    const wagePriceSignal = wagePriceSignalForSettlement(settlement);
    const wagePerWorkerDay = laborCostPerWorkerDay(wagePriceSignal);
    const laborClassContext = laborContextForSettlement(settlement);
    // Per docs/15 §C14: mason and carpenter pools drain INDEPENDENTLY.
    // A granary (heavy stone+brick) bottleneck on masons, a smithy
    // (heavy lumber) bottlenecks on carpenters.
    const shouldCapByClass = laborClassContext.totalWorkingAdults > 0;
    let masonBudget = settlement.jobAllocations.get(MASON_JOB) ?? 0;
    let carpenterBudget = settlement.jobAllocations.get(CARPENTER_JOB) ?? 0;
    if (shouldCapByClass) {
      masonBudget = Math.min(masonBudget, allocatedWorkersForJob(laborClassContext, MASON_JOB));
      carpenterBudget = Math.min(
        carpenterBudget,
        allocatedWorkersForJob(laborClassContext, CARPENTER_JOB),
      );
    }
    if (masonBudget <= 0 && carpenterBudget <= 0) continue;

    const completed: number[] = [];
    for (let i = 0; i < settlement.pendingBuildings.length; i++) {
      const pb = settlement.pendingBuildings[i] as PendingBuilding;
      const owner = world.actors.get(pb.ownerActor);
      let masonApplied = 0;
      let carpenterApplied = 0;
      // Mason work first.
      if (pb.masonDaysRemaining !== undefined && pb.masonDaysRemaining > 0 && masonBudget > 0) {
        const apply = Math.min(masonBudget, pb.masonDaysRemaining);
        pb.masonDaysRemaining -= apply;
        pb.workerDaysRemaining -= apply;
        masonBudget -= apply;
        masonApplied += apply;
      }
      // Then carpenter work.
      if (
        pb.carpenterDaysRemaining !== undefined &&
        pb.carpenterDaysRemaining > 0 &&
        carpenterBudget > 0
      ) {
        const apply = Math.min(carpenterBudget, pb.carpenterDaysRemaining);
        pb.carpenterDaysRemaining -= apply;
        pb.workerDaysRemaining -= apply;
        carpenterBudget -= apply;
        carpenterApplied += apply;
      }
      // Legacy projects without the split: drain from combined pool.
      if (pb.masonDaysRemaining === undefined && pb.carpenterDaysRemaining === undefined) {
        const combined = masonBudget + carpenterBudget;
        if (combined > 0) {
          const apply = Math.min(combined, pb.workerDaysRemaining);
          pb.workerDaysRemaining -= apply;
          // Drain proportionally.
          const masonShare = combined > 0 ? masonBudget / combined : 0;
          const legacyMasonApplied = apply * masonShare;
          const legacyCarpenterApplied = apply * (1 - masonShare);
          masonBudget -= legacyMasonApplied;
          carpenterBudget -= legacyCarpenterApplied;
          masonApplied += legacyMasonApplied;
          carpenterApplied += legacyCarpenterApplied;
        }
      }
      if (owner !== undefined && (masonApplied > 0 || carpenterApplied > 0)) {
        payProductionWages(
          world,
          settlement,
          laborClassContext,
          owner,
          new Map([
            [MASON_JOB, masonApplied],
            [CARPENTER_JOB, carpenterApplied],
          ]),
          wagePriceSignal,
          wagePerWorkerDay,
        );
      }
      if (pb.workerDaysRemaining <= 0) completed.push(i);
      if (masonBudget <= 0 && carpenterBudget <= 0) break;
    }
    // Materialize completed builds in reverse index order so splice is safe.
    for (let j = completed.length - 1; j >= 0; j--) {
      const idx = completed[j] as number;
      const pb = settlement.pendingBuildings[idx] as PendingBuilding;
      // Catchment may have shrunk; check the hex is still in this
      // settlement before adding.
      const stillValid =
        settlement.urbanHexes.some((u) => hexEquals(u, pb.hex)) ||
        settlement.catchmentHexes.some((c) => hexEquals(c, pb.hex));
      settlement.pendingBuildings.splice(idx, 1);
      if (!stillValid) continue;
      const def = getBuilding(pb.buildingId);
      addBuilding(settlement, {
        buildingId: pb.buildingId,
        hex: pb.hex,
        ownerActor: pb.ownerActor,
        capacity: def.capacityUnits,
        maxCapacity: def.capacityUnits,
        daysSinceMaintained: 0,
      });
      events.push({
        type: 'building_completed',
        settlement: settlement.id,
        building: pb.buildingId,
        ownerActor: pb.ownerActor,
        daysToBuild: today - pb.beganOnDay,
      });
    }
  }
};
