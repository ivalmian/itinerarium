/**
 * Tax-shipment phase (docs/11 §"Taxes" + codex review #2).
 *
 * Once per month the governor's office assesses harvest + coin taxes
 * across every settlement in the province, queues the assessments,
 * and dispatches a bounded number of tax-shipment caravans per day
 * to physically carry the owed grain / coin / cloth to the capital.
 *
 * Why the dispatch cap: harvest assessments can touch hundreds of
 * settlements; a province dispatches district convoys over weeks,
 * not one caravan per owner/settlement in a single discontinuous
 * burst. The queue persists across days via a WeakMap keyed on the
 * `WorldState` so a fresh world (e.g. a test fixture) starts with
 * an empty queue.
 */

import { MAX_ACTIVE_WORLD_CARAVANS } from '../caravan/limits.js';
import { caravanId as makeCaravanIdLocal } from '../types.js';
import {
  assessTaxes,
  createTaxShipmentCaravan,
  type SettlementTaxView,
  type TaxAssessment,
  type TaxRatesPercent,
} from '../politics/taxShipment.js';
import { getStockAt, removeStockAt, type Actor } from '../politics/actor.js';
import type { Rng } from '../rng.js';
import { resourceId, type ActorId, type Day } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const COIN_RESOURCE = resourceId('goods.coin');

const DEFAULT_TAX_RATES: TaxRatesPercent = {
  harvestPct: 10, // 1/10 of recent harvest as grain tribute
  cartTollPerCart: 0,
  coinTaxPctOfWealth: 1, // 1% monthly coin assessment
};

const MAX_TAX_SHIPMENT_CARAVANS_DISPATCHED_PER_DAY = 1;
const MAX_ACTIVE_TAX_SHIPMENT_CARAVANS = 24;
const MAX_TAX_ASSESSMENTS_PER_CARAVAN = 24;
const pendingTaxAssessmentsByWorld: WeakMap<WorldState, TaxAssessment[]> = new WeakMap();

const compareTaxAssessments = (a: TaxAssessment, b: TaxAssessment): number => {
  const settlement = String(a.fromSettlement).localeCompare(String(b.fromSettlement));
  if (settlement !== 0) return settlement;
  const owner = String(a.fromOwnerActor).localeCompare(String(b.fromOwnerActor));
  if (owner !== 0) return owner;
  const resource = String(a.resource).localeCompare(String(b.resource));
  if (resource !== 0) return resource;
  return a.quantityOwed - b.quantityOwed;
};

const activeTaxShipmentCaravanCount = (world: WorldState): number => {
  let count = 0;
  for (const caravan of world.caravans.values()) {
    if (String(caravan.id).startsWith('tax-')) count += 1;
  }
  return count;
};

const pendingTaxQueueForWorld = (world: WorldState): TaxAssessment[] => {
  let queue = pendingTaxAssessmentsByWorld.get(world);
  if (queue === undefined) {
    queue = [];
    pendingTaxAssessmentsByWorld.set(world, queue);
  }
  return queue;
};

/**
 * Whether the world has any tax assessments queued for dispatch.
 * Used by the tick orchestrator to skip the phase entirely on days
 * with no pending work AND no new assessment cadence.
 */
export const hasPendingTaxAssessments = (world: WorldState): boolean =>
  (pendingTaxAssessmentsByWorld.get(world)?.length ?? 0) > 0;

const drainTaxAssessment = (world: WorldState, assessment: TaxAssessment): number => {
  const owner = world.actors.get(assessment.fromOwnerActor);
  if (owner === undefined) return 0;
  if (assessment.resource === COIN_RESOURCE) {
    const drain = Math.min(owner.treasury, assessment.quantityOwed);
    if (drain <= 0) return 0;
    owner.treasury -= drain;
    return drain;
  }
  const have = getStockAt(owner, assessment.fromSettlement, assessment.resource);
  const drain = Math.min(have, assessment.quantityOwed);
  if (drain <= 0) return 0;
  removeStockAt(owner, assessment.fromSettlement, assessment.resource, drain);
  return drain;
};

