/**
 * Supply-side of market clearing. One owner-stockpile produces one
 * SupplySource — a step function with quantity 0 below the reservation
 * price and `availableToSell` at or above it.
 *
 * Source: docs/08-money-and-trade.md "Modern microeconomic pricing" and
 * "Supply: how it forms".
 *
 * Reservation price (locked):
 *
 *   raw = max(productionCost, expectedFuturePrice)
 *   urgencyAdjusted = raw / (1 + ownerUrgencyFactor + spoilagePressure)
 *   reservation = max(productionCost, minimumReservationPrice, urgencyAdjusted)
 *
 *   spoilagePressure (perishables only):
 *     when spoilageDaysRemaining < storageHoldingDays:
 *       1 - spoilageDaysRemaining / storageHoldingDays   ∈ (0, 1]
 *     otherwise: 0
 *
 * In modern terms, this is an owner-specific ask price: productionCost is
 * the marginal-cost floor, expectedFuturePrice is the opportunity cost of
 * holding inventory, and the divisor models liquidity pressure and spoilage
 * pressure lowering the owner's ask. The floor prevents a desperate
 * non-perishable seller from destroying the local price signal by selling
 * below marginal/salvage value; urgency discounts the opportunity premium,
 * not the physical cost floor.
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
  readonly minimumReservationPrice?: number;
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

interface MutableSupplySource {
  id: string;
  ownerActor: ActorId;
  reservationPrice: number;
  availableToSell: number;
  quantityAt(price: number): number;
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

const supplySourceQuantityAt = function (this: SupplySource, price: number): number {
  if (this.availableToSell <= 0) return 0;
  return price >= this.reservationPrice ? this.availableToSell : 0;
};

export const ownerSupply = (opts: OwnerSupplyOpts): SupplySource => {
  return ownerSupplyDirect(
    opts.id ?? nextId(),
    opts.ownerActor,
    opts.stockpile,
    opts.reservedForOwnUse,
    opts.productionCost,
    opts.minimumReservationPrice,
    opts.expectedFuturePrice,
    opts.spoilageDaysRemaining,
    opts.ownerUrgencyFactor,
    opts.storageHoldingDays,
  );
};

export const ownerSupplyDirect = (
  id: string,
  ownerActor: ActorId,
  stockpile: number,
  reservedForOwnUse: number,
  productionCost: number,
  minimumReservationPrice: number | undefined,
  expectedFuturePrice: number,
  spoilageDaysRemaining: number | undefined,
  ownerUrgencyFactor: number,
  storageHoldingDays: number,
): SupplySource => {
  const availableToSell = Math.max(0, stockpile - reservedForOwnUse);
  const raw = Math.max(productionCost, expectedFuturePrice);
  const spoilagePressure = computeSpoilagePressure(
    spoilageDaysRemaining,
    storageHoldingDays,
  );
  const divisor = 1 + Math.max(0, ownerUrgencyFactor) + spoilagePressure;
  const urgencyAdjusted = divisor > 0 ? raw / divisor : raw;
  const floor = Math.max(0, productionCost, minimumReservationPrice ?? 0);
  const source: MutableSupplySource = {
    id,
    ownerActor,
    reservationPrice: Math.max(floor, urgencyAdjusted),
    availableToSell,
    quantityAt: supplySourceQuantityAt,
  };
  return source;
};

export const quantityAtSupplySource = (source: SupplySource, price: number): number => {
  if (source.availableToSell <= 0) return 0;
  return price >= source.reservationPrice ? source.availableToSell : 0;
};

const supplyTotalAt = function (this: SupplySchedule, price: number): number {
  let sum = 0;
  for (const s of this.sources) sum += quantityAtSupplySource(s, price);
  return sum;
};

const supplyBreakpoints = function (this: SupplySchedule): readonly SupplyBreakpoint[] {
  const bps: SupplyBreakpoint[] = [];
  for (const s of this.sources) {
    if (s.availableToSell > 0) {
      bps.push({ price: s.reservationPrice, quantityChange: s.availableToSell });
    }
  }
  bps.sort((a, b) => a.price - b.price);
  return bps;
};

export const aggregateSupply = (sources: readonly SupplySource[]): SupplySchedule => ({
  sources,
  totalAt: supplyTotalAt,
  breakpoints: supplyBreakpoints,
});
