/**
 * WorldState snapshot serialization.
 *
 * Reference: docs/10 §"Burn-in CLI" — `snapshotEvery: 'never' | 'month' | 'year';
 * outDir: string for snapshots and final report`. The burn-in CLI dumps these
 * periodically so a long stabilization run can be resumed, post-mortemed, or
 * fed into the eventual save/load system.
 *
 * Strategy:
 *   - Every nested `Map<K,V>` becomes `Array<[K,V]>` so JSON.stringify works
 *     and the round-trip is symmetric. Includes Settlement.population (a
 *     PopulationPool wrapping a Map), Settlement.market.{recentInflows,
 *     recentOutflows, lastClearingPrice}, Actor.stockpile, Caravan.cargo,
 *     Caravan.priceBook (which is itself nested Map<ResourceId, Map<...>>),
 *     and the ReputationTable.
 *   - HexGrid is serialized as `[hexKey, HexTile][]` from grid.tiles() —
 *     sparse, only set hexes appear.
 *   - Reputation is serialized as `{ holder, subject, value }[]` triples.
 *     Zero-valued entries are pruned by the sparse table itself.
 *   - The `bySite` diagnostic field is serialized verbatim (it's just plain
 *     SettlementSite records — Hex objects, primitives).
 *
 * Schema versioning: the top-level `schemaVersion` lets us reject snapshots
 * from incompatible code revisions early. Bump it whenever the on-disk
 * shape changes.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { Caravan, CrewMember, PriceObservation } from './caravan/caravan.js';
import { createCaravan } from './caravan/caravan.js';
import type { Actor } from './politics/actor.js';
import { createActor } from './politics/actor.js';
import type { Faction } from './politics/faction.js';
import { createFaction } from './politics/faction.js';
import type { NamedCharacter } from './politics/character.js';
import { createCharacter } from './politics/character.js';
import { createReputationTable, type ReputationTable } from './reputation/table.js';
import { poolFromMap } from './population/cohort.js';
import type { Settlement } from './world/settlement.js';
import { createSettlement } from './world/settlement.js';
import { createGrid, type HexGrid } from './world/grid.js';
import { hex, parseHexKey, type Hex } from './world/hex.js';
import type { HexDeposit, HexTile } from './world/terrain.js';
import {
  actorId,
  caravanId,
  characterId,
  factionId,
  jobId,
  resourceId,
  settlementId,
  type ActorId,
  type CaravanId,
  type CharacterId,
  type Day,
  type FactionId,
  type ResourceId,
  type SettlementId,
} from './types.js';
import type { WorldState } from '../procgen/seed.js';
import type { SettlementSite } from '../procgen/settlements.js';

// --- Serialized shapes ------------------------------------------------------

const SCHEMA_VERSION = 1 as const;

interface SerializedHex {
  readonly q: number;
  readonly r: number;
}

interface SerializedDeposit {
  readonly resource: string;
  readonly remaining: number;
}

interface SerializedHexTile {
  readonly terrain: HexTile['terrain'];
  readonly climate: HexTile['climate'];
  readonly elevation: number;
  readonly hasRiver: boolean;
  readonly road: HexTile['road'];
  readonly ownerActor: string | null;
  readonly deposit?: SerializedDeposit;
  readonly hiddenFeature?: NonNullable<HexTile['hiddenFeature']>;
  readonly hiddenFeatureDiscovered?: boolean;
}

interface SerializedMarketSnapshot {
  readonly recentInflows: ReadonlyArray<readonly [string, number]>;
  readonly recentOutflows: ReadonlyArray<readonly [string, number]>;
  readonly lastClearingPrice: ReadonlyArray<readonly [string, number]>;
}

interface SerializedSettlementBuilding {
  readonly buildingId: string;
  readonly hex: SerializedHex;
  readonly ownerActor: string;
  readonly capacity: number;
  readonly daysSinceMaintained: number;
}

interface SerializedSettlement {
  readonly id: string;
  readonly tier: Settlement['tier'];
  readonly name: string;
  readonly anchor: SerializedHex;
  readonly urbanHexes: readonly SerializedHex[];
  readonly catchmentHexes: readonly SerializedHex[];
  /** Sparse: only non-zero cohorts. */
  readonly population: ReadonlyArray<readonly [string, number]>;
  readonly buildings: readonly SerializedSettlementBuilding[];
  readonly factions: readonly string[];
  readonly stockpileOwners: readonly string[];
  readonly market: SerializedMarketSnapshot;
  /** Optional for back-compat with snapshots from before C3/C6 landed. */
  readonly catchmentBaselinePop?: number;
  readonly catchmentDayLastChanged?: number;
  readonly jobAllocations?: ReadonlyArray<readonly [string, number]>;
}

