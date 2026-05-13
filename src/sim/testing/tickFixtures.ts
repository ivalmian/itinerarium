/**
 * Shared test fixtures for the per-phase tick tests.
 *
 * Most phase test files in `src/sim/phases/<name>.test.ts` use the
 * same handcrafted-world setup that the original monolithic
 * `tick.test.ts` evolved. Lifting these helpers here keeps each
 * phase test file focused on its own behavior while preserving
 * the canonical fixture shape (1-settlement city_corporation with
 * a 3×3 plains patch + named patriarch + reputation table).
 *
 * Tests that need bespoke world shapes — multi-settlement layouts,
 * unusual terrain, edge-of-map fixtures — should still build them
 * inline rather than parameterizing these helpers indefinitely.
 */

import { createGrid } from '../world/grid.js';
import { hex } from '../world/hex.js';
import type { HexTile } from '../world/terrain.js';
import { createSettlement, type Settlement } from '../world/settlement.js';
import {
  addStockAt,
  createActor,
  getStockAt,
  removeStockAt,
  type Actor,
} from '../politics/actor.js';
import type { ResourceId } from '../types.js';
import { createFaction, type Faction } from '../politics/faction.js';
import { createCharacter, type NamedCharacter } from '../politics/character.js';
import { createReputationTable } from '../reputation/table.js';
import type { Caravan } from '../caravan/caravan.js';
import {
  actorId,
  buildingId,
  characterId,
  factionId,
  resourceId,
  settlementId,
  type ActorId,
  type CaravanId,
  type CharacterId,
  type FactionId,
  type SettlementId,
} from '../types.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

// Test helpers: most actors in this file are single-settlement; collapse the
// per-settlement stockpile shape (docs/15 §C30) into a pair of one-line
// helpers keyed by `actor.homeSettlement`. Tests that legitimately want
// multi-settlement inventory call addStockAt/getStockAt directly.
const stockSettlementFor = (a: Actor): SettlementId => {
  if (a.homeSettlement === undefined) {
    throw new Error(
      `test stockpile helper requires actor.homeSettlement (actor ${String(a.id)}, kind=${a.kind})`,
    );
  }
  return a.homeSettlement;
};

export const setStock = (a: Actor, r: ResourceId, q: number): void => {
  const s = stockSettlementFor(a);
  const existing = getStockAt(a, s, r);
  if (existing > 0) removeStockAt(a, s, r, existing);
  if (q > 0) addStockAt(a, s, r, q);
};

export const getStock = (a: Actor, r: ResourceId): number =>
  getStockAt(a, stockSettlementFor(a), r);

export const makeTile = (terrain: HexTile['terrain'] = 'plains'): HexTile => ({
  terrain,
  climate: 'mediterranean',
  elevation: 100,
  hasRiver: false,
  road: 'roman',
  ownerActor: null,
});

export const buildEmptyWorld = (): WorldState => {
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

export interface OneSettlementOpts {
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
export const buildOneSettlementWorld = (opts: OneSettlementOpts = {}): WorldState => {
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
    setStock(cityActor, resourceId('food.grain'), opts.grainModii!);
  }
  if ((opts.flourSacks ?? 0) > 0) {
    setStock(cityActor, resourceId('food.flour'), opts.flourSacks!);
  }
  if ((opts.woodCords ?? 0) > 0) {
    setStock(cityActor, resourceId('material.wood'), opts.woodCords!);
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

export const eventsOfType = <T extends TickEvent['type']>(
  events: readonly TickEvent[],
  type: T,
): readonly Extract<TickEvent, { type: T }>[] => {
  return events.filter((e): e is Extract<TickEvent, { type: T }> => e.type === type);
};
