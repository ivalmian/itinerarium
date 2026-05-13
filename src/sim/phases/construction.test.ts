/** Tests for the per-day construction phase (src/sim/phases/construction.ts). */

import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  createActor,
} from '../politics/actor.js';
import {
  actorId,
  buildingId,
  jobId,
  resourceId,
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  makeTile,
} from '../testing/tickFixtures.js';

  describe('construction phase', () => {
    it('pays construction wages while pending buildings consume worker-days', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('construction-wage-town');
      const ownerId = actorId('construction-owner');
      const householdId = actorId('construction-workers');
      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Construction Wage Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.stockpileOwners.push(ownerId, householdId);
      settlement.jobAllocations.set(jobId('mason'), 1);
      settlement.jobAllocations.set(jobId('carpenter'), 1);
      settlement.market.lastClearingPrice.set(resourceId('food.grain'), 2);
      settlement.pendingBuildings.push({
        buildingId: buildingId('smithy'),
        hex: anchor,
        ownerActor: ownerId,
        beganOnDay: 0,
        workerDaysRemaining: 10,
        workerDaysTotal: 10,
        masonDaysRemaining: 5,
        carpenterDaysRemaining: 5,
      });

      const owner = createActor({
        id: ownerId,
        kind: 'patrician_family',
        name: 'Construction Patron',
        homeSettlement: sId,
        treasury: 100,
      });
      const household = createActor({
        id: householdId,
        kind: 'hamlet_household',
        name: 'Construction Workers',
        homeSettlement: sId,
        treasury: 0,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(ownerId, owner);
      w.actors.set(householdId, household);

      tick({ world: w, rng: createRng('construction-wages') });

      expect(settlement.pendingBuildings[0]?.workerDaysRemaining).toBe(8);
      expect(owner.treasury).toBeLessThan(100);
      expect(household.treasury).toBeGreaterThan(0);
    });
  });
