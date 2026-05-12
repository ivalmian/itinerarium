import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hex, hexKey } from './world/hex.js';
import { createGrid } from './world/grid.js';
import type { HexTile } from './world/terrain.js';
import { createSettlement } from './world/settlement.js';
import { createActor } from './politics/actor.js';
import { createFaction } from './politics/faction.js';
import { createCharacter } from './politics/character.js';
import { createCaravan } from './caravan/caravan.js';
import { createReputationTable } from './reputation/table.js';
import { generateTerrain } from '../procgen/terrain.js';
import { siteSettlements } from '../procgen/settlements.js';
import { seedWorld } from '../procgen/seed.js';
import { actorId, caravanId, characterId, factionId, resourceId, settlementId } from './types.js';
import type { WorldState } from '../procgen/seed.js';
import {
  deserializeWorld,
  readSnapshot,
  serializeWorld,
  writeSnapshot,
  type WorldSnapshot,
} from './snapshot.js';

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 0,
  hasRiver: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

const buildTinyWorld = (): WorldState => {
  const grid = createGrid();
  grid.set(hex(0, 0), tile({ terrain: 'plains' }));
  grid.set(hex(1, 0), tile({ terrain: 'forest' }));
  grid.set(hex(0, 1), tile({ terrain: 'mountains' }));

  const settlement = createSettlement({
    id: settlementId('s.tiny'),
    tier: 'village',
    name: 'Pagus Test',
    anchor: hex(0, 0),
    urbanHexes: [hex(0, 0)],
    catchmentHexes: [hex(1, 0)],
  });
  settlement.population.set({ age: '20-24', sex: 'female', class: 'plebeian' }, 12);
  settlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 11);
  settlement.market.recentInflows.set(resourceId('food.grain'), 50);
  settlement.market.lastClearingPrice.set(resourceId('food.grain'), 4.5);
  settlement.market.bestBid.set(resourceId('food.grain'), 4.25);
  settlement.market.bidDepth.set(resourceId('food.grain'), 12);
  settlement.market.bestAsk.set(resourceId('food.grain'), 4.75);
  settlement.market.askDepth.set(resourceId('food.grain'), 20);
  settlement.market.midPrice.set(resourceId('food.grain'), 4.5);
  settlement.market.spread.set(resourceId('food.grain'), 0.5);
  settlement.market.lastClearedDay.set(resourceId('food.grain'), 6);
  settlement.market.bookLadder.set(resourceId('food.grain'), {
    asks: [
      {
        actorId: actorId('a.headman'),
        actorKind: 'free_village',
        price: 4.75,
        quantity: 20,
      },
    ],
    bids: [
      {
        actorId: actorId('a.headman'),
        actorKind: 'free_village',
        price: 4.25,
        quantity: 12,
        curve: 'derived',
        buyerDisposition: 'stockpile',
      },
    ],
  });
  settlement.market.lastBookSampleDay.set(resourceId('food.grain'), 7);

  const actor = createActor({
    id: actorId('a.headman'),
    kind: 'free_village',
    name: 'Free Village of Test',
    homeSettlement: settlement.id,
    treasury: 200,
  });
  actor.stockpile.set(resourceId('food.grain'), 100);
  actor.stockpile.set(resourceId('goods.tools'), 4);

  const faction = createFaction({
    id: factionId('f.headman'),
    actor: actor.id,
    name: 'Council',
    members: [characterId('c.elder')],
  });

  const character = createCharacter({
    id: characterId('c.elder'),
    name: 'Marcus Elder',
    age: 55,
    sex: 'male',
    class: 'plebeian',
    faction: faction.id,
    role: 'elder',
    location: hex(0, 0),
  });

  const caravan = createCaravan({
    id: caravanId('cv.test'),
    ownerActor: actor.id,
    position: hex(0, 0),
    crew: [{ kind: 'merchant', count: 2, weapons: 0.1, armor: 0 }],
    animals: { mule: 4 },
    vehicles: { pack_saddle: 4 },
    treasury: 50,
  });
  caravan.cargo.set(resourceId('food.grain'), 30);
  caravan.priceBook.set(
    resourceId('food.grain'),
    new Map([
      [
        hexKey(hex(0, 0)),
        {
          price: 4.5,
          bidPrice: 4.25,
          askPrice: 4.75,
          bidDepth: 12,
          askDepth: 20,
          observedOnDay: 1,
        },
      ],
    ]),
  );

  const reputation = createReputationTable();
  reputation.set(character.id, actor.id, 0.5);
  reputation.set(actor.id, character.id, 0.4);

  return {
    day: 7,
    grid,
    settlements: new Map([[settlement.id, settlement]]),
    actors: new Map([[actor.id, actor]]),
    factions: new Map([[faction.id, faction]]),
    characters: new Map([[character.id, character]]),
    caravans: new Map([[caravan.id, caravan]]),
    reputation,
    bySite: [],
  };
};

