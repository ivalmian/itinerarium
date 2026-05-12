/**
 * Continuous-double-auction market clearing.
 *
 * Given an aggregate DemandSchedule and SupplySchedule for a single
 * (settlement, resource, day), find a clearing price p* and emit the
 * resulting trades.
 *
 * This is the market microstructure side of docs/08's modern
 * microeconomic model: buyers arrive with willingness-to-pay curves,
 * sellers arrive with reservation asks, and price discovery matches the
 * highest WTP to the lowest ask until one side is exhausted.
 *
 * Properties used:
 *   - aggregate demand is non-increasing in price.
 *   - aggregate supply is non-decreasing in price.
 *
 * Therefore the function diff(p) = supply(p) - demand(p) is non-decreasing.
 * The clearing price is the lowest p in [minPrice, maxPrice] where
 * diff(p) >= 0. We find it by walking the sorted union of breakpoint
 * prices: the first candidate where diff >= 0 gives us a bracket on the
 * crossing. If demand has continuous portions (subsistence, comfort),
 * the crossing inside the bracket is found by bisection.
 *
 * Matching: at p*, all trades execute at p*. Demand sources with
 * positive quantityAt(p*) are matched in descending maxWillingnessToPay;
 * supply sources are matched in ascending reservationPrice. This realizes
 * the docs/08 rule "highest-WTP demanders match with lowest-reservation
 * sellers, in price order."
 *
 * Boundary behavior:
 *   - If supply >= demand even at minPrice, clearingPrice = minPrice.
 *   - If demand > supply at maxPrice, clearingPrice = maxPrice and
 *     unmetDemand is populated. With no maxPrice, clearingPrice = +Infinity.
 *   - Empty schedules: clearingPrice = minPrice; no trades.
 */

import type { DemandSchedule } from './demand.js';
import type { SupplySchedule } from './supply.js';

export interface ClearingTrade {
  readonly buyerSourceId: string;
  readonly sellerSourceId: string;
  readonly quantity: number;
  readonly price: number;
}

export interface ClearingResult {
  readonly clearingPrice: number;
  readonly totalTraded: number;
  readonly trades: readonly ClearingTrade[];
  readonly unmetDemandAtClearingPrice: number;
  readonly unsoldSupplyAtClearingPrice: number;
  /**
   * Post-clearing book per docs/08 §"Bid-ask book":
   *   bestAsk  — lowest reservation among sellers that did NOT fully clear,
   *              i.e. supply quoted but unsold after the day's matching.
   *   askDepth — total residual availableToSell at or below bestAsk.
   *   bestBid  — highest maxWillingnessToPay among buyers that did NOT clear,
   *              i.e. unfilled demand quoted at or above bestBid.
   *   bidDepth — total residual demand quantity at or above bestBid.
   *   midPrice — clearing price if any trade cleared; otherwise the geometric
   *              mean of bestBid/bestAsk when both exist, or whichever
   *              single side is quoted.
   *   spread   — bestAsk - bestBid when both >0 AND ask >= bid; null otherwise.
   *              A "crossing" book (bid >= ask) yields null spread and a
   *              non-zero clearingPrice in the same result.
   *
   * All five fields are `null` when no side quotes anything meaningful
   * (treated as no observable book today).
   */
  readonly bestAsk: number | null;
  readonly askDepth: number;
  readonly bestBid: number | null;
  readonly bidDepth: number;
  readonly midPrice: number | null;
  readonly spread: number | null;
}

export interface ClearMarketOpts {
  readonly minPrice?: number;
  readonly maxPrice?: number;
  /** Bisection tolerance for finding the crossing in continuous segments. */
  readonly priceEpsilon?: number;
  /** Safety cap on bisection iterations. */
  readonly maxBisectionIterations?: number;
}

const DEFAULT_MIN = 0;
const DEFAULT_PRICE_EPSILON = 1e-6;
const DEFAULT_MAX_BISECTION = 64;

