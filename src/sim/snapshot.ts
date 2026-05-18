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
import type { MarketObservation, ResourceQuote } from './politics/knownPrices.js';
import type { Faction } from './politics/faction.js';
import { createFaction } from './politics/faction.js';
import type { NamedCharacter } from './politics/character.js';
import { createCharacter } from './politics/character.js';
import { createReputationTable, type ReputationTable } from './reputation/table.js';
import { poolFromMap } from './population/cohort.js';
import type { MarketBookLadder, Settlement } from './world/settlement.js';
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
  personId,
  resourceId,
  settlementId,
  type ActorId,
  type CaravanId,
  type CharacterId,
  type Day,
  type FactionId,
  type PersonId,
  type ResourceId,
  type SettlementId,
} from './types.js';
import { createPerson, type Person } from './people/person.js';
import type { WorldState } from '../procgen/seed.js';
import type { SettlementSite } from '../procgen/settlements.js';

// --- Serialized shapes ------------------------------------------------------

// v3 (v1.6 pass 27b): integer-only treasury + stockpile, with new
//   Actor.stockpileResidue per-(settlement, resource) fractional
//   accumulator. v2 snapshots rejected (no silent shim per CLAUDE.md).
// v2 (v1.6 realism pass): Actor.knownPrices added per docs/06 §"Caravan
//   information model".
const SCHEMA_VERSION = 3 as const;

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
  readonly recentImports?: ReadonlyArray<readonly [string, number]>;
  readonly recentExports?: ReadonlyArray<readonly [string, number]>;
  readonly recentProduction?: ReadonlyArray<readonly [string, number]>;
  readonly recentConsumption?: ReadonlyArray<readonly [string, number]>;
  readonly recentInflows: ReadonlyArray<readonly [string, number]>;
  readonly recentOutflows: ReadonlyArray<readonly [string, number]>;
  readonly lastClearingPrice: ReadonlyArray<readonly [string, number]>;
  /** docs/08 §"Bid-ask book". Optional for back-compat with older snapshots. */
  readonly bestAsk?: ReadonlyArray<readonly [string, number]>;
  readonly askDepth?: ReadonlyArray<readonly [string, number]>;
  readonly bestBid?: ReadonlyArray<readonly [string, number]>;
  readonly bidDepth?: ReadonlyArray<readonly [string, number]>;
  readonly midPrice?: ReadonlyArray<readonly [string, number]>;
  readonly spread?: ReadonlyArray<readonly [string, number]>;
  readonly lastClearedDay?: ReadonlyArray<readonly [string, number]>;
  readonly bookLadder?: ReadonlyArray<readonly [string, SerializedMarketBookLadder]>;
  readonly lastBookSampleDay?: ReadonlyArray<readonly [string, number]>;
}

interface SerializedMarketBookOrder {
  readonly actorId: string;
  readonly actorKind: string;
  readonly price: number;
  readonly quantity: number;
  readonly curve?: 'subsistence' | 'comfort' | 'status' | 'derived';
  readonly buyerDisposition?: 'consume' | 'stockpile';
}

interface SerializedMarketBookLadder {
  readonly asks: readonly SerializedMarketBookOrder[];
  readonly bids: readonly SerializedMarketBookOrder[];
}

