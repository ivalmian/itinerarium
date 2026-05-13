/** Tests for the consumption phase (src/sim/phases/consumption.ts). */

import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  createActor,
} from '../politics/actor.js';
import {
  actorId,
  resourceId,
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, type TickResult } from '../tick.js';
import {
  buildEmptyWorld,
  buildOneSettlementWorld,
  eventsOfType,
  getStock,
  makeTile,
  setStock,
} from '../testing/tickFixtures.js';

  describe('consumption phase', () => {
    it('drains roughly one day of grain through the subsistence market', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1000 },
        grainModii: 200,
      });
      const corp1 = w.actors.get(actorId('city-corp-1'));
      const grain = resourceId('food.grain');
      const before = corp1 !== undefined ? getStock(corp1, grain) : 0;
      tick({ world: w, rng: createRng('cons-1') });
      const after = corp1 !== undefined ? getStock(corp1, grain) : 0;
      const drained = before - after;
      expect(drained).toBeGreaterThan(55);
      expect(drained).toBeLessThan(65);
    });

    it('does not take another actor stockpile for subsistence when the buyer has no coin', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('cashless-ration-village');
      const sellerId = actorId('cashless-ration-patron');
      const buyerId = actorId('cashless-ration-household');
      const grain = resourceId('food.grain');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Cashless Ration Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      settlement.stockpileOwners.push(sellerId, buyerId);

      const seller = createActor({
        id: sellerId,
        kind: 'patrician_family',
        name: 'Village Patron',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, grain, 100);
      const buyer = createActor({
        id: buyerId,
        kind: 'plebeian_household',
        name: 'Tenant Households',
        homeSettlement: sId,
        treasury: 0,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(buyerId, buyer);

      const result = tick({ world: w, rng: createRng('tenant-rations') });

      expect(getStock(seller, grain) ?? 0).toBe(100);
      expect(seller.treasury).toBe(0);
      expect(buyer.treasury).toBe(0);
      expect(eventsOfType(result.events, 'market_cleared').some((e) => e.resource === grain)).toBe(
        false,
      );
      expect(eventsOfType(result.events, 'cohort_deaths')).toHaveLength(0);
    });

    it('uses non-grain ration stockpiles before applying famine deaths', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 500 },
        grainModii: 0,
        flourSacks: 10_000,
      });

      let deaths = 0;
      let world = w;
      for (let d = 0; d < 8; d++) {
        const r: TickResult = tick({ world, rng: createRng(`flour-ration-${d}`) });
        for (const e of r.events) {
          if (e.type === 'cohort_deaths' && e.cause === 'famine') deaths += e.deaths;
        }
        world = r.world;
      }
      expect(deaths).toBe(0);
    });

    it('buys fallback ration stockpiles through a concrete local buyer', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('fallback-ration-market');
      const sellerId = actorId('flour-ration-seller');
      const householdId = actorId('flour-ration-household');
      const flour = resourceId('food.flour');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Ration Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 500);
      settlement.stockpileOwners.push(sellerId, householdId);

      const seller = createActor({
        id: sellerId,
        kind: 'city_corporation',
        name: 'Flour Seller',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, flour, 100);
      const household = createActor({
        id: householdId,
        kind: 'hamlet_household',
        name: 'Ration Household',
        homeSettlement: sId,
        treasury: 500,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(householdId, household);

      const beforeHouseholdTreasury = household.treasury;
      const r = tick({ world: w, rng: createRng('paid-fallback-ration') });
      const flourClear = eventsOfType(r.events, 'market_cleared').find((e) => e.resource === flour);

      expect(flourClear).toBeDefined();
      expect(settlement.market.lastClearingPrice.get(flour)).toBeGreaterThan(0);
      expect(getStock(seller, flour)).toBeLessThan(100);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(household.treasury).toBeLessThan(beforeHouseholdTreasury);
      expect(getStock(household, flour) ?? 0).toBe(0);
    });

    it('buys perishable local foods as priced fallback rations', () => {
      for (const resourceName of ['food.milk', 'food.fish', 'food.game'] as const) {
        const w = buildEmptyWorld();
        const anchor = hex(0, 0);
        w.grid.set(anchor, makeTile('plains'));

        const sId = settlementId(`fresh-ration-${resourceName}`);
        const sellerId = actorId(`fresh-ration-seller-${resourceName}`);
        const householdId = actorId(`fresh-ration-household-${resourceName}`);
        const ration = resourceId(resourceName);
        const settlement = createSettlement({
          id: sId,
          tier: 'village',
          name: 'Fresh Ration Village',
          anchor,
          urbanHexes: [anchor],
          catchmentHexes: [],
        });
        settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 500);
        settlement.stockpileOwners.push(sellerId, householdId);

        const seller = createActor({
          id: sellerId,
          kind: 'city_corporation',
          name: 'Fresh Ration Seller',
          homeSettlement: sId,
          treasury: 0,
        });
        setStock(seller, ration, 100);
        const household = createActor({
          id: householdId,
          kind: 'hamlet_household',
          name: 'Fresh Ration Household',
          homeSettlement: sId,
          treasury: 500,
        });

        w.settlements.set(sId, settlement);
        w.actors.set(sellerId, seller);
        w.actors.set(householdId, household);

        const beforeHouseholdTreasury = household.treasury;
        const r = tick({ world: w, rng: createRng(`fresh-ration-${resourceName}`) });
        const cleared = eventsOfType(r.events, 'market_cleared').find((e) => e.resource === ration);

        expect(cleared).toBeDefined();
        expect(settlement.market.lastClearingPrice.get(ration)).toBeGreaterThan(0);
        expect(getStock(seller, ration) ?? 0).toBeLessThan(100);
        expect(seller.treasury).toBeGreaterThan(0);
        expect(household.treasury).toBeLessThan(beforeHouseholdTreasury);
        expect(getStock(household, ration) ?? 0).toBe(0);
      }
    });

    it('lets civic ration reserves self-provision local famine shortfalls', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 500 },
        grainModii: 100,
      });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const city = w.actors.get(actorId('city-corp-1'))!;
      const household = createActor({
        id: actorId('cashless-household'),
        kind: 'plebeian_household',
        name: 'Cashless Households',
        homeSettlement: settlement.id,
        treasury: 0,
      });
      w.actors.set(household.id, household);
      settlement.stockpileOwners.push(household.id);
      setStock(city, resourceId('food.bread'), 100);

      const before = getStock(city, resourceId('food.bread')) ?? 0;
      const result = tick({ world: w, rng: createRng('civic-ration-self-provision') });
      const after = getStock(city, resourceId('food.bread')) ?? 0;

      expect(after).toBeLessThan(before);
      expect(household.treasury).toBe(0);
      expect(
        eventsOfType(result.events, 'market_cleared').some(
          (e) => e.resource === resourceId('food.bread'),
        ),
      ).toBe(true);
    });

    it('emits cohort_deaths with cause famine when there is no food', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 500 },
        grainModii: 0,
      });
      // Run several days so famine pressure accumulates above the threshold.
      let deaths = 0;
      let world = w;
      for (let d = 0; d < 8; d++) {
        const r: TickResult = tick({ world, rng: createRng(`fam-${d}`) });
        for (const e of r.events) {
          if (e.type === 'cohort_deaths' && e.cause === 'famine') deaths += e.deaths;
        }
        world = r.world;
      }
      expect(deaths).toBeGreaterThan(0);
    });
  });
