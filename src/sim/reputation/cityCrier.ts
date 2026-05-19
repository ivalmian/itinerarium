/**
 * City criers are persistent price-news walkers funded by the patricians.
 *
 * Unlike reputation `NewsCarrier`s, a crier does not disappear after one
 * delivery. He keeps a personal known-price book, walks a city-rural circuit,
 * and only spreads prices he physically observed or received from actors at
 * previous stops.
 */

import { NEWS_CARRIER_SPEED } from './news.js';
import type { ActorId, Day, SettlementId } from '../types.js';
import { createKnownPrices, type KnownPrices } from '../politics/knownPrices.js';
import { hexDistance, type Hex } from '../world/hex.js';

export const CITY_CRIER_SPEED = NEWS_CARRIER_SPEED;

export interface CityCrier {
  readonly id: string;
  readonly city: SettlementId;
  readonly position: Hex;
  readonly destination: Hex;
  readonly movementPointsPerDay: number;
  readonly startedOnDay: Day;
  readonly lastCityCheckinDay: Day;
  /** Greedy city → rural stops → city circuit, with the city at index 0. */
  readonly route: readonly SettlementId[];
  /** Index in `route` for the current destination settlement. */
  readonly routeIndex: number;
  /** Patrician families that paid the most recent spawn/restock bill. */
  readonly paidBy: readonly ActorId[];
  readonly knownPrices: KnownPrices;
}

export interface CreateCityCrierInput {
  readonly id: string;
  readonly city: SettlementId;
  readonly route: readonly SettlementId[];
  readonly spawnHex: Hex;
  readonly destination: Hex;
  readonly spawnDay: Day;
  readonly paidBy: readonly ActorId[];
  readonly speed?: number;
}

export const createCityCrier = (input: CreateCityCrierInput): CityCrier => {
  if (input.id.length === 0) {
    throw new Error('CityCrier id must be non-empty');
  }
  if (input.route.length === 0) {
    throw new Error('CityCrier route must include at least the city');
  }
  if (input.route[0] !== input.city) {
    throw new Error('CityCrier route must start with its city');
  }
  const speed = input.speed ?? CITY_CRIER_SPEED;
  if (!(speed > 0) || !Number.isFinite(speed)) {
    throw new Error(`CityCrier speed must be positive finite, got ${speed}`);
  }
  const routeIndex = input.route.length > 1 ? 1 : 0;
  return {
    id: input.id,
    city: input.city,
    position: input.spawnHex,
    destination: input.destination,
    movementPointsPerDay: speed,
    startedOnDay: input.spawnDay,
    lastCityCheckinDay: input.spawnDay,
    route: [...input.route],
    routeIndex,
    paidBy: [...input.paidBy],
    knownPrices: createKnownPrices(),
  };
};

export const nextRouteIndex = (crier: CityCrier): number => {
  if (crier.route.length <= 1) return 0;
  return (crier.routeIndex + 1) % crier.route.length;
};

export const routeNeedsTravel = (crier: CityCrier): boolean =>
  crier.route.length > 1 && hexDistance(crier.position, crier.destination) > 0;