interface SerializedActor {
  readonly id: string;
  readonly kind: Actor['kind'];
  readonly name: string;
  readonly homeSettlement?: string;
  readonly stockpile: ReadonlyArray<readonly [string, number]>;
  readonly treasury: number;
}

interface SerializedFaction {
  readonly id: string;
  readonly actor: string;
  readonly name: string;
  readonly members: readonly string[];
}

interface SerializedNamedCharacter {
  readonly id: string;
  readonly name: string;
  readonly age: number;
  readonly sex: NamedCharacter['sex'];
  readonly class: NamedCharacter['class'];
  readonly faction: string;
  readonly role?: NonNullable<NamedCharacter['role']>;
  readonly location: SerializedHex;
  readonly status: NamedCharacter['status'];
  readonly traits: readonly string[];
}

interface SerializedPriceObservation {
  readonly price: number;
  readonly observedOnDay: number;
}

interface SerializedCaravan {
  readonly id: string;
  readonly ownerActor: string;
  readonly position: SerializedHex;
  readonly destination: SerializedHex | null;
  readonly crew: readonly CrewMember[];
  readonly animals: Caravan['animals'];
  readonly vehicles: Caravan['vehicles'];
  readonly cargo: ReadonlyArray<readonly [string, number]>;
  readonly treasury: number;
  readonly mpRemainingToday: number;
  readonly priceBook: ReadonlyArray<
    readonly [string, ReadonlyArray<readonly [string, SerializedPriceObservation]>]
  >;
  readonly health: number;
}

interface SerializedReputationEntry {
  readonly holder: string;
  readonly subject: string;
  readonly value: number;
}

interface SerializedSettlementSite {
  readonly kind: SettlementSite['kind'];
  readonly anchor: SerializedHex;
  readonly urbanHexes: readonly SerializedHex[];
  readonly estimatedPopulation: number;
}

export interface SerializedWorldState {
  readonly day: Day;
  readonly gridTiles: ReadonlyArray<readonly [string, SerializedHexTile]>;
  readonly settlements: ReadonlyArray<readonly [string, SerializedSettlement]>;
  readonly actors: ReadonlyArray<readonly [string, SerializedActor]>;
  readonly factions: ReadonlyArray<readonly [string, SerializedFaction]>;
  readonly characters: ReadonlyArray<readonly [string, SerializedNamedCharacter]>;
  readonly caravans: ReadonlyArray<readonly [string, SerializedCaravan]>;
  readonly reputation: readonly SerializedReputationEntry[];
  readonly bySite: readonly SerializedSettlementSite[];
}

export interface WorldSnapshot {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly capturedAtDay: Day;
  readonly world: SerializedWorldState;
}

// --- Helpers ----------------------------------------------------------------

const serHex = (h: Hex): SerializedHex => ({ q: h.q, r: h.r });
const deserHex = (s: SerializedHex): Hex => hex(s.q, s.r);

const mapToArray = <V>(m: ReadonlyMap<string, V>): ReadonlyArray<readonly [string, V]> => {
  const out: [string, V][] = [];
  for (const [k, v] of m) out.push([k, v]);
  return out;
};

const stringMapToArray = <K extends string, V>(
  m: ReadonlyMap<K, V>,
): ReadonlyArray<readonly [string, V]> => {
  const out: [string, V][] = [];
  for (const [k, v] of m) out.push([String(k), v]);
  return out;
};

// --- Tile serialization -----------------------------------------------------

const serializeTile = (t: HexTile): SerializedHexTile => {
  const out: SerializedHexTile = {
    terrain: t.terrain,
    climate: t.climate,
    elevation: t.elevation,
    hasRiver: t.hasRiver,
    road: t.road,
    ownerActor: t.ownerActor === null ? null : String(t.ownerActor),
    ...(t.deposit !== undefined
      ? { deposit: { resource: String(t.deposit.resource), remaining: t.deposit.remaining } }
      : {}),
    ...(t.hiddenFeature !== undefined ? { hiddenFeature: t.hiddenFeature } : {}),
    ...(t.hiddenFeatureDiscovered !== undefined
      ? { hiddenFeatureDiscovered: t.hiddenFeatureDiscovered }
      : {}),
  };
  return out;
};

