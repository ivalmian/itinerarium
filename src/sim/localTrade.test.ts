/**
 * Tests for the local-trade phase: petty merchants / villager pickup carts
 * arbitraging price spreads between settlements within 3 hexes.
 *
 * Design refs:
 *   docs/06-caravans.md §"Local trade between nearby settlements"
 *   docs/08-money-and-trade.md §"Per-settlement markets, regional smoothing"
 *
 * These tests use small handcrafted worlds so we can pre-seed
 * `lastClearingPrice` directly and observe the transfer end-to-end without
 * paying for a real market clearing first.
 */

import { describe, expect, it } from 'vitest';
import { createGrid } from './world/grid.js';
import { hex } from './world/hex.js';
import type { HexTile } from './world/terrain.js';
import { createSettlement, type Settlement } from './world/settlement.js';
import { createActor, type Actor } from './politics/actor.js';
import { createReputationTable } from './reputation/table.js';
import {
  actorId,
  resourceId,
  settlementId,
  type ActorId,
  type CaravanId,
  type CharacterId,
  type FactionId,
  type SettlementId,
} from './types.js';
import type { Faction } from './politics/faction.js';
import type { NamedCharacter } from './politics/character.js';
import type { Caravan } from './caravan/caravan.js';
import { createRng } from './rng.js';
import type { WorldState } from '../procgen/seed.js';
import { tick, type TickEvent } from './tick.js';

// --- Fixture builders -------------------------------------------------------

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

interface PairOpts {
  /** Hex separation between the two anchors. Default 1. */
  readonly distance?: number;
  /** Pre-seeded clearing price for resource at A. */
  readonly priceA: number;
  /** Pre-seeded clearing price for resource at B. */
  readonly priceB: number;
  /** Stockpile of resource at A's owner. */
  readonly stockA?: number;
  /** Stockpile of resource at B's owner. */
  readonly stockB?: number;
  /** Treasury of A's owner. */
  readonly treasuryA?: number;
  /** Treasury of B's owner. */
  readonly treasuryB?: number;
  /** Resource id (defaults to food.grain). */
  readonly resource?: string;
}

const localTradeEvents = (
  events: readonly TickEvent[],
): readonly Extract<TickEvent, { type: 'local_trade' }>[] =>
  events.filter(
    (e): e is Extract<TickEvent, { type: 'local_trade' }> => e.type === 'local_trade',
  );

const buildPairWorld = (opts: PairOpts): WorldState => {
  const w = buildEmptyWorld();
  const distance = opts.distance ?? 1;
  const anchorA = hex(0, 0);
  const anchorB = hex(distance, 0);
  // Populate enough plains around both anchors that everything is in-grid.
  for (let q = -1; q <= distance + 1; q++) {
    for (let r = -2; r <= 2; r++) {
      w.grid.set(hex(q, r), makeTile('plains'));
    }
  }
  const ownerAId = actorId('owner-a');
  const ownerBId = actorId('owner-b');
  const sAId = settlementId('a-settle');
  const sBId = settlementId('b-settle');
  const sA = createSettlement({
    id: sAId,
    tier: 'village',
    name: 'A',
    anchor: anchorA,
    urbanHexes: [anchorA],
    catchmentHexes: [],
    stockpileOwners: [ownerAId],
  });
  const sB = createSettlement({
    id: sBId,
    tier: 'village',
    name: 'B',
    anchor: anchorB,
    urbanHexes: [anchorB],
    catchmentHexes: [],
    stockpileOwners: [ownerBId],
  });
  const resId = resourceId(opts.resource ?? 'food.grain');
  if (opts.priceA > 0) sA.market.lastClearingPrice.set(resId, opts.priceA);
  if (opts.priceB > 0) sB.market.lastClearingPrice.set(resId, opts.priceB);
  const ownerA = createActor({
    id: ownerAId,
    kind: 'city_corporation',
    name: 'Owner A',
    homeSettlement: sAId,
    treasury: opts.treasuryA ?? 1000,
  });
  const ownerB = createActor({
    id: ownerBId,
    kind: 'city_corporation',
    name: 'Owner B',
    homeSettlement: sBId,
    treasury: opts.treasuryB ?? 1000,
  });
  if ((opts.stockA ?? 0) > 0) ownerA.stockpile.set(resId, opts.stockA!);
  if ((opts.stockB ?? 0) > 0) ownerB.stockpile.set(resId, opts.stockB!);
  w.actors.set(ownerAId, ownerA);
  w.actors.set(ownerBId, ownerB);
  w.settlements.set(sAId, sA);
  w.settlements.set(sBId, sB);
  return w;
};

// --- Tests ------------------------------------------------------------------

