/**
 * Tiny shared wrappers for actor-stockpile mutation.
 *
 * Production, trade, local trade, and caravan phases all push/pull
 * stock at a settlement and occasionally credit coin to an actor's
 * treasury. These wrappers exist mainly as named seams — the
 * underlying primitives in `politics/actor.ts` are addStockAt /
 * removeStockAt, but a phase reading `decreaseStockpile(actor, …)`
 * communicates intent more clearly than `removeStockAt(actor, …)`,
 * and `receiveResourceOrCoin` centralizes the "is this resource
 * actually coin?" branch so every consumer doesn't reimplement it.
 *
 * `EMPTY_RESOURCE_MAP` is a frozen sentinel for places that need a
 * never-mutating ReadonlyMap of stocks (e.g., an actor with no
 * stockpile slice at a given settlement).
 */

import { addCoin, addStockAt, removeStockAt, type Actor } from '../politics/actor.js';
import type { Quantity, ResourceId, SettlementId } from '../types.js';
import { resourceId } from '../types.js';

export const COIN_RESOURCE = resourceId('goods.coin');
export const EMPTY_RESOURCE_MAP: ReadonlyMap<ResourceId, Quantity> = new Map();

export const decreaseStockpile = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  removeStockAt(actor, settlement, resource, qty);
};

export const increaseStockpile = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  addStockAt(actor, settlement, resource, qty);
};

export const receiveResourceOrCoin = (
  actor: Actor,
  settlement: SettlementId,
  resource: ResourceId,
  qty: Quantity,
): void => {
  if (qty <= 0) return;
  if (resource === COIN_RESOURCE) {
    addCoin(actor, qty);
    return;
  }
  increaseStockpile(actor, settlement, resource, qty);
};

export const isServiceResource = (resource: ResourceId): boolean =>
  String(resource).startsWith('service.');
