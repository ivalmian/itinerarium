/**
 * City crier phase.
 *
 * One patrician-funded crier per city walks a deterministic greedy rural
 * circuit and returns home after the loop. At each stop he records the local
 * market and mutually merges his personal known-price map with resident
 * actors there. If a city has no crier, or its crier has not checked back
 * into the city for over a month, the patricians fund a replacement.
 */

import type { WorldState } from '../../procgen/seed.js';
import { subtractCoin, type Actor } from '../politics/actor.js';
import {
  mergeKnownPriceMaps,
  recordKnownPriceObservation,
} from '../politics/knownPrices.js';
import {
  createCityCrier,
  nextRouteIndex,
  type CityCrier,
} from '../reputation/cityCrier.js';
import { advanceFootTravelerWithGrid } from '../reputation/newsMovement.js';
import type { TickEvent } from '../tick.js';
import type { ActorId, Day, SettlementId } from '../types.js';
import { addRoadWear, WEAR_PER_NEWS_CARRIER } from '../world/roadWear.js';
import type { Settlement } from '../world/settlement.js';
import { hexDistance, hexEquals } from '../world/hex.js';
import type { Season } from '../world/terrain.js';
import { snapshotSettlementMarket } from './homePresenceSync.js';

export const CITY_CRIER_MISSING_DAYS = 30;
export const CITY_CRIER_RESTOCK_COST = 12;

const isCity = (settlement: Settlement): boolean =>
  settlement.tier === 'small_city' || settlement.tier === 'large_city';

const isRuralStop = (settlement: Settlement): boolean =>
  settlement.tier === 'village' || settlement.tier === 'hamlet';

const crierIdForCity = (city: SettlementId): string => `city-crier:${String(city)}`;

const sortedSettlements = (world: WorldState): Settlement[] =>
  [...world.settlements.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));

const cityPatricians = (world: WorldState, city: SettlementId): Actor[] =>
  [...world.actors.values()]
    .filter((actor) => actor.kind === 'patrician_family' && actor.homeSettlement === city)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

const nearestCity = (world: WorldState, settlement: Settlement): Settlement | undefined => {
  const cities = sortedSettlements(world).filter(isCity);
  let best: Settlement | undefined;
  let bestDistance = Infinity;
  for (const city of cities) {
    const distance = hexDistance(settlement.anchor, city.anchor);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== undefined && String(city.id) < String(best.id))
    ) {
      best = city;
      bestDistance = distance;
    }
  }
  return best;
};

const tiedCityForRuralStop = (
  world: WorldState,
  settlement: Settlement,
): Settlement | undefined => {
  if (settlement.clientPatron !== undefined) {
    const patron = world.actors.get(settlement.clientPatron);
    if (patron?.homeSettlement !== undefined) {
      const patronCity = world.settlements.get(patron.homeSettlement);
      if (patronCity !== undefined && isCity(patronCity)) return patronCity;
    }
  }
  return nearestCity(world, settlement);
};

/**
 * Deterministic nearest-neighbor circuit: start at the city, repeatedly visit
 * the closest unvisited tied village/hamlet, then wrap back to the city.
 */
export const greedyCityCrierRoute = (
  world: WorldState,
  city: Settlement,
): readonly SettlementId[] => {
  const unvisited = sortedSettlements(world).filter((settlement) => {
    if (!isRuralStop(settlement)) return false;
    return tiedCityForRuralStop(world, settlement)?.id === city.id;
  });
  const route: SettlementId[] = [city.id];
  let current = city;
  while (unvisited.length > 0) {
    let bestIndex = 0;
    let best = unvisited[0] as Settlement;
    let bestDistance = hexDistance(current.anchor, best.anchor);
    for (let i = 1; i < unvisited.length; i++) {
      const candidate = unvisited[i] as Settlement;
      const distance = hexDistance(current.anchor, candidate.anchor);
      if (
        distance < bestDistance ||
        (distance === bestDistance && String(candidate.id) < String(best.id))
      ) {
        bestIndex = i;
        best = candidate;
        bestDistance = distance;
      }
    }
    route.push(best.id);
    current = best;
    unvisited.splice(bestIndex, 1);
  }
  return route;
};

const payRestockCost = (
  world: WorldState,
  city: SettlementId,
  costCoin: number,
): readonly ActorId[] | undefined => {
  const payers = cityPatricians(world, city).filter((actor) => actor.treasury > 0);
  const total = payers.reduce((sum, actor) => sum + actor.treasury, 0);
  if (total < costCoin) return undefined;
  let remaining = costCoin;
  const paidBy: ActorId[] = [];
  for (let i = 0; i < payers.length && remaining > 0; i++) {
    const payer = payers[i] as Actor;
    const remainingPayers = payers.length - i;
    const share = Math.min(payer.treasury, Math.ceil(remaining / remainingPayers));
    if (share <= 0) continue;
    subtractCoin(payer, share);
    remaining -= share;
    paidBy.push(payer.id);
  }
  return remaining <= 0 ? paidBy : undefined;
};

const localActorsAt = (world: WorldState, settlement: Settlement): Actor[] => {
  const ids = new Set<ActorId>(settlement.stockpileOwners);
  for (const actor of world.actors.values()) {
    if (actor.homeSettlement === settlement.id) ids.add(actor.id);
  }
  return [...ids]
    .map((id) => world.actors.get(id))
    .filter((actor): actor is Actor => actor !== undefined)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
};