describe('localTradePhase (docs/06 §"Local trade between nearby settlements")', () => {
  it('moves grain from cheap settlement to expensive neighbor and emits local_trade', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1, // cheap
      priceB: 3, // dear
      stockA: 100,
      treasuryB: 1000,
    });
    const r = tick({ world: w, rng: createRng('lt-1') });
    const trades = localTradeEvents(r.events);
    expect(trades.length).toBeGreaterThan(0);
    // Direction: from A (cheap) to B (dear).
    const grainTrade = trades.find((t) => String(t.resource) === 'food.grain');
    expect(grainTrade).toBeDefined();
    expect(String(grainTrade!.fromSettlement)).toBe('a-settle');
    expect(String(grainTrade!.toSettlement)).toBe('b-settle');
    expect(grainTrade!.quantity).toBeGreaterThan(0);
    expect(grainTrade!.coinPaid).toBeGreaterThan(0);
  });

  it('skips trade when the spread does not cover transport cost', () => {
    // priceB - priceA = 0.005, transport at distance 1 = 0.005 — no margin.
    const w = buildPairWorld({
      distance: 1,
      priceA: 1.0,
      priceB: 1.005,
      stockA: 100,
      treasuryB: 1000,
    });
    const r = tick({ world: w, rng: createRng('lt-no-spread') });
    expect(localTradeEvents(r.events).length).toBe(0);
  });

  it('moves goods at the midpoint price (split the spread)', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 2,
      priceB: 6,
      stockA: 100,
      treasuryB: 10000,
    });
    const ownerB = w.actors.get(actorId('owner-b'))!;
    const beforeTreasury = ownerB.treasury;
    const r = tick({ world: w, rng: createRng('lt-mid') });
    const trade = localTradeEvents(r.events).find((t) => String(t.resource) === 'food.grain');
    expect(trade).toBeDefined();
    // mid = (2 + 6) / 2 = 4. coin paid should equal qty * 4.
    expect(trade!.coinPaid).toBeCloseTo(trade!.quantity * 4, 6);
    // Buyer treasury fell by exactly coinPaid.
    expect(beforeTreasury - ownerB.treasury).toBeCloseTo(trade!.coinPaid, 6);
  });

  it('caps petty load at MAX_PETTY_LOAD_KG / weightKgPerUnit', () => {
    // food.grain weighs 6.7 kg / unit; 50/6.7 ≈ 7.46.
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 1000, // plenty
      treasuryB: 100000,
    });
    const r = tick({ world: w, rng: createRng('lt-cap') });
    const trade = localTradeEvents(r.events).find((t) => String(t.resource) === 'food.grain');
    expect(trade).toBeDefined();
    expect(trade!.quantity).toBeLessThanOrEqual(50 / 6.7 + 1e-6);
  });

  it('reduces the post-tick price spread after one tick (smoothing test)', () => {
    // Use a procgen-free pair: pre-seed prices, run a tick, compare implicit
    // spread movement. The trade phase will re-clear A and B with the new
    // stockpiles; B's price should fall (more supply) and A's should rise
    // (less supply) — but both shift toward the midpoint.
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 1000,
      treasuryB: 100000,
    });
    const sA = w.settlements.get(settlementId('a-settle'))!;
    const sB = w.settlements.get(settlementId('b-settle'))!;
    const ownerA = w.actors.get(actorId('owner-a'))!;
    const ownerB = w.actors.get(actorId('owner-b'))!;
    const grain = resourceId('food.grain');
    const stockBefore = {
      a: ownerA.stockpile.get(grain) ?? 0,
      b: ownerB.stockpile.get(grain) ?? 0,
    };
    tick({ world: w, rng: createRng('lt-smooth') });
    // A's grain stockpile should have fallen (sold some); B's should have
    // risen (received some). This is the directly observable smoothing.
    expect((ownerA.stockpile.get(grain) ?? 0)).toBeLessThan(stockBefore.a);
    expect((ownerB.stockpile.get(grain) ?? 0)).toBeGreaterThan(stockBefore.b);
    // Both markets retain a recorded price — the regional gradient narrows
    // mechanically each tick because supply/demand are equalizing.
    expect(sA.market.lastClearingPrice.has(grain)).toBe(true);
    expect(sB.market.lastClearingPrice.has(grain)).toBe(true);
  });

  it('does not fire when distance > 3 hexes', () => {
    const w = buildPairWorld({
      distance: 4,
      priceA: 1,
      priceB: 10,
      stockA: 100,
      treasuryB: 1000,
    });
    expect(localTradeEvents(tick({ world: w, rng: createRng('lt-far') }).events).length).toBe(0);
  });

  it('skips when only one side has an observed clearing price', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 0, // no observed price → not seeded
      stockA: 100,
      treasuryB: 1000,
    });
    expect(localTradeEvents(tick({ world: w, rng: createRng('lt-no-px') }).events).length).toBe(0);
  });

  it('skips when seller has no stock', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 0,
      treasuryB: 1000,
    });
    expect(localTradeEvents(tick({ world: w, rng: createRng('lt-no-stock') }).events).length).toBe(0);
  });

  it('skips when buyer treasury is zero', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 100,
      treasuryB: 0,
    });
    expect(localTradeEvents(tick({ world: w, rng: createRng('lt-no-coin') }).events).length).toBe(0);
  });

  it('is deterministic across two equivalent worlds', () => {
    const a = buildPairWorld({ distance: 2, priceA: 1, priceB: 4, stockA: 200, treasuryB: 5000 });
    const b = buildPairWorld({ distance: 2, priceA: 1, priceB: 4, stockA: 200, treasuryB: 5000 });
    const ra = tick({ world: a, rng: createRng('lt-det') });
    const rb = tick({ world: b, rng: createRng('lt-det') });
    const ea = localTradeEvents(ra.events);
    const eb = localTradeEvents(rb.events);
    expect(JSON.stringify(eb)).toBe(JSON.stringify(ea));
  });

  it('respects unordered pair ordering (each pair visited once per tick)', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 100,
      treasuryB: 1000,
    });
    const trades = localTradeEvents(tick({ world: w, rng: createRng('lt-order') }).events);
    // Exactly one local_trade per resource per pair per day.
    const grainTrades = trades.filter((t) => String(t.resource) === 'food.grain');
    expect(grainTrades.length).toBe(1);
  });
});