const deserializeTile = (t: SerializedHexTile): HexTile => {
  const deposit: HexDeposit | undefined =
    t.deposit !== undefined
      ? { resource: resourceId(t.deposit.resource), remaining: t.deposit.remaining }
      : undefined;
  const tile: HexTile = {
    terrain: t.terrain,
    climate: t.climate,
    elevation: t.elevation,
    hasRiver: t.hasRiver,
    road: t.road,
    ownerActor: t.ownerActor === null ? null : actorId(t.ownerActor),
    ...(deposit !== undefined ? { deposit } : {}),
    ...(t.hiddenFeature !== undefined ? { hiddenFeature: t.hiddenFeature } : {}),
    ...(t.hiddenFeatureDiscovered !== undefined
      ? { hiddenFeatureDiscovered: t.hiddenFeatureDiscovered }
      : {}),
  };
  return tile;
};

// --- Settlement serialization ----------------------------------------------

const serializeSettlement = (s: Settlement): SerializedSettlement => {
  // PopulationPool exposes cohorts() yielding [CohortKey, n]; key.format via agedKey.
  const population: [string, number][] = [];
  for (const [key, n] of s.population.cohorts()) {
    if (n > 0) population.push([`${key.age}|${key.sex}|${key.class}`, n]);
  }
  return {
    id: String(s.id),
    tier: s.tier,
    name: s.name,
    anchor: serHex(s.anchor),
    urbanHexes: s.urbanHexes.map(serHex),
    catchmentHexes: s.catchmentHexes.map(serHex),
    population,
    buildings: s.buildings.map((b) => ({
      buildingId: String(b.buildingId),
      hex: serHex(b.hex),
      ownerActor: String(b.ownerActor),
      capacity: b.capacity,
      daysSinceMaintained: b.daysSinceMaintained,
    })),
    factions: s.factions.map(String),
    stockpileOwners: s.stockpileOwners.map(String),
    market: {
      recentInflows: stringMapToArray(s.market.recentInflows),
      recentOutflows: stringMapToArray(s.market.recentOutflows),
      lastClearingPrice: stringMapToArray(s.market.lastClearingPrice),
    },
    catchmentBaselinePop: s.catchmentBaselinePop,
    catchmentDayLastChanged: s.catchmentDayLastChanged,
    jobAllocations: stringMapToArray(s.jobAllocations),
  };
};

const deserializeSettlement = (s: SerializedSettlement): Settlement => {
  const settlement = createSettlement({
    id: settlementId(s.id),
    tier: s.tier,
    name: s.name,
    anchor: deserHex(s.anchor),
    urbanHexes: s.urbanHexes.map(deserHex),
    catchmentHexes: s.catchmentHexes.map(deserHex),
    factions: s.factions.map(factionId),
    stockpileOwners: s.stockpileOwners.map(actorId),
    ...(s.catchmentBaselinePop !== undefined
      ? { catchmentBaselinePop: s.catchmentBaselinePop }
      : {}),
    ...(s.catchmentDayLastChanged !== undefined
      ? { catchmentDayLastChanged: s.catchmentDayLastChanged }
      : {}),
  });
  if (s.jobAllocations !== undefined) {
    for (const [j, n] of s.jobAllocations) {
      settlement.jobAllocations.set(jobId(j), n);
    }
  }
  // Restore population.
  const popMap = new Map<string, number>(s.population.map(([k, n]) => [k, n] as const));
  const restoredPool = poolFromMap(popMap);
  for (const [key, count] of restoredPool.cohorts()) {
    settlement.population.set(key, count);
  }
  // Restore buildings (createSettlement starts with []).
  for (const b of s.buildings) {
    settlement.buildings.push({
      buildingId: b.buildingId as Settlement['buildings'][number]['buildingId'],
      hex: deserHex(b.hex),
      ownerActor: actorId(b.ownerActor),
      capacity: b.capacity,
      daysSinceMaintained: b.daysSinceMaintained,
    });
  }
  // Restore market maps.
  for (const [r, n] of s.market.recentInflows) {
    settlement.market.recentInflows.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.recentOutflows) {
    settlement.market.recentOutflows.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.lastClearingPrice) {
    settlement.market.lastClearingPrice.set(resourceId(r), n);
  }
  return settlement;
};

// --- Actor / Faction / Character / Caravan ---------------------------------