const syncCrierAtSettlement = (
  world: WorldState,
  crier: CityCrier,
  settlement: Settlement,
  today: Day,
): number => {
  const obs = snapshotSettlementMarket(settlement, today);
  if (obs.quotes.size > 0) recordKnownPriceObservation(crier.knownPrices, settlement.id, obs);
  let actorCount = 0;
  for (const actor of localActorsAt(world, settlement)) {
    mergeKnownPriceMaps(actor.knownPrices, crier.knownPrices);
    mergeKnownPriceMaps(crier.knownPrices, actor.knownPrices);
    actorCount += 1;
  }
  return actorCount;
};

const spawnCityCrier = (
  world: WorldState,
  city: Settlement,
  today: Day,
  reason: 'initial' | 'missing',
  events: TickEvent[],
): CityCrier | undefined => {
  const route = greedyCityCrierRoute(world, city);
  if (route.length <= 1) return undefined;
  const paidBy = payRestockCost(world, city.id, CITY_CRIER_RESTOCK_COST);
  if (paidBy === undefined) return undefined;
  const firstDestinationId = route.length > 1 ? (route[1] as SettlementId) : city.id;
  const firstDestination = world.settlements.get(firstDestinationId) ?? city;
  const crier = createCityCrier({
    id: crierIdForCity(city.id),
    city: city.id,
    route,
    spawnHex: city.anchor,
    destination: firstDestination.anchor,
    spawnDay: today,
    paidBy,
  });
  syncCrierAtSettlement(world, crier, city, today);
  world.cityCriers?.set(crier.id, crier);
  events.push({
    type: 'city_crier_spawned',
    crier: crier.id,
    city: city.id,
    reason,
    routeStops: route.length,
    costCoin: CITY_CRIER_RESTOCK_COST,
    paidBy,
  });
  return crier;
};

const crierForCity = (world: WorldState, city: SettlementId): CityCrier | undefined => {
  if (world.cityCriers === undefined) return undefined;
  for (const crier of world.cityCriers.values()) {
    if (crier.city === city) return crier;
  }
  return undefined;
};

const ensureCityCriers = (world: WorldState, today: Day, events: TickEvent[]): void => {
  if (world.cityCriers === undefined) {
    (world as { cityCriers: Map<string, CityCrier> }).cityCriers = new Map();
  }
  const cityCriers = world.cityCriers as Map<string, CityCrier>;
  const seenCities = new Set<SettlementId>();
  for (const [id, crier] of [...cityCriers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (seenCities.has(crier.city)) {
      cityCriers.delete(id);
      continue;
    }
    seenCities.add(crier.city);
  }
  for (const city of sortedSettlements(world).filter(isCity)) {
    const existing = crierForCity(world, city.id);
    if (existing !== undefined && today - existing.lastCityCheckinDay <= CITY_CRIER_MISSING_DAYS) {
      continue;
    }
    if (existing !== undefined) cityCriers.delete(existing.id);
    spawnCityCrier(world, city, today, existing === undefined ? 'initial' : 'missing', events);
  }
  for (const [id, crier] of [...cityCriers.entries()]) {
    const city = world.settlements.get(crier.city);
    if (city === undefined || !isCity(city)) cityCriers.delete(id);
  }
};

const advanceDestinationAfterArrival = (
  world: WorldState,
  crier: CityCrier,
  arrivedAt: Settlement,
  today: Day,
  events: TickEvent[],
): CityCrier => {
  const actorCount = syncCrierAtSettlement(world, crier, arrivedAt, today);
  events.push({
    type: 'city_crier_price_synced',
    crier: crier.id,
    settlement: arrivedAt.id,
    actorCount,
    knownSettlements: crier.knownPrices.size,
  });
  let checkedInDay = crier.lastCityCheckinDay;
  let paidBy = crier.paidBy;
  let canDepart = true;
  if (arrivedAt.id === crier.city) {
    checkedInDay = today;
    const restockPayers = payRestockCost(world, crier.city, CITY_CRIER_RESTOCK_COST);
    paidBy = restockPayers ?? [];
    canDepart = restockPayers !== undefined;
    events.push({
      type: 'city_crier_checked_in',
      crier: crier.id,
      city: crier.city,
      costCoin: CITY_CRIER_RESTOCK_COST,
      paidBy,
    });
  }
  if (!canDepart) {
    return {
      ...crier,
      routeIndex: 0,
      destination: arrivedAt.anchor,
      lastCityCheckinDay: checkedInDay,
      paidBy,
    };
  }
  const nextIndex = nextRouteIndex(crier);
  const nextStop = world.settlements.get(crier.route[nextIndex] ?? crier.city);
  const city = world.settlements.get(crier.city);
  const destination = nextStop?.anchor ?? city?.anchor ?? crier.destination;
  return {
    ...crier,
    routeIndex: nextIndex,
    destination,
    lastCityCheckinDay: checkedInDay,
    paidBy,
  };
};

export const cityCrierPhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
): void => {
  ensureCityCriers(world, today, events);
  if (world.cityCriers === undefined || world.cityCriers.size === 0) return;
  for (const [id, crier] of [...world.cityCriers]) {
    if (!world.cityCriers.has(id)) continue;
    const before = crier.position;
    const advanced = advanceFootTravelerWithGrid({
      position: crier.position,
      destination: crier.destination,
      movementPointsPerDay: crier.movementPointsPerDay,
      grid: world.grid,
      season,
    });
    if (!hexEquals(before, advanced.position)) {
      addRoadWear(world, advanced.position, WEAR_PER_NEWS_CARRIER);
    }
    let next: CityCrier = { ...crier, position: advanced.position };
    if (advanced.arrived) {
      const arrivedAt = world.settlements.get(next.route[next.routeIndex] ?? next.city);
      if (arrivedAt !== undefined) {
        next = advanceDestinationAfterArrival(world, next, arrivedAt, today, events);
      }
    }
    world.cityCriers.set(id, next);
  }
};
