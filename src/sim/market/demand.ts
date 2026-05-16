/**
 * Demand-side of market clearing. Each (settlement, resource, day) builds
 * a per-resource DemandSchedule by aggregating four kinds of source curves:
 *
 *   1. subsistence — vertical at need until wealth/need; then wealth/p.
 *   2. comfort     — smooth decay from want toward 0 past the budget.
 *   3. status      — step from want to 0 at a very-high threshold.
 *   4. derived     — step from full producer demand to 0 at break-even.
 *
 * Source: docs/08-money-and-trade.md "Modern microeconomic pricing" and
 * "Demand: how it forms (locked)" plus the population segments described
 * in docs/04-population.md. The shapes encode constrained utility demand
 * (subsistence/comfort/status) and profit-derived input demand.
 *
 * The curves operate on plain numbers; this module is intentionally
 * resource- and actor-agnostic. Callers attach IDs upstream via the
 * source.id field for diagnostics.
 *
 * Comfort decay choice: exponential exp(-x * scale) where x = price/budget.
 * This gives a smooth monotonic decline that is ~37% of peak at price=budget
 * with the default scale of 1, dropping to <1% by ~5 budgets out. The exact
 * shape is tuneable via decayScale; the docs leave the function open and
 * only require "smooth, monotonic, falls to zero".
 */

import type { ActorId } from '../types.js';
import { integerCoinBid } from './wholeUnits.js';

export type DemandCurveKind = 'subsistence' | 'comfort' | 'status' | 'derived';

export interface DemandSource {
  readonly id: string;
  readonly curve: DemandCurveKind;
  quantityAt(price: number): number;
  readonly peakQuantity: number;
  readonly maxWillingnessToPay: number;
  /** Internal fast-path parameter: wealth/budget backing standard curves. */
  readonly curveBudget?: number;
  /** Internal fast-path parameter: exponential scale for comfort curves. */
  readonly curveScale?: number;
  /** Concrete actor whose treasury/stockpile should receive purchases. */
  readonly buyerActor?: ActorId;
  /** Consumer purchases are consumed immediately; producer inputs are stored. */
  readonly buyerDisposition?: 'consume' | 'stockpile';
}

export interface DemandBreakpoint {
  readonly price: number;
  /** Negative for a drop in demanded quantity at this price (above this price). */
  readonly quantityChange: number;
}

export interface DemandSchedule {
  readonly sources: readonly DemandSource[];
  totalAt(price: number): number;
  breakpoints(): readonly DemandBreakpoint[];
}

interface MutableDemandSource {
  id: string;
  curve: DemandCurveKind;
  quantityAt(price: number): number;
  peakQuantity: number;
  maxWillingnessToPay: number;
  curveBudget?: number;
  curveScale?: number;
  buyerActor?: ActorId;
  buyerDisposition?: 'consume' | 'stockpile';
}

let autoId = 0;
const nextId = (prefix: string): string => `${prefix}#${++autoId}`;

// --- Subsistence -------------------------------------------------------------

export interface SubsistenceOpts {
  readonly id?: string;
  readonly needPerDay: number;
  readonly segmentWealth: number;
  readonly buyerActor?: ActorId;
  readonly buyerDisposition?: 'consume' | 'stockpile';
}

const subsistenceQuantityAt = function (this: DemandSource, price: number): number {
  const need = this.peakQuantity;
  if (need <= 0) return 0;
  if (price <= 0) return need;
  const wealth = this.curveBudget ?? 0;
  const threshold = wealth / need; // p above this point causes spending cap.
  if (price <= threshold) return need;
  return wealth / price;
};

export const subsistenceDemand = (opts: SubsistenceOpts): DemandSource => {
  return subsistenceDemandDirect(
    opts.id ?? nextId('subsistence'),
    opts.needPerDay,
    opts.segmentWealth,
    opts.buyerActor,
    opts.buyerDisposition,
  );
};

export const subsistenceDemandDirect = (
  id: string,
  needPerDay: number,
  segmentWealth: number,
  buyerActor?: ActorId,
  buyerDisposition?: 'consume' | 'stockpile',
): DemandSource => {
  const need = Math.max(0, needPerDay);
  const wealth = Math.max(0, segmentWealth);
  const source: MutableDemandSource = {
    id,
    curve: 'subsistence',
    peakQuantity: need,
    curveBudget: wealth,
    // Households will starve before they refuse to pay; the curve is
    // hyperbolic above the wealth/need threshold, never reaching zero.
    maxWillingnessToPay: Number.POSITIVE_INFINITY,
    quantityAt: subsistenceQuantityAt,
  };
  if (buyerActor !== undefined) source.buyerActor = buyerActor;
  if (buyerDisposition !== undefined) source.buyerDisposition = buyerDisposition;
  return source;
};