describe('serializeWorld → JSON-friendly snapshot', () => {
  it('produces a JSON-serializable object (no functions, no cycles, no Maps)', () => {
    const w = buildTinyWorld();
    const snap = serializeWorld(w, w.day);
    const json = JSON.stringify(snap);
    expect(json.length).toBeGreaterThan(0);
    // Round-trip through JSON to ensure nothing is unserializable.
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toEqual(snap);
  });

  it('records schemaVersion=1 and capturedAtDay', () => {
    const w = buildTinyWorld();
    const snap = serializeWorld(w, 99);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.capturedAtDay).toBe(99);
    expect(snap.world.day).toBe(7);
  });

  it('serializes only set hexes (sparse representation)', () => {
    const w = buildTinyWorld();
    const snap = serializeWorld(w, 0);
    expect(snap.world.gridTiles.length).toBe(3);
    const keys = snap.world.gridTiles.map(([k]) => k).sort();
    expect(keys).toEqual([hexKey(hex(0, 0)), hexKey(hex(0, 1)), hexKey(hex(1, 0))].sort());
  });

  it('serializes settlement market/population maps as arrays', () => {
    const w = buildTinyWorld();
    const snap = serializeWorld(w, 0);
    const first = snap.world.settlements[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [, settlement] = first;
    expect(Array.isArray(settlement.population)).toBe(true);
  });

  it('serializes reputation as sparse triples (only non-zero entries)', () => {
    const w = buildTinyWorld();
    const snap = serializeWorld(w, 0);
    expect(snap.world.reputation.length).toBe(2);
    for (const r of snap.world.reputation) {
      expect(typeof r.holder).toBe('string');
      expect(typeof r.subject).toBe('string');
      expect(r.value).not.toBe(0);
    }
  });

  it('omits zero-population cohorts (sparse pyramid)', () => {
    const w = buildTinyWorld();
    const snap = serializeWorld(w, 0);
    const first = snap.world.settlements[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const [, s] = first;
    for (const [, count] of s.population) {
      expect(count).toBeGreaterThan(0);
    }
  });
});

describe('deserializeWorld → round-trip', () => {
  it('round-trips a tiny hand-built world', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, original.day);
    const restored = deserializeWorld(snap);

    expect(restored.day).toBe(original.day);
    expect(restored.grid.size()).toBe(original.grid.size());
    for (const [h, t] of original.grid.tiles()) {
      const got = restored.grid.get(h);
      expect(got).toBeDefined();
      expect(got?.terrain).toBe(t.terrain);
      expect(got?.climate).toBe(t.climate);
      expect(got?.elevation).toBe(t.elevation);
      expect(got?.hasRiver).toBe(t.hasRiver);
      expect(got?.road).toBe(t.road);
      expect(got?.ownerActor).toBe(t.ownerActor);
    }
    expect(restored.settlements.size).toBe(original.settlements.size);
    expect(restored.actors.size).toBe(original.actors.size);
    expect(restored.factions.size).toBe(original.factions.size);
    expect(restored.characters.size).toBe(original.characters.size);
    expect(restored.caravans.size).toBe(original.caravans.size);
  });

  it('preserves settlement.population cohorts and totals', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const restored = deserializeWorld(snap);
    const sId = settlementId('s.tiny');
    const origS = original.settlements.get(sId);
    const restS = restored.settlements.get(sId);
    expect(restS).toBeDefined();
    if (restS === undefined || origS === undefined) return;
    expect(restS.population.total()).toBe(origS.population.total());
    expect(restS.population.count({ age: '20-24', sex: 'female', class: 'plebeian' })).toBe(12);
  });

  it('preserves settlement.market maps', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const restored = deserializeWorld(snap);
    const restS = restored.settlements.get(settlementId('s.tiny'));
    expect(restS).toBeDefined();
    if (restS === undefined) return;
    expect(restS.market.recentInflows.get(resourceId('food.grain'))).toBe(50);
    expect(restS.market.lastClearingPrice.get(resourceId('food.grain'))).toBe(4.5);
    expect(restS.market.bestBid.get(resourceId('food.grain'))).toBe(4.25);
    expect(restS.market.bestAsk.get(resourceId('food.grain'))).toBe(4.75);
    expect(restS.market.bidDepth.get(resourceId('food.grain'))).toBe(12);
    expect(restS.market.askDepth.get(resourceId('food.grain'))).toBe(20);
    expect(restS.market.bookLadder.get(resourceId('food.grain'))?.bids[0]?.buyerDisposition).toBe(
      'stockpile',
    );
    expect(restS.market.lastBookSampleDay.get(resourceId('food.grain'))).toBe(7);
  });

  it('preserves actor stockpile and treasury', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const restored = deserializeWorld(snap);
    const restA = restored.actors.get(actorId('a.headman'));
    expect(restA).toBeDefined();
    if (restA === undefined) return;
    expect(restA.treasury).toBe(200);
    expect(restA.stockpile.get(resourceId('food.grain'))).toBe(100);
    expect(restA.stockpile.get(resourceId('goods.tools'))).toBe(4);
  });

  it('preserves caravan cargo and priceBook nested maps', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const restored = deserializeWorld(snap);
    const restC = restored.caravans.get(caravanId('cv.test'));
    expect(restC).toBeDefined();
    if (restC === undefined) return;
    expect(restC.cargo.get(resourceId('food.grain'))).toBe(30);
    const pb = restC.priceBook.get(resourceId('food.grain'));
    expect(pb).toBeDefined();
    expect(pb?.get(hexKey(hex(0, 0)))?.price).toBe(4.5);
    expect(pb?.get(hexKey(hex(0, 0)))?.bidPrice).toBe(4.25);
    expect(pb?.get(hexKey(hex(0, 0)))?.askPrice).toBe(4.75);
    expect(pb?.get(hexKey(hex(0, 0)))?.bidDepth).toBe(12);
    expect(pb?.get(hexKey(hex(0, 0)))?.askDepth).toBe(20);
    expect(pb?.get(hexKey(hex(0, 0)))?.observedOnDay).toBe(1);
  });

  it('preserves reputation pairs and values', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const restored = deserializeWorld(snap);
    expect(restored.reputation.get(characterId('c.elder'), actorId('a.headman'))).toBe(0.5);
    expect(restored.reputation.get(actorId('a.headman'), characterId('c.elder'))).toBe(0.4);
  });

  it('preserves named character location and traits', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const restored = deserializeWorld(snap);
    const c = restored.characters.get(characterId('c.elder'));
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(c.name).toBe('Marcus Elder');
    expect(c.age).toBe(55);
    expect(c.location.q).toBe(0);
    expect(c.location.r).toBe(0);
    expect(c.role).toBe('elder');
  });

  it('round-trips through JSON.stringify/JSON.parse', () => {
    const original = buildTinyWorld();
    const snap = serializeWorld(original, 0);
    const blob = JSON.stringify(snap);
    const parsed = JSON.parse(blob) as WorldSnapshot;
    const restored = deserializeWorld(parsed);
    expect(restored.actors.get(actorId('a.headman'))?.treasury).toBe(200);
    expect(restored.settlements.get(settlementId('s.tiny'))?.population.total()).toBe(23);
  });
});

