import { describe, expect, it } from 'vitest';
import { createActor } from '../politics/actor.js';
import { getResourceQuote } from '../politics/knownPrices.js';
import { createReputationTable } from '../reputation/table.js';
import { createCityCrier } from '../reputation/cityCrier.js';
import { createGrid } from '../world/grid.js';
import { hex } from '../world/hex.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import type { HexTile, Season } from '../world/terrain.js';
import {
  actorId,
  resourceId,
  settlementId,
  type ActorId,
  type Day,
} from '../types.js';
import type { Actor } from '../politics/actor.js';
import type { WorldState } from '../../procgen/seed.js';
import { cityCrierPhase, greedyCityCrierRoute } from './cityCrier.js';
import type { TickEvent } from '../tick.js';

const tile = (): HexTile => ({
  terrain: 'plains',
  climate: 'mediterranean',
  elevation: 10,
  hasRiver: false,
  road: 'roman',
  ownerActor: null,
});

const emptyWorld = (): WorldState => {
  const grid = createGrid();
  for (let q = -5; q <= 12; q++) {
    for (let r = -2; r <= 2; r++) {
      grid.set(hex(q, r), tile());
    }
  }
  return {
    day: 0,
    grid,
    settlements: new Map(),
    actors: new Map(),
    factions: new Map(),
    characters: new Map(),
    caravans: new Map(),
    cityCriers: new Map(),
    reputation: createReputationTable(),
    bySite: [],
  };
};

const addSettlement = (
  world: WorldState,
  id: string,
  tier: Settlement['tier'],
  q: number,
  r: number,
): Settlement => {
  const anchor = hex(q, r);
  world.grid.set(anchor, tile());
  const settlement = createSettlement({
    id: settlementId(id),
    tier,
    name: id,
    anchor,
    urbanHexes: [anchor],
    catchmentHexes: [],
  });
  world.settlements.set(settlement.id, settlement);
  return settlement;
};

const addPatrician = (
  world: WorldState,
  city: Settlement,
  id: string,
  treasury = 100,
): Actor => {
  const actor = createActor({
    id: actorId(id),
    kind: 'patrician_family',
    name: id,
    homeSettlement: city.id,
    treasury,
  });
  world.actors.set(actor.id, actor);
  city.stockpileOwners.push(actor.id);
  return actor;
};

const addRuralOwner = (
  world: WorldState,
  settlement: Settlement,
  id: string,
  kind: 'free_village' | 'hamlet_household' = 'free_village',
): Actor => {
  const actor = createActor({
    id: actorId(id),
    kind,
    name: id,
    homeSettlement: settlement.id,
    treasury: 20,
  });
  world.actors.set(actor.id, actor);
  settlement.stockpileOwners.push(actor.id);
  return actor;
};

const setPrice = (settlement: Settlement, resource: string, price: number): void => {
  settlement.market.lastClearingPrice.set(resourceId(resource), price);
};

const runCrier = (
  world: WorldState,
  day: number,
  events: TickEvent[] = [],
  season: Season = 'spring',
): TickEvent[] => {
  cityCrierPhase(world, season, day as Day, events);
  return events;
};

describe('cityCrierPhase', () => {
  it('builds a deterministic greedy route through tied rural stops', () => {
    const world = emptyWorld();
    const city = addSettlement(world, 'city-a', 'large_city', 0, 0);
    addPatrician(world, city, 'pat-a');
    const far = addSettlement(world, 'v-far', 'village', 7, 0);
    const near = addSettlement(world, 'v-near', 'village', 1, 0);
    const mid = addSettlement(world, 'v-mid', 'hamlet', 3, 0);
    addRuralOwner(world, far, 'far-owner');
    addRuralOwner(world, near, 'near-owner');
    addRuralOwner(world, mid, 'mid-owner', 'hamlet_household');

    expect(greedyCityCrierRoute(world, city)).toEqual([
      city.id,
      near.id,
      mid.id,
      far.id,
    ]);
  });

  it('uses client patronage before nearest-city fallback when tying villages to cities', () => {
    const world = emptyWorld();
    const patronCity = addSettlement(world, 'city-patron', 'large_city', 0, 0);
    const nearbyCity = addSettlement(world, 'city-near', 'large_city', 10, 0);
    const patron = addPatrician(world, patronCity, 'patron');
    addPatrician(world, nearbyCity, 'near-patrician');
    const client = addSettlement(world, 'client', 'village', 9, 0);
    client.clientPatron = patron.id;
    addRuralOwner(world, client, 'client-owner');

    expect(greedyCityCrierRoute(world, patronCity)).toEqual([patronCity.id, client.id]);
    expect(greedyCityCrierRoute(world, nearbyCity)).toEqual([nearbyCity.id]);
  });

  it('spreads city prices to villages, then village prices back to city after the return leg', () => {
    const world = emptyWorld();
    const city = addSettlement(world, 'city', 'large_city', 0, 0);
    const village = addSettlement(world, 'village', 'village', 2, 0);
    const patrician = addPatrician(world, city, 'patrician', 100);
    const villageOwner = addRuralOwner(world, village, 'village-owner');
    setPrice(city, 'food.grain', 9);
    setPrice(village, 'goods.tools', 22);

    runCrier(world, 0);

    expect(getResourceQuote(villageOwner, city.id, resourceId('food.grain'), 0 as Day)).toEqual({
      bestAsk: 9,
      bestBid: 9,
    });
    expect(getResourceQuote(patrician, village.id, resourceId('goods.tools'), 0 as Day)).toBe(
      undefined,
    );

    runCrier(world, 1);

    expect(getResourceQuote(patrician, village.id, resourceId('goods.tools'), 1 as Day)).toEqual({
      bestAsk: 22,
      bestBid: 22,
    });
  });

  it('replaces a city crier that has not checked back into the city for over a month', () => {
    const world = emptyWorld();
    const city = addSettlement(world, 'city', 'large_city', 0, 0);
    const village = addSettlement(world, 'village', 'village', 2, 0);
    addPatrician(world, city, 'patrician', 100);
    addRuralOwner(world, village, 'village-owner');
    const old = createCityCrier({
      id: 'old-crier',
      city: city.id,
      route: [city.id, village.id],
      spawnHex: village.anchor,
      destination: city.anchor,
      spawnDay: 0 as Day,
      paidBy: [actorId('patrician') as ActorId],
    });
    (world.cityCriers as Map<string, typeof old>).set(old.id, {
      ...old,
      lastCityCheckinDay: 0 as Day,
    });
    const events = runCrier(world, 31);

    expect(world.cityCriers?.has('old-crier')).toBe(false);
    const replacement = [...(world.cityCriers?.values() ?? [])][0];
    expect(replacement?.city).toBe(city.id);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'city_crier_spawned',
        city: city.id,
        reason: 'missing',
      }),
    );
  });

  it('does not create a free crier when city patricians cannot fund one', () => {
    const world = emptyWorld();
    const city = addSettlement(world, 'city', 'large_city', 0, 0);
    const village = addSettlement(world, 'village', 'village', 2, 0);
    addPatrician(world, city, 'broke-patrician', 0);
    addRuralOwner(world, village, 'village-owner');

    runCrier(world, 0);

    expect(world.cityCriers?.size).toBe(0);
  });
});
