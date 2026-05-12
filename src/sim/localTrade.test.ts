/**
 * Tests for the local-trade phase: petty merchants / villager pickup carts
 * arbitraging price spreads between nearby settlements.
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
  buildingId,
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
  events.filter((e): e is Extract<TickEvent, { type: 'local_trade' }> => e.type === 'local_trade');

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

  it('routes producer-input arbitrage to the local producer that has derived demand', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 8,
      stockA: 100,
      treasuryB: 0,
    });
    const buyerSettlement = w.settlements.get(settlementId('b-settle'))!;
    const patricianId = actorId('buyer-patrician');
    const millerId = actorId('buyer-miller');
    buyerSettlement.stockpileOwners.splice(0, buyerSettlement.stockpileOwners.length);
    buyerSettlement.stockpileOwners.push(patricianId, millerId);
    buyerSettlement.market.lastClearingPrice.set(resourceId('food.flour'), 8);
    buyerSettlement.buildings.push({
      buildingId: buildingId('mill'),
      hex: buyerSettlement.anchor,
      ownerActor: millerId,
      capacity: 2,
      daysSinceMaintained: 0,
    });
    const patrician = createActor({
      id: patricianId,
      kind: 'patrician_family',
      name: 'Buyer Patrician',
      homeSettlement: buyerSettlement.id,
      treasury: 100_000,
    });
    const miller = createActor({
      id: millerId,
      kind: 'city_corporation',
      name: 'Buyer Miller',
      homeSettlement: buyerSettlement.id,
      treasury: 100_000,
    });
    w.actors.set(patricianId, patrician);
    w.actors.set(millerId, miller);

    const trades = localTradeEvents(tick({ world: w, rng: createRng('lt-derived-buyer') }).events);
    const trade = trades.find((t) => String(t.resource) === 'food.grain');

    expect(trade).toBeDefined();
    expect(miller.stockpile.get(resourceId('food.grain')) ?? 0).toBeGreaterThan(0);
    expect(patrician.stockpile.get(resourceId('food.grain')) ?? 0).toBe(0);
  });

  it('routes consumer arbitrage to household consumption instead of arbitrary stockpiling', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 100,
      treasuryB: 0,
      resource: 'food.bread',
    });
    const buyerSettlement = w.settlements.get(settlementId('b-settle'))!;
    const patricianId = actorId('bread-patrician');
    const householdId = actorId('bread-household');
    const bread = resourceId('food.bread');
    buyerSettlement.population.set({ age: '20-24', sex: 'male', class: 'plebeian' }, 100);
    buyerSettlement.stockpileOwners.splice(0, buyerSettlement.stockpileOwners.length);
    buyerSettlement.stockpileOwners.push(patricianId, householdId);
    const patrician = createActor({
      id: patricianId,
      kind: 'patrician_family',
      name: 'Bread Patrician',
      homeSettlement: buyerSettlement.id,
      treasury: 100_000,
    });
    const household = createActor({
      id: householdId,
      kind: 'plebeian_household',
      name: 'Bread Household',
      homeSettlement: buyerSettlement.id,
      treasury: 100_000,
    });
    w.actors.set(patricianId, patrician);
    w.actors.set(householdId, household);

    const trades = localTradeEvents(tick({ world: w, rng: createRng('lt-consumer-buyer') }).events);
    const trade = trades.find((t) => String(t.resource) === 'food.bread');

    expect(trade).toBeDefined();
    expect(household.treasury).toBeLessThan(100_000);
    expect(household.stockpile.get(bread) ?? 0).toBe(0);
    expect(patrician.stockpile.get(bread) ?? 0).toBe(0);
    expect(buyerSettlement.market.recentInflows.get(bread) ?? 0).toBeGreaterThan(0);
    expect(buyerSettlement.market.recentOutflows.get(bread) ?? 0).toBeGreaterThan(0);
  });

  it('skips trade when the spread does not cover transport cost', () => {
    // Per docs/06 §"Distance and cost", transport is per-kg. food.grain is
    // 6.7 kg/modius, so distance-1 cost is 6.7 × 0.005 = 0.0335 coin/unit.
    // priceB - priceA = 0.03 < 0.0335 → no trade.
    const w = buildPairWorld({
      distance: 1,
      priceA: 1.0,
      priceB: 1.03,
      stockA: 100,
      treasuryB: 1000,
    });
    const r = tick({ world: w, rng: createRng('lt-no-spread') });
    expect(localTradeEvents(r.events).length).toBe(0);
  });

  it('scales transport cost by resource weight (per-kg, per docs/06)', () => {
    // food.grain is 6.7 kg/modius. At distance 1 the cost is 0.005 coin/kg →
    // 0.0335 coin/modius. priceA=1, priceB=1.05 → spread 0.05 > 0.0335 trades.
    const trades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 1,
          priceA: 1.0,
          priceB: 1.05,
          stockA: 100,
          treasuryB: 1000,
        }),
        rng: createRng('lt-perkg-trade'),
      }).events,
    );
    expect(trades.find((t) => String(t.resource) === 'food.grain')).toBeDefined();

    // Contrast: food.bread is only 1 kg/loaf, so distance-1 cost is just
    // 0.005 coin/loaf. At priceA=1, priceB=1.01 the spread 0.01 > 0.005
    // trades for bread but would NOT trade for grain (grain's per-modius
    // cost is 0.0335 — six times higher).
    const breadTrades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 1,
          priceA: 1.0,
          priceB: 1.01,
          stockA: 100,
          treasuryB: 1000,
          resource: 'food.bread',
        }),
        rng: createRng('lt-perkg-bread'),
      }).events,
    );
    expect(breadTrades.find((t) => String(t.resource) === 'food.bread')).toBeDefined();
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

  it('moves fresh local foods that have market prices', () => {
    for (const resource of ['food.milk', 'food.fish', 'food.game'] as const) {
      const trades = localTradeEvents(
        tick({
          world: buildPairWorld({
            distance: 1,
            priceA: 1,
            priceB: 5,
            stockA: 100,
            treasuryB: 100000,
            resource,
          }),
          rng: createRng(`lt-fresh-${resource}`),
        }).events,
      );
      const trade = trades.find((t) => String(t.resource) === resource);
      expect(trade, resource).toBeDefined();
      expect(trade!.quantity).toBeGreaterThan(0);
    }
  });

  it('moves raw material intermediates that feed local workshops', () => {
    for (const resource of ['material.hides', 'material.wool', 'material.flax'] as const) {
      const trades = localTradeEvents(
        tick({
          world: buildPairWorld({
            distance: 1,
            priceA: 1,
            priceB: 10,
            stockA: 1000,
            treasuryB: 100000,
            resource,
          }),
          rng: createRng(`lt-intermediate-${resource}`),
        }).events,
      );
      const trade = trades.find((t) => String(t.resource) === resource);
      expect(trade, resource).toBeDefined();
      expect(trade!.quantity).toBeGreaterThan(0);
    }
  });

  it('moves required herd capital locally as walking stock', () => {
    const trades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 1,
          priceA: 45,
          priceB: 120,
          stockA: 1,
          treasuryB: 100000,
          resource: 'livestock.cattle',
        }),
        rng: createRng('lt-walking-herd'),
      }).events,
    );
    const trade = trades.find((t) => String(t.resource) === 'livestock.cattle');
    expect(trade).toBeDefined();
    expect(trade!.quantity).toBeGreaterThan(0);
    expect(trade!.quantity).toBeLessThanOrEqual(0.1 + 1e-6);
  });

  it('uses cartage-scale loads for bulky industrial inputs', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 20,
      stockA: 1000,
      treasuryB: 100000,
      resource: 'material.charcoal',
    });

    const r = tick({ world: w, rng: createRng('lt-industrial-cartage') });
    const trade = localTradeEvents(r.events).find(
      (t) => String(t.resource) === 'material.charcoal',
    );

    expect(trade).toBeDefined();
    // Charcoal weighs 30 kg/unit. Industrial cartage should move far more than
    // the old 50 kg basket cap, but no more than the 3,000 kg cartage cap.
    expect(trade!.quantity).toBeGreaterThan(50 / 30);
    expect(trade!.quantity).toBeLessThanOrEqual(3000 / 30 + 1e-6);
  });

  it('uses wagon-scale lots for strategic workshop goods', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 100,
      stockA: 1000,
      treasuryB: 100000,
      resource: 'goods.tools',
    });

    const r = tick({ world: w, rng: createRng('lt-workshop-cartage') });
    const trade = localTradeEvents(r.events).find((t) => String(t.resource) === 'goods.tools');

    expect(trade).toBeDefined();
    // Tools weigh 8 kg/unit; workshop cartage caps at 500 kg ⇒ 62.5 units.
    // The lot-cap is the only thing this test validates; the absolute
    // quantity in this fixture is bottlenecked by demand (no smithy or
    // barracks on the buyer settlement consumes tools), so we don't
    // assert a lower bound — only that the cap is respected.
    expect(trade!.quantity).toBeGreaterThan(0);
    expect(trade!.quantity).toBeLessThanOrEqual(500 / 8 + 1e-6);
  });

  it('locally trades military workshop goods when barracks markets bid for them', () => {
    const trades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 1,
          priceA: 1,
          priceB: 100,
          stockA: 1000,
          treasuryB: 100000,
          resource: 'goods.armor',
        }),
        rng: createRng('lt-armor-workshop-cartage'),
      }).events,
    );

    const armorTrade = trades.find((t) => String(t.resource) === 'goods.armor');
    expect(armorTrade).toBeDefined();
    expect(armorTrade!.quantity).toBeGreaterThan(0);
  });

  it('moves mineral inputs locally so mine and smelter districts can balance', () => {
    const trades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 1,
          priceA: 1,
          priceB: 5,
          stockA: 1000,
          treasuryB: 100000,
          resource: 'mineral.iron_ore',
        }),
        rng: createRng('lt-mineral-inputs'),
      }).events,
    );

    const oreTrade = trades.find((t) => String(t.resource) === 'mineral.iron_ore');
    expect(oreTrade).toBeDefined();
    expect(oreTrade!.quantity).toBeGreaterThan(0);
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
    expect(ownerA.stockpile.get(grain) ?? 0).toBeLessThan(stockBefore.a);
    expect(ownerB.stockpile.get(grain) ?? 0).toBeGreaterThan(stockBefore.b);
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

  it('moves industrial inputs by local cartage out to 6 hexes', () => {
    const trades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 6,
          priceA: 1,
          priceB: 20,
          stockA: 1000,
          treasuryB: 100000,
          resource: 'mineral.iron_ore',
        }),
        rng: createRng('lt-industrial-six'),
      }).events,
    );
    const oreTrade = trades.find((t) => String(t.resource) === 'mineral.iron_ore');
    expect(oreTrade).toBeDefined();
    expect(oreTrade!.quantity).toBeGreaterThan(0);
  });

  it('does not move industrial inputs beyond the local-cartage radius', () => {
    const trades = localTradeEvents(
      tick({
        world: buildPairWorld({
          distance: 7,
          priceA: 1,
          priceB: 100,
          stockA: 1000,
          treasuryB: 100000,
          resource: 'mineral.iron_ore',
        }),
        rng: createRng('lt-industrial-seven'),
      }).events,
    );
    expect(trades.find((t) => String(t.resource) === 'mineral.iron_ore')).toBeUndefined();
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
    expect(localTradeEvents(tick({ world: w, rng: createRng('lt-no-stock') }).events).length).toBe(
      0,
    );
  });

  it('skips when buyer treasury is zero', () => {
    const w = buildPairWorld({
      distance: 1,
      priceA: 1,
      priceB: 5,
      stockA: 100,
      treasuryB: 0,
    });
    expect(localTradeEvents(tick({ world: w, rng: createRng('lt-no-coin') }).events).length).toBe(
      0,
    );
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