interface SerializedSettlementBuilding {
  readonly buildingId: string;
  readonly hex: SerializedHex;
  readonly ownerActor: string;
  readonly capacity: number;
  readonly maxCapacity?: number;
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
  /** Per docs/15 §C29: optional patron for client villages. */
  readonly clientPatron?: string;
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
  /**
   * Per docs/15 §C30: actor stockpile is keyed by settlement. Serialized
   * as `[settlementId, [[resourceId, quantity], ...]][]`.
   */
  readonly stockpile: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]>;
  /** v3: fractional residue accumulator (production carry-over). */
  readonly stockpileResidue: ReadonlyArray<
    readonly [string, ReadonlyArray<readonly [string, number]>]
  >;
  /**
   * Per docs/06 §"Caravan information model": one MarketObservation per
   * settlement. Serialized as `[settlementId, { observedDay, quotes:
   * [[resourceId, {bestAsk, bestBid}], ...] }][]`. Required in schema v2+.
   */
  readonly knownPrices: ReadonlyArray<
    readonly [
      string,
      {
        readonly observedDay: number;
        readonly quotes: ReadonlyArray<
          readonly [string, { readonly bestAsk: number; readonly bestBid: number }]
        >;
      },
    ]
  >;
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
  readonly bidPrice?: number;
  readonly askPrice?: number;
  readonly bidDepth?: number;
  readonly askDepth?: number;
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
  /** v1.6 off-map sojourn (docs/06 §"The 20-tick off-map sojourn"). */
  readonly offMapUntil?: number;
  /** v1.6 dispatch origin for the return trip home. */
  readonly originSettlement?: string;
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

interface SerializedPerson {
  readonly id: string;
  readonly name: string;
  readonly age: number;
  readonly sex: Person['sex'];
  readonly class: Person['class'];
  readonly faction: string;
  readonly role: Person['role'];
  readonly status: Person['status'];
  readonly health: number;
  readonly bornOnDay: Day;
  readonly diedOnDay?: Day;
  readonly unitId?: string;
  readonly namedCharacterId?: string;
}

interface SerializedPersonEquipment {
  readonly personId: string;
  readonly slots: ReadonlyArray<readonly [string, number]>;
}

