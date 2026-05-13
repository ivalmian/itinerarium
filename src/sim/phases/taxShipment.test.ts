/** Tests for the tax-shipment phase (src/sim/phases/taxShipment.ts). */

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
  caravanId,
  resourceId,
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  eventsOfType,
  getStock,
  makeTile,
  setStock,
} from '../testing/tickFixtures.js';

  describe('tax shipments', () => {
    it('delivers tax caravans at the capital instead of turning them into merchants', () => {
      const w = buildEmptyWorld();
      const governorId = actorId('governor-office');
      const capitalId = settlementId('capital');
      const capitalHex = hex(0, 0);
      w.grid.set(capitalHex, makeTile('plains'));
      const capital = createSettlement({
        id: capitalId,
        tier: 'large_city',
        name: 'Capital',
        anchor: capitalHex,
        urbanHexes: [capitalHex],
        catchmentHexes: [],
      });
      capital.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
      capital.stockpileOwners.push(governorId);
      const governor = createActor({
        id: governorId,
        kind: 'governor_office',
        name: 'Governor',
        homeSettlement: capitalId,
        treasury: 100_000,
      });
      w.settlements.set(capitalId, capital);
      w.actors.set(governorId, governor);
      const cId = caravanId('tax-test');
      const caravan = createCaravan({
        id: cId,
        ownerActor: governorId,
        position: capitalHex,
        destination: capitalHex,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 1 },
        vehicles: {},
      });
      caravan.cargo.set(resourceId('food.bread'), 5);
      caravan.cargo.set(resourceId('food.legumes'), 5);
      caravan.cargo.set(resourceId('food.grain'), 12);
      w.caravans.set(cId, caravan);

      tick({ world: w, rng: createRng('tax-deliver') });

      expect(w.caravans.has(cId)).toBe(false);
      expect(getStock(governor, resourceId('food.grain'))).toBeGreaterThan(11.9);
    });

    it('delivers coin tax cargo into governor treasury instead of stockpile', () => {
      const w = buildEmptyWorld();
      const governorId = actorId('governor-office');
      const capitalId = settlementId('capital');
      const capitalHex = hex(0, 0);
      const coin = resourceId('goods.coin');
      w.grid.set(capitalHex, makeTile('plains'));
      const capital = createSettlement({
        id: capitalId,
        tier: 'large_city',
        name: 'Capital',
        anchor: capitalHex,
        urbanHexes: [capitalHex],
        catchmentHexes: [],
      });
      capital.stockpileOwners.push(governorId);
      const governor = createActor({
        id: governorId,
        kind: 'governor_office',
        name: 'Governor',
        homeSettlement: capitalId,
        treasury: 100_000,
      });
      w.settlements.set(capitalId, capital);
      w.actors.set(governorId, governor);
      const cId = caravanId('tax-coin-delivery');
      const caravan = createCaravan({
        id: cId,
        ownerActor: governorId,
        position: capitalHex,
        destination: capitalHex,
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: {},
        vehicles: {},
      });
      caravan.cargo.set(coin, 125);
      w.caravans.set(cId, caravan);

      tick({ world: w, rng: createRng('tax-coin-delivery') });

      expect(w.caravans.has(cId)).toBe(false);
      expect(governor.treasury).toBeCloseTo(100_125, 6);
      expect(getStock(governor, coin) ?? 0).toBe(0);
      expect(capital.market.recentInflows.get(coin)).toBeCloseTo(125, 6);
    });

    it('dispatches monthly coin tax from owner treasury even without coin stockpile', () => {
      const w = buildEmptyWorld();
      const governorId = actorId('governor-office');
      const capitalId = settlementId('capital');
      const ownerId = actorId('coin-tax-owner');
      const villageId = settlementId('coin-tax-village');
      const capitalHex = hex(0, 0);
      const villageHex = hex(1, 0);
      const coin = resourceId('goods.coin');
      for (let q = 0; q <= 1; q++) w.grid.set(hex(q, 0), makeTile('plains'));
      const capital = createSettlement({
        id: capitalId,
        tier: 'large_city',
        name: 'Capital',
        anchor: capitalHex,
        urbanHexes: [capitalHex],
        catchmentHexes: [],
      });
      capital.stockpileOwners.push(governorId);
      const village = createSettlement({
        id: villageId,
        tier: 'village',
        name: 'Coin Tax Village',
        anchor: villageHex,
        urbanHexes: [villageHex],
        catchmentHexes: [],
      });
      village.stockpileOwners.push(ownerId);
      const governor = createActor({
        id: governorId,
        kind: 'governor_office',
        name: 'Governor',
        homeSettlement: capitalId,
        treasury: 100_000,
      });
      const owner = createActor({
        id: ownerId,
        kind: 'patrician_family',
        name: 'Coin Tax Owner',
        homeSettlement: villageId,
        treasury: 10_000,
      });
      w.settlements.set(capitalId, capital);
      w.settlements.set(villageId, village);
      w.actors.set(governorId, governor);
      w.actors.set(ownerId, owner);
      w.day = 30;

      const result = tick({ world: w, rng: createRng('coin-tax-dispatch') });
      const shipments = eventsOfType(result.events, 'tax_shipment_dispatched');
      const taxCaravan = Array.from(w.caravans.values()).find((c) =>
        String(c.id).startsWith('tax-'),
      );

      expect(shipments).toHaveLength(1);
      expect(shipments[0]?.coin).toBe(100);
      expect(owner.treasury).toBe(9_900);
      expect(getStock(owner, coin) ?? 0).toBe(0);
      expect(taxCaravan?.cargo.get(coin)).toBe(100);
    });

    it('paces harvest shipment dispatch instead of spawning every owed caravan at once', () => {
      const w = buildEmptyWorld();
      const governorId = actorId('governor-office');
      const capitalId = settlementId('capital');
      const capitalHex = hex(0, 0);
      for (let q = -5; q <= 25; q++) {
        for (let r = -2; r <= 2; r++) {
          w.grid.set(hex(q, r), makeTile('plains'));
        }
      }
      const capital = createSettlement({
        id: capitalId,
        tier: 'large_city',
        name: 'Capital',
        anchor: capitalHex,
        urbanHexes: [capitalHex],
        catchmentHexes: [],
      });
      capital.stockpileOwners.push(governorId);
      const governor = createActor({
        id: governorId,
        kind: 'governor_office',
        name: 'Governor',
        homeSettlement: capitalId,
        treasury: 100_000,
      });
      w.settlements.set(capitalId, capital);
      w.actors.set(governorId, governor);

      for (let i = 0; i < 20; i++) {
        const sId = settlementId(`tax-village-${i}`);
        const ownerId = actorId(`tax-owner-${i}`);
        const anchor = hex(i + 1, 0);
        const s = createSettlement({
          id: sId,
          tier: 'village',
          name: `Tax Village ${i}`,
          anchor,
          urbanHexes: [anchor],
          catchmentHexes: [],
        });
        s.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
        s.stockpileOwners.push(ownerId);
        s.market.recentInflows.set(resourceId('food.grain'), 1_000);
        const owner = createActor({
          id: ownerId,
          kind: 'patrician_family',
          name: `Tax Owner ${i}`,
          homeSettlement: sId,
          treasury: 1_000,
        });
        setStock(owner, resourceId('food.grain'), 1_000);
        w.settlements.set(sId, s);
        w.actors.set(ownerId, owner);
      }

      w.day = 273;
      const first = tick({ world: w, rng: createRng('tax-burst-1') });
      const firstShipments = eventsOfType(first.events, 'tax_shipment_dispatched');
      // Dispatch is paced by convoy, not by raw assessment. The first
      // harvest day should release one district convoy carrying the full
      // same-resource assessment batch, instead of one caravan per owner.
      // The day's `ageRecentFlowsPhase` decays each seeded recentInflows
      // (1000 grain × 20 villages = 20 000) by ~3.3% before tax assessment
      // runs, so the expected harvest tax sits around 1900-1980 grain
      // rather than the pre-decay 2000. Assert pacing (one convoy in tick
      // 1) and a 1900..2000 grain envelope.
      expect(firstShipments.length).toBe(1);
      const firstTotal = firstShipments.reduce((sum, e) => sum + e.grainModii, 0);
      expect(firstTotal).toBeGreaterThanOrEqual(1900);
      expect(firstTotal).toBeLessThanOrEqual(2000);

      // Across multiple ticks the queued assessment cargo should flush
      // without requiring one caravan per assessment.
      let totalConvoys = firstShipments.length;
      let totalGrain = firstTotal;
      for (let k = 0; k < 10 && totalGrain < 1900; k++) {
        const r = tick({ world: w, rng: createRng(`tax-burst-${k + 2}`) });
        const shipments = eventsOfType(r.events, 'tax_shipment_dispatched');
        totalConvoys += shipments.length;
        totalGrain += shipments.reduce((sum, e) => sum + e.grainModii, 0);
      }
      expect(totalGrain).toBeGreaterThanOrEqual(1900);
      expect(totalGrain).toBeLessThanOrEqual(2000);
      expect(totalConvoys).toBe(1);
    });

    it('holds queued tax assessments when active tax convoys already saturate the road', () => {
      const w = buildEmptyWorld();
      const governorId = actorId('governor-office');
      const capitalId = settlementId('capital');
      const capitalHex = hex(0, 0);
      for (let q = -5; q <= 25; q++) {
        for (let r = -2; r <= 2; r++) {
          w.grid.set(hex(q, r), makeTile('plains'));
        }
      }
      const capital = createSettlement({
        id: capitalId,
        tier: 'large_city',
        name: 'Capital',
        anchor: capitalHex,
        urbanHexes: [capitalHex],
        catchmentHexes: [],
      });
      capital.stockpileOwners.push(governorId);
      const governor = createActor({
        id: governorId,
        kind: 'governor_office',
        name: 'Governor',
        homeSettlement: capitalId,
        treasury: 100_000,
      });
      w.settlements.set(capitalId, capital);
      w.actors.set(governorId, governor);

      for (let i = 0; i < 24; i++) {
        const cId = caravanId(`tax-existing-${i}`);
        w.caravans.set(
          cId,
          createCaravan({
            id: cId,
            ownerActor: governorId,
            position: hex(25, 2),
            destination: hex(999, 999),
            crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
            animals: { mule: 1 },
            vehicles: {},
          }),
        );
      }

      for (let i = 0; i < 10; i++) {
        const sId = settlementId(`queued-tax-village-${i}`);
        const ownerId = actorId(`queued-tax-owner-${i}`);
        const anchor = hex(i + 1, 0);
        const s = createSettlement({
          id: sId,
          tier: 'village',
          name: `Queued Tax Village ${i}`,
          anchor,
          urbanHexes: [anchor],
          catchmentHexes: [],
        });
        s.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
        s.stockpileOwners.push(ownerId);
        s.market.recentInflows.set(resourceId('food.grain'), 1_000);
        const owner = createActor({
          id: ownerId,
          kind: 'patrician_family',
          name: `Queued Tax Owner ${i}`,
          homeSettlement: sId,
          treasury: 1_000,
        });
        setStock(owner, resourceId('food.grain'), 1_000);
        w.settlements.set(sId, s);
        w.actors.set(ownerId, owner);
      }

      w.day = 273;
      const r = tick({ world: w, rng: createRng('tax-active-cap') });
      const shipments = eventsOfType(r.events, 'tax_shipment_dispatched');
      expect(shipments).toEqual([]);
      expect([...w.caravans.keys()].filter((id) => String(id).startsWith('tax-')).length).toBe(24);
    });
  });
