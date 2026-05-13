/** Tests for the production phase (src/sim/phases/production.ts). */

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
import type { WorldState } from '../../procgen/seed.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  buildOneSettlementWorld,
  eventsOfType,
  getStock,
  makeTile,
  setStock,
} from '../testing/tickFixtures.js';

  describe('production phase', () => {
    it('emits recipe_ran when a mill has grain + a miller', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const r = tick({ world: w, rng: createRng('mill-1') });
      const ran = eventsOfType(r.events, 'recipe_ran');
      const mills = ran.filter((e) => e.recipe === ('mill_grain' as unknown));
      expect(mills.length).toBeGreaterThan(0);
    });

    it('produces flour into the building owner stockpile', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const flour = resourceId('food.flour');
      const corp1 = w.actors.get(actorId('city-corp-1'));
      const before = corp1 !== undefined ? getStock(corp1, flour) : 0;
      tick({ world: w, rng: createRng('mill-2') });
      const after = corp1 !== undefined ? getStock(corp1, flour) : 0;
      expect(after).toBeGreaterThan(before);
    });

    it('credits minted coin to spendable owner treasury instead of inert stockpile', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));
      const sId = settlementId('mint-town');
      const ownerId = actorId('mint-owner');
      const coin = resourceId('goods.coin');
      const silver = resourceId('metal.silver');
      const settlement = createSettlement({
        id: sId,
        tier: 'small_city',
        name: 'Mint Town',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.jobAllocations.set(jobId('minter'), 1);
      settlement.stockpileOwners.push(ownerId);
      settlement.buildings.push({
        buildingId: buildingId('mint'),
        hex: anchor,
        ownerActor: ownerId,
        capacity: 1,
        daysSinceMaintained: 0,
      });
      const owner = createActor({
        id: ownerId,
        kind: 'city_corporation',
        name: 'Mint Office',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(owner, silver, 1);
      w.settlements.set(sId, settlement);
      w.actors.set(ownerId, owner);

      const result = tick({ world: w, rng: createRng('mint-coin-treasury') });

      expect(
        eventsOfType(result.events, 'recipe_ran').some((e) => String(e.recipe) === 'mint_coin'),
      ).toBe(true);
      expect(owner.treasury).toBeCloseTo(100, 6);
      expect(getStock(owner, coin) ?? 0).toBe(0);
      expect(getStock(owner, silver)).toBeCloseTo(0.6, 6);
    });

    it('idles production when the owner already holds the output stock target', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 10_000,
        flourSacks: 6_000,
        addMill: true,
      });
      const owner = w.actors.get(actorId('city-corp-1'));
      if (owner === undefined) throw new Error('missing owner');
      const beforeFlour = getStock(owner, resourceId('food.flour')) ?? 0;

      const r = tick({ world: w, rng: createRng('mill-output-stock-target') });

      expect(
        eventsOfType(r.events, 'recipe_ran').some((e) => String(e.recipe) === 'mill_grain'),
      ).toBe(false);
      expect(getStock(owner, resourceId('food.flour')) ?? 0).toBeLessThanOrEqual(beforeFlour);
    });

    it('resets daily building capacity to the installed per-building maximum', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      const mill = settlement?.buildings.find((b) => b.buildingId === buildingId('mill'));
      expect(mill).toBeDefined();
      mill!.capacity = 3;
      mill!.maxCapacity = 7;

      tick({ world: w, rng: createRng('installed-capacity-reset') });

      expect(mill!.capacity).toBe(7);
    });

    it('blocks paid-labor production when the owner cannot pay wages', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        flourSacks: 50,
        woodCords: 50,
        addBakery: true,
      });
      const owner = w.actors.get(actorId('city-corp-1'));
      expect(owner).toBeDefined();
      owner!.treasury = 0;
      const settlement = w.settlements.get(settlementId('settle-1'));
      expect(settlement).toBeDefined();
      const householdId = actorId('paid-workers');
      settlement!.stockpileOwners.push(householdId);
      settlement!.market.lastClearingPrice.set(resourceId('food.grain'), 2);
      w.actors.set(
        householdId,
        createActor({
          id: householdId,
          kind: 'hamlet_household',
          name: 'Paid Workers',
          homeSettlement: settlement!.id,
          treasury: 0,
        }),
      );

      const bread = resourceId('food.bread');
      const before = owner !== undefined ? getStock(owner, bread) : 0;
      const r = tick({ world: w, rng: createRng('cash-blocks-paid-production') });
      const after = owner !== undefined ? getStock(owner, bread) : 0;

      expect(after).toBe(before);
      expect(eventsOfType(r.events, 'recipe_blocked').some((e) => e.reason === 'cash')).toBe(true);
    });

    it('can pay production wages in staple food when coin is exhausted', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('in-kind-wage-town');
      const producerId = actorId('in-kind-producer');
      const householdId = actorId('in-kind-household');
      const grain = resourceId('food.grain');
      const tools = resourceId('goods.tools');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'In-Kind Wage Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      settlement.stockpileOwners.push(producerId, householdId);
      settlement.market.lastClearingPrice.set(grain, 2);
      settlement.buildings.push({
        buildingId: buildingId('farm'),
        hex: anchor,
        ownerActor: producerId,
        capacity: 1,
        daysSinceMaintained: 0,
      });

      const producer = createActor({
        id: producerId,
        kind: 'patrician_family',
        name: 'Food-Rich Owner',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(producer, grain, 5);
      setStock(producer, tools, 1);
      const household = createActor({
        id: householdId,
        kind: 'plebeian_household',
        name: 'Paid Workers',
        homeSettlement: sId,
        treasury: 0,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(producerId, producer);
      w.actors.set(householdId, household);

      const result = tick({ world: w, rng: createRng('in-kind-production-wages') });

      expect(eventsOfType(result.events, 'recipe_ran').length).toBeGreaterThan(0);
      expect(eventsOfType(result.events, 'recipe_blocked').some((e) => e.reason === 'cash')).toBe(
        false,
      );
    });

    it('emits recipe_blocked with reason missing_input when grain is empty', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 0,
        addMill: true,
      });
      const r = tick({ world: w, rng: createRng('mill-blocked') });
      const blocked = eventsOfType(r.events, 'recipe_blocked');
      expect(blocked.some((e) => e.reason === 'missing_input')).toBe(true);
    });

    it('requires a matching finite deposit for mine recipes', () => {
      const buildMiningWorld = (depositResource?: string): WorldState => {
        const w = buildOneSettlementWorld({ populationByClass: { plebeian: 20 } });
        const settlement = w.settlements.get(settlementId('settle-1'));
        const owner = w.actors.get(actorId('city-corp-1'));
        const mineHex = hex(1, 0);
        if (settlement === undefined || owner === undefined) {
          throw new Error('invalid mining fixture');
        }
        const tile = w.grid.get(mineHex);
        if (tile === undefined) throw new Error('missing mine tile');
        tile.terrain = 'hills';
        if (depositResource !== undefined) {
          tile.deposit = { resource: resourceId(depositResource), remaining: 5 };
        }
        settlement.jobAllocations.set(jobId('miner'), 20);
        settlement.buildings.push({
          buildingId: buildingId('mine'),
          hex: mineHex,
          ownerActor: owner.id,
          capacity: 10,
          daysSinceMaintained: 0,
        });
        setStock(owner, resourceId('goods.tools'), 100);
        return w;
      };

      const withoutDeposit = tick({
        world: buildMiningWorld(),
        rng: createRng('mine-without-deposit'),
      });
      expect(
        eventsOfType(withoutDeposit.events, 'recipe_ran').some(
          (e) => String(e.recipe) === 'mine_iron',
        ),
      ).toBe(false);
      expect(
        eventsOfType(withoutDeposit.events, 'recipe_blocked').some(
          (e) => String(e.recipe) === 'mine_iron' && e.reason === 'missing_deposit',
        ),
      ).toBe(true);

      const mismatchedDeposit = tick({
        world: buildMiningWorld('mineral.salt'),
        rng: createRng('mine-with-salt-deposit'),
      });
      expect(
        eventsOfType(mismatchedDeposit.events, 'recipe_ran').some(
          (e) => String(e.recipe) === 'mine_iron',
        ),
      ).toBe(false);
      expect(
        eventsOfType(mismatchedDeposit.events, 'recipe_blocked').some(
          (e) => String(e.recipe) === 'mine_iron' && e.reason === 'missing_deposit',
        ),
      ).toBe(false);

      const withDepositWorld = buildMiningWorld('mineral.iron_ore');
      const withDeposit = tick({ world: withDepositWorld, rng: createRng('mine-with-deposit') });
      const owner = withDepositWorld.actors.get(actorId('city-corp-1'));
      expect(
        eventsOfType(withDeposit.events, 'recipe_ran').some(
          (e) => String(e.recipe) === 'mine_iron',
        ),
      ).toBe(true);
      expect(owner !== undefined ? getStock(owner, resourceId('mineral.iron_ore')) : 0).toBeCloseTo(
        5,
        6,
      );
      expect(withDepositWorld.grid.get(hex(1, 0))?.deposit).toBeUndefined();
    });

    it('phase ordering: bake_bread sees flour produced earlier in the same tick', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 300 },
        grainModii: 500,
        woodCords: 50,
        addMill: true,
        addBakery: true,
      });
      const r = tick({ world: w, rng: createRng('phase-order') });
      const ran = eventsOfType(r.events, 'recipe_ran');
      const bread = ran.find((e) => String(e.recipe) === 'bake_bread');
      // Bread should run because flour was produced earlier in the same
      // production phase. fraction may be < 1 because flour is a fresh
      // produce (small first-tick amount), but it must run.
      expect(bread).toBeDefined();
    });

    it('pays production wages from the building owner to a local household', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('wage-town');
      const producerId = actorId('wage-producer');
      const householdId = actorId('wage-household');
      const grain = resourceId('food.grain');
      const tools = resourceId('goods.tools');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Wage Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 1);
      settlement.stockpileOwners.push(producerId, householdId);
      settlement.market.lastClearingPrice.set(grain, 2);
      settlement.buildings.push({
        buildingId: buildingId('farm'),
        hex: anchor,
        ownerActor: producerId,
        capacity: 1,
        daysSinceMaintained: 0,
      });

      const producer = createActor({
        id: producerId,
        kind: 'patrician_family',
        name: 'Farm Owner',
        homeSettlement: sId,
        treasury: 100,
      });
      setStock(producer, grain, 5);
      setStock(producer, tools, 1);
      const household = createActor({
        id: householdId,
        kind: 'hamlet_household',
        name: 'Local Workers',
        homeSettlement: sId,
        treasury: 0,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(producerId, producer);
      w.actors.set(householdId, household);

      tick({ world: w, rng: createRng('production-wages') });

      expect(producer.treasury).toBeLessThan(100);
      expect(household.treasury).toBeGreaterThan(0);
    });

    it('does not pay cash wages for enslaved production labor', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('slave-wage-town');
      const producerId = actorId('slave-wage-producer');
      const householdId = actorId('slave-wage-household');
      const grain = resourceId('food.grain');
      const tools = resourceId('goods.tools');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Slave Labor Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'slave' }, 1);
      settlement.stockpileOwners.push(producerId, householdId);
      settlement.market.lastClearingPrice.set(grain, 2);
      settlement.buildings.push({
        buildingId: buildingId('farm'),
        hex: anchor,
        ownerActor: producerId,
        capacity: 1,
        daysSinceMaintained: 0,
      });

      const producer = createActor({
        id: producerId,
        kind: 'patrician_family',
        name: 'Estate Owner',
        homeSettlement: sId,
        treasury: 0,
      });
      setStock(producer, grain, 5);
      setStock(producer, tools, 1);
      const household = createActor({
        id: householdId,
        kind: 'hamlet_household',
        name: 'Free Worker Household',
        homeSettlement: sId,
        treasury: 0,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(producerId, producer);
      w.actors.set(householdId, household);

      const result = tick({ world: w, rng: createRng('slave-production-wages') });

      expect(eventsOfType(result.events, 'recipe_ran').length).toBeGreaterThan(0);
      expect(household.treasury).toBe(0);
    });

    it("does not let common-household buildings use someone else's slave labor", () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('common-slave-labor-town');
      const producerId = actorId('common-slave-labor-producer');
      const grain = resourceId('food.grain');
      const tools = resourceId('goods.tools');
      const settlement = createSettlement({
        id: sId,
        tier: 'village',
        name: 'Common Slave Labor Village',
        anchor,
        urbanHexes: [anchor],
        catchmentHexes: [],
      });
      settlement.population.set({ age: '20-24', sex: 'male', class: 'slave' }, 10);
      settlement.jobAllocations.set(jobId('farmer'), 10);
      settlement.stockpileOwners.push(producerId);
      settlement.market.lastClearingPrice.set(grain, 2);
      settlement.buildings.push({
        buildingId: buildingId('farm'),
        hex: anchor,
        ownerActor: producerId,
        capacity: 1,
        daysSinceMaintained: 0,
      });

      const producer = createActor({
        id: producerId,
        kind: 'plebeian_household',
        name: 'Common Producer',
        homeSettlement: sId,
        treasury: 100,
      });
      setStock(producer, grain, 5);
      setStock(producer, tools, 1);

      w.settlements.set(sId, settlement);
      w.actors.set(producerId, producer);

      const result = tick({ world: w, rng: createRng('common-cannot-command-slaves') });

      expect(eventsOfType(result.events, 'recipe_ran')).toHaveLength(0);
      expect(
        eventsOfType(result.events, 'recipe_blocked').some((e) => e.reason === 'no_labor'),
      ).toBe(true);
    });
  });