export const clearMarket = (
  demand: DemandSchedule,
  supply: SupplySchedule,
  opts: ClearMarketOpts = {},
): ClearingResult => {
  const minPrice = opts.minPrice ?? DEFAULT_MIN;
  const maxPrice = opts.maxPrice ?? Number.POSITIVE_INFINITY;
  const eps = opts.priceEpsilon ?? DEFAULT_PRICE_EPSILON;
  const maxIter = opts.maxBisectionIterations ?? DEFAULT_MAX_BISECTION;

  // Empty market: no trades, no unmet/unsold to report.
  if (demand.sources.length === 0 && supply.sources.length === 0) {
    return {
      clearingPrice: minPrice,
      totalTraded: 0,
      trades: [],
      unmetDemandAtClearingPrice: 0,
      unsoldSupplyAtClearingPrice: 0,
      bestAsk: null,
      askDepth: 0,
      bestBid: null,
      bidDepth: 0,
      midPrice: null,
      spread: null,
    };
  }

  // Build a sorted unique list of candidate prices: every breakpoint plus
  // the price floor and ceiling. We deduplicate within an epsilon so
  // floating-point jitter does not create spurious empty intervals.
  const candidates = collectCandidates(demand, supply, minPrice, maxPrice, eps);

  const D = (p: number): number => demand.totalAt(p);
  const S = (p: number): number => supply.totalAt(p);

  // If supply already meets demand at the minPrice, clearing happens there.
  // (E.g., no demand at all → trivial clear at floor.)
  if (S(minPrice) >= D(minPrice)) {
    return finalizeClearing(demand, supply, minPrice);
  }

  // Walk candidates ascending. The first candidate where diff >= 0 brackets
  // the crossing; the previous candidate is the lower bracket.
  // We also detect the case where a demand step at candidate `c` drops just
  // above c so that S(c) >= D(c+ε). In that case the cleared interval starts
  // at c itself and the CDA convention is to take c as the clearing price.
  let lower = minPrice;
  let upper: number | undefined;
  for (const c of candidates) {
    if (c <= lower) continue;
    if (S(c) >= D(c)) {
      upper = c;
      break;
    }
    // Demand-step drop just above this candidate.
    const probe = c + eps;
    if (S(probe) >= D(probe) && D(c) > D(probe) + eps) {
      return finalizeClearing(demand, supply, c);
    }
    lower = c;
  }

  if (upper === undefined) {
    // No breakpoint yet clears the market. If demand has a continuous tail
    // (subsistence hyperbola, comfort exponential), it will eventually fall
    // below the supply level. Probe upward exponentially to find an upper
    // bracket. If we hit the maxPrice cap without crossing, this is a true
    // famine — clearing price is the cap (or +Infinity uncapped).
    const probed = probeUpward(D, S, lower, maxPrice, eps);
    if (probed === undefined) {
      const clearingPrice = Number.isFinite(maxPrice) ? maxPrice : Number.POSITIVE_INFINITY;
      return finalizeClearing(demand, supply, clearingPrice);
    }
    upper = probed;
  }

  // We have a crossing in (lower, upper]. If supply is a step that crossed
  // over demand at `upper`, the clearing price is `upper` itself: any
  // p ∈ (lower, upper) sits in the constant supply level below the step.
  // If demand is continuous and crosses inside (lower, upper], bisect.
  const supplyJumpsAtUpper = Math.abs(S(upper) - S(midSafe(lower, upper))) > eps;
  if (supplyJumpsAtUpper) {
    return finalizeClearing(demand, supply, upper);
  }

  // Continuous crossing: bisect for diff(p) = 0.
  const root = bisect(D, S, lower, upper, eps, maxIter);
  return finalizeClearing(demand, supply, root);
};

const midSafe = (lo: number, hi: number): number => {
  if (!Number.isFinite(hi)) return lo + 1;
  return (lo + hi) / 2;
};

