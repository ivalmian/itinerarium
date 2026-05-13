/**
 * Storage + natural-perishable spoilage phase.
 *
 * Two distinct mechanisms collapsed into a single per-day phase:
 *
 *  1. **Natural short-perishable spoilage.** Resources with a small
 *     `perishableDays` (≤ 14: bread, milk, fish, salted meat in some
 *     climates) lose a daily fraction `1 − exp(−1/perishableDays)`
 *     of every owner's stockpile regardless of storage cap. This is
 *     how a baker's day-old bread stops being food.
 *
 *  2. **Above-capacity spoilage** (docs/15 §C10). When a settlement's
 *     combined stockpile of a perishable resource exceeds the
 *     aggregate storage cap (per-resource + wildcard kg pool), the
 *     excess decays at 0.2 % / day spread proportionally across
 *     owners with stock. Hard goods (iron, tools, cut stone) sit
 *     in stockpiles indefinitely.
 *
 *     A `SPOILAGE_GRACE_DAYS = 365` floor delays this for a year so
 *     bootstrap stockpiles from procgen have time to be consumed
 *     naturally before storage caps kick in.
 *
 * Originally lived inline in `src/sim/tick.ts`; moved here to keep
 * the orchestrator slim.
 */

import { actorStockEntriesAt, getStockAt, removeStockAt, type Actor } from '../politics/actor.js';
import { getResource } from '../resources/catalog.js';
import type { ResourceId, SettlementId } from '../types.js';
import { computeStorageCapacity } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const SPOILAGE_RATE_PER_DAY = 0.002; // 0.2% per day above cap
const NATURAL_SPOILAGE_MAX_DAYS = 14;
const SPOILAGE_GRACE_DAYS = 365;

const isPerishable = (resource: ResourceId): boolean => {
  const def = getResource(resource);
  return def.perishableDays !== undefined && def.perishableDays > 0;
};

const naturalSpoilageFractionForResource = (resource: ResourceId): number => {
  const days = getResource(resource).perishableDays;
  if (days === undefined || days <= 0 || days > NATURAL_SPOILAGE_MAX_DAYS) return 0;
  return 1 - Math.exp(-1 / days);
};

const drainSpoilageProportional = (
  owners: readonly Actor[],
  settlement: SettlementId,
  resource: ResourceId,
  totalSpoil: number,
): void => {
  if (owners.length === 0 || totalSpoil <= 1e-9) return;
  // Weighted by current stock. Spoil more from the bigger holders.
  let totalStock = 0;
  for (const a of owners) totalStock += getStockAt(a, settlement, resource);
  if (totalStock <= 0) return;
  for (const a of owners) {
    const have = getStockAt(a, settlement, resource);
    if (have <= 0) continue;
    const share = (have / totalStock) * totalSpoil;
    if (share > 0) removeStockAt(a, settlement, resource, share);
  }
};

const naturalShortPerishableSpoilagePhase = (
  world: WorldState,
  events: TickEvent[],
): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const totalByResource = new Map<ResourceId, number>();
    const ownersWithStock = new Map<ResourceId, Actor[]>();

    for (const oId of settlement.stockpileOwners) {
      const actor = world.actors.get(oId);
      if (actor === undefined) continue;
      for (const [resource, qty] of actorStockEntriesAt(actor, settlement.id)) {
        if (qty <= 0) continue;
        const fraction = naturalSpoilageFractionForResource(resource);
        if (fraction <= 0) continue;
        totalByResource.set(resource, (totalByResource.get(resource) ?? 0) + qty);
        let owners = ownersWithStock.get(resource);
        if (owners === undefined) {
          owners = [];
          ownersWithStock.set(resource, owners);
        }
        owners.push(actor);
      }
    }

    for (const [resource, total] of totalByResource) {
      const fraction = naturalSpoilageFractionForResource(resource);
      const spoil = total * fraction;
      if (spoil <= 1e-9) continue;
      drainSpoilageProportional(
        ownersWithStock.get(resource) ?? [],
        settlement.id,
        resource,
        spoil,
      );
      events.push({
        type: 'storage_spoilage',
        settlement: settlement.id,
        resource,
        spoiled: spoil,
      });
    }
  }
};

export const storageSpoilagePhase = (world: WorldState, events: TickEvent[]): void => {
  naturalShortPerishableSpoilagePhase(world, events);
  if (world.day < SPOILAGE_GRACE_DAYS) return;
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const cap = computeStorageCapacity(settlement);

    const totalByResource = new Map<ResourceId, number>();
    const ownersWithStock = new Map<ResourceId, Actor[]>();
    let wildcardKgUsed = 0;

    for (const oId of settlement.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      for (const [r, qty] of actorStockEntriesAt(a, settlement.id)) {
        if (qty <= 0) continue;
        totalByResource.set(r, (totalByResource.get(r) ?? 0) + qty);
        let arr = ownersWithStock.get(r);
        if (arr === undefined) {
          arr = [];
          ownersWithStock.set(r, arr);
        }
        arr.push(a);
        if (!cap.perResource.has(r)) {
          wildcardKgUsed += qty * getResource(r).weightKgPerUnit;
        }
      }
    }

    // Per-resource caps first. Only perishable resources spoil.
    for (const [r, total] of totalByResource) {
      if (!isPerishable(r)) continue;
      const limit = cap.perResource.get(r);
      if (limit === undefined) continue;
      if (total <= limit) continue;
      const excess = total - limit;
      const spoil = excess * SPOILAGE_RATE_PER_DAY;
      drainSpoilageProportional(ownersWithStock.get(r) ?? [], settlement.id, r, spoil);
      events.push({
        type: 'storage_spoilage',
        settlement: settlement.id,
        resource: r,
        spoiled: spoil,
      });
    }

    // Wildcard pool: only perishables spoil. Hard goods stack up.
    if (wildcardKgUsed > cap.wildcardKg && cap.wildcardKg > 0) {
      let perishableKgUsed = 0;
      for (const [r, total] of totalByResource) {
        if (cap.perResource.has(r)) continue;
        if (!isPerishable(r)) continue;
        perishableKgUsed += total * getResource(r).weightKgPerUnit;
      }
      if (perishableKgUsed <= 0) continue;
      const overflowKg = wildcardKgUsed - cap.wildcardKg;
      const overflowPerishableShare = Math.min(overflowKg, perishableKgUsed);
      const spoilFraction = (overflowPerishableShare * SPOILAGE_RATE_PER_DAY) / perishableKgUsed;
      for (const [r, total] of totalByResource) {
        if (cap.perResource.has(r)) continue;
        if (!isPerishable(r)) continue;
        const spoil = total * spoilFraction;
        if (spoil <= 0) continue;
        drainSpoilageProportional(ownersWithStock.get(r) ?? [], settlement.id, r, spoil);
        events.push({
          type: 'storage_spoilage',
          settlement: settlement.id,
          resource: r,
          spoiled: spoil,
        });
      }
    }
  }
};
