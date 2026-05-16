/** Tests for the trade phase (src/sim/phases/trade.ts). */

import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  createActor,
} from '../politics/actor.js';
import {
  createCaravan,
} from '../caravan/caravan.js';
import {
  actorId,
  buildingId,
  caravanId,
  resourceId,
  settlementId,
  type Day,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  buildOneSettlementWorld,
  eventsOfType,
  getStock,
  makeTile,
  setStock,
} from '../testing/tickFixtures.js';

  describe('trade phase', () => {
    it('emits market_cleared events for resources with both demand and supply', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 500 },
        grainModii: 500,
      });
      const r = tick({ world: w, rng: createRng('mkt-1') });
      const cleared = eventsOfType(r.events, 'market_cleared');
      // grain is in demand (subsistence) and on offer (city corp); should
      // clear at some price > 0.
      const grainClears = cleared.filter((e) => e.resource === resourceId('food.grain'));
      expect(grainClears.length).toBeGreaterThan(0);
    });

    it('records a scarcity price when population demands grain but no owner has stock', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 500 },
        grainModii: 0,
      });

      const r = tick({ world: w, rng: createRng('mkt-shortage') });
      const shortage = eventsOfType(r.events, 'market_shortage').find(
        (e) => e.resource === resourceId('food.grain'),
      );
      const settlement = w.settlements.get(settlementId('settle-1'));

      expect(shortage).toBeDefined();
      const price = settlement?.market.lastClearingPrice.get(resourceId('food.grain')) ?? 0;
      // 5× scaled per realism pass 8: ceiling 18 → 90 (the scarcity
      // ceiling is derived from the off-map reference price which is
      // now 7.5 instead of 1.5; the multiplier remains the same).
      expect(price).toBeGreaterThan(50);
      expect(price).toBeLessThanOrEqual(90);
    });

    it('uses a finite local-only scarcity ceiling instead of pinning missing wood at the universal cap', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 500 },
        grainModii: 500,
        woodCords: 0,
      });

      const r = tick({ world: w, rng: createRng('mkt-wood-shortage') });
      const shortage = eventsOfType(r.events, 'market_shortage').find(
        (e) => e.resource === resourceId('material.wood'),
      );
      const settlement = w.settlements.get(settlementId('settle-1'));

      expect(shortage).toBeDefined();
      const price = settlement?.market.lastClearingPrice.get(resourceId('material.wood')) ?? 0;
      expect(price).toBeGreaterThan(100);
      expect(price).toBeLessThan(10_000);
    });

    it('removes stale scarcity quotes when no current buyer or seller exists', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1 },
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      if (settlement === undefined) throw new Error('missing settlement');
      const city = w.actors.get(actorId('city-corp-1'));
      if (city === undefined) throw new Error('missing city actor');
      city.treasury = 0;
      const tools = resourceId('goods.tools');
      settlement.market.lastClearingPrice.set(tools, 2500);

      tick({ world: w, rng: createRng('mkt-stale-no-bid') });

      expect(settlement.market.lastClearingPrice.has(tools)).toBe(false);
    });

    it('retains a price memory for resources with recorded outflow', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1 },
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      const city = w.actors.get(actorId('city-corp-1'));
      if (settlement === undefined || city === undefined) throw new Error('missing fixture');
      city.treasury = 0;
      const tools = resourceId('goods.tools');
      settlement.market.lastClearingPrice.set(tools, 2500);
      settlement.market.recentOutflows.set(tools, 1);

      tick({ world: w, rng: createRng('mkt-retain-traded-price-memory') });

      expect(settlement.market.lastClearingPrice.get(tools)).toBe(2500);
    });

    it('records a seller ask when stock exists but no buyer is active', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1 },
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      const city = w.actors.get(actorId('city-corp-1'));
      if (settlement === undefined || city === undefined) throw new Error('missing fixture');
      const tools = resourceId('goods.tools');
      setStock(city, tools, 100);
      settlement.market.lastClearingPrice.set(tools, 2500);

      tick({ world: w, rng: createRng('mkt-seller-ask-no-bid') });

      const quote = settlement.market.lastClearingPrice.get(tools);
      expect(quote).toBeGreaterThan(0);
    });

    it('bounds seller-only asks for local capital goods by scarcity ceilings', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1 },
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      const city = w.actors.get(actorId('city-corp-1'));
      if (settlement === undefined || city === undefined) throw new Error('missing fixture');
      const cart = resourceId('goods.cart');
      setStock(city, cart, 10);
      settlement.market.lastClearingPrice.set(cart, 200_000);

      tick({ world: w, rng: createRng('mkt-cart-seller-ask-ceiling') });

      const quote = settlement.market.lastClearingPrice.get(cart) ?? 0;
      expect(quote).toBeGreaterThan(0);
      expect(quote).toBeLessThanOrEqual(600);
    });

    it('does not let dust-sized producer demand broadcast a scarcity quote', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1 },
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      const city = w.actors.get(actorId('city-corp-1'));
      if (settlement === undefined || city === undefined) throw new Error('missing fixture');
      city.treasury = 5;
      settlement.buildings.push({
        buildingId: buildingId('farm'),
        hex: settlement.anchor,
        ownerActor: city.id,
        capacity: 1,
        daysSinceMaintained: 0,
      });
      const tools = resourceId('goods.tools');
      settlement.market.lastClearingPrice.set(tools, 1000);
      settlement.market.lastClearingPrice.set(resourceId('food.grain'), 0.335);

      const r = tick({ world: w, rng: createRng('mkt-dust-tool-shortage') });

      expect(eventsOfType(r.events, 'market_shortage').some((e) => e.resource === tools)).toBe(
        false,
      );
      expect(settlement.market.lastClearingPrice.has(tools)).toBe(false);
    });

    it('records a fallback ration price when a caravan buys food without an existing quote', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      for (let q = -2; q <= 2; q++) {
        for (let r = -2; r <= 2; r++) w.grid.set(hex(q, r), makeTile('plains'));
      }
      const sId = settlementId('ration-market');
      const ownerId = actorId('ration-owner');
      const cId = caravanId('ration-caravan');
      const cheese = resourceId('food.cheese');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Ration Market',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
        stockpileOwners: [ownerId],
      });
      const owner = createActor({
        id: ownerId,
        kind: 'caravan_owner',
        name: 'Ration Owner',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(owner, cheese, 100);
      const caravan = createCaravan({
        id: cId,
        ownerActor: ownerId,
        position: anchor,
        destination: anchor,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
      });
      w.settlements.set(sId, settlement);
      w.actors.set(ownerId, owner);
      w.caravans.set(cId, caravan);

      tick({ world: w, rng: createRng('caravan-ration-fallback-price') });

      // 5× scaled per realism pass 8 (cheese fallback ration price 25, was 5).
      expect(settlement.market.lastClearingPrice.get(cheese)).toBe(25);
      expect(settlement.market.recentOutflows.get(cheese)).toBeGreaterThan(0);
    });

    it('transfers producer-input purchases to the building owner stockpile', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      for (let q = -1; q <= 1; q++) {
        for (let r = -1; r <= 1; r++) w.grid.set(hex(q, r), makeTile('plains'));
      }

      const sId = settlementId('bakery-market');
      const sellerId = actorId('flour-seller');
      const bakerId = actorId('baker-house');
      const flour = resourceId('food.flour');
      const bread = resourceId('food.bread');
      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Baker Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      settlement.stockpileOwners.push(sellerId, bakerId);
      settlement.buildings.push({
        buildingId: buildingId('bakery'),
        hex: anchor,
        ownerActor: bakerId,
        capacity: 2,
        daysSinceMaintained: 0,
      });
      settlement.market.lastClearingPrice.set(bread, 10);

      const seller = createActor({
        id: sellerId,
        kind: 'city_corporation',
        name: 'Flour Seller',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, flour, 50);
      const baker = createActor({
        id: bakerId,
        kind: 'city_corporation',
        name: 'Baker House',
        homeSettlement: sId,
        treasury: 500,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(bakerId, baker);

      const beforeBakerTreasury = baker.treasury;
      const r = tick({ world: w, rng: createRng('producer-input-purchase') });
      const flourClear = eventsOfType(r.events, 'market_cleared').find((e) => e.resource === flour);

      expect(flourClear).toBeDefined();
      expect(getStock(baker, flour)).toBeGreaterThan(0);
      expect(getStock(seller, flour)).toBeLessThan(50);
      expect(baker.treasury).toBeLessThan(beforeBakerTreasury);
      expect(seller.treasury).toBeGreaterThan(0);
    });

    it('debits concrete consumer buyers and consumes purchased goods immediately', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('wine-market');
      const sellerId = actorId('wine-seller');
      const householdId = actorId('local-household');
      const wine = resourceId('food.wine');
      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Wine Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 200);
      settlement.stockpileOwners.push(sellerId, householdId);

      const seller = createActor({
        id: sellerId,
        kind: 'city_corporation',
        name: 'Wine Seller',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, wine, 50);
      const household = createActor({
        id: householdId,
        kind: 'hamlet_household',
        name: 'Local Household',
        homeSettlement: sId,
        treasury: 500,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(householdId, household);

      const beforeHouseholdTreasury = household.treasury;
      const r = tick({ world: w, rng: createRng('consumer-buyer-purchase') });
      const wineClear = eventsOfType(r.events, 'market_cleared').find((e) => e.resource === wine);

      expect(wineClear).toBeDefined();
      expect(getStock(seller, wine)).toBeLessThan(50);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(household.treasury).toBeLessThan(beforeHouseholdTreasury);
      expect(getStock(household, wine) ?? 0).toBe(0);
    });

    it('clears institutional procurement demand and consumes upkeep goods', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('garrison-market');
      const sellerId = actorId('weapon-seller');
      const barracksOwnerId = actorId('garrison-buyer');
      const weapons = resourceId('goods.gladius');
      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Garrison Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      settlement.stockpileOwners.push(sellerId, barracksOwnerId);
      settlement.buildings.push({
        buildingId: buildingId('barracks'),
        hex: anchor,
        ownerActor: barracksOwnerId,
        capacity: 1,
        daysSinceMaintained: 0,
      });

      const seller = createActor({
        id: sellerId,
        kind: 'city_corporation',
        name: 'Weapon Seller',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, weapons, 2);
      const buyer = createActor({
        id: barracksOwnerId,
        kind: 'governor_office',
        name: 'Garrison Office',
        homeSettlement: sId,
        treasury: 500,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(barracksOwnerId, buyer);

      const beforeBuyerTreasury = buyer.treasury;
      const r = tick({ world: w, rng: createRng('institutional-procurement') });
      const cleared = eventsOfType(r.events, 'market_cleared').find((e) => e.resource === weapons);

      expect(cleared).toBeDefined();
      expect(getStock(seller, weapons)).toBeLessThan(2);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(buyer.treasury).toBeLessThan(beforeBuyerTreasury);
      // Per docs/15 §C26 the governor also market-makes — they may end
      // with a small residual MM stockpile alongside the consumed
      // institutional procurement. Allow up to 1 unit of residual.
      expect(getStock(buyer, weapons) ?? 0).toBeLessThan(1);
    });

    it('clears local service capacity for coin without creating stockpile cargo', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('priesthood-market');
      const templeOwnerId = actorId('temple-owner');
      const householdId = actorId('service-household');
      const priesthood = resourceId('service.priesthood');
      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Temple Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 500);
      settlement.stockpileOwners.push(templeOwnerId, householdId);
      settlement.buildings.push({
        buildingId: buildingId('temple'),
        hex: anchor,
        ownerActor: templeOwnerId,
        capacity: 100,
        daysSinceMaintained: 0,
      });

      const templeOwner = createActor({
        id: templeOwnerId,
        kind: 'temple',
        name: 'Temple Owner',
        homeSettlement: sId,
        treasury: 0,
      });
      const household = createActor({
        id: householdId,
        kind: 'plebeian_household',
        name: 'Temple Household',
        homeSettlement: sId,
        treasury: 500,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(templeOwnerId, templeOwner);
      w.actors.set(householdId, household);

      const beforeHouseholdTreasury = household.treasury;
      const r = tick({ world: w, rng: createRng('service-capacity-trade') });
      const cleared = eventsOfType(r.events, 'market_cleared').find(
        (e) => e.resource === priesthood,
      );

      expect(cleared).toBeDefined();
      expect(cleared?.volume).toBeGreaterThan(0);
      expect(templeOwner.treasury).toBeGreaterThan(0);
      expect(household.treasury).toBeLessThan(beforeHouseholdTreasury);
      expect(getStock(templeOwner, priesthood) ?? 0).toBe(0);
      expect(getStock(household, priesthood) ?? 0).toBe(0);
    });

    it('clears public works service for pending construction without cargo', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('public-works-market');
      const forumOwnerId = actorId('forum-owner');
      const patronId = actorId('public-works-patron');
      const publicWorks = resourceId('service.public_works');
      const settlement = createSettlement({
        id: sId,
        tier: 'town',
        name: 'Works Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
      settlement.stockpileOwners.push(forumOwnerId, patronId);
      settlement.buildings.push({
        buildingId: buildingId('forum_market'),
        hex: anchor,
        ownerActor: forumOwnerId,
        capacity: 100,
        maxCapacity: 100,
        daysSinceMaintained: 0,
      });
      settlement.pendingBuildings.push({
        buildingId: buildingId('warehouse'),
        hex: anchor,
        ownerActor: patronId,
        beganOnDay: 0 as Day,
        workerDaysRemaining: 100,
        workerDaysTotal: 100,
        masonDaysRemaining: 40,
        carpenterDaysRemaining: 60,
      });

      const forumOwner = createActor({
        id: forumOwnerId,
        kind: 'city_corporation',
        name: 'Forum Owner',
        homeSettlement: sId,
        treasury: 0,
      });
      const patron = createActor({
        id: patronId,
        kind: 'patrician_family',
        name: 'Building Patron',
        homeSettlement: sId,
        treasury: 500,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(forumOwnerId, forumOwner);
      w.actors.set(patronId, patron);

      const beforePatronTreasury = patron.treasury;
      const r = tick({ world: w, rng: createRng('public-works-service-trade') });
      const cleared = eventsOfType(r.events, 'market_cleared').find(
        (e) => e.resource === publicWorks,
      );

      expect(cleared).toBeDefined();
      expect(cleared?.volume).toBeGreaterThan(0);
      expect(forumOwner.treasury).toBeGreaterThan(0);
      expect(patron.treasury).toBeLessThan(beforePatronTreasury);
      expect(getStock(forumOwner, publicWorks) ?? 0).toBe(0);
      expect(getStock(patron, publicWorks) ?? 0).toBe(0);
    });

    it('lets producers buy required herd capital that is present but not consumed', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('dairy-capital-market');
      const sellerId = actorId('cattle-seller');
      const dairyOwnerId = actorId('dairy-owner');
      const cattle = resourceId('livestock.cattle');
      const milk = resourceId('food.milk');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Dairy Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      settlement.stockpileOwners.push(sellerId, dairyOwnerId);
      settlement.market.lastClearingPrice.set(milk, 2);
      settlement.buildings.push({
        buildingId: buildingId('dairy'),
        hex: anchor,
        ownerActor: dairyOwnerId,
        capacity: 10,
        daysSinceMaintained: 0,
      });

      const seller = createActor({
        id: sellerId,
        kind: 'patrician_family',
        name: 'Cattle Seller',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, cattle, 1);
      const dairyOwner = createActor({
        id: dairyOwnerId,
        kind: 'city_corporation',
        name: 'Dairy Owner',
        homeSettlement: sId,
        treasury: 1_000,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(dairyOwnerId, dairyOwner);

      const beforeBuyerTreasury = dairyOwner.treasury;
      const r = tick({ world: w, rng: createRng('productive-herd-capital') });
      const cleared = eventsOfType(r.events, 'market_cleared').find((e) => e.resource === cattle);

      expect(cleared).toBeDefined();
      expect(cleared?.volume).toBeGreaterThan(0);
      expect(getStock(dairyOwner, cattle) ?? 0).toBeGreaterThan(0);
      expect(getStock(seller, cattle) ?? 0).toBeLessThan(1);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(dairyOwner.treasury).toBeLessThan(beforeBuyerTreasury);
    });
  });
