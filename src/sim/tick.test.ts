/**
 * Tests for the per-day tick loop. Uses small handcrafted worlds so the
 * sub-phase contract is observable end-to-end without procgen overhead.
 */

import { describe, expect, it } from 'vitest';
import { createGrid } from './world/grid.js';
import { hex } from './world/hex.js';
import type { HexTile } from './world/terrain.js';
import { createSettlement, type Settlement } from './world/settlement.js';
import { createActor, type Actor } from './politics/actor.js';
import { createFaction, type Faction } from './politics/faction.js';
import { createCharacter, type NamedCharacter } from './politics/character.js';
import { createReputationTable } from './reputation/table.js';
import { createCaravan, type Caravan } from './caravan/caravan.js';
import { createCamp } from './bandit/camp.js';
import {
  actorId,
  banditCampId,
  buildingId,
  caravanId,
  characterId,
  factionId,
  jobId,
  resourceId,
  settlementId,
  type ActorId,
  type CaravanId,
  type CharacterId,
  type FactionId,
  type SettlementId,
} from './types.js';
import { createRng } from './rng.js';
import type { WorldState } from '../procgen/seed.js';
import { tick, type TickEvent, type TickResult } from './tick.js';

// --- Test fixture builders --------------------------------------------------

const makeTile = (terrain: HexTile['terrain'] = 'plains'): HexTile => ({
  terrain,
  climate: 'mediterranean',
  elevation: 100,
  hasRiver: false,
  road: 'roman',
  ownerActor: null,
});

const buildEmptyWorld = (): WorldState => {
  const grid = createGrid();
  return {
    day: 0,
    grid,
    settlements: new Map<SettlementId, Settlement>(),
    actors: new Map<ActorId, Actor>(),
    factions: new Map<FactionId, Faction>(),
    characters: new Map<CharacterId, NamedCharacter>(),
    caravans: new Map<CaravanId, Caravan>(),
    reputation: createReputationTable(),
    bySite: [],
  };
};

interface OneSettlementOpts {
  readonly populationByClass?: Partial<Record<'plebeian' | 'patrician' | 'slave', number>>;
  readonly grainModii?: number;
  readonly flourSacks?: number;
  readonly woodCords?: number;
  readonly addBakery?: boolean;
  readonly addMill?: boolean;
}

/**
 * Build a one-settlement world: a town with a city_corporation actor that
 * holds the stockpile. Optional buildings + starting goods let tests dial in
 * specific scenarios (e.g. starvation, recipe satisfaction).
 */
const buildOneSettlementWorld = (opts: OneSettlementOpts = {}): WorldState => {
  const w = buildEmptyWorld();
  const anchor = hex(0, 0);
  // Populate a 3×3 area of plains so catchment hexes exist.
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      w.grid.set(hex(q, r), makeTile('plains'));
    }
  }
  const cityActorId = actorId('city-corp-1');
  const sId = settlementId('settle-1');
  const fId = factionId('city-faction');
  const charId = characterId('headman-1');

  const settlement = createSettlement({
    id: sId,
    tier: 'town',
    name: 'Test Town',
    anchor,
    urbanHexes: [anchor],
    catchmentHexes: [hex(1, 0), hex(0, 1), hex(-1, 0), hex(0, -1)],
  });
  // Population.
  const pleb = opts.populationByClass?.plebeian ?? 100;
  if (pleb > 0) settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, pleb);
  if ((opts.populationByClass?.patrician ?? 0) > 0) {
    settlement.population.set(
      { age: '40-44', sex: 'male', class: 'patrician' },
      opts.populationByClass!.patrician!,
    );
  }
  if ((opts.populationByClass?.slave ?? 0) > 0) {
    settlement.population.set(
      { age: '25-29', sex: 'male', class: 'slave' },
      opts.populationByClass!.slave!,
    );
  }
  settlement.stockpileOwners.push(cityActorId);
  settlement.factions.push(fId);

  if (opts.addMill === true) {
    settlement.buildings.push({
      buildingId: buildingId('mill'),
      hex: anchor,
      ownerActor: cityActorId,
      capacity: 2,
      daysSinceMaintained: 0,
    });
  }
  if (opts.addBakery === true) {
    settlement.buildings.push({
      buildingId: buildingId('bakery'),
      hex: anchor,
      ownerActor: cityActorId,
      capacity: 2,
      daysSinceMaintained: 0,
    });
  }

  const cityActor = createActor({
    id: cityActorId,
    kind: 'city_corporation',
    name: 'Test City Corporation',
    homeSettlement: sId,
    treasury: 5000,
  });
  if ((opts.grainModii ?? 0) > 0) {
    cityActor.stockpile.set(resourceId('food.grain'), opts.grainModii!);
  }
  if ((opts.flourSacks ?? 0) > 0) {
    cityActor.stockpile.set(resourceId('food.flour'), opts.flourSacks!);
  }
  if ((opts.woodCords ?? 0) > 0) {
    cityActor.stockpile.set(resourceId('material.wood'), opts.woodCords!);
  }

  const headman = createCharacter({
    id: charId,
    name: 'Marcus Vibianus',
    age: 45,
    sex: 'male',
    class: 'patrician',
    faction: fId,
    role: 'patriarch',
    location: anchor,
  });
  const faction = createFaction({
    id: fId,
    actor: cityActorId,
    name: 'City Faction',
    members: [charId],
  });

  // Set ownerActor on every urban + catchment tile.
  for (const u of settlement.urbanHexes) {
    const tile = w.grid.get(u);
    if (tile !== undefined) tile.ownerActor = cityActorId;
  }
  for (const c of settlement.catchmentHexes) {
    const tile = w.grid.get(c);
    if (tile !== undefined) tile.ownerActor = cityActorId;
  }

  w.actors.set(cityActorId, cityActor);
  w.factions.set(fId, faction);
  w.characters.set(charId, headman);
  w.settlements.set(sId, settlement);
  return w;
};