const takeTaxDispatchBatch = (
  world: WorldState,
  pending: TaxAssessment[],
): { readonly assessment: TaxAssessment; readonly fromSettlement: Settlement } | null => {
  while (pending.length > 0) {
    const seed = pending.shift() as TaxAssessment;
    const fromSettlement = world.settlements.get(seed.fromSettlement);
    if (fromSettlement === undefined) continue;
    const firstDrain = drainTaxAssessment(world, seed);
    if (firstDrain <= 0) continue;

    let total = firstDrain;
    let included = 1;
    for (let i = 0; i < pending.length && included < MAX_TAX_ASSESSMENTS_PER_CARAVAN; ) {
      const candidate = pending[i] as TaxAssessment;
      if (candidate.resource !== seed.resource) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      const drain = drainTaxAssessment(world, candidate);
      if (drain <= 0) continue;
      total += drain;
      included += 1;
    }

    return {
      assessment: { ...seed, quantityOwed: total },
      fromSettlement,
    };
  }
  return null;
};

const remainingWorldCaravanSlots = (world: WorldState, plannedSpawns = 0): number =>
  Math.max(0, MAX_ACTIVE_WORLD_CARAVANS - world.caravans.size - plannedSpawns);

export const taxShipmentPhase = (
  world: WorldState,
  today: Day,
  rng: Rng,
  events: TickEvent[],
): void => {
  // Find the governor (one per province; per docs/11 there's one
  // governor_office actor anchored at the capital).
  let governor: Actor | undefined;
  let capital: Settlement | undefined;
  for (const a of world.actors.values()) {
    if (a.kind === 'governor_office') {
      governor = a;
      break;
    }
  }
  if (governor === undefined) return;
  for (const s of world.settlements.values()) {
    if (s.tier === 'large_city' && s.id === governor.homeSettlement) {
      capital = s;
      break;
    }
  }
  if (capital === undefined) {
    // Fall back: use the largest settlement as the capital.
    let bestPop = -1;
    for (const s of world.settlements.values()) {
      const p = s.population.total();
      if (p > bestPop) {
        bestPop = p;
        capital = s;
      }
    }
  }
  if (capital === undefined) return;

  // Build settlement views: recent harvest = recent grain inflows; coin
  // wealth = sum of stockpile owners' treasuries.
  const settlementViews: SettlementTaxView[] = [];
  for (const s of world.settlements.values()) {
    if (s.id === capital.id) continue; // capital doesn't tax itself
    const harvest = s.market.recentInflows.get(resourceId('food.grain')) ?? 0;
    const cloth = s.market.recentInflows.get(resourceId('goods.cloth')) ?? 0;
    const owners: { id: ActorId; treasury: number }[] = [];
    for (const oId of s.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      owners.push({ id: a.id, treasury: a.treasury });
    }
    if (owners.length === 0) continue;
    settlementViews.push({
      id: s.id,
      tier: s.tier,
      recentHarvestQuantity: Math.max(0, Math.floor(harvest)),
      recentClothProduction: Math.max(0, Math.floor(cloth)),
      ownerActors: owners,
    });
  }

  const assessments = assessTaxes({
    governor,
    taxRatesPercent: DEFAULT_TAX_RATES,
    settlements: settlementViews,
    today,
  });
  const pending = pendingTaxQueueForWorld(world);
  if (assessments.length > 0) {
    pending.push(...assessments.slice().sort(compareTaxAssessments));
  }

  let dispatched = 0;
  const activeTaxShipments = activeTaxShipmentCaravanCount(world);
  while (
    pending.length > 0 &&
    dispatched < MAX_TAX_SHIPMENT_CARAVANS_DISPATCHED_PER_DAY &&
    activeTaxShipments + dispatched < MAX_ACTIVE_TAX_SHIPMENT_CARAVANS &&
    remainingWorldCaravanSlots(world, dispatched) > 0
  ) {
    const batch = takeTaxDispatchBatch(world, pending);
    if (batch === null) break;
    const a = batch.assessment;
    const fromS = batch.fromSettlement;

    const cId = makeCaravanIdLocal(
      `tax-${today}-${String(a.fromSettlement)}-${String(a.fromOwnerActor)}-${String(a.resource)}-${dispatched}`,
    );
    if (world.caravans.has(cId)) continue;
    const caravan = createTaxShipmentCaravan({
      id: cId,
      assessment: a,
      fromHex: fromS.anchor,
      toHex: capital.anchor,
      governorActor: governor.id,
      rng: rng.derive(String(cId)),
    });
    world.caravans.set(cId, caravan);
    dispatched += 1;
    events.push({
      type: 'tax_shipment_dispatched',
      fromSettlement: a.fromSettlement,
      toSettlement: capital.id,
      grainModii: a.resource === resourceId('food.grain') ? a.quantityOwed : 0,
      coin: a.resource === resourceId('goods.coin') ? a.quantityOwed : 0,
    });
  }
};