describe('round-trip a full procgen-seeded world', () => {
  it('preserves the headline counts and a few specific fields', () => {
    const grid = generateTerrain({
      seed: 'snap-rt',
      widthHexes: 30,
      heightHexes: 30,
      mountainsCoveragePct: 10,
      oceanCoveragePct: 5,
    });
    const sites = siteSettlements({
      seed: 'snap-sites',
      grid,
      cityCount: 2,
      townCount: 3,
      villageCount: 8,
      hamletCount: 5,
    });
    const original = seedWorld({ seed: 'snap-seed', grid, settlementSites: sites });
    const snap = serializeWorld(original, original.day);
    const restored = deserializeWorld(snap);
    expect(restored.grid.size()).toBe(original.grid.size());
    expect(restored.settlements.size).toBe(original.settlements.size);
    expect(restored.actors.size).toBe(original.actors.size);
    expect(restored.factions.size).toBe(original.factions.size);
    expect(restored.characters.size).toBe(original.characters.size);
    let totalPopOrig = 0;
    let totalPopRest = 0;
    for (const s of original.settlements.values()) totalPopOrig += s.population.total();
    for (const s of restored.settlements.values()) totalPopRest += s.population.total();
    expect(totalPopRest).toBe(totalPopOrig);
  });
});

describe('writeSnapshot / readSnapshot', () => {
  it('writes and reads back a snapshot from disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ecogame-snap-'));
    try {
      const w = buildTinyWorld();
      const snap = serializeWorld(w, w.day);
      const path = join(tmp, 'snap.json');
      await writeSnapshot(snap, path);
      const back = await readSnapshot(path);
      expect(back.schemaVersion).toBe(1);
      expect(back.capturedAtDay).toBe(w.day);
      expect(back.world.gridTiles.length).toBe(snap.world.gridTiles.length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('readSnapshot rejects files with the wrong schema version', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ecogame-snap-'));
    try {
      const path = join(tmp, 'bad.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, JSON.stringify({ schemaVersion: 99, capturedAtDay: 0, world: {} }));
      await expect(readSnapshot(path)).rejects.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('performance smoke', () => {
  it('serializes a 100×100 grid world in under 500ms', () => {
    const grid = generateTerrain({
      seed: 'perf-snap',
      widthHexes: 100,
      heightHexes: 100,
      mountainsCoveragePct: 10,
      oceanCoveragePct: 5,
    });
    const sites = siteSettlements({
      seed: 'perf-sites',
      grid,
      cityCount: 3,
      townCount: 8,
      villageCount: 20,
      hamletCount: 10,
    });
    const world = seedWorld({ seed: 'perf-seed', grid, settlementSites: sites });
    const start = Date.now();
    const snap = serializeWorld(world, world.day);
    const elapsed = Date.now() - start;
    expect(snap.world.gridTiles.length).toBe(10000);
    expect(elapsed).toBeLessThan(500);
  });
});