// --- Comfort ----------------------------------------------------------------

export interface ComfortOpts {
  readonly id?: string;
  readonly wantQuantity: number;
  readonly budget: number;
  readonly buyerActor?: ActorId;
  readonly buyerDisposition?: 'consume' | 'stockpile';
  /** Larger = steeper drop past the budget. Defaults to 1. */
  readonly decayScale?: number;
  /**
   * Price at which the curve is treated as effectively zero, used for
   * breakpoints and for clearing's max-WTP ordering. Defaults to budget * 20
   * which corresponds to <0.0001 of peak under exp(-x) decay.
   */
  readonly cutoffMultiplier?: number;
}

const comfortQuantityAt = function (this: DemandSource, price: number): number {
  const want = this.peakQuantity;
  if (want <= 0) return 0;
  if (price <= 0) return want;
  const budget = this.curveBudget ?? 0;
  if (budget <= 0) return 0;
  const x = price / budget;
  return want * Math.exp(-x * (this.curveScale ?? 1));
};

export const comfortDemand = (opts: ComfortOpts): DemandSource => {
  return comfortDemandDirect(
    opts.id ?? nextId('comfort'),
    opts.wantQuantity,
    opts.budget,
    opts.decayScale ?? 1,
    opts.cutoffMultiplier ?? 20,
    opts.buyerActor,
    opts.buyerDisposition,
  );
};

export const comfortDemandDirect = (
  id: string,
  wantQuantity: number,
  budget: number,
  decayScale = 1,
  cutoffMultiplier = 20,
  buyerActor?: ActorId,
  buyerDisposition?: 'consume' | 'stockpile',
): DemandSource => {
  const want = Math.max(0, wantQuantity);
  const safeBudget = Math.max(0, budget);
  // For zero budget, treat the curve as a vanishing want — any positive
  // price knocks demand out (consumers have nothing to spend on this).
  // Quantize positive WTP to integer ≥ 1 per docs/08 §"Integer-coin
  // prices" (comfort buyers bid in whole coins; sub-1 positives floor to
  // 1, zero stays zero so a cashless segment is still representable).
  const maxWtp = integerCoinBid(safeBudget > 0 ? safeBudget * cutoffMultiplier : 0);
  const source: MutableDemandSource = {
    id,
    curve: 'comfort',
    peakQuantity: want,
    maxWillingnessToPay: maxWtp,
    curveBudget: safeBudget,
    curveScale: decayScale,
    quantityAt: comfortQuantityAt,
  };
  if (buyerActor !== undefined) source.buyerActor = buyerActor;
  if (buyerDisposition !== undefined) source.buyerDisposition = buyerDisposition;
  return source;
};

// --- Status -----------------------------------------------------------------

export interface StatusOpts {
  readonly id?: string;
  readonly wantQuantity: number;
  readonly buyerActor?: ActorId;
  readonly buyerDisposition?: 'consume' | 'stockpile';
  /**
   * Pool of cash/assets backing the elite segment's status spend. Currently
   * unused for shape (status is a step), but plumbed for future tuning where
   * a dynastic family with no cash should not bid on luxuries.
   */
  readonly segmentWealth: number;
  readonly veryHighThreshold: number;
}

const stepQuantityAt = function (this: DemandSource, price: number): number {
  if (this.peakQuantity <= 0) return 0;
  return price <= this.maxWillingnessToPay ? this.peakQuantity : 0;
};

export const statusDemand = (opts: StatusOpts): DemandSource => {
  return statusDemandDirect(
    opts.id ?? nextId('status'),
    opts.wantQuantity,
    opts.segmentWealth,
    opts.veryHighThreshold,
    opts.buyerActor,
    opts.buyerDisposition,
  );
};

export const statusDemandDirect = (
  id: string,
  wantQuantity: number,
  segmentWealth: number,
  veryHighThreshold: number,
  buyerActor?: ActorId,
  buyerDisposition?: 'consume' | 'stockpile',
): DemandSource => {
  const want = Math.max(0, wantQuantity);
  const wealth = Math.max(0, segmentWealth);
  const threshold = Math.max(0, veryHighThreshold);
  // Effective want clipped by what total wealth could afford even one unit;
  // an entirely cashless patrician cannot bid.
  const effectiveWant = wealth > 0 || want === 0 ? want : 0;
  // Status WTP is the price ceiling above which the patrician walks away;
  // quantize to integer coin per docs/08 §"Integer-coin prices".
  const source: MutableDemandSource = {
    id,
    curve: 'status',
    peakQuantity: effectiveWant,
    maxWillingnessToPay: integerCoinBid(threshold),
    quantityAt: stepQuantityAt,
  };
  if (buyerActor !== undefined) source.buyerActor = buyerActor;
  if (buyerDisposition !== undefined) source.buyerDisposition = buyerDisposition;
  return source;
};

