/** Tests for the fiscal-redistribution phase (src/sim/phases/fiscalRedistribution.ts). */

import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import { createSettlement } from '../world/settlement.js';
import {
  createActor,
} from '../politics/actor.js';
import {
  actorId,
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import type { WorldState } from '../../procgen/seed.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  makeTile,
} from '../testing/tickFixtures.js';

  describe('fiscal redistribution (docs/15 §C20)', () => {
    const buildFiscalWorld = (): WorldState => {
      const w = buildEmptyWorld();
      const sId = settlementId('rich-city');
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));
      const settlement = createSettlement({
        id: sId,
        tier: 'large_city',
        name: 'Rich City',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      // Need a population so tradePhase doesn't early-out before the
      // quarterly hook fires. A single plebeian adult is enough.
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      const corp = createActor({
        id: actorId('rich-corp'),
        kind: 'city_corporation',
        name: 'Rich Corp',
        homeSettlement: sId,
        treasury: 100_000,
      });
      const famA = createActor({
        id: actorId('family-a'),
        kind: 'patrician_family',
        name: 'Family A',
        homeSettlement: sId,
        treasury: 1_000,
      });
      const famB = createActor({
        id: actorId('family-b'),
        kind: 'patrician_family',
        name: 'Family B',
        homeSettlement: sId,
        treasury: 1_000,
      });
      settlement.stockpileOwners.push(corp.id, famA.id, famB.id);
      w.settlements.set(sId, settlement);
      w.actors.set(corp.id, corp);
      w.actors.set(famA.id, famA);
      w.actors.set(famB.id, famB);
      // Day 89 + 1 = 90 → quarterly redistribution hook fires on this tick.
      w.day = 89;
      return w;
    };

    it('distributes a fraction of city-corp treasury to patrician families on quarterly boundary', () => {
      const w = buildFiscalWorld();
      const corp = w.actors.get(actorId('rich-corp'));
      const famA = w.actors.get(actorId('family-a'));
      const famB = w.actors.get(actorId('family-b'));
      if (!corp || !famA || !famB) throw new Error('setup');
      const corpBefore = corp.treasury;
      const famABefore = famA.treasury;
      const famBBefore = famB.treasury;

      const r = tick({ world: w, rng: createRng('fiscal-civic') });
      const dividends = r.events.filter(
        (e) => e.type === 'fiscal_redistribution' && e.channel === 'civic_dividend',
      );

      expect(dividends.length).toBe(2);
      // 8% of 100k split evenly = 4k per family per quarter.
      const expected = corpBefore * 0.08;
      expect(corp.treasury).toBeCloseTo(corpBefore - expected, 1);
      expect(famA.treasury).toBeCloseTo(famABefore + expected / 2, 1);
      expect(famB.treasury).toBeCloseTo(famBBefore + expected / 2, 1);
    });

    it('does not fire civic dividends outside the quarterly boundary', () => {
      const w = buildFiscalWorld();
      w.day = 30; // mid-quarter
      const corp = w.actors.get(actorId('rich-corp'));
      if (!corp) throw new Error('setup');
      const corpBefore = corp.treasury;

      const r = tick({ world: w, rng: createRng('fiscal-no-fire') });
      const dividends = r.events.filter((e) => e.type === 'fiscal_redistribution');

      expect(dividends.length).toBe(0);
      expect(corp.treasury).toBe(corpBefore);
    });

    it('collects tenant rent from free villages to nearest patrician family', () => {
      const w = buildEmptyWorld();
      const cityId = settlementId('city');
      const villageId = settlementId('village');
      const cityHex = hex(0, 0);
      const villageHex = hex(3, 0);
      w.grid.set(cityHex, makeTile('plains'));
      w.grid.set(villageHex, makeTile('plains'));

      const city = createSettlement({
        id: cityId,
        tier: 'town',
        name: 'City',
        anchor: cityHex,
        urbanHexes: [cityHex],
        catchmentHexes: [],
      });
      city.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);

      const village = createSettlement({
        id: villageId,
        tier: 'village',
        name: 'Village',
        anchor: villageHex,
        urbanHexes: [villageHex],
        catchmentHexes: [],
      });
      village.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);

      const family = createActor({
        id: actorId('family'),
        kind: 'patrician_family',
        name: 'Family',
        homeSettlement: cityId,
        treasury: 1_000,
      });
      const villageActor = createActor({
        id: actorId('village-actor'),
        kind: 'free_village',
        name: 'Village Actor',
        homeSettlement: villageId,
        treasury: 10_000,
      });
      city.stockpileOwners.push(family.id);
      village.stockpileOwners.push(villageActor.id);
      w.settlements.set(cityId, city);
      w.settlements.set(villageId, village);
      w.actors.set(family.id, family);
      w.actors.set(villageActor.id, villageActor);
      // Day 89 + 1 = 90 → quarterly redistribution boundary.
      w.day = 89;

      const familyBefore = family.treasury;
      const villageBefore = villageActor.treasury;

      const r = tick({ world: w, rng: createRng('fiscal-rent') });
      const rentEvents = r.events.filter(
        (e) => e.type === 'fiscal_redistribution' && e.channel === 'tenant_rent',
      );

      expect(rentEvents.length).toBe(1);
      // 5% of 10k = 500 coin per quarter (single family in the patron city).
      expect(family.treasury).toBeGreaterThan(familyBefore);
      expect(villageActor.treasury).toBeLessThan(villageBefore);
      const transferred = family.treasury - familyBefore;
      expect(transferred).toBeCloseTo(500, 0);
    });
  });
