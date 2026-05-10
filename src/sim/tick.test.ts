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
import {
  actorId,
  buildingId,
  caravanId,
  characterId,
  factionId,
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
  hasCoast: false,
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
  });

  describe('consumption phase', () => {
    it('drains grain when population is fed from stockpile', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 1000 },
        grainModii: 200,
      });
      const before =
        w.actors.get(actorId('city-corp-1'))?.stockpile.get(resourceId('food.grain')) ?? 0;
      tick({ world: w, rng: createRng('cons-1') });
      const after =
        w.actors.get(actorId('city-corp-1'))?.stockpile.get(resourceId('food.grain')) ?? 0;
      expect(after).toBeLessThan(before);
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
});
