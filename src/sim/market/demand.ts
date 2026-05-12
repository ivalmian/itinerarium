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

export type DemandCurveKind = 'subsistence' | 'comfort' | 'status' | 'derived';

export interface DemandSource {
  readonly id: string;
  readonly curve: DemandCurveKind;
  quantityAt(price: number): number;
  readonly peakQuantity: number;
  readonly maxWillingnessToPay: number;
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

export const subsistenceDemand = (opts: SubsistenceOpts): DemandSource => {
  const need = Math.max(0, opts.needPerDay);
  const wealth = Math.max(0, opts.segmentWealth);
  const id = opts.id ?? nextId('subsistence');
  return {
    id,
    curve: 'subsistence',
    peakQuantity: need,
    ...(opts.buyerActor !== undefined ? { buyerActor: opts.buyerActor } : {}),
    ...(opts.buyerDisposition !== undefined ? { buyerDisposition: opts.buyerDisposition } : {}),
    // Households will starve before they refuse to pay; the curve is
    // hyperbolic above the wealth/need threshold, never reaching zero.
    maxWillingnessToPay: Number.POSITIVE_INFINITY,
    quantityAt(price: number): number {
      if (need <= 0) return 0;
      if (price <= 0) return need;
      const threshold = wealth / need; // p above this point causes spending cap.
      if (price <= threshold) return need;
      return wealth / price;
    },
  };
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

export const comfortDemand = (opts: ComfortOpts): DemandSource => {
  const want = Math.max(0, opts.wantQuantity);
  const budget = Math.max(0, opts.budget);
  const scale = opts.decayScale ?? 1;
  const cutoff = opts.cutoffMultiplier ?? 20;
  const id = opts.id ?? nextId('comfort');
  // For zero budget, treat the curve as a vanishing want — any positive
  // price knocks demand out (consumers have nothing to spend on this).
  const maxWtp = budget > 0 ? budget * cutoff : 0;
  return {
    id,
    curve: 'comfort',
    peakQuantity: want,
    maxWillingnessToPay: maxWtp,
    ...(opts.buyerActor !== undefined ? { buyerActor: opts.buyerActor } : {}),
    ...(opts.buyerDisposition !== undefined ? { buyerDisposition: opts.buyerDisposition } : {}),
    quantityAt(price: number): number {
      if (want <= 0) return 0;
      if (price <= 0) return want;
      if (budget <= 0) return 0;
      const x = price / budget;
      return want * Math.exp(-x * scale);
    },
  };
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

export const statusDemand = (opts: StatusOpts): DemandSource => {
  const want = Math.max(0, opts.wantQuantity);
  const wealth = Math.max(0, opts.segmentWealth);
  const threshold = Math.max(0, opts.veryHighThreshold);
  const id = opts.id ?? nextId('status');
  // Effective want clipped by what total wealth could afford even one unit;
  // an entirely cashless patrician cannot bid.
  const effectiveWant = wealth > 0 || want === 0 ? want : 0;
  return {
    id,
    curve: 'status',
    peakQuantity: effectiveWant,
    maxWillingnessToPay: threshold,
    ...(opts.buyerActor !== undefined ? { buyerActor: opts.buyerActor } : {}),
    ...(opts.buyerDisposition !== undefined ? { buyerDisposition: opts.buyerDisposition } : {}),
    quantityAt(price: number): number {
      if (effectiveWant <= 0) return 0;
      return price <= threshold ? effectiveWant : 0;
    },
  };
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
  const breakEven =
    opts.expectedOutputRevenuePerInputUnit - opts.otherCostsPerInputUnit - opts.margin;
  const capacity = Math.max(0, opts.productionCapacity);
  const inputPerOutput = Math.max(0, opts.inputPerOutput);
  const quantityDemanded = breakEven > 0 ? capacity * inputPerOutput : 0;
  const id = opts.id ?? nextId('derived');
  const safeBreakEven = breakEven > 0 ? breakEven : 0;
  return {
    id,
    curve: 'derived',
    peakQuantity: quantityDemanded,
    maxWillingnessToPay: safeBreakEven,
    ...(opts.buyerActor !== undefined ? { buyerActor: opts.buyerActor } : {}),
    ...(opts.buyerDisposition !== undefined ? { buyerDisposition: opts.buyerDisposition } : {}),
    quantityAt(price: number): number {
      if (quantityDemanded <= 0) return 0;
      return price <= safeBreakEven ? quantityDemanded : 0;
    },
  };
};

// --- Aggregation ------------------------------------------------------------

export const aggregateDemand = (sources: readonly DemandSource[]): DemandSchedule => {
  return {
    sources,
    totalAt(price: number): number {
      let sum = 0;
      for (const s of sources) sum += s.quantityAt(price);
      return sum;
    },
    breakpoints(): readonly DemandBreakpoint[] {
      const bps: DemandBreakpoint[] = [];
      for (const s of sources) {
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
    },
  };
};