export interface SerializedWorldState {
  readonly day: Day;
  readonly gridTiles: ReadonlyArray<readonly [string, SerializedHexTile]>;
  readonly settlements: ReadonlyArray<readonly [string, SerializedSettlement]>;
  readonly actors: ReadonlyArray<readonly [string, SerializedActor]>;
  readonly factions: ReadonlyArray<readonly [string, SerializedFaction]>;
  readonly characters: ReadonlyArray<readonly [string, SerializedNamedCharacter]>;
  readonly caravans: ReadonlyArray<readonly [string, SerializedCaravan]>;
  readonly persons?: ReadonlyArray<SerializedPerson>;
  readonly personEquipment?: ReadonlyArray<SerializedPersonEquipment>;
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

const marketBookLadderToArray = (
  m: ReadonlyMap<ResourceId, MarketBookLadder>,
): ReadonlyArray<readonly [string, SerializedMarketBookLadder]> => {
  const out: [string, SerializedMarketBookLadder][] = [];
  for (const [resource, ladder] of m) {
    out.push([
      String(resource),
      {
        asks: ladder.asks.map((order) => ({
          actorId: String(order.actorId),
          actorKind: order.actorKind,
          price: order.price,
          quantity: order.quantity,
          ...(order.curve !== undefined ? { curve: order.curve } : {}),
          ...(order.buyerDisposition !== undefined
            ? { buyerDisposition: order.buyerDisposition }
            : {}),
        })),
        bids: ladder.bids.map((order) => ({
          actorId: String(order.actorId),
          actorKind: order.actorKind,
          price: order.price,
          quantity: order.quantity,
          ...(order.curve !== undefined ? { curve: order.curve } : {}),
          ...(order.buyerDisposition !== undefined
            ? { buyerDisposition: order.buyerDisposition }
            : {}),
        })),
      },
    ]);
  }
  return out;
};

const marketBookLadderFromSerialized = (ladder: SerializedMarketBookLadder): MarketBookLadder => ({
  asks: ladder.asks.map((order) => ({
    actorId: actorId(order.actorId),
    actorKind: order.actorKind,
    price: order.price,
    quantity: order.quantity,
    ...(order.curve !== undefined ? { curve: order.curve } : {}),
    ...(order.buyerDisposition !== undefined ? { buyerDisposition: order.buyerDisposition } : {}),
  })),
  bids: ladder.bids.map((order) => ({
    actorId: actorId(order.actorId),
    actorKind: order.actorKind,
    price: order.price,
    quantity: order.quantity,
    ...(order.curve !== undefined ? { curve: order.curve } : {}),
    ...(order.buyerDisposition !== undefined ? { buyerDisposition: order.buyerDisposition } : {}),
  })),
});

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
      ...(b.maxCapacity !== undefined ? { maxCapacity: b.maxCapacity } : {}),
      daysSinceMaintained: b.daysSinceMaintained,
    })),
    factions: s.factions.map(String),
    stockpileOwners: s.stockpileOwners.map(String),
    ...(s.clientPatron !== undefined ? { clientPatron: String(s.clientPatron) } : {}),
    market: {
      recentImports: stringMapToArray(s.market.recentImports),
      recentExports: stringMapToArray(s.market.recentExports),
      recentProduction: stringMapToArray(s.market.recentProduction),
      recentConsumption: stringMapToArray(s.market.recentConsumption),
      recentInflows: stringMapToArray(s.market.recentInflows),
      recentOutflows: stringMapToArray(s.market.recentOutflows),
      lastClearingPrice: stringMapToArray(s.market.lastClearingPrice),
      bestAsk: stringMapToArray(s.market.bestAsk),
      askDepth: stringMapToArray(s.market.askDepth),
      bestBid: stringMapToArray(s.market.bestBid),
      bidDepth: stringMapToArray(s.market.bidDepth),
      midPrice: stringMapToArray(s.market.midPrice),
      spread: stringMapToArray(s.market.spread),
      lastClearedDay: stringMapToArray(s.market.lastClearedDay),
      bookLadder: marketBookLadderToArray(s.market.bookLadder),
      lastBookSampleDay: stringMapToArray(s.market.lastBookSampleDay),
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
    ...(s.clientPatron !== undefined ? { clientPatron: actorId(s.clientPatron) } : {}),
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
      ...(b.maxCapacity !== undefined ? { maxCapacity: b.maxCapacity } : {}),
      daysSinceMaintained: b.daysSinceMaintained,
    });
  }
  // Restore market maps. Per-category fields are optional in older
  // snapshots; when absent we recover them by leaving them empty (a
  // few ticks of replay re-populates them from real flow events).
  for (const [r, n] of s.market.recentImports ?? []) {
    settlement.market.recentImports.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.recentExports ?? []) {
    settlement.market.recentExports.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.recentProduction ?? []) {
    settlement.market.recentProduction.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.recentConsumption ?? []) {
    settlement.market.recentConsumption.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.recentInflows) {
    settlement.market.recentInflows.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.recentOutflows) {
    settlement.market.recentOutflows.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.lastClearingPrice) {
    settlement.market.lastClearingPrice.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.bestAsk ?? []) {
    settlement.market.bestAsk.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.askDepth ?? []) {
    settlement.market.askDepth.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.bestBid ?? []) {
    settlement.market.bestBid.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.bidDepth ?? []) {
    settlement.market.bidDepth.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.midPrice ?? []) {
    settlement.market.midPrice.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.spread ?? []) {
    settlement.market.spread.set(resourceId(r), n);
  }
  for (const [r, n] of s.market.lastClearedDay ?? []) {
    settlement.market.lastClearedDay.set(resourceId(r), n);
  }
  for (const [r, ladder] of s.market.bookLadder ?? []) {
    settlement.market.bookLadder.set(resourceId(r), marketBookLadderFromSerialized(ladder));
  }
  for (const [r, n] of s.market.lastBookSampleDay ?? []) {
    settlement.market.lastBookSampleDay.set(resourceId(r), n);
  }
  return settlement;
};

// --- Actor / Faction / Character / Caravan ---------------------------------