const eventsOfType = <T extends TickEvent['type']>(
  events: readonly TickEvent[],
  type: T,
): readonly Extract<TickEvent, { type: T }>[] => {
  return events.filter((e): e is Extract<TickEvent, { type: T }> => e.type === type);
};

// --- Tests ------------------------------------------------------------------

describe('tick (per-day loop)', () => {
  describe('shape', () => {
    it('returns the same world reference advanced by one day with no events on an empty world', () => {
      const w = buildEmptyWorld();
      const r = tick({ world: w, rng: createRng('t1') });
      expect(r.world.day).toBe(1);
      expect(r.events).toEqual([]);
    });

    it('preserves all top-level maps (no replacement)', () => {
      const w = buildEmptyWorld();
      const r = tick({ world: w, rng: createRng('t1') });
      expect(r.world.settlements).toBe(w.settlements);
      expect(r.world.actors).toBe(w.actors);
      expect(r.world.factions).toBe(w.factions);
      expect(r.world.characters).toBe(w.characters);
      expect(r.world.caravans).toBe(w.caravans);
      expect(r.world.reputation).toBe(w.reputation);
    });
  });

  describe('determinism', () => {
    it('two ticks with the same world + RNG produce the same events', () => {
      const a = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const b = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const ra = tick({ world: a, rng: createRng('det-1') });
      const rb = tick({ world: b, rng: createRng('det-1') });
      // Compare event sequences by stringifying (events contain only plain
      // structurally-comparable data).
      expect(JSON.stringify(rb.events)).toBe(JSON.stringify(ra.events));
    });
  });

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
      const before =
        w.actors.get(actorId('city-corp-1'))?.stockpile.get(resourceId('food.flour')) ?? 0;
      tick({ world: w, rng: createRng('mill-2') });
      const after =
        w.actors.get(actorId('city-corp-1'))?.stockpile.get(resourceId('food.flour')) ?? 0;
      expect(after).toBeGreaterThan(before);
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
      const beforeFlour = owner.stockpile.get(resourceId('food.flour')) ?? 0;

      const r = tick({ world: w, rng: createRng('mill-output-stock-target') });

      expect(
        eventsOfType(r.events, 'recipe_ran').some((e) => String(e.recipe) === 'mill_grain'),
      ).toBe(false);
      expect(owner.stockpile.get(resourceId('food.flour')) ?? 0).toBeLessThanOrEqual(beforeFlour);
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

      const before = owner?.stockpile.get(resourceId('food.bread')) ?? 0;
      const r = tick({ world: w, rng: createRng('cash-blocks-paid-production') });
      const after = owner?.stockpile.get(resourceId('food.bread')) ?? 0;

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
      producer.stockpile.set(grain, 5);
      producer.stockpile.set(tools, 1);
      const household = createActor({
        id: householdId,
        kind: 'common_household',
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
        owner.stockpile.set(resourceId('goods.tools'), 100);
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
      expect(owner?.stockpile.get(resourceId('mineral.iron_ore')) ?? 0).toBeCloseTo(5, 6);
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
      producer.stockpile.set(grain, 5);
      producer.stockpile.set(tools, 1);
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
      producer.stockpile.set(grain, 5);
      producer.stockpile.set(tools, 1);
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
        kind: 'common_household',
        name: 'Common Producer',
        homeSettlement: sId,
        treasury: 100,
      });
      producer.stockpile.set(grain, 5);
      producer.stockpile.set(tools, 1);

      w.settlements.set(sId, settlement);
      w.actors.set(producerId, producer);

      const result = tick({ world: w, rng: createRng('common-cannot-command-slaves') });

      expect(eventsOfType(result.events, 'recipe_ran')).toHaveLength(0);
      expect(
        eventsOfType(result.events, 'recipe_blocked').some((e) => e.reason === 'no_labor'),
      ).toBe(true);
    });
  });

  describe('consumption phase', () => {
    it('drains roughly one day of grain through the subsistence market', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1000 },
        grainModii: 200,
      });
      const before =
        w.actors.get(actorId('city-corp-1'))?.stockpile.get(resourceId('food.grain')) ?? 0;
      tick({ world: w, rng: createRng('cons-1') });
      const after =
        w.actors.get(actorId('city-corp-1'))?.stockpile.get(resourceId('food.grain')) ?? 0;
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
      seller.stockpile.set(grain, 100);
      const buyer = createActor({
        id: buyerId,
        kind: 'common_household',
        name: 'Tenant Households',
        homeSettlement: sId,
        treasury: 0,
      });

      w.settlements.set(sId, settlement);
      w.actors.set(sellerId, seller);
      w.actors.set(buyerId, buyer);

      const result = tick({ world: w, rng: createRng('tenant-rations') });

      expect(seller.stockpile.get(grain) ?? 0).toBe(100);
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
      seller.stockpile.set(flour, 100);
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
      expect(seller.stockpile.get(flour)).toBeLessThan(100);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(household.treasury).toBeLessThan(beforeHouseholdTreasury);
      expect(household.stockpile.get(flour) ?? 0).toBe(0);
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
        kind: 'common_household',
        name: 'Cashless Households',
        homeSettlement: settlement.id,
        treasury: 0,
      });
      w.actors.set(household.id, household);
      settlement.stockpileOwners.push(household.id);
      city.stockpile.set(resourceId('food.bread'), 100);

      const before = city.stockpile.get(resourceId('food.bread')) ?? 0;
      const result = tick({ world: w, rng: createRng('civic-ration-self-provision') });
      const after = city.stockpile.get(resourceId('food.bread')) ?? 0;

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

  describe('movement phase', () => {
    it('advances a caravan with a destination toward the destination', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      // Add several plains hexes east of the anchor for the caravan to walk.
      for (let q = 3; q <= 10; q++) {
        w.grid.set(hex(q, 0), makeTile('plains'));
      }
      const cId = caravanId('cara-1');
      const owner = actorId('city-corp-1');
      const c = createCaravan({
        id: cId,
        ownerActor: owner,
        position: { q: 0, r: 0 },
        destination: { q: 10, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 6 },
        vehicles: {},
      });
      // Give it some rations so it doesn't starve immediately.
      c.cargo.set(resourceId('food.bread'), 50);
      w.caravans.set(cId, c);
      const r = tick({ world: w, rng: createRng('cara-move') });
      const moves = eventsOfType(r.events, 'caravan_moved');
      // The caravan should have moved at least one hex toward the destination.
      expect(c.position.q).toBeGreaterThan(0);
      expect(moves.length).toBeGreaterThan(0);
      for (let i = 1; i < moves.length; i++) {
        expect(moves[i]?.from).toEqual(moves[i - 1]?.to);
      }
    });

    it('emits caravan_arrived when a caravan reaches its destination', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const cId = caravanId('cara-arr');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('city-corp-1'),
        position: { q: 0, r: 0 },
        destination: { q: 0, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 4 },
        vehicles: {},
      });
      c.cargo.set(resourceId('food.bread'), 10);
      w.caravans.set(cId, c);
      const r = tick({ world: w, rng: createRng('cara-arr') });
      const arrivals = eventsOfType(r.events, 'caravan_arrived');
      expect(arrivals.some((e) => e.caravan === cId)).toBe(true);
    });

    it('disbands caravans whose crew has already been wiped out', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const cId = caravanId('cara-zero-crew');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('city-corp-1'),
        position: { q: 0, r: 0 },
        destination: { q: 0, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 1 },
        vehicles: {},
      });
      c.crew = [];
      w.caravans.set(cId, c);

      const r = tick({ world: w, rng: createRng('zero-crew-disband') });
      const disbanded = eventsOfType(r.events, 'caravan_disbanded').find((e) => e.caravan === cId);

      expect(w.caravans.has(cId)).toBe(false);
      expect(disbanded?.reason).toBe('zero_crew');
    });
  });

  describe('trail wear phase', () => {
    it('caps road wear from heavy repeated caravan traffic', () => {
      const w = buildEmptyWorld();
      w.grid.set(hex(0, 0), makeTile('plains'));
      w.grid.set(hex(1, 0), makeTile('plains'));
      w.grid.set(hex(2, 0), makeTile('plains'));
      for (const [, t] of w.grid.tiles()) {
        t.road = 'none';
        t.roadWear = 0;
      }

      const cId = caravanId('heavy-traffic');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('city-corp-1'),
        position: hex(0, 0),
        destination: hex(2, 0),
        crew: [{ kind: 'merchant', count: 2000, weapons: 0, armor: 0 }],
        animals: { mule: 5000 },
        vehicles: {},
      });
      c.cargo.set(resourceId('food.bread'), 100000);
      w.caravans.set(cId, c);

      tick({ world: w, rng: createRng('road-wear-cap') });

      expect(w.grid.get(hex(1, 0))?.roadWear).toBeLessThanOrEqual(10);
    });

    it('demotes unused dirt roads near the downgrade threshold and clears their wear', () => {
      const w = buildEmptyWorld();
      // Isolated dirt hex (0 road neighbors): decay = 3.0 × 2^-2 = 0.75/day.
      // Isolated dirt hex (0 road neighbors): decay = 1.5 × 2^-2 = 0.375/day.
      // Seed it at 20.2 so a single tick brings it below DIRT_DOWNGRADE_THRESHOLD (20).
      w.grid.set(hex(0, 0), {
        ...makeTile('plains'),
        road: 'dirt',
        roadWear: 20.2,
      });

      const r = tick({ world: w, rng: createRng('road-decay') });
      const downgraded = eventsOfType(r.events, 'road_downgraded');

      expect(w.grid.get(hex(0, 0))?.road).toBe('none');
      expect(w.grid.get(hex(0, 0))?.roadWear).toBe(0);
      expect(downgraded).toHaveLength(1);
    });

    it('scales dirt-road decay exponentially with road-neighbor count', () => {
      // An isolated dirt hex (0 road neighbors) should decay at 0.25× the
      // baseline rate. A 3-road-neighbor dirt hex should decay at 2× the
      // baseline. See docs/06 §"Dirt roads can downgrade."
      const isolated = buildEmptyWorld();
      isolated.grid.set(hex(10, 10), makeTile('plains'));
      isolated.grid.set(hex(10, 10), {
        ...isolated.grid.get(hex(10, 10))!,
        road: 'dirt',
        roadWear: 100,
      });
      tick({ world: isolated, rng: createRng('iso') });
      // Baseline DIRT_ROAD_DECAY_PER_DAY = 1.5; with n=0, decay = 1.5 × 2^-2 = 0.375.
      // 100 - 0.375 = 99.625.
      expect(isolated.grid.get(hex(10, 10))?.roadWear).toBeCloseTo(99.625, 2);

      const dense = buildEmptyWorld();
      const center = hex(10, 10);
      dense.grid.set(center, makeTile('plains'));
      dense.grid.set(center, {
        ...dense.grid.get(center)!,
        road: 'dirt',
        roadWear: 100,
      });
      // Give it 3 road neighbors.
      for (const d of [hex(11, 10), hex(11, 9), hex(10, 9)]) {
        dense.grid.set(d, makeTile('plains'));
        dense.grid.set(d, { ...dense.grid.get(d)!, road: 'dirt', roadWear: 100 });
      }
      tick({ world: dense, rng: createRng('dense') });
      // With n=3, decay = 1.5 × 2^1 = 3.0. 100 - 3 = 97.
      expect(dense.grid.get(center)?.roadWear).toBeCloseTo(97, 2);
    });
  });

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
      expect(price).toBeGreaterThan(10);
      expect(price).toBeLessThanOrEqual(18);
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

    it('records a seller ask when stock exists but no buyer is active', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1 },
      });
      const settlement = w.settlements.get(settlementId('settle-1'));
      const city = w.actors.get(actorId('city-corp-1'));
      if (settlement === undefined || city === undefined) throw new Error('missing fixture');
      const tools = resourceId('goods.tools');
      city.stockpile.set(tools, 100);
      settlement.market.lastClearingPrice.set(tools, 2500);

      tick({ world: w, rng: createRng('mkt-seller-ask-no-bid') });

      const quote = settlement.market.lastClearingPrice.get(tools);
      expect(quote).toBeGreaterThan(0);
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
      seller.stockpile.set(flour, 50);
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
      expect(baker.stockpile.get(flour)).toBeGreaterThan(0);
      expect(seller.stockpile.get(flour)).toBeLessThan(50);
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
      seller.stockpile.set(wine, 50);
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
      expect(seller.stockpile.get(wine)).toBeLessThan(50);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(household.treasury).toBeLessThan(beforeHouseholdTreasury);
      expect(household.stockpile.get(wine) ?? 0).toBe(0);
    });

    it('clears institutional procurement demand and consumes upkeep goods', () => {
      const w = buildEmptyWorld();
      const anchor = hex(0, 0);
      w.grid.set(anchor, makeTile('plains'));

      const sId = settlementId('garrison-market');
      const sellerId = actorId('weapon-seller');
      const barracksOwnerId = actorId('garrison-buyer');
      const weapons = resourceId('goods.weapons');
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
      seller.stockpile.set(weapons, 2);
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
      expect(seller.stockpile.get(weapons)).toBeLessThan(2);
      expect(seller.treasury).toBeGreaterThan(0);
      expect(buyer.treasury).toBeLessThan(beforeBuyerTreasury);
      expect(buyer.stockpile.get(weapons) ?? 0).toBe(0);
    });
  });

  describe('storage spoilage', () => {
    it('short-lived perishables spoil even during the bootstrap storage grace period', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 0, slave: 100 },
        grainModii: 1_000,
      });
      const owner = w.actors.get(actorId('city-corp-1'));
      if (owner === undefined) throw new Error('missing owner');
      const grapes = resourceId('food.grapes');
      const cheese = resourceId('food.cheese');
      owner.stockpile.set(grapes, 100);
      owner.stockpile.set(cheese, 100);

      const r = tick({ world: w, rng: createRng('natural-short-spoilage') });

      expect(owner.stockpile.get(grapes) ?? 0).toBeLessThan(100);
      expect(owner.stockpile.get(cheese) ?? 0).toBe(100);
      expect(eventsOfType(r.events, 'storage_spoilage').some((e) => e.resource === grapes)).toBe(
        true,
      );
      expect(eventsOfType(r.events, 'storage_spoilage').some((e) => e.resource === cheese)).toBe(
        false,
      );
    });
  });

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
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
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
      buyer.stockpile.set(tools, 1);

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
      expect(buyer.stockpile.get(tools) ?? 0).toBeGreaterThan(1);
    });

    it('consigns unsold off-map imports and routes them back to their edge gate', () => {
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

      expect(c.cargo.get(spices) ?? 0).toBe(0);
      expect(buyer.stockpile.get(spices)).toBeCloseTo(20, 6);
      expect(c.treasury).toBe(0);
      expect(c.destination).toEqual(edge);

      tick({ world: w, rng: createRng('import-return-exit') });

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
      seller.stockpile.set(bread, 100);
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
      expect(seller.stockpile.get(bread)).toBeLessThan(100);
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
      family.stockpile.set(resourceId('livestock.equines'), 5);
      family.stockpile.set(resourceId('goods.cart'), 1);
      family.stockpile.set(resourceId('food.grain'), 100);
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
      expect(family.stockpile.get(resourceId('livestock.equines'))).toBeLessThan(5);
      expect(family.stockpile.get(resourceId('goods.cart'))).toBeUndefined();
      expect(family.stockpile.get(resourceId('food.grain'))).toBeLessThan(100);
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
      family.stockpile.set(resourceId('livestock.equines'), 5);
      family.stockpile.set(resourceId('goods.cart'), 1);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement-no-rations') });

      expect(eventsOfType(r.events, 'merchant_caravan_dispatched')).toEqual([]);
      expect(family.treasury).toBe(1_000);
      expect(family.stockpile.get(resourceId('livestock.equines'))).toBe(5);
      expect(family.stockpile.get(resourceId('goods.cart'))).toBe(1);
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
      family.stockpile.set(resourceId('livestock.equines'), 1);
      family.stockpile.set(resourceId('food.grain'), 100);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement-lean') });
      const dispatched = eventsOfType(r.events, 'merchant_caravan_dispatched');
      const caravan = w.caravans.get(dispatched[0]!.caravan);

      expect(dispatched).toHaveLength(1);
      expect(caravan?.animals.mule).toBe(6);
      expect(caravan?.animals.donkey ?? 0).toBe(0);
      expect(family.stockpile.get(resourceId('livestock.equines'))).toBeUndefined();
    });

    it('lets replacement owners buy local pack animals before assembly', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const familyId = actorId('market-replacement-family');
      const settlement = w.settlements.get(settlementId('settle-1'))!;
      const seller = w.actors.get(actorId('city-corp-1'))!;
      seller.stockpile.set(resourceId('livestock.equines'), 1);
      settlement.market.lastClearingPrice.set(resourceId('livestock.equines'), 100);
      const sellerTreasuryBefore = seller.treasury;
      const family = createActor({
        id: familyId,
        kind: 'patrician_family',
        name: 'Market Replacement Family',
        homeSettlement: settlement.id,
        treasury: 10_000,
      });
      family.stockpile.set(resourceId('food.grain'), 100);
      w.actors.set(familyId, family);

      const r = tick({ world: w, rng: createRng('merchant-replacement-market-animals') });
      const dispatched = eventsOfType(r.events, 'merchant_caravan_dispatched');

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.ownerActor).toBe(familyId);
      expect(seller.stockpile.get(resourceId('livestock.equines'))).toBeUndefined();
      expect(seller.treasury).toBeGreaterThan(sellerTreasuryBefore);
      expect(family.stockpile.get(resourceId('livestock.equines'))).toBeUndefined();
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
      family.stockpile.set(resourceId('livestock.equines'), 50);
      family.stockpile.set(resourceId('goods.cart'), 10);
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
      seller.stockpile.set(grain, 100);
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
      expect(seller.stockpile.get(grain)).toBeLessThan(100);
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

  describe('demographics phase', () => {
    it('runs population dynamics each day (births / deaths drift over many ticks)', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 5000 },
        grainModii: 1_000_000, // ample food so famine isn't a confound
      });
      const settlementId1 = settlementId('settle-1');
      const startTotal = w.settlements.get(settlementId1)?.population.total() ?? 0;
      let world = w;
      // 120 days at 5000 people: at ~1.2% adult mortality / year that's
      // 5000 * 0.012 * 120/365 ≈ 20 deaths plus births. Reliably non-zero
      // drift even with zero RNG variance.
      for (let d = 0; d < 120; d++) {
        const r = tick({ world, rng: createRng(`demo-${d}`) });
        world = r.world;
      }
      const endTotal = world.settlements.get(settlementId1)?.population.total() ?? 0;
      expect(endTotal).not.toBe(startTotal);
    });
  });

  describe('annual tick', () => {
    it('does not age the pyramid on off-cycle days', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 100 },
        grainModii: 100000,
      });
      const sid = settlementId('settle-1');
      const startBand = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      // Tick a single day (day 0 → 1). No yearly tick should fire.
      tick({ world: w, rng: createRng('ann-off') });
      const after = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      // The 20-24 band should still hold ~100 (deaths are rare on a single day).
      // Tolerance: at most a couple of statistical deaths.
      expect(Math.abs(after - startBand)).toBeLessThan(5);
    });

    it('shifts cohorts into the next age band on a year boundary', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1000 },
        grainModii: 1_000_000,
      });
      const sid = settlementId('settle-1');
      // Start the world at day 364 so the next tick crosses into day 365 and
      // triggers the yearly aging.
      w.day = 364;
      const before20 = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      const before25 = w.settlements.get(sid)?.population.totalByAgeBand('25-29') ?? 0;
      tick({ world: w, rng: createRng('ann-cross') });
      const after20 = w.settlements.get(sid)?.population.totalByAgeBand('20-24') ?? 0;
      const after25 = w.settlements.get(sid)?.population.totalByAgeBand('25-29') ?? 0;
      // The 20-24 band should have drained (people moved to 25-29) and the
      // 25-29 band should have grown.
      expect(after20).toBeLessThan(before20);
      expect(after25).toBeGreaterThan(before25);
    });
  });

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

  describe('integration smoke', () => {
    it('a procgen-seeded small world ticks 30 days without throwing', async () => {
      const { generateTerrain } = await import('../procgen/terrain.js');
      const { siteSettlements } = await import('../procgen/settlements.js');
      const { seedWorld } = await import('../procgen/seed.js');
      const grid = generateTerrain({
        seed: 'tick-smoke',
        widthHexes: 24,
        heightHexes: 24,
        oceanCoveragePct: 5,
        mountainsCoveragePct: 10,
      });
      const sites = siteSettlements({
        seed: 'tick-smoke-sites',
        grid,
        cityCount: 1,
        townCount: 2,
        villageCount: 4,
        hamletCount: 4,
      });
      let world = seedWorld({ seed: 'tick-smoke-world', grid, settlementSites: sites });
      const allEvents: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`smoke-${d}`) });
        allEvents.push(...r.events);
        world = r.world;
      }
      expect(world.day).toBe(30);
      // Sanity: at least some events should have fired across 30 days in a
      // populated world (markets clearing, demographics ticking).
      expect(allEvents.length).toBeGreaterThan(0);
    });
  });

  describe('reputation phase', () => {
    it('decays existing reputation entries every tick', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const a = actorId('actor-A');
      const b = actorId('actor-B');
      w.reputation.set(a, b, 0.5);
      const before = w.reputation.get(a, b);
      // Tick many days so the half-life decay is observable.
      let world = w;
      for (let d = 0; d < 60; d++) {
        const r = tick({ world, rng: createRng(`rep-${d}`) });
        world = r.world;
      }
      const after = world.reputation.get(a, b);
      expect(Math.abs(after)).toBeLessThan(Math.abs(before));
    });
  });

  describe('worker reallocation by demand (docs/04 §"Worker reallocation")', () => {
    it('moves workers from over-supplied roles to roles whose recipes are blocked by labor', async () => {
      // Setup: a town with a mill (needs millers) but every adult is
      // procgen-allocated as a 'farmer'. The mill_grain recipe will block on
      // labor every day (no millers). After ~30 days the monthly hook should
      // shift some workers off farmer onto miller.
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        addMill: true,
        flourSacks: 0,
        // Give the city actor some grain so the mill has inputs and only
        // labor is the bottleneck.
        grainModii: 200,
      });
      const sId = settlementId('settle-1');
      const settle = w.settlements.get(sId);
      if (settle === undefined) throw new Error('expected fixture settlement');
      // Simulate procgen having put everyone on the farmer role (no millers).
      const { jobId } = await import('./types.js');
      settle.jobAllocations.set(jobId('farmer'), 200);

      // Drive 30 days; the politicsPhase reallocation hook fires when
      // (today + 1) % 30 === 0 — i.e. after day=29 ticks (today=29 → +1 = 30).
      let world: WorldState = w;
      let collected: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`worker-${d}`) });
        collected = collected.concat(r.events);
        world = r.world;
      }

      const moves = eventsOfType(collected, 'workers_reallocated');
      expect(moves.length).toBeGreaterThanOrEqual(1);
      const lastMove = moves[moves.length - 1];
      expect(lastMove?.toJob).toBe(jobId('miller'));
      expect(lastMove?.fromJob).toBe(jobId('farmer'));
      expect(lastMove?.count).toBeGreaterThan(0);
      // Allocation should have shifted: some millers now exist.
      const refreshed = world.settlements.get(sId);
      expect(refreshed?.jobAllocations.get(jobId('miller'))).toBeGreaterThan(0);
      expect(refreshed?.jobAllocations.get(jobId('farmer'))).toBeLessThan(200);
    });

    it('splits monthly worker moves across multiple labor bottlenecks', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        addMill: true,
        addBakery: true,
        grainModii: 2000,
        flourSacks: 2000,
        woodCords: 2000,
      });
      const sId = settlementId('settle-1');
      const settle = w.settlements.get(sId);
      if (settle === undefined) throw new Error('expected fixture settlement');
      settle.jobAllocations.clear();
      settle.jobAllocations.set(jobId('farmer'), 200);

      let world: WorldState = w;
      let collected: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`worker-split-${d}`) });
        collected = collected.concat(r.events);
        world = r.world;
      }

      const moves = eventsOfType(collected, 'workers_reallocated');
      expect(moves.some((m) => m.toJob === jobId('miller'))).toBe(true);
      expect(moves.some((m) => m.toJob === jobId('baker'))).toBe(true);
      const refreshed = world.settlements.get(sId);
      expect(refreshed?.jobAllocations.get(jobId('miller'))).toBeGreaterThan(0);
      expect(refreshed?.jobAllocations.get(jobId('baker'))).toBeGreaterThan(0);
      expect(refreshed?.jobAllocations.get(jobId('farmer'))).toBeLessThan(200);
    });

    it('emits no workers_reallocated event when no recipes are blocked by labor', async () => {
      // Settlement with no buildings → no recipes can run → no labor blocks.
      // The reallocation phase has nothing to do.
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const sId = settlementId('settle-1');
      const settle = w.settlements.get(sId);
      if (settle === undefined) throw new Error('expected fixture settlement');
      const { jobId } = await import('./types.js');
      // Allocate everyone to idle so production can't fire.
      settle.jobAllocations.set(jobId('idle'), 100);

      let world: WorldState = w;
      let collected: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`worker-noop-${d}`) });
        collected = collected.concat(r.events);
        world = r.world;
      }

      const moves = eventsOfType(collected, 'workers_reallocated');
      expect(moves.length).toBe(0);
    });
  });

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
      settlement.buildings.push({
        buildingId: buildingId('bloomery'),
        hex: anchor,
        ownerActor: ownerId,
        capacity: 100,
        daysSinceMaintained: 0,
      });
      for (let i = 0; i < 6; i++) {
        settlement.buildings.push({
          buildingId: buildingId('quarry'),
          hex: spareHex,
          ownerActor: ownerId,
          capacity: 3,
          daysSinceMaintained: 0,
        });
      }
      settlement.market.lastClearingPrice.set(resourceId('mineral.iron_ore'), 5_000);
      settlement.market.lastClearingPrice.set(resourceId('food.grain'), 1);
      settlement.market.lastClearingPrice.set(resourceId('food.legumes'), 1);
      settlement.market.lastClearingPrice.set(resourceId('goods.tools'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.lumber'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.cut_stone'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.brick_tile'), 1);
      settlement.market.lastClearingPrice.set(resourceId('material.charcoal'), 1);
      settlement.market.lastClearingPrice.set(resourceId('metal.iron'), 480);

      const owner = createActor({
        id: ownerId,
        kind: 'city_corporation',
        name: 'Mine Investor',
        homeSettlement: sId,
        treasury: 100_000,
      });
      owner.stockpile.set(resourceId('material.lumber'), 100);
      owner.stockpile.set(resourceId('material.cut_stone'), 100);
      owner.stockpile.set(resourceId('material.brick_tile'), 100);
      owner.stockpile.set(resourceId('goods.tools'), 100);
      owner.stockpile.set(resourceId('material.charcoal'), 100);
      owner.stockpile.set(resourceId('food.grain'), 100);
      owner.stockpile.set(resourceId('food.legumes'), 100);

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
      caravan.cargo.set(resourceId('food.grain'), 12);
      w.caravans.set(cId, caravan);

      tick({ world: w, rng: createRng('tax-deliver') });

      expect(w.caravans.has(cId)).toBe(false);
      expect(governor.stockpile.get(resourceId('food.grain'))).toBeGreaterThan(11.9);
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
        owner.stockpile.set(resourceId('food.grain'), 1_000);
        w.settlements.set(sId, s);
        w.actors.set(ownerId, owner);
      }

      w.day = 273;
      const first = tick({ world: w, rng: createRng('tax-burst-1') });
      const firstShipments = eventsOfType(first.events, 'tax_shipment_dispatched');
      // Dispatch is paced by convoy, not by raw assessment. The first
      // harvest day should release two district convoys, each carrying up
      // to eight same-resource assessments, instead of one caravan per
      // owner.
      expect(firstShipments.length).toBe(2);
      expect(firstShipments.reduce((sum, e) => sum + e.grainModii, 0)).toBe(1_600);

      // Across multiple ticks the queued assessment cargo should flush
      // without requiring one caravan per assessment.
      let totalConvoys = firstShipments.length;
      let totalGrain = firstShipments.reduce((sum, e) => sum + e.grainModii, 0);
      for (let k = 0; k < 10 && totalGrain < 2_000; k++) {
        const r = tick({ world: w, rng: createRng(`tax-burst-${k + 2}`) });
        const shipments = eventsOfType(r.events, 'tax_shipment_dispatched');
        totalConvoys += shipments.length;
        totalGrain += shipments.reduce((sum, e) => sum + e.grainModii, 0);
      }
      expect(totalGrain).toBe(2_000);
      expect(totalConvoys).toBe(3);
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
        owner.stockpile.set(resourceId('food.grain'), 1_000);
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
});
