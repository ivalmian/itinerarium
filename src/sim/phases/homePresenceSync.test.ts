import { describe, expect, it } from 'vitest';
import { actorId, resourceId, settlementId, type Day } from '../types.js';
import { type WorldState } from '../../procgen/seed.js';
import { createActor } from '../politics/actor.js';
import { getResourceQuote } from '../politics/knownPrices.js';
import { createSettlement, recordClearingPrice } from '../world/settlement.js';
import { hex } from '../world/hex.js';
import { createGrid } from '../world/grid.js';
import { homePresenceSyncPhase } from './homePresenceSync.js';
import { createReputationTable } from '../reputation/table.js';

const emptyWorld = (): WorldState => ({
  day: 0 as Day,
  grid: createGrid(10, 10),
  settlements: new Map(),
  actors: new Map(),
  factions: new Map(),
  characters: new Map(),
  caravans: new Map(),
  patrols: new Map(),
  banditCamps: new Map(),
  banditParties: new Map(),
  newsCarriers: new Map(),
  guilds: new Map(),
  persons: new Map(),
  personEquipment: new Map(),
  reputation: createReputationTable(),
  bySite: [],
});

const setupCityWithResident = (kind: Parameters<typeof createActor>[0]['kind']) => {
  const world = emptyWorld();
  const sId = settlementId('city-x');
  const s = createSettlement({
    id: sId,
    tier: 'large_city',
    name: 'City X',
    anchor: hex(0, 0),
    urbanHexes: [hex(0, 0)],
    catchmentHexes: [],
  });
  world.settlements.set(sId, s);
  const a = createActor({
    id: actorId('a'),
    kind,
    name: 'Resident',
    homeSettlement: sId,
  });
  world.actors.set(a.id, a);
  return { world, settlement: s, actor: a };
};

describe('homePresenceSyncPhase', () => {
  it("records every resident's home market observation after the market clears", () => {
    const { world, settlement, actor } = setupCityWithResident('patrician_family');
    const grain = resourceId('grain');
    recordClearingPrice(settlement, grain, 7);
    homePresenceSyncPhase(world, 5 as Day);
    const got = getResourceQuote(actor, settlement.id, grain, 5 as Day);
    expect(got).toBeDefined();
    expect(got?.bestAsk).toBeGreaterThan(0);
  });

  it('overwrites a stale resident observation with the current-day snapshot', () => {
    const { world, settlement, actor } = setupCityWithResident('free_village');
    const grain = resourceId('grain');
    recordClearingPrice(settlement, grain, 5);
    homePresenceSyncPhase(world, 0 as Day);
    expect(getResourceQuote(actor, settlement.id, grain, 0 as Day)?.bestAsk).toBe(5);
    // price moves on day 30
    recordClearingPrice(settlement, grain, 9);
    homePresenceSyncPhase(world, 30 as Day);
    expect(getResourceQuote(actor, settlement.id, grain, 30 as Day)?.bestAsk).toBe(9);
  });

  it('does NOT sync non-resident actor kinds (bandit_camp, caravan_owner)', () => {
    const { world, settlement, actor } = setupCityWithResident('bandit_camp');
    const grain = resourceId('grain');
    recordClearingPrice(settlement, grain, 7);
    homePresenceSyncPhase(world, 5 as Day);
    expect(getResourceQuote(actor, settlement.id, grain, 5 as Day)).toBeUndefined();
  });

  it('records all three class household kinds', () => {
    for (const kind of ['plebeian_household', 'freedman_household', 'foreigner_household'] as const) {
      const { world, settlement, actor } = setupCityWithResident(kind);
      const grain = resourceId('grain');
      recordClearingPrice(settlement, grain, 7);
      homePresenceSyncPhase(world, 5 as Day);
      expect(
        getResourceQuote(actor, settlement.id, grain, 5 as Day),
        `expected ${kind} to record its home observation`,
      ).toBeDefined();
    }
  });

  it('skips actors with no homeSettlement', () => {
    const world = emptyWorld();
    const a = createActor({ id: actorId('off'), kind: 'off_map_house', name: 'Off' });
    world.actors.set(a.id, a);
    homePresenceSyncPhase(world, 5 as Day);
    expect(a.knownPrices.size).toBe(0);
  });

  it('writes nothing when the home market has no clearings yet', () => {
    const { world, actor } = setupCityWithResident('city_corporation');
    homePresenceSyncPhase(world, 0 as Day);
    expect(actor.knownPrices.size).toBe(0);
  });
});