const serializeActor = (a: Actor): SerializedActor => {
  const stockpile: Array<readonly [string, ReadonlyArray<readonly [string, number]>]> = [];
  for (const [sId, slice] of a.stockpile) {
    const entries: Array<readonly [string, number]> = [];
    for (const [r, q] of slice) entries.push([String(r), q] as const);
    stockpile.push([String(sId), entries] as const);
  }
  const knownPrices: Array<
    readonly [
      string,
      {
        readonly observedDay: number;
        readonly quotes: ReadonlyArray<
          readonly [string, { readonly bestAsk: number; readonly bestBid: number }]
        >;
      },
    ]
  > = [];
  for (const [sId, obs] of a.knownPrices) {
    const quotes: Array<readonly [string, { readonly bestAsk: number; readonly bestBid: number }]> =
      [];
    for (const [r, q] of obs.quotes) {
      quotes.push([String(r), { bestAsk: q.bestAsk, bestBid: q.bestBid }] as const);
    }
    knownPrices.push([String(sId), { observedDay: obs.observedDay, quotes }] as const);
  }
  const stockpileResidue: Array<readonly [string, ReadonlyArray<readonly [string, number]>]> = [];
  for (const [sId, slice] of a.stockpileResidue) {
    const entries: Array<readonly [string, number]> = [];
    for (const [r, q] of slice) entries.push([String(r), q] as const);
    stockpileResidue.push([String(sId), entries] as const);
  }
  return {
    id: String(a.id),
    kind: a.kind,
    name: a.name,
    ...(a.homeSettlement !== undefined ? { homeSettlement: String(a.homeSettlement) } : {}),
    stockpile,
    stockpileResidue,
    knownPrices,
    treasury: a.treasury,
  };
};