const serializeActor = (a: Actor): SerializedActor => ({
  id: String(a.id),
  kind: a.kind,
  name: a.name,
  ...(a.homeSettlement !== undefined ? { homeSettlement: String(a.homeSettlement) } : {}),
  stockpile: stringMapToArray(a.stockpile),
  treasury: a.treasury,
});

const deserializeActor = (a: SerializedActor): Actor => {
  const actor = createActor({
    id: actorId(a.id),
    kind: a.kind,
    name: a.name,
    ...(a.homeSettlement !== undefined ? { homeSettlement: settlementId(a.homeSettlement) } : {}),
    treasury: a.treasury,
  });
  for (const [r, n] of a.stockpile) {
    actor.stockpile.set(resourceId(r), n);
  }
  return actor;
};

const serializeFaction = (f: Faction): SerializedFaction => ({
  id: String(f.id),
  actor: String(f.actor),
  name: f.name,
  members: f.members.map(String),
});

const deserializeFaction = (f: SerializedFaction): Faction =>
  createFaction({
    id: factionId(f.id),
    actor: actorId(f.actor),
    name: f.name,
    members: f.members.map(characterId),
  });

const serializeCharacter = (c: NamedCharacter): SerializedNamedCharacter => ({
  id: String(c.id),
  name: c.name,
  age: c.age,
  sex: c.sex,
  class: c.class,
  faction: String(c.faction),
  ...(c.role !== undefined ? { role: c.role } : {}),
  location: serHex(c.location),
  status: c.status,
  traits: [...c.traits],
});

const deserializeCharacter = (c: SerializedNamedCharacter): NamedCharacter =>
  createCharacter({
    id: characterId(c.id),
    name: c.name,
    age: c.age,
    sex: c.sex,
    class: c.class,
    faction: factionId(c.faction),
    ...(c.role !== undefined ? { role: c.role } : {}),
    location: deserHex(c.location),
    status: c.status,
    traits: c.traits,
  });

const serializeCaravan = (c: Caravan): SerializedCaravan => {
  const priceBook: [string, [string, SerializedPriceObservation][]][] = [];
  for (const [res, inner] of c.priceBook) {
    const innerArr: [string, SerializedPriceObservation][] = [];
    for (const [hexK, obs] of inner) {
      innerArr.push([hexK, { price: obs.price, observedOnDay: obs.observedOnDay }]);
    }
    priceBook.push([String(res), innerArr]);
  }
  return {
    id: String(c.id),
    ownerActor: String(c.ownerActor),
    position: serHex(c.position),
    destination: c.destination === null ? null : serHex(c.destination),
    crew: c.crew.map((m) => ({ ...m })),
    animals: { ...c.animals },
    vehicles: { ...c.vehicles },
    cargo: stringMapToArray(c.cargo),
    treasury: c.treasury,
    mpRemainingToday: c.mpRemainingToday,
    priceBook,
    health: c.health,
  };
};

const deserializeCaravan = (c: SerializedCaravan): Caravan => {
  const caravan = createCaravan({
    id: caravanId(c.id),
    ownerActor: actorId(c.ownerActor),
    position: deserHex(c.position),
    crew: c.crew.map((m) => ({ ...m })),
    animals: { ...c.animals },
    vehicles: { ...c.vehicles },
    destination: c.destination === null ? null : deserHex(c.destination),
    treasury: c.treasury,
  });
  caravan.mpRemainingToday = c.mpRemainingToday;
  caravan.health = c.health;
  for (const [r, n] of c.cargo) caravan.cargo.set(resourceId(r), n);
  for (const [res, inner] of c.priceBook) {
    const innerMap = new Map<string, PriceObservation>();
    for (const [hexK, obs] of inner) {
      innerMap.set(hexK, { price: obs.price, observedOnDay: obs.observedOnDay });
    }
    caravan.priceBook.set(resourceId(res), innerMap);
  }
  return caravan;
};

// --- Reputation -------------------------------------------------------------

const serializeReputation = (r: ReputationTable): readonly SerializedReputationEntry[] => {
  const out: SerializedReputationEntry[] = [];
  for (const e of r.entries()) {
    out.push({ holder: String(e.holder), subject: String(e.subject), value: e.value });
  }
  return out;
};

const deserializeReputation = (entries: readonly SerializedReputationEntry[]): ReputationTable => {
  const t = createReputationTable();
  for (const e of entries) {
    // ReputationKey accepts both ActorId and CharacterId; we don't know which
    // here, but since both are branded strings, casting through ActorId works.
    t.set(actorId(e.holder), actorId(e.subject), e.value);
  }
  return t;
};

