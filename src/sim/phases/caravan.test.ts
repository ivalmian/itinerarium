/** Tests for the caravan-cluster phases — replan + assembly (src/sim/phases/caravan.ts). */

import { describe, expect, it } from 'vitest';
import type { WorldState } from '../../procgen/seed.js';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  createActor,
} from '../politics/actor.js';
import {
  createCaravan,
} from '../caravan/caravan.js';
import { createCamp } from '../bandit/camp.js';
import {
  actorId,
  banditCampId,
  buildingId,
  caravanId,
  resourceId,
  settlementId,
} from '../types.js';
import type { Settlement } from '../world/settlement.js';
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

  describe('caravan replan / price observation (same-hex)', () => {
    // docs/05 §"Same-hex coexistence": multiple settlements may share a hex.
    // The caravan's price book must observe ALL same-hex settlements at
    // arrival, not just the last one inserted into the world map.
    it('averages prices across same-hex settlements when recording into priceBook', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      // Plains around the anchor + path east.
      for (let q = -2; q <= 12; q++) {
        for (let r = -2; r <= 2; r++) w.grid.set(hex(q, r), makeTile('plains'));
      }
      const grain = resourceId('food.grain');
      // Two stacked settlements on the same hex: a pagus + dependent hamlet.
      const sA = createSettlement({
        id: settlementId('pagus-A'),
        tier: 'village',
        name: 'Pagus',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      sA.market.lastClearingPrice.set(grain, 2);
      const sB = createSettlement({
        id: settlementId('hamlet-B'),
        tier: 'hamlet',
        name: 'Hamlet',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      sB.market.lastClearingPrice.set(grain, 4);
      w.settlements.set(sA.id, sA);
      w.settlements.set(sB.id, sB);
      // Need a second settlement somewhere else for caravanReplanPhase to
      // have any work (the candidate list needs >= 2 entries).
      const east = hex(10, 0);
      const sC = createSettlement({
        id: settlementId('east'),
        tier: 'village',
        name: 'East',
        anchor: east,
        urbanHexes: [east],
        catchmentHexes: [],
      });
      sC.market.lastClearingPrice.set(grain, 1);
      w.settlements.set(sC.id, sC);

      // Caravan parked at anchor, with destination == position so it's
      // "arrived" and the price-book observation step fires.
      const cId = caravanId('cara-obs');
      const owner = actorId('caravan-owner');
      const c = createCaravan({
        id: cId,
        ownerActor: owner,
        position: { q: 0, r: 0 },
        destination: { q: 0, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
      });
      w.caravans.set(cId, c);
      const ownerActor = createActor({
        id: owner,
        kind: 'caravan_owner',
        name: 'Owner',
        homeSettlement: sA.id,
        treasury: 100,
      });
      w.actors.set(owner, ownerActor);

      tick({ world: w, rng: createRng('caravan-samehex') });
      const book = c.priceBook.get(grain);
      expect(book).toBeDefined();
      const obs = book?.get('0,0');
      expect(obs).toBeDefined();
      // Average of 2 and 4 = 3 (NOT just the last one inserted).
      expect(obs!.price).toBeCloseTo(3, 6);
    });

    it('sells arrived caravan cargo into the local market', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 0 } });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const buyer = w.actors.get(actorId('city-corp-1'))!;
      const tools = resourceId('goods.tools');
      settlement.buildings.push({
        buildingId: buildingId('forum_market'),
        hex: settlement.anchor,
        ownerActor: buyer.id,
        capacity: 100,
        maxCapacity: 100,
        daysSinceMaintained: 0,
      });
      settlement.market.lastClearingPrice.set(tools, 100);
      setStock(buyer, tools, 1);

      const cId = caravanId('import-arrived');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('off-map-house-test'),
        position: hex(0, 0),
        destination: hex(0, 0),
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
      });
      c.cargo.set(tools, 2);
      w.caravans.set(cId, c);

      const beforeTreasury = buyer.treasury;
      const r = tick({ world: w, rng: createRng('caravan-sell') });
      const trades = eventsOfType(r.events, 'caravan_traded').filter((e) => e.caravan === cId);
      const sale = trades.find((e) => e.side === 'sold' && e.resource === tools);

      expect(sale).toBeDefined();
      expect(sale?.quantity ?? 0).toBeGreaterThan(0);
      expect(c.cargo.get(tools) ?? 0).toBeCloseTo(2 - sale!.quantity, 6);
      expect(c.treasury).toBeCloseTo(sale!.coin, 6);
      expect(buyer.treasury).toBeCloseTo(beforeTreasury - sale!.coin, 6);
      expect(getStock(buyer, tools) ?? 0).toBeGreaterThan(1);
    });

    it('sells arrived caravan cargo into residual book bids before stale last prices', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 0 } });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const bookBuyerId = actorId('book-buyer');
      const staleBuyerId = actorId('stale-buyer');
      const tools = resourceId('goods.tools');

      const bookBuyer = createActor({
        id: bookBuyerId,
        kind: 'patrician_family',
        name: 'Book Buyer',
        homeSettlement: settlement.id,
        treasury: 10_000,
      });
      const staleBuyer = createActor({
        id: staleBuyerId,
        kind: 'city_corporation',
        name: 'Stale Buyer',
        homeSettlement: settlement.id,
        treasury: 1_000,
      });
      w.actors.set(bookBuyerId, bookBuyer);
      w.actors.set(staleBuyerId, staleBuyer);
      settlement.stockpileOwners.push(bookBuyerId);
      settlement.market.lastClearingPrice.set(tools, 100);
      settlement.market.bestBid.set(tools, 7);
      settlement.market.bidDepth.set(tools, 1);
      settlement.market.bookLadder.set(tools, {
        asks: [],
        bids: [
          {
            actorId: bookBuyerId,
            actorKind: 'patrician_family',
            price: 7,
            quantity: 1,
            curve: 'derived',
            buyerDisposition: 'stockpile',
          },
        ],
      });
      settlement.market.lastBookSampleDay.set(tools, 0);

      const cId = caravanId('book-import-arrived');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('off-map-house-test'),
        position: hex(0, 0),
        destination: hex(0, 0),
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
      });
      c.cargo.set(tools, 2);
      w.caravans.set(cId, c);

      const r = tick({ world: w, rng: createRng('caravan-book-sell') });
      const sale = eventsOfType(r.events, 'caravan_traded').find(
        (e) => e.caravan === cId && e.side === 'sold' && e.resource === tools,
      );

      expect(sale).toBeDefined();
      expect(sale?.quantity ?? 0).toBeGreaterThan(0);
      expect(sale!.coin / sale!.quantity).toBeCloseTo(7, 6);
      expect(getStock(bookBuyer, tools) ?? 0).toBeCloseTo(sale!.quantity, 6);
      expect(getStock(staleBuyer, tools) ?? 0).toBe(0);
      expect(c.cargo.get(tools) ?? 0).toBeCloseTo(2 - sale!.quantity, 6);
    });

    it('routes caravan sales to consumer book bids as consumption', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 0 } });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const householdId = actorId('household-bidder');
      const wine = resourceId('food.wine');
      const household = createActor({
        id: householdId,
        kind: 'plebeian_household',
        name: 'Household Bidder',
        homeSettlement: settlement.id,
        treasury: 100,
      });
      w.actors.set(householdId, household);
      settlement.stockpileOwners.push(householdId);
      settlement.market.bestBid.set(wine, 3);
      settlement.market.bidDepth.set(wine, 2);
      settlement.market.bookLadder.set(wine, {
        asks: [],
        bids: [
          {
            actorId: householdId,
            actorKind: 'plebeian_household',
            price: 3,
            quantity: 2,
            curve: 'comfort',
            buyerDisposition: 'consume',
          },
        ],
      });
      settlement.market.lastBookSampleDay.set(wine, 0);

      const cId = caravanId('consumer-import-arrived');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('off-map-house-test'),
        position: hex(0, 0),
        destination: hex(0, 0),
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
      });
      c.cargo.set(wine, 3);
      w.caravans.set(cId, c);

      const r = tick({ world: w, rng: createRng('caravan-consumer-book-sell') });
      const sale = eventsOfType(r.events, 'caravan_traded').find(
        (e) => e.caravan === cId && e.side === 'sold' && e.resource === wine,
      );

      expect(sale).toBeDefined();
      expect(sale?.quantity ?? 0).toBeGreaterThan(0);
      expect(getStock(household, wine) ?? 0).toBe(0);
      expect(settlement.market.recentImports.get(wine) ?? 0).toBeCloseTo(sale!.quantity, 6);
      expect(settlement.market.recentConsumption.get(wine) ?? 0).toBeCloseTo(sale!.quantity, 6);
    });

    it('carries unsold off-map imports back to the edge and sells them off-map (docs/10 §45)', () => {
      // Per docs/06 §"Edge-hub inbound visits" (v1.9): when a domestic
      // buyer can't absorb the import cargo for cash, the goods STAY in
      // the inbound caravan and ship back off-map. No free consignment.
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const buyer = w.actors.get(actorId('city-corp-1'))!;
      const edge = hex(-2, 0);
      const spices = resourceId('exotic.spices');
      settlement.market.lastClearingPrice.set(spices, 10);
      buyer.treasury = 0;

      const offMapOwner = actorId(`off-map-house-${edge.q},${edge.r}`);
      w.actors.set(
        offMapOwner,
        createActor({
          id: offMapOwner,
          kind: 'off_map_house',
          name: 'Western Off-map House',
          treasury: 0,
        }),
      );

      const cId = caravanId('import-1--2,0-test');
      const c = createCaravan({
        id: cId,
        ownerActor: offMapOwner,
        position: hex(0, 0),
        destination: hex(0, 0),
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 4 },
        vehicles: {},
      });
      c.cargo.set(spices, 20);
      w.caravans.set(cId, c);

      tick({ world: w, rng: createRng('import-return-route') });

      // Imports were NOT consigned: buyer stockpile remains 0; cargo
      // remains in the caravan (will be sold off-map at the gate).
      expect(getStock(buyer, spices)).toBe(0);
      expect(c.cargo.get(spices) ?? 0).toBe(20);
      expect(c.destination).toEqual(edge);

      tick({ world: w, rng: createRng('import-return-exit') });

      // After traveling to the gate, the caravan is deleted along with
      // any residual treasury. Coin and goods exit our economy together.
      expect(w.caravans.has(cId)).toBe(false);
    });

    it('buys road rations from the local market before departing', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));
      const sId = settlementId('ration-stop');
      const sellerId = actorId('ration-seller');
      const bread = resourceId('food.bread');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Ration Stop',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.stockpileOwners.push(sellerId);
      settlement.market.lastClearingPrice.set(bread, 1);
      const seller = createActor({
        id: sellerId,
        kind: 'hamlet_household',
        name: 'Bread Seller',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(seller, bread, 100);
      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);

      const cId = caravanId('ration-buyer');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('merchant-owner'),
        position: anchor,
        destination: anchor,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
        treasury: 20,
      });
      w.caravans.set(cId, c);

      const r = tick({ world: w, rng: createRng('caravan-ration-buy') });
      const bought = eventsOfType(r.events, 'caravan_traded').find(
        (e) => e.caravan === cId && e.side === 'bought' && e.resource === bread,
      );

      expect(bought).toBeDefined();
      expect(c.cargo.get(bread)).toBeGreaterThan(0);
      expect(c.treasury).toBeLessThan(20);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(getStock(seller, bread)).toBeLessThan(100);
    });

    it('paces replacement merchant caravans from owner treasury when the trade fleet is thin', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const familyId = actorId('replacement-family');
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const family = createActor({
        id: familyId,
        kind: 'patrician_family',
        name: 'Replacement Family',
        homeSettlement: settlement.id,
        treasury: 1_000,
      });
      setStock(family, resourceId('livestock.equines'), 5);
      setStock(family, resourceId('goods.cart'), 1);
      setStock(family, resourceId('food.grain'), 100);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement') });
      const dispatched = eventsOfType(r.events, 'merchant_caravan_dispatched');

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.ownerActor).toBe(familyId);
      expect(family.treasury).toBeLessThan(1_000);
      const caravan = w.caravans.get(dispatched[0]!.caravan);
      expect(caravan).toBeDefined();
      expect(caravan?.ownerActor).toBe(familyId);
      expect(caravan?.position).toEqual(settlement.anchor);
      expect(caravan?.destination).toEqual(settlement.anchor);
      expect(caravan?.treasury).toBeGreaterThan(0);
      expect(caravan?.vehicles.light_cart).toBe(1);
      expect(caravan?.cargo.get(resourceId('food.grain'))).toBeGreaterThan(0);
      expect(getStock(family, resourceId('livestock.equines'))).toBeLessThan(5);
      expect(getStock(family, resourceId('goods.cart'))).toBe(0);
      expect(getStock(family, resourceId('food.grain'))).toBeLessThan(100);
    });

    it('does not launch replacement merchants without local starter rations', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const familyId = actorId('unfed-replacement-family');
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const family = createActor({
        id: familyId,
        kind: 'patrician_family',
        name: 'Unfed Replacement Family',
        homeSettlement: settlement.id,
        treasury: 1_000,
      });
      setStock(family, resourceId('livestock.equines'), 5);
      setStock(family, resourceId('goods.cart'), 1);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement-no-rations') });

      expect(eventsOfType(r.events, 'merchant_caravan_dispatched')).toEqual([]);
      expect(family.treasury).toBe(1_000);
      expect(getStock(family, resourceId('livestock.equines'))).toBe(5);
      expect(getStock(family, resourceId('goods.cart'))).toBe(1);
    });

    it('sizes replacement merchants down to available pack animals', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const familyId = actorId('lean-replacement-family');
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const family = createActor({
        id: familyId,
        kind: 'patrician_family',
        name: 'Lean Replacement Family',
        homeSettlement: settlement.id,
        treasury: 1_000,
      });
      setStock(family, resourceId('livestock.equines'), 1);
      setStock(family, resourceId('food.grain'), 100);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement-lean') });
      const dispatched = eventsOfType(r.events, 'merchant_caravan_dispatched');
      const caravan = w.caravans.get(dispatched[0]!.caravan);

      expect(dispatched).toHaveLength(1);
      expect(caravan?.animals.mule).toBe(6);
      expect(caravan?.animals.donkey ?? 0).toBe(0);
      expect(getStock(family, resourceId('livestock.equines'))).toBe(0);
    });

    it('lets replacement owners buy local pack animals before assembly', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const familyId = actorId('market-replacement-family');
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const seller = w.actors.get(actorId('city-corp-1'))!;
      setStock(seller, resourceId('livestock.equines'), 1);
      // 5× scaled per realism pass 8 (equines clearing price, family
      // working capital).
      settlement.market.lastClearingPrice.set(resourceId('livestock.equines'), 500);
      const sellerTreasuryBefore = seller.treasury;
      const family = createActor({
        id: familyId,
        kind: 'patrician_family',
        name: 'Market Replacement Family',
        homeSettlement: settlement.id,
        treasury: 50_000,
      });
      setStock(family, resourceId('food.grain'), 100);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement-market-animals') });
      const dispatched = eventsOfType(r.events, 'merchant_caravan_dispatched');

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.ownerActor).toBe(familyId);
      expect(getStock(seller, resourceId('livestock.equines'))).toBe(0);
      expect(seller.treasury).toBeGreaterThan(sellerTreasuryBefore);
      // Per docs/15 §C26 the patrician family also market-makes — they
      // may keep a tiny residual MM stockpile of equines beyond what
      // the caravan assembly consumed. Allow sub-unit residual.
      expect(getStock(family, resourceId('livestock.equines'))).toBeLessThan(1);
    });

    it('does not assemble replacement merchants when temporary convoys fill the world cap', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const familyId = actorId('capped-replacement-family');
      const family = createActor({
        id: familyId,
        kind: 'patrician_family',
        name: 'Capped Replacement Family',
        homeSettlement: settlement.id,
        treasury: 10_000,
      });
      setStock(family, resourceId('livestock.equines'), 50);
      setStock(family, resourceId('goods.cart'), 10);
      w.actors.set(familyId, family);

      for (let i = 0; i < 96; i++) {
        const cId = caravanId(`import-existing-${i}`);
        const c = createCaravan({
          id: cId,
          ownerActor: actorId(`off-map-house-${i}`),
          position: settlement.anchor,
          destination: settlement.anchor,
          crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
          animals: { mule: 1 },
          vehicles: {},
        });
        c.cargo.set(resourceId('food.bread'), 10);
        w.caravans.set(cId, c);
      }

      const r = tick({ world: w, rng: createRng('merchant-global-cap') });
      const dispatched = eventsOfType(r.events, 'merchant_caravan_dispatched');

      expect(dispatched).toEqual([]);
      expect(family.treasury).toBe(10_000);
      expect(w.caravans.size).toBeLessThanOrEqual(96);
    });

    it('remits standing caravan profits to the owner when back at the home market', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 1 } });
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const owner = w.actors.get(actorId('city-corp-1'))!;
      const cId = caravanId('merchant-profit-remit');
      const c = createCaravan({
        id: cId,
        ownerActor: owner.id,
        position: settlement.anchor,
        destination: settlement.anchor,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 4 },
        vehicles: {},
        treasury: 5_000,
      });
      w.caravans.set(cId, c);

      const beforeOwnerTreasury = owner.treasury;
      const r = tick({ world: w, rng: createRng('caravan-profit-remit') });
      const remitted = eventsOfType(r.events, 'caravan_profit_remitted').find(
        (e) => e.caravan === cId,
      );

      expect(remitted).toBeDefined();
      expect(remitted?.ownerActor).toBe(owner.id);
      expect(remitted?.settlement).toBe(settlement.id);
      expect(remitted?.coin).toBeCloseTo(2_000, 6);
      expect(owner.treasury).toBeCloseTo(beforeOwnerTreasury + 2_000, 6);
      expect(c.treasury).toBeCloseTo(3_000, 6);
    });

    it('loads profitable cargo before departing for a dearer observed market', () => {
      const w = buildEmptyWorld();
      for (let q = -1; q <= 11; q++) {
        for (let r = -1; r <= 1; r++) w.grid.set(hex(q, r), makeTile('plains'));
      }

      const grain = resourceId('food.grain');
      const aId = settlementId('origin');
      const bId = settlementId('destination');
      const aActorId = actorId('origin-corp');
      const bActorId = actorId('destination-corp');
      const a = createSettlement({
        id: aId,
        tier: 'town',
        name: 'Origin',
        anchor: hex(0, 0),
        urbanHexes: [hex(0, 0)],
        catchmentHexes: [],
      });
      const b = createSettlement({
        id: bId,
        tier: 'town',
        name: 'Destination',
        anchor: hex(10, 0),
        urbanHexes: [hex(10, 0)],
        catchmentHexes: [],
      });
      a.stockpileOwners.push(aActorId);
      b.stockpileOwners.push(bActorId);
      a.market.lastClearingPrice.set(grain, 1);
      b.market.lastClearingPrice.set(grain, 5);
      const seller = createActor({
        id: aActorId,
        kind: 'city_corporation',
        name: 'Origin Corporation',
        homeSettlement: aId,
        treasury: 1000,
      });
      setStock(seller, grain, 100);
      const destinationOwner = createActor({
        id: bActorId,
        kind: 'city_corporation',
        name: 'Destination Corporation',
        homeSettlement: bId,
        treasury: 1000,
      });
      w.settlements.set(a.id, a);
      w.settlements.set(b.id, b);
      w.actors.set(seller.id, seller);
      w.actors.set(destinationOwner.id, destinationOwner);

      const cId = caravanId('local-merchant');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('merchant-owner'),
        position: hex(0, 0),
        destination: hex(0, 0),
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
        treasury: 50,
      });
      c.priceBook.set(grain, new Map([['10,0', { price: 5, observedOnDay: 0 }]]));
      w.caravans.set(cId, c);

      const r = tick({ world: w, rng: createRng('caravan-buy') });
      const bought = eventsOfType(r.events, 'caravan_traded').find(
        (e) => e.caravan === cId && e.side === 'bought' && e.resource === grain,
      );

      expect(bought).toBeDefined();
      expect(c.destination).toEqual(hex(10, 0));
      expect(c.cargo.get(grain)).toBeGreaterThan(0);
      expect(c.treasury).toBeLessThan(50);
      expect(getStock(seller, grain)).toBeLessThan(100);
    });

    it('uses known bandit risk when scouting without a profitable route', () => {
      const w = buildEmptyWorld();
      for (let q = -13; q <= 13; q++) {
        for (let r = -2; r <= 2; r++) w.grid.set(hex(q, r), makeTile('plains'));
      }

      const mkSettlement = (
        id: string,
        name: string,
        anchor: ReturnType<typeof hex>,
      ): Settlement => {
        const s = createSettlement({
          id: settlementId(id),
          tier: 'town',
          name,
          anchor,
          urbanHexes: [anchor],
          catchmentHexes: [],
        });
        s.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 10);
        const ownerId = actorId(`${id}-owner`);
        s.stockpileOwners.push(ownerId);
        w.actors.set(
          ownerId,
          createActor({
            id: ownerId,
            kind: 'city_corporation',
            name: `${name} Corporation`,
            homeSettlement: s.id,
            treasury: 1000,
          }),
        );
        w.settlements.set(s.id, s);
        return s;
      };

      const origin = mkSettlement('origin-risk-scout', 'Origin', hex(0, 0));
      const risky = mkSettlement('risky-risk-scout', 'Risky', hex(12, 0));
      const safe = mkSettlement('safe-risk-scout', 'Safe', hex(-12, 0));

      const banditOwner = actorId('risk-scout-bandits');
      const campId = banditCampId('risk-scout-camp');
      w.actors.set(
        banditOwner,
        createActor({
          id: banditOwner,
          kind: 'bandit_camp',
          name: 'Risk Scout Bandits',
          treasury: 0,
        }),
      );
      (w as WorldState & { banditCamps: NonNullable<WorldState['banditCamps']> }).banditCamps =
        new Map([
          [
            campId,
            createCamp({
              id: campId,
              name: 'Risk Scout Camp',
              hex: hex(8, 0),
              ownerActor: banditOwner,
              banditCount: 120,
              hangersOnCount: 0,
              weaponsPerBandit: 0.5,
              armorPerBandit: 0.2,
              averageHealth: 1,
            }),
          ],
        ]);

      const cId = caravanId('risk-aware-scout');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('merchant-owner'),
        position: origin.anchor,
        destination: origin.anchor,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 2 },
        vehicles: {},
        treasury: 50,
      });
      c.cargo.set(resourceId('food.grain'), 1);
      w.caravans.set(cId, c);

      tick({ world: w, rng: createRng('risk-aware-scout') });

      expect(c.destination).toEqual(safe.anchor);
      expect(c.destination).not.toEqual(risky.anchor);
    });
  });