/**
 * Search upward from `lower` for the first price where supply meets demand.
 * Used when the breakpoint walk runs out and demand has a continuous tail.
 * Doubles the step each iteration to find an upper bracket quickly. Returns
 * undefined if we hit the cap (or run out of doubling room) without crossing.
 */
const probeUpward = (
  D: (p: number) => number,
  S: (p: number) => number,
  lower: number,
  maxPrice: number,
  eps: number,
): number | undefined => {
  const cap = Number.isFinite(maxPrice) ? maxPrice : 1e18;
  let step = Math.max(1, lower * 2 + 1);
  let p = lower + step;
  // Hard iteration cap so we cannot loop forever even if S/D are pathological.
  for (let i = 0; i < 200; i++) {
    if (p > cap) {
      // Try the cap itself before giving up.
      if (S(cap) - D(cap) >= -eps) return cap;
      return undefined;
    }
    if (S(p) - D(p) >= -eps) return p;
    step *= 2;
    p = lower + step;
  }
  return undefined;
};

const bisect = (
  D: (p: number) => number,
  S: (p: number) => number,
  lo: number,
  hi: number,
  eps: number,
  maxIter: number,
): number => {
  let a = lo;
  let b = hi;
  for (let i = 0; i < maxIter; i++) {
    const m = (a + b) / 2;
    if (b - a < eps) return m;
    const diff = S(m) - D(m);
    if (diff >= 0) {
      b = m;
    } else {
      a = m;
    }
  }
  return (a + b) / 2;
};

const collectCandidates = (
  demand: DemandSchedule,
  supply: SupplySchedule,
  minPrice: number,
  maxPrice: number,
  eps: number,
): readonly number[] => {
  const set: number[] = [];
  set.push(minPrice);
  if (Number.isFinite(maxPrice)) set.push(maxPrice);
  for (const bp of demand.breakpoints()) set.push(bp.price);
  for (const bp of supply.breakpoints()) set.push(bp.price);
  // Sort ascending.
  set.sort((a, b) => a - b);
  // Deduplicate within eps.
  const out: number[] = [];
  for (const p of set) {
    if (p < minPrice) continue;
    if (Number.isFinite(maxPrice) && p > maxPrice) continue;
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last === undefined || p - last > eps) {
      out.push(p);
    }
  }
  return out;
};