const deserializeActor = (a: SerializedActor): Actor => {
  const actor = createActor({
    id: actorId(a.id),
    kind: a.kind,
    name: a.name,
    ...(a.homeSettlement !== undefined ? { homeSettlement: settlementId(a.homeSettlement) } : {}),
    treasury: a.treasury,
  });
  for (const [sIdStr, entries] of a.stockpile) {
    const sId = settlementId(sIdStr);
    const slice = new Map<ResourceId, number>();
    for (const [r, n] of entries) slice.set(resourceId(r), n);
    if (slice.size > 0) actor.stockpile.set(sId, slice);
  }
  for (const [sIdStr, entries] of a.stockpileResidue) {
    const sId = settlementId(sIdStr);
    const slice = new Map<ResourceId, number>();
    for (const [r, n] of entries) slice.set(resourceId(r), n);
    if (slice.size > 0) actor.stockpileResidue.set(sId, slice);
  }
  for (const [sIdStr, ser] of a.knownPrices) {
    const sId = settlementId(sIdStr);
    const quotes = new Map<ResourceId, ResourceQuote>();
    for (const [r, q] of ser.quotes) {
      quotes.set(resourceId(r), { bestAsk: q.bestAsk, bestBid: q.bestBid });
    }
    if (quotes.size > 0) {
      const obs: MarketObservation = { quotes, observedDay: ser.observedDay as Day };
      actor.knownPrices.set(sId, obs);
    }
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

const serializePerson = (p: Person): SerializedPerson => ({
  id: String(p.id),
  name: p.name,
  age: p.age,
  sex: p.sex,
  class: p.class,
  faction: String(p.faction),
  role: p.role,
  status: p.status,
  health: p.health,
  bornOnDay: p.bornOnDay,
  ...(p.diedOnDay !== undefined ? { diedOnDay: p.diedOnDay } : {}),
  ...(p.unitId !== undefined ? { unitId: p.unitId } : {}),
  ...(p.namedCharacterId !== undefined ? { namedCharacterId: p.namedCharacterId } : {}),
});

const deserializePerson = (p: SerializedPerson): Person => {
  // createPerson handles defaults (status='alive', health=1) but the
  // snapshot's status may be 'dead'/'captured'/etc., so layer the
  // recorded state on top of the validated base.
  const base = createPerson({
    id: personId(p.id),
    name: p.name,
    age: p.age,
    sex: p.sex,
    class: p.class,
    faction: factionId(p.faction),
    role: p.role,
    bornOnDay: p.bornOnDay,
    status: p.status,
    health: p.health,
    ...(p.unitId !== undefined ? { unitId: p.unitId } : {}),
    ...(p.namedCharacterId !== undefined
      ? { namedCharacterId: characterId(p.namedCharacterId) }
      : {}),
  });
  if (p.diedOnDay === undefined) return base;
  return { ...base, diedOnDay: p.diedOnDay };
};

const serializeCaravan = (c: Caravan): SerializedCaravan => {
  const priceBook: [string, [string, SerializedPriceObservation][]][] = [];
  for (const [res, inner] of c.priceBook) {
    const innerArr: [string, SerializedPriceObservation][] = [];
    for (const [hexK, obs] of inner) {
      innerArr.push([
        hexK,
        {
          price: obs.price,
          ...(obs.bidPrice !== undefined ? { bidPrice: obs.bidPrice } : {}),
          ...(obs.askPrice !== undefined ? { askPrice: obs.askPrice } : {}),
          ...(obs.bidDepth !== undefined ? { bidDepth: obs.bidDepth } : {}),
          ...(obs.askDepth !== undefined ? { askDepth: obs.askDepth } : {}),
          observedOnDay: obs.observedOnDay,
        },
      ]);
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
    ...(c.offMapUntil !== undefined ? { offMapUntil: c.offMapUntil } : {}),
    ...(c.originSettlement !== undefined
      ? { originSettlement: String(c.originSettlement) }
      : {}),
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
    ...(c.originSettlement !== undefined
      ? { originSettlement: settlementId(c.originSettlement) }
      : {}),
  });
  caravan.mpRemainingToday = c.mpRemainingToday;
  caravan.health = c.health;
  if (c.offMapUntil !== undefined) caravan.offMapUntil = c.offMapUntil as Day;
  for (const [r, n] of c.cargo) caravan.cargo.set(resourceId(r), n);
  for (const [res, inner] of c.priceBook) {
    const innerMap = new Map<string, PriceObservation>();
    for (const [hexK, obs] of inner) {
      innerMap.set(hexK, {
        price: obs.price,
        ...(obs.bidPrice !== undefined ? { bidPrice: obs.bidPrice } : {}),
        ...(obs.askPrice !== undefined ? { askPrice: obs.askPrice } : {}),
        ...(obs.bidDepth !== undefined ? { bidDepth: obs.bidDepth } : {}),
        ...(obs.askDepth !== undefined ? { askDepth: obs.askDepth } : {}),
        observedOnDay: obs.observedOnDay,
      });
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
  const persons: SerializedPerson[] = [];
  if (world.persons !== undefined) {
    for (const p of world.persons.values()) persons.push(serializePerson(p));
  }
  const personEquipment: SerializedPersonEquipment[] = [];
  if (world.personEquipment !== undefined) {
    for (const [pid, slots] of world.personEquipment) {
      if (slots.size === 0) continue;
      const slotArr: [string, number][] = [];
      for (const [res, qty] of slots) slotArr.push([String(res), qty]);
      personEquipment.push({ personId: String(pid), slots: slotArr });
    }
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
      ...(persons.length > 0 ? { persons } : {}),
      ...(personEquipment.length > 0 ? { personEquipment } : {}),
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
  const persons = new Map<PersonId, Person>();
  if (w.persons !== undefined) {
    for (const p of w.persons) persons.set(personId(p.id), deserializePerson(p));
  }
  const personEquipment = new Map<PersonId, Map<ResourceId, number>>();
  if (w.personEquipment !== undefined) {
    for (const entry of w.personEquipment) {
      const slot = new Map<ResourceId, number>();
      for (const [res, qty] of entry.slots) slot.set(resourceId(res), qty);
      personEquipment.set(personId(entry.personId), slot);
    }
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
    banditParties: new Map(),
    newsCarriers: new Map(),
    persons,
    personEquipment,
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