// --- Site (diagnostic) ------------------------------------------------------

const serializeSite = (s: SettlementSite): SerializedSettlementSite => ({
  kind: s.kind,
  anchor: serHex(s.anchor),
  urbanHexes: s.urbanHexes.map(serHex),
  estimatedPopulation: s.estimatedPopulation,
});

const deserializeSite = (s: SerializedSettlementSite): SettlementSite => ({
  kind: s.kind,
  anchor: deserHex(s.anchor),
  urbanHexes: s.urbanHexes.map(deserHex),
  estimatedPopulation: s.estimatedPopulation,
});

// --- Public API -------------------------------------------------------------

export const serializeWorld = (world: WorldState, capturedAtDay: Day): WorldSnapshot => {
  const gridTiles: [string, SerializedHexTile][] = [];
  for (const [h, t] of world.grid.tiles()) {
    gridTiles.push([`${h.q},${h.r}`, serializeTile(t)]);
  }
  const settlements: [string, SerializedSettlement][] = [];
  for (const [id, s] of world.settlements) {
    settlements.push([String(id), serializeSettlement(s)]);
  }
  const actors: [string, SerializedActor][] = [];
  for (const [id, a] of world.actors) {
    actors.push([String(id), serializeActor(a)]);
  }
  const factions: [string, SerializedFaction][] = [];
  for (const [id, f] of world.factions) {
    factions.push([String(id), serializeFaction(f)]);
  }
  const characters: [string, SerializedNamedCharacter][] = [];
  for (const [id, c] of world.characters) {
    characters.push([String(id), serializeCharacter(c)]);
  }
  const caravans: [string, SerializedCaravan][] = [];
  for (const [id, c] of world.caravans) {
    caravans.push([String(id), serializeCaravan(c)]);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    capturedAtDay,
    world: {
      day: world.day,
      gridTiles,
      settlements,
      actors,
      factions,
      characters,
      caravans,
      reputation: serializeReputation(world.reputation),
      bySite: world.bySite.map(serializeSite),
    },
  };
};

export const deserializeWorld = (snap: WorldSnapshot): WorldState => {
  if (snap.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `deserializeWorld: unsupported schemaVersion ${String(snap.schemaVersion)} ` +
        `(expected ${SCHEMA_VERSION})`,
    );
  }
  const w = snap.world;
  const grid: HexGrid = createGrid();
  for (const [k, t] of w.gridTiles) {
    grid.set(parseHexKey(k), deserializeTile(t));
  }
  const settlements = new Map<SettlementId, Settlement>();
  for (const [id, s] of w.settlements) {
    settlements.set(settlementId(id), deserializeSettlement(s));
  }
  const actors = new Map<ActorId, Actor>();
  for (const [id, a] of w.actors) {
    actors.set(actorId(id), deserializeActor(a));
  }
  const factions = new Map<FactionId, Faction>();
  for (const [id, f] of w.factions) {
    factions.set(factionId(id), deserializeFaction(f));
  }
  const characters = new Map<CharacterId, NamedCharacter>();
  for (const [id, c] of w.characters) {
    characters.set(characterId(id), deserializeCharacter(c));
  }
  const caravans = new Map<CaravanId, Caravan>();
  for (const [id, c] of w.caravans) {
    caravans.set(caravanId(id), deserializeCaravan(c));
  }
  return {
    day: w.day,
    grid,
    settlements,
    actors,
    factions,
    characters,
    caravans,
    patrols: new Map(),
    banditCamps: new Map(),
    newsCarriers: new Map(),
    reputation: deserializeReputation(w.reputation),
    bySite: w.bySite.map(deserializeSite),
  };
};

export const writeSnapshot = async (snap: WorldSnapshot, path: string): Promise<void> => {
  await writeFile(path, JSON.stringify(snap), 'utf8');
};

export const readSnapshot = async (path: string): Promise<WorldSnapshot> => {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as WorldSnapshot;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `readSnapshot: unsupported schemaVersion ${String(parsed.schemaVersion)} ` +
        `(expected ${SCHEMA_VERSION})`,
    );
  }
  return parsed;
};

// Reference imports that are part of the public type surface but not used as
// values directly (the deserialize path uses the shape, not the type imports).
void mapToArray;
// Ensure ResourceId is treated as used so eslint doesn't flag the type-only
// import on certain TS configs.
const _resourceIdPin: ResourceId | null = null;
void _resourceIdPin;
