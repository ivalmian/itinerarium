/**
 * Actors: the named owners and decision-makers in the world.
 *
 * Every workshop, field, mine, herd, and stockpile in the game
 * belongs to exactly one Actor (docs/11 §"Hex-level ownership").
 * Patrician families, free villages, common households, hamlet households, the
 * governor's office, temples, bandit camps, caravan owners, the
 * player, off-map merchant houses, and city corporations are all
 * Actors.
 *
 * This module owns the ledger surface: an Actor holds a stockpile
 * (a `Map<SettlementId, Map<ResourceId, Quantity>>` per docs/15 §C30
 * — inventory is keyed by the settlement where it physically lives,
 * so the same actor can hold goods at multiple settlements but the
 * pools are distinct) and a treasury. Reputation, succession,
 * faction membership, and policy are layered on top (factions in
 * `faction.ts`; reputation in T-future).
 *
 * Design references:
 *   docs/11-politics-and-ownership.md
 *   docs/15-v1-5-cleanups.md §C30
 */

import type { ActorId, Coin, Quantity, ResourceId, SettlementId } from '../types.js';
import { createKnownPrices, type KnownPrices } from './knownPrices.js';

/**
 * Kinds of Actor. See docs/11 §"Every faction has named characters".
 *
 * Per docs/15 §C21 the legacy `common_household` aggregate was split into
 * three per-class household kinds: `plebeian_household`, `freedman_household`,
 * `foreigner_household`. Each carries its own treasury and stockpile so
 * per-class demand is bounded by that class's own cash, not a city-wide
 * aggregate pool. Slaves remain owner-funded (no `slave_household` kind).
 */
export type ActorKind =
  | 'patrician_family'
  | 'free_village'
  | 'plebeian_household'
  | 'freedman_household'
  | 'foreigner_household'
  | 'hamlet_household'
  | 'governor_office'
  | 'temple'
  | 'bandit_camp'
  | 'caravan_owner'
  | 'player'
  | 'off_map_house'
  | 'city_corporation'
  | 'merchant_guild';

export const ACTOR_KINDS = [
  'patrician_family',
  'free_village',
  'plebeian_household',
  'freedman_household',
  'foreigner_household',
  'hamlet_household',
  'governor_office',
  'temple',
  'bandit_camp',
  'caravan_owner',
  'player',
  'off_map_house',
  'city_corporation',
  'merchant_guild',
] as const satisfies readonly ActorKind[];

/**
 * The set of household kinds whose treasury / stockpile represents a single
 * class of free residents at one settlement. Hamlet / free-village actors are
 * NOT in this set — they are political entities that own land and exist
 * regardless of class mix.
 */
export const CLASS_HOUSEHOLD_KINDS = [
  'plebeian_household',
  'freedman_household',
  'foreigner_household',
] as const satisfies readonly ActorKind[];

export type ClassHouseholdKind = (typeof CLASS_HOUSEHOLD_KINDS)[number];

export interface Actor {
  readonly id: ActorId;
  readonly kind: ActorKind;
  /** Display name, e.g. 'Family Vibian of Aquileia'. */
  readonly name: string;
  /**
   * Settlement the actor is anchored to. Patrician families have
   * a city; free villages have themselves; off-map houses and the
   * player have none. Bandit camps are anchored to a hex (not a
   * settlement) and tracked elsewhere.
   */
  readonly homeSettlement?: SettlementId;
  /**
   * Per docs/15 §C30: actor inventory is keyed by the settlement where it
   * physically lives. The outer key is a SettlementId; the inner Map holds
   * resource quantities. Empty inner maps are pruned (an actor with no
   * slice at S has `stockpile.has(S) === false`). Zero entries inside
   * each inner map are also pruned by the helpers below.
   *
   * For actors with `homeSettlement` defined this map will typically have
   * a single key. Actors that legitimately hold inventory at multiple
   * settlements (e.g., off-map factor consignments, future merchant
   * warehouses) have multiple keys; the same modius is never counted
   * twice because each key holds its own physical slice.
   */
  readonly stockpile: Map<SettlementId, Map<ResourceId, Quantity>>;
  /**
   * Per-actor information-asymmetric price map (docs/06 §"Caravan
   * information model"). Outer key = settlement, inner key = resource;
   * the observation records the best bid/ask seen there and the day
   * it was stamped. There is no global price oracle — this map is the
   * only thing the actor knows about prices anywhere. See
   * `knownPrices.ts` for helpers and the 180-day staleness rule.
   */
  readonly knownPrices: KnownPrices;
  /** Liquid coin. Mutable by design; ledger movements are at the call site. */
  treasury: Coin;
}

export interface CreateActorInput {
  readonly id: ActorId;
  readonly kind: ActorKind;
  readonly name: string;
  readonly homeSettlement?: SettlementId;
  readonly treasury?: Coin;
}

export const createActor = (input: CreateActorInput): Actor => {
  if (input.name.length === 0) {
    throw new Error(`Actor ${input.id} must have a non-empty name`);
  }
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    ...(input.homeSettlement !== undefined ? { homeSettlement: input.homeSettlement } : {}),
    stockpile: new Map(),
    knownPrices: createKnownPrices(),
    treasury: input.treasury ?? 0,
  };
};