const finalizeClearing = (
  demand: DemandSchedule,
  supply: SupplySchedule,
  clearingPrice: number,
): ClearingResult => {
  // For an infinite clearing price (no cap, demand outstrips supply forever),
  // sample with a very large but finite price so quantityAt evaluations remain
  // well-defined (subsistence's hyperbola is finite for finite p, and the
  // tail of comfort decays to 0). We use the supply at +Inf which is the
  // total availableToSell, plus the demand at this large p.
  const evalPrice = Number.isFinite(clearingPrice) ? clearingPrice : Number.MAX_SAFE_INTEGER;

  const totalDemand = sumSourceQuantities(demand.sources, evalPrice);
  const totalSupply = sumSupply(supply.sources);
  const tradedAtPrice = Number.isFinite(clearingPrice)
    ? Math.min(demand.totalAt(evalPrice), supply.totalAt(evalPrice))
    : Math.min(totalDemand, totalSupply);

  const totalTraded = Math.max(0, tradedAtPrice);

  // Allocate trades: highest-WTP demanders ↔ lowest-reservation suppliers.
  const buyerOrder = demand.sources
    .map((s) => ({
      id: s.id,
      maxWtp: s.maxWillingnessToPay,
      remaining: Math.max(0, s.quantityAt(evalPrice)),
    }))
    .filter((b) => b.remaining > 0)
    .sort((a, b) => b.maxWtp - a.maxWtp);

  const sellerOrder = supply.sources
    .map((s) => ({
      id: s.id,
      reservation: s.reservationPrice,
      remaining: s.availableToSell,
    }))
    .filter(
      (s) => s.remaining > 0 && (s.reservation <= clearingPrice || !Number.isFinite(clearingPrice)),
    )
    .sort((a, b) => a.reservation - b.reservation);

  const trades: ClearingTrade[] = [];
  let remainingToTrade = totalTraded;
  let bi = 0;
  let si = 0;
  while (remainingToTrade > 0 && bi < buyerOrder.length && si < sellerOrder.length) {
    const buyer = buyerOrder[bi];
    const seller = sellerOrder[si];
    if (!buyer || !seller) break;
    const qty = Math.min(buyer.remaining, seller.remaining, remainingToTrade);
    if (qty <= 0) {
      if (buyer.remaining <= 0) bi++;
      else if (seller.remaining <= 0) si++;
      else break;
      continue;
    }
    trades.push({
      buyerSourceId: buyer.id,
      sellerSourceId: seller.id,
      quantity: qty,
      price: clearingPrice,
    });
    buyer.remaining -= qty;
    seller.remaining -= qty;
    remainingToTrade -= qty;
    if (buyer.remaining <= 0) bi++;
    if (seller.remaining <= 0) si++;
  }

  // "Unmet demand at clearing price" is literal: demand that still exists at
  // p* but could not be served. Priced-out derived/status/comfort demand is
  // foregone activity, not a shortage at the discovered market price.
  const unmetDemandAtClearingPrice = Math.max(0, totalDemand - totalTraded);
  const unsoldSupplyAtClearingPrice = Math.max(
    0,
    supplyAvailableAt(supply.sources, clearingPrice) - totalTraded,
  );

  const book = derivePostClearingBook(
    demand,
    supply,
    clearingPrice,
    totalTraded,
    buyerOrder,
    sellerOrder,
  );

  return {
    clearingPrice,
    totalTraded,
    trades,
    unmetDemandAtClearingPrice,
    unsoldSupplyAtClearingPrice,
    ...book,
  };
};

const BOOK_QTY_EPS = 1e-9;

interface PostClearingBook {
  readonly bestAsk: number | null;
  readonly askDepth: number;
  readonly bestBid: number | null;
  readonly bidDepth: number;
  readonly midPrice: number | null;
  readonly spread: number | null;
}

/**
 * Derive the residual bid-ask book per docs/08 §"Bid-ask book". The book is
 * what would remain visible in the forum after today's matching:
 *
 *   bestAsk = lowest reservation among sellers with unsold availableToSell
 *   bestBid = highest maxWillingnessToPay among demanders whose curve still
 *             quotes a positive quantity at their max-WTP after clearing
 *
 * Residual is computed against the matched buyer/seller arrays (which had
 * their .remaining drained inside the trade loop), so unfilled bids/asks are
 * the ones that did NOT clear today. We also re-scan the *original* source
 * lists for sellers with reservation strictly above the clearing price
 * (they posted an ask but were too pricey today) and buyers with WTP
 * strictly below the clearing price (they wanted to bid but the going
 * price was already past them).
 */
