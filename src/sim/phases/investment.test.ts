/** Tests for the investment phase (src/sim/phases/investment.ts). */

import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  createActor,
} from '../politics/actor.js';
import {
  actorId,
  buildingId,
  resourceId,
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import type { WorldState } from '../../procgen/seed.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  eventsOfType,
  makeTile,
  setStock,
} from '../testing/tickFixtures.js';

  describe('investment phase', () => {
    const buildMiningInvestmentWorld = (withDeposit: boolean): WorldState => {
      const w = buildEmptyWorld();
      const ownerId = actorId('mine-investor');
      const sId = settlementId('mining-town');
      const anchor = hex(0, 0);
      const depositHex = hex(1, 0);
      const spareHex = hex(0, 1);
      w.grid.set(anchor, makeTile('plains'));
      w.grid.set(depositHex, {
        ...makeTile('mountains'),
        ...(withDeposit
          ? { deposit: { resource: resourceId('mineral.iron_ore'), remaining: 500_000 } }
          : {}),
      });
      w.grid.set(spareHex, makeTile('plains'));

      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Mining Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [depositHex, spareHex],
      });
      settlement.stockpileOwners.push(ownerId);
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      // Per docs/15 §C27: the original fixture seeded a bloomery and 6
      // quarries to motivate competing recipes, but those buildings'
      // derived input demand combined with the MM bid clamp now
      // collapses iron_ore's scarcity price, and forester_camp's wood
      // scarcity price beats mine in ROI. The test's intent is just to
      // verify "mine investment goes on the deposit hex," so we strip
      // the competing buildings and seed mine-friendly prices directly.
      settlement.market.lastClearingPrice.set(resourceId('mineral.iron_ore'), 5_000);
      settlement.market.lastClearingPrice.set(resourceId('food.grain'), 1);
      settlement.market.lastClearingPrice.set(resourceId('food.legumes'), 1);
      settlement.market.lastClearingPrice.set(resourceId('goods.tools'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.lumber'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.cut_stone'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.brick_tile'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.charcoal'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.wood'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.stone'), 1);
      settlement.market.lastClearingPrice.set(resourceId('metal.iron'), 480);

      const owner = createActor({
        id: ownerId,
        kind: 'city_corporation',
        name: 'Mine Investor',
        homeSettlement: sId,
        treasury: 100_000,
      });
      setStock(owner, resourceId('material.lumber'), 100);
      setStock(owner, resourceId('material.cut_stone'), 100);
      setStock(owner, resourceId('material.brick_tile'), 100);
      setStock(owner, resourceId('goods.tools'), 100);
      setStock(owner, resourceId('material.charcoal'), 100);
      setStock(owner, resourceId('food.grain'), 100);
      setStock(owner, resourceId('food.legumes'), 100);

      w.settlements.set(sId, settlement);
      w.actors.set(ownerId, owner);
      w.day = 89;
      return w;
    };

    it('places mine investments only on matching mineral deposits, including mountain deposits', () => {
      const w = buildMiningInvestmentWorld(true);

      const r = tick({ world: w, rng: createRng('deposit-backed-investment') });
      const invested = eventsOfType(r.events, 'building_invested').find(
        (event) => event.building === buildingId('mine'),
      );
      const settlement = w.settlements.get(settlementId('mining-town'));

      expect(invested).toBeDefined();
      expect(settlement?.pendingBuildings.some((b) => b.buildingId === buildingId('mine'))).toBe(
        true,
      );
      expect(
        settlement?.pendingBuildings.find((b) => b.buildingId === buildingId('mine'))?.hex,
      ).toEqual(hex(1, 0));
    });

    it('does not invest in fake mines when no matching local deposit exists', () => {
      const w = buildMiningInvestmentWorld(false);

      tick({ world: w, rng: createRng('depositless-investment') });
      const settlement = w.settlements.get(settlementId('mining-town'));

      expect(settlement?.pendingBuildings.some((b) => b.buildingId === buildingId('mine'))).toBe(
        false,
      );
    });
  });