// --- Integer-coin treasury helpers (v1.6 pass 27) --------------------------
//
// Per docs/08 §"Integer-coin prices" + user direction (2025-05-17):
// treasury is ALWAYS integer coin. Every mutation rounds at the
// assignment so floating-point drift can't accumulate. Use these
// helpers at every call site; direct `treasury += x` is being
// migrated out.

interface CoinHolder {
  treasury: Coin;
}

/** Increase `holder`'s treasury by `delta` (rounded). Negative `delta` allowed (becomes subtract). */
export const addCoin = (holder: CoinHolder, delta: number): void => {
  if (!Number.isFinite(delta)) return;
  holder.treasury = Math.max(0, Math.round(holder.treasury + delta));
};

/** Decrease `holder`'s treasury by `delta` (rounded). Clamps to ≥0. */
export const subtractCoin = (holder: CoinHolder, delta: number): void => {
  if (!Number.isFinite(delta)) return;
  holder.treasury = Math.max(0, Math.round(holder.treasury - delta));
};

/** Set the treasury directly (rounded, clamped ≥0). */
export const setCoin = (holder: CoinHolder, value: number): void => {
  if (!Number.isFinite(value)) {
    holder.treasury = 0;
    return;
  }
  holder.treasury = Math.max(0, Math.round(value));
};

/** Whole-coin integer of any number (rounds, clamps ≥0). */
export const intCoin = (n: number): number => {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
};

// --- Per-settlement stockpile accessors (docs/15 §C30) ---------------------

/** Quantity an actor holds of `resource` at `settlement`. 0 if absent. */
export const getStockAt = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
): Quantity => {
  return actor.stockpile.get(settlement)?.get(resource) ?? 0;
};

/**
 * Sum of an actor's holdings of `resource` across every settlement they
 * keep inventory at. Intended for debug / UI / invariants — production
 * code should normally use `getStockAt` with an explicit settlement.
 */
export const actorTotalStock = (actor: Actor, resource: ResourceId): Quantity => {
  let total = 0;
  for (const slice of actor.stockpile.values()) {
    total += slice.get(resource) ?? 0;
  }
  return total;
};

/** Iterate the settlements at which the actor currently keeps any inventory. */
export const actorSettlementsWithStock = function* (actor: Actor): IterableIterator<SettlementId> {
  for (const s of actor.stockpile.keys()) yield s;
};

/**
 * Iterate (resource, quantity) at a single settlement slice. Yields nothing
 * if the actor has no inventory at that settlement.
 */
export const actorStockEntriesAt = function* (
  actor: Actor,
  settlement: SettlementId,
): IterableIterator<readonly [ResourceId, Quantity]> {
  const slice = actor.stockpile.get(settlement);
  if (slice === undefined) return;
  for (const entry of slice) yield entry;
};

const requirePositiveInteger = (qty: Quantity, label: string): void => {
  if (!Number.isFinite(qty) || !Number.isInteger(qty)) {
    throw new Error(`${label} must be an integer, got ${qty}`);
  }
  if (qty <= 0) {
    throw new Error(`${label} must be positive, got ${qty}`);
  }
};

/**
 * Add to an actor's stockpile at `settlement`. Use this in seed / test
 * code where the qty is an integer; sim code that mutates fractional
 * quantities should use `addStockAt` (no integer check).
 */
export const addToStockpile = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  requirePositiveInteger(qty, 'addToStockpile qty');
  addStockAt(actor, settlement, resource, qty);
};

/** Add to an actor's stockpile at `settlement`. Tolerates fractional qty. */
export const addStockAt = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  if (qty <= 0) return;
  let slice = actor.stockpile.get(settlement);
  if (slice === undefined) {
    slice = new Map();
    actor.stockpile.set(settlement, slice);
  }
  slice.set(resource, (slice.get(resource) ?? 0) + qty);
};

/**
 * Remove `qty` from an actor's stockpile at `settlement`. Asserts that
 * the actor actually has enough; throws otherwise so the caller catches
 * the bug rather than silently going negative.
 */
export const removeFromStockpile = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  requirePositiveInteger(qty, 'removeFromStockpile qty');
  const slice = actor.stockpile.get(settlement);
  const current = slice?.get(resource) ?? 0;
  if (current < qty) {
    throw new Error(
      `Cannot remove ${qty} of ${String(resource)} from actor ${String(actor.id)} at ${String(settlement)}: only ${current} available`,
    );
  }
  removeStockAt(actor, settlement, resource, qty);
};

/**
 * Remove up to `qty` from an actor's stockpile at `settlement`. Clamps
 * fractional-precision drift to zero; if the resulting slice is empty
 * the inner map is pruned, and if the settlement key has no resources
 * left the outer key is also pruned.
 */
export const removeStockAt = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  if (qty <= 0) return;
  const slice = actor.stockpile.get(settlement);
  if (slice === undefined) return;
  const current = slice.get(resource) ?? 0;
  const remaining = current - qty;
  if (remaining <= 1e-9) {
    slice.delete(resource);
    if (slice.size === 0) actor.stockpile.delete(settlement);
  } else {
    slice.set(resource, remaining);
  }
};