const derivePostClearingBook = (
  demand: DemandSchedule,
  supply: SupplySchedule,
  clearingPrice: number,
  totalTraded: number,
  buyerOrder: readonly { id: string; maxWtp: number; remaining: number }[],
  sellerOrder: readonly { id: string; reservation: number; remaining: number }[],
): PostClearingBook => {
  // --- Ask side: residual sellers ---
  let bestAsk: number | null = null;
  let askDepth = 0;
  for (const s of sellerOrder) {
    if (s.remaining > BOOK_QTY_EPS) {
      if (bestAsk === null || s.reservation < bestAsk) bestAsk = s.reservation;
    }
  }
  // Sellers above the clearing price (above-water asks) are also part of
  // today's visible book — they posted but were not in the clearable set.
  for (const s of supply.sources) {
    if (s.availableToSell <= BOOK_QTY_EPS) continue;
    if (!Number.isFinite(s.reservationPrice)) continue;
    if (Number.isFinite(clearingPrice) && s.reservationPrice <= clearingPrice) continue;
    if (bestAsk === null || s.reservationPrice < bestAsk) bestAsk = s.reservationPrice;
  }
  if (bestAsk !== null) {
    for (const s of supply.sources) {
      const remaining = sellerOrder.find((x) => x.id === s.id)?.remaining ?? s.availableToSell;
      if (remaining <= BOOK_QTY_EPS) continue;
      if (!Number.isFinite(s.reservationPrice)) continue;
      if (s.reservationPrice <= bestAsk + BOOK_QTY_EPS) askDepth += remaining;
    }
  }

  // --- Bid side: residual buyers ---
  let bestBid: number | null = null;
  let bidDepth = 0;
  // Drained buyers from clearing.
  for (const b of buyerOrder) {
    if (b.remaining > BOOK_QTY_EPS) {
      if (Number.isFinite(b.maxWtp) && (bestBid === null || b.maxWtp > bestBid)) bestBid = b.maxWtp;
    }
  }
  // Demanders with WTP at-or-below the clearing price (they were squeezed out)
  // still represent a quoted bid in the residual book.
  for (const d of demand.sources) {
    if (!Number.isFinite(d.maxWillingnessToPay)) continue;
    if (d.maxWillingnessToPay <= 0) continue;
    // Subsistence has maxWtp = +Infinity; never finite-quote it as a book bid.
    if (!Number.isFinite(d.maxWillingnessToPay)) continue;
    if (Number.isFinite(clearingPrice) && d.maxWillingnessToPay >= clearingPrice) continue;
    const peak = d.peakQuantity;
    if (peak <= BOOK_QTY_EPS) continue;
    if (bestBid === null || d.maxWillingnessToPay > bestBid) bestBid = d.maxWillingnessToPay;
  }
  if (bestBid !== null) {
    for (const d of demand.sources) {
      if (!Number.isFinite(d.maxWillingnessToPay)) continue;
      if (d.maxWillingnessToPay + BOOK_QTY_EPS < bestBid) continue;
      const matchedRemaining = buyerOrder.find((b) => b.id === d.id)?.remaining;
      const remaining =
        matchedRemaining !== undefined ? matchedRemaining : Math.max(0, d.peakQuantity);
      bidDepth += remaining;
    }
  }

  // --- Mid and spread ---
  let midPrice: number | null = null;
  let spread: number | null = null;
  if (totalTraded > BOOK_QTY_EPS && Number.isFinite(clearingPrice)) {
    midPrice = clearingPrice;
  } else if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
    // Geometric mean is scale-friendly for goods that span orders of magnitude
    // in price; falls back to arithmetic for the tiny-positive case.
    midPrice = Math.sqrt(bestBid * bestAsk);
  } else if (bestAsk !== null) {
    midPrice = bestAsk;
  } else if (bestBid !== null) {
    midPrice = bestBid;
  }
  if (bestBid !== null && bestAsk !== null && bestAsk >= bestBid) {
    spread = bestAsk - bestBid;
  }

  return { bestAsk, askDepth, bestBid, bidDepth, midPrice, spread };
};

const sumSourceQuantities = (
  sources: readonly { quantityAt(p: number): number }[],
  p: number,
): number => {
  let total = 0;
  for (const s of sources) total += s.quantityAt(p);
  return total;
};

const sumSupply = (sources: readonly { availableToSell: number }[]): number => {
  let total = 0;
  for (const s of sources) total += s.availableToSell;
  return total;
};

const supplyAvailableAt = (
  sources: readonly { reservationPrice: number; availableToSell: number }[],
  p: number,
): number => {
  let total = 0;
  for (const s of sources) {
    if (p >= s.reservationPrice) total += s.availableToSell;
  }
  return total;
};
