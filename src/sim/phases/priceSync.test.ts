import { describe, expect, it } from 'vitest';
import { actorId, caravanId, resourceId, settlementId, type Day } from '../types.js';
import { type WorldState } from '../../procgen/seed.js';
import { createActor } from '../politics/actor.js';
import { addGuildMember, createGuild } from '../politics/guild.js';
import { getResourceQuote } from '../politics/knownPrices.js';
import { createSettlement, recordClearingPrice } from '../world/settlement.js';
import { createGrid } from '../world/grid.js';
import { hex } from '../world/hex.js';
import { createReputationTable } from '../reputation/table.js';
import { createCaravan } from '../caravan/caravan.js';
import { homePresenceSyncPhase } from './homePresenceSync.js';
import {
  caravanArrivalSyncPhase,
  caravanMeetingSyncPhase,
  guildLedgerSyncPhase,
} from './priceSync.js';

const emptyWorld = (): WorldState => ({
  day: 0 as Day,
  grid: createGrid(),
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

const seedCity = (world: WorldState, id: string, name: string, anchor: { q: number; r: number }) => {
  const sId = settlementId(id);
  const s = createSettlement({
    id: sId,
    tier: 'large_city',
    name,
    anchor: hex(anchor.q, anchor.r),
    urbanHexes: [hex(anchor.q, anchor.r)],
    catchmentHexes: [],
  });
  world.settlements.set(sId, s);
  return s;
};

const seedCaravan = (
  world: WorldState,
  id: string,
  owner: ReturnType<typeof createActor>,
  pos: { q: number; r: number },
) => {
  const c = createCaravan({
    id: caravanId(id),
    ownerActor: owner.id,
    position: hex(pos.q, pos.r),
    crew: [
      { kind: 'merchant', count: 1 },
      { kind: 'drover', count: 1 },
    ],
    animals: { mule: 1 },
    vehicles: {},
  });
  world.caravans.set(c.id, c);
  return c;
};

describe('caravanArrivalSyncPhase', () => {
  it("writes a fresh MarketObservation into the caravan owner's knownPrices on arrival", () => {
    const world = emptyWorld();
    const city = seedCity(world, 'city-x', 'City X', { q: 0, r: 0 });
    const owner = createActor({
      id: actorId('owner'),
      kind: 'patrician_family',
      name: 'Owner',
      homeSettlement: settlementId('home'),
    });
    world.actors.set(owner.id, owner);
    seedCaravan(world, 'car-1', owner, { q: 0, r: 0 });
    const grain = resourceId('grain');
    recordClearingPrice(city, grain, 8);
    caravanArrivalSyncPhase(world, 5 as Day);
    expect(getResourceQuote(owner, city.id, grain, 5 as Day)?.bestAsk).toBe(8);
  });

  it('skips caravans not parked on a settlement anchor', () => {
    const world = emptyWorld();
    seedCity(world, 'city-x', 'City X', { q: 0, r: 0 });
    const owner = createActor({ id: actorId('owner'), kind: 'patrician_family', name: 'Owner' });
    world.actors.set(owner.id, owner);
    seedCaravan(world, 'car-1', owner, { q: 5, r: 5 });
    caravanArrivalSyncPhase(world, 5 as Day);
    expect(owner.knownPrices.size).toBe(0);
  });

  it("does not overwrite a newer same-settlement observation already in the owner's map", () => {
    const world = emptyWorld();
    const city = seedCity(world, 'city-x', 'City X', { q: 0, r: 0 });
    const owner = createActor({ id: actorId('owner'), kind: 'patrician_family', name: 'Owner' });
    world.actors.set(owner.id, owner);
    seedCaravan(world, 'car-1', owner, { q: 0, r: 0 });
    // Pre-seed a newer observation (day 100).
    const grain = resourceId('grain');
    recordClearingPrice(city, grain, 8);
    homePresenceSyncPhase(world, 5 as Day); // day-5 attempt skipped — owner is not a resident here.
    // Owner is a non-resident; arrival sync at day 5 should write day-5 obs.
    caravanArrivalSyncPhase(world, 5 as Day);
    expect(getResourceQuote(owner, city.id, grain, 5 as Day)?.bestAsk).toBe(8);
    // Now a stale-attempt: day-1 sync should NOT overwrite the day-5 obs.
    recordClearingPrice(city, grain, 999);
    caravanArrivalSyncPhase(world, 1 as Day);
    expect(getResourceQuote(owner, city.id, grain, 5 as Day)?.bestAsk).toBe(8);
  });
});

describe('caravanMeetingSyncPhase', () => {
  it('two caravans of different owners on the same hex swap knownPrices', () => {
    const world = emptyWorld();
    const cityA = seedCity(world, 'city-a', 'A', { q: 10, r: 10 });
    const cityB = seedCity(world, 'city-b', 'B', { q: 20, r: 20 });
    const meetHex = { q: 0, r: 0 };
    const ownerA = createActor({ id: actorId('owner-a'), kind: 'patrician_family', name: 'OwnA' });
    const ownerB = createActor({ id: actorId('owner-b'), kind: 'patrician_family', name: 'OwnB' });
    world.actors.set(ownerA.id, ownerA);
    world.actors.set(ownerB.id, ownerB);
    seedCaravan(world, 'car-a', ownerA, meetHex);
    seedCaravan(world, 'car-b', ownerB, meetHex);
    // ownerA has observed cityA's grain; ownerB has observed cityB's wine.
    const grain = resourceId('grain');
    const wine = resourceId('wine');
    recordClearingPrice(cityA, grain, 5);
    recordClearingPrice(cityB, wine, 50);
    // Park a phantom owner-A caravan at cityA, owner-B caravan at cityB to seed.
    seedCaravan(world, 'phantom-a', ownerA, { q: 10, r: 10 });
    seedCaravan(world, 'phantom-b', ownerB, { q: 20, r: 20 });
    caravanArrivalSyncPhase(world, 3 as Day);
    expect(getResourceQuote(ownerA, cityA.id, grain, 3 as Day)).toBeDefined();
    expect(getResourceQuote(ownerB, cityB.id, wine, 3 as Day)).toBeDefined();
    // Meeting at the empty hex syncs knowledge symmetrically.
    caravanMeetingSyncPhase(world);
    expect(getResourceQuote(ownerA, cityB.id, wine, 3 as Day)?.bestAsk).toBe(50);
    expect(getResourceQuote(ownerB, cityA.id, grain, 3 as Day)?.bestAsk).toBe(5);
  });

  it('hostile pair refuses to share', () => {
    const world = emptyWorld();
    const cityA = seedCity(world, 'city-a', 'A', { q: 10, r: 10 });
    const ownerA = createActor({ id: actorId('owner-a'), kind: 'patrician_family', name: 'A' });
    const ownerB = createActor({ id: actorId('owner-b'), kind: 'patrician_family', name: 'B' });
    world.actors.set(ownerA.id, ownerA);
    world.actors.set(ownerB.id, ownerB);
    // OwnerA hates ownerB hard.
    world.reputation.set(ownerA.id, ownerB.id, -0.9);
    const grain = resourceId('grain');
    recordClearingPrice(cityA, grain, 5);
    seedCaravan(world, 'phantom-a', ownerA, { q: 10, r: 10 });
    seedCaravan(world, 'meet-a', ownerA, { q: 0, r: 0 });
    seedCaravan(world, 'meet-b', ownerB, { q: 0, r: 0 });
    caravanArrivalSyncPhase(world, 3 as Day);
    caravanMeetingSyncPhase(world);
    // OwnerB never learns about cityA because ownerA is hostile.
    expect(getResourceQuote(ownerB, cityA.id, grain, 3 as Day)).toBeUndefined();
  });

  it('solitary caravan triggers no sync', () => {
    const world = emptyWorld();
    const owner = createActor({ id: actorId('owner'), kind: 'patrician_family', name: 'X' });
    world.actors.set(owner.id, owner);
    seedCaravan(world, 'car-1', owner, { q: 0, r: 0 });
    // Should not throw.
    expect(() => caravanMeetingSyncPhase(world)).not.toThrow();
  });
});

describe('guildLedgerSyncPhase', () => {
  it('resident guild member co-located at home gets the guild ledger merged into their map', () => {
    const world = emptyWorld();
    const cityG = seedCity(world, 'city-g', 'GuildCity', { q: 0, r: 0 });
    const cityX = seedCity(world, 'city-x', 'CityX', { q: 10, r: 10 });
    const guildActor = createActor({
      id: actorId('guild'),
      kind: 'merchant_guild',
      name: 'Guild',
      homeSettlement: cityG.id,
    });
    world.actors.set(guildActor.id, guildActor);
    const guild = createGuild({
      id: guildActor.id,
      name: guildActor.name,
      homeSettlement: cityG.id,
    });
    const member = createActor({
      id: actorId('member'),
      kind: 'patrician_family',
      name: 'Member',
      homeSettlement: cityG.id,
    });
    world.actors.set(member.id, member);
    addGuildMember(guild, member.id);
    world.guilds!.set(guildActor.id, guild);
    // Seed: the guild has observed cityX (e.g. via a returning caravan).
    const wine = resourceId('wine');
    recordClearingPrice(cityX, wine, 70);
    seedCaravan(world, 'guild-car', guildActor, { q: 10, r: 10 });
    caravanArrivalSyncPhase(world, 3 as Day);
    expect(getResourceQuote(guildActor, cityX.id, wine, 3 as Day)).toBeDefined();
    // The member is resident at the guild's home → guild ledger sync should
    // transfer the cityX wine quote into the member's map.
    guildLedgerSyncPhase(world);
    expect(getResourceQuote(member, cityX.id, wine, 3 as Day)?.bestAsk).toBe(70);
  });

  it('absent (non-resident, no caravan at home) members do not sync', () => {
    const world = emptyWorld();
    const cityG = seedCity(world, 'city-g', 'GuildCity', { q: 0, r: 0 });
    const cityX = seedCity(world, 'city-x', 'CityX', { q: 10, r: 10 });
    const otherCity = seedCity(world, 'other', 'Other', { q: 20, r: 20 });
    const guildActor = createActor({
      id: actorId('guild'),
      kind: 'merchant_guild',
      name: 'Guild',
      homeSettlement: cityG.id,
    });
    world.actors.set(guildActor.id, guildActor);
    const guild = createGuild({
      id: guildActor.id,
      name: guildActor.name,
      homeSettlement: cityG.id,
    });
    // Member lives at a different city, has no caravan at the guild's home.
    const member = createActor({
      id: actorId('member'),
      kind: 'patrician_family',
      name: 'Member',
      homeSettlement: otherCity.id,
    });
    world.actors.set(member.id, member);
    addGuildMember(guild, member.id);
    world.guilds!.set(guildActor.id, guild);
    const wine = resourceId('wine');
    recordClearingPrice(cityX, wine, 70);
    seedCaravan(world, 'guild-car', guildActor, { q: 10, r: 10 });
    caravanArrivalSyncPhase(world, 3 as Day);
    guildLedgerSyncPhase(world);
    expect(getResourceQuote(member, cityX.id, wine, 3 as Day)).toBeUndefined();
  });

  it("non-resident member with a caravan parked at the guild's home gets the merge", () => {
    const world = emptyWorld();
    const cityG = seedCity(world, 'city-g', 'GuildCity', { q: 0, r: 0 });
    const cityX = seedCity(world, 'city-x', 'CityX', { q: 10, r: 10 });
    const otherCity = seedCity(world, 'other', 'Other', { q: 20, r: 20 });
    const guildActor = createActor({
      id: actorId('guild'),
      kind: 'merchant_guild',
      name: 'Guild',
      homeSettlement: cityG.id,
    });
    world.actors.set(guildActor.id, guildActor);
    const guild = createGuild({
      id: guildActor.id,
      name: guildActor.name,
      homeSettlement: cityG.id,
    });
    const member = createActor({
      id: actorId('member'),
      kind: 'patrician_family',
      name: 'Member',
      homeSettlement: otherCity.id,
    });
    world.actors.set(member.id, member);
    addGuildMember(guild, member.id);
    world.guilds!.set(guildActor.id, guild);
    const wine = resourceId('wine');
    recordClearingPrice(cityX, wine, 70);
    seedCaravan(world, 'guild-car', guildActor, { q: 10, r: 10 });
    // Member's caravan parked at the guild's home.
    seedCaravan(world, 'member-car', member, { q: 0, r: 0 });
    caravanArrivalSyncPhase(world, 3 as Day);
    guildLedgerSyncPhase(world);
    expect(getResourceQuote(member, cityX.id, wine, 3 as Day)?.bestAsk).toBe(70);
  });
});
