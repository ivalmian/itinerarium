/**
 * Supply-side of market clearing. One owner-stockpile produces one
 * SupplySource — a step function with quantity 0 below the reservation
 * price and `availableToSell` at or above it.
 *
 * Source: docs/08-money-and-trade.md "Supply: how it forms".
 *
 * Reservation price (locked):
 *
 *   raw = max(productionCost, expectedFuturePrice)
 *   reservation = raw / (1 + ownerUrgencyFactor + spoilagePressure)
 *
 *   spoilagePressure (perishables only):
 *     when spoilageDaysRemaining < storageHoldingDays:
 *       1 - spoilageDaysRemaining / storageHoldingDays   ∈ (0, 1]
 *     otherwise: 0
 *
 * The doc writes spoilage as a discount on the future-price term and
 * urgency as a divisor; here we fold spoilage into the urgency divisor
 * because both have the same emergent meaning ("dump it cheaper, fast")
 * and folding keeps the formula uniform. The two formulations agree at
 * the limits (no spoilage / full spoilage) and the docs are explicit
 * that the structural property — "near-spoilage lowers reservation" —
 * matters more than the exact algebra.
 *
 * "Patrician hoarder" emerges naturally: ownerUrgencyFactor=0 and a
 * high expectedFuturePrice keeps the reservation high; "poor seller"
 * with ownerUrgencyFactor>0 cuts the reservation by the divisor.
 */

import type { ActorId } from '../types.js';

export interface SupplySource {
  readonly id: string;
  readonly ownerActor: ActorId;
  readonly reservationPrice: number;
  readonly availableToSell: number;
  quantityAt(price: number): number;
}

export interface OwnerSupplyOpts {
  readonly id?: string;
  readonly ownerActor: ActorId;
  readonly stockpile: number;
  readonly reservedForOwnUse: number;
  readonly productionCost: number;
  readonly expectedFuturePrice: number;
  /**
   * Days of spoilage remaining for the stockpile, only meaningful for
   * perishables. Omit for non-perishable goods (no spoilage pressure).
   */
  readonly spoilageDaysRemaining?: number;
  /** 0 = patient (rich); 1 = ordinary; 2+ = desperate (subsistence-class). */
  readonly ownerUrgencyFactor: number;
  readonly storageHoldingDays: number;
}

export interface SupplyBreakpoint {
  readonly price: number;
  /** Positive: extra quantity available once price reaches this point. */
  readonly quantityChange: number;
}

export interface SupplySchedule {
  readonly sources: readonly SupplySource[];
  totalAt(price: number): number;
  breakpoints(): readonly SupplyBreakpoint[];
}

let autoId = 0;
const nextId = (): string => `supply#${++autoId}`;

const computeSpoilagePressure = (
  spoilageDaysRemaining: number | undefined,
  storageHoldingDays: number,
): number => {
  if (spoilageDaysRemaining === undefined) return 0;
  if (storageHoldingDays <= 0) return 0;
  if (spoilageDaysRemaining >= storageHoldingDays) return 0;
  // Linear ramp from 0 (fresh) to 1 (already spoiled).
  const fraction = 1 - spoilageDaysRemaining / storageHoldingDays;
  return Math.max(0, Math.min(1, fraction));
};

export const ownerSupply = (opts: OwnerSupplyOpts): SupplySource => {
  const id = opts.id ?? nextId();
  const availableToSell = Math.max(0, opts.stockpile - opts.reservedForOwnUse);
  const raw = Math.max(opts.productionCost, opts.expectedFuturePrice);
  const spoilagePressure = computeSpoilagePressure(
    opts.spoilageDaysRemaining,
    opts.storageHoldingDays,
  );
  const divisor = 1 + Math.max(0, opts.ownerUrgencyFactor) + spoilagePressure;
  const reservationPrice = divisor > 0 ? raw / divisor : raw;
  return {
    id,
    ownerActor: opts.ownerActor,
    reservationPrice,
    availableToSell,
    quantityAt(price: number): number {
      if (availableToSell <= 0) return 0;
      return price >= reservationPrice ? availableToSell : 0;
    },
  };
};

export const aggregateSupply = (sources: readonly SupplySource[]): SupplySchedule => {
  const cached: SupplySource[] = sources.slice();
  return {
    sources: cached,
    totalAt(price: number): number {
      let sum = 0;
      for (const s of cached) sum += s.quantityAt(price);
      return sum;
    },
    breakpoints(): readonly SupplyBreakpoint[] {
      const bps: SupplyBreakpoint[] = [];
      for (const s of cached) {
        if (s.availableToSell > 0) {
          bps.push({ price: s.reservationPrice, quantityChange: s.availableToSell });
        }
      }
      bps.sort((a, b) => a.price - b.price);
      return bps;
    },
  };
};