// --- Derived input ----------------------------------------------------------

export interface DerivedInputOpts {
  readonly id?: string;
  readonly expectedOutputRevenuePerInputUnit: number;
  readonly otherCostsPerInputUnit: number;
  readonly margin: number;
  readonly productionCapacity: number;
  readonly inputPerOutput: number;
  readonly buyerActor?: ActorId;
  readonly buyerDisposition?: 'consume' | 'stockpile';
}

export const derivedInputDemand = (opts: DerivedInputOpts): DemandSource => {
  return derivedInputDemandDirect(
    opts.id ?? nextId('derived'),
    opts.expectedOutputRevenuePerInputUnit,
    opts.otherCostsPerInputUnit,
    opts.margin,
    opts.productionCapacity,
    opts.inputPerOutput,
    opts.buyerActor,
    opts.buyerDisposition,
  );
};

export const derivedInputDemandDirect = (
  id: string,
  expectedOutputRevenuePerInputUnit: number,
  otherCostsPerInputUnit: number,
  margin: number,
  productionCapacity: number,
  inputPerOutput: number,
  buyerActor?: ActorId,
  buyerDisposition?: 'consume' | 'stockpile',
): DemandSource => {
  const breakEven = expectedOutputRevenuePerInputUnit - otherCostsPerInputUnit - margin;
  const capacity = Math.max(0, productionCapacity);
  const inputPerOutputSafe = Math.max(0, inputPerOutput);
  const quantityDemanded = breakEven > 0 ? capacity * inputPerOutputSafe : 0;
  const safeBreakEven = breakEven > 0 ? breakEven : 0;
  // Derived producer bid is the break-even input price the buyer can pay
  // before output economics turn unprofitable. Quantize to integer coin
  // per docs/08 §"Integer-coin prices"; sub-1 positive values floor to 1.
  const source: MutableDemandSource = {
    id,
    curve: 'derived',
    peakQuantity: quantityDemanded,
    maxWillingnessToPay: integerCoinBid(safeBreakEven),
    quantityAt: stepQuantityAt,
  };
  if (buyerActor !== undefined) source.buyerActor = buyerActor;
  if (buyerDisposition !== undefined) source.buyerDisposition = buyerDisposition;
  return source;
};

// --- Aggregation ------------------------------------------------------------

export const quantityAtDemandSource = (source: DemandSource, price: number): number => {
  switch (source.curve) {
    case 'subsistence': {
      const need = source.peakQuantity;
      if (need <= 0) return 0;
      if (price <= 0) return need;
      const wealth = source.curveBudget;
      if (wealth === undefined) return source.quantityAt(price);
      const threshold = wealth / need;
      if (price <= threshold) return need;
      return wealth / price;
    }
    case 'comfort': {
      const want = source.peakQuantity;
      if (want <= 0) return 0;
      if (price <= 0) return want;
      const budget = source.curveBudget;
      if (budget === undefined) return source.quantityAt(price);
      if (budget <= 0) return 0;
      return want * Math.exp(-(price / budget) * (source.curveScale ?? 1));
    }
    case 'status':
    case 'derived':
      if (source.peakQuantity <= 0) return 0;
      return price <= source.maxWillingnessToPay ? source.peakQuantity : 0;
  }
};

const demandTotalAt = function (this: DemandSchedule, price: number): number {
  let sum = 0;
  for (const s of this.sources) sum += quantityAtDemandSource(s, price);
  return sum;
};

const demandBreakpoints = function (this: DemandSchedule): readonly DemandBreakpoint[] {
  const bps: DemandBreakpoint[] = [];
  for (const s of this.sources) {
    // Step sources contribute one discontinuity at their max-WTP, where
    // demand drops from peak to 0 going up in price. Continuous sources
    // (subsistence, comfort) emit no breakpoint here; clearing samples
    // them via totalAt.
    if (s.curve === 'status' || s.curve === 'derived') {
      if (s.peakQuantity > 0) {
        bps.push({ price: s.maxWillingnessToPay, quantityChange: -s.peakQuantity });
      }
    }
  }
  bps.sort((a, b) => a.price - b.price);
  return bps;
};

export const aggregateDemand = (sources: readonly DemandSource[]): DemandSchedule => ({
  sources,
  totalAt: demandTotalAt,
  breakpoints: demandBreakpoints,
});
