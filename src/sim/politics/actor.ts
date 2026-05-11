/**
 * Actors: the named owners and decision-makers in the world.
 *
 * Every workshop, field, mine, herd, and stockpile in the game
 * belongs to exactly one Actor (docs/11 §"Hex-level ownership").
 * Patrician families, free villages, hamlet households, the
 * governor's office, temples, bandit camps, caravan owners, the
 * player, off-map merchant houses, and city corporations are all
 * Actors.
 *
 * This module owns the ledger surface: an Actor holds a stockpile
 * (a Map<ResourceId, Quantity>) and a treasury. Reputation,
 * succession, faction membership, and policy are layered on top
 * (factions in `faction.ts`; reputation in T-future).
 *
 * Design references:
 *   docs/11-politics-and-ownership.md
 */

import type { ActorId, Coin, Quantity, ResourceId, SettlementId } from '../types.js';

/** Kinds of Actor. See docs/11 §"Every faction has named characters". */
export type ActorKind =
  | 'patrician_family'
  | 'free_village'
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
  /** Resource holdings. Zeroed entries are pruned. */
  readonly stockpile: Map<ResourceId, Quantity>;
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
    treasury: input.treasury ?? 0,
  };
};

export const getStockpile = (actor: Actor, resource: ResourceId): Quantity => {
  return actor.stockpile.get(resource) ?? 0;
};

const requirePositiveInteger = (qty: Quantity, label: string): void => {
  if (!Number.isFinite(qty) || !Number.isInteger(qty)) {
    throw new Error(`${label} must be an integer, got ${qty}`);
  }
  if (qty <= 0) {
    throw new Error(`${label} must be positive, got ${qty}`);
  }
};

export const addToStockpile = (actor: Actor, resource: ResourceId, qty: Quantity): void => {
  requirePositiveInteger(qty, 'addToStockpile qty');
  const current = actor.stockpile.get(resource) ?? 0;
  actor.stockpile.set(resource, current + qty);
};

export const removeFromStockpile = (actor: Actor, resource: ResourceId, qty: Quantity): void => {
  requirePositiveInteger(qty, 'removeFromStockpile qty');
  const current = actor.stockpile.get(resource) ?? 0;
  if (current < qty) {
    throw new Error(
      `Cannot remove ${qty} of ${String(resource)} from actor ${String(actor.id)}: only ${current} available`,
    );
  }
  const remaining = current - qty;
  if (remaining === 0) {
    actor.stockpile.delete(resource);
  } else {
    actor.stockpile.set(resource, remaining);
  }
};
