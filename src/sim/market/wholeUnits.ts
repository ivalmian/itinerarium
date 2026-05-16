/**
 * Whole-unit transaction guard.
 *
 * Per docs/02-resources §"Unit basis" + the locked decision in
 * docs/08-money-and-trade §"Whole-unit transactions": every trade
 * in a tangible good crosses ownership in integer multiples of the
 * resource's native unit. The market clearer can quote fractional
 * supply / demand schedules, recipes can produce fractional output
 * (small efficiency losses), and stockpiles can accumulate fractions
 * over time — but the moment a tangible good physically changes
 * hands (caravan buy / sell, local trade between settlements, market
 * clearing trade) the quantity must be a whole number of units.
 *
 * Concrete example: a market clearer computes that a buyer wants
 * 12.4 bolts of cloth and a seller can supply 15.0 — the executed
 * trade is 12 bolts of cloth, not 12.4. The 0.4 stays in the
 * demander's "I'd still take more" residual.
 *
 * Service resources (priesthood-days, garrison-days, administration-
 * days, public-works-days) are intangible capacity, not goods. They
 * pass through unrounded — you can hire 0.4 priest-days of
 * religious service. Players don't physically pick up half a priest.
 *
 * The rationale is a mix of (a) player legibility — "you bought 1
 * loaf of bread for 0.05 coin" reads cleaner than "0.973 loaves" —
 * and (b) realism: amphorae aren't divisible into 0.4 amphorae, a
 * tool is a tool. Resources whose unit is a bulk measure (modii of
 * grain, kg of pig iron) still round to whole units; the unit is
 * already chosen at a granularity where fractional trades are
 * implausible.
 */

import type { ResourceId } from '../types.js';

/**
 * Floor a raw transaction quantity to the largest whole unit that
 * doesn't exceed it. Negative inputs and NaN clamp to 0. Use the
 * resource-aware `wholeUnitsForTransaction` at trade sites where
 * services may be involved.
 */
export const wholeUnits = (qty: number): number => {
  if (!Number.isFinite(qty)) return 0;
  if (qty <= 0) return 0;
  return Math.floor(qty);
};

/**
 * Whether a resource is a service (intangible capacity), which
 * transacts in fractional units rather than being rounded down.
 */
export const isServiceTransaction = (resource: ResourceId): boolean =>
  String(resource).startsWith('service.');

/**
 * Round a transaction quantity to whole units when the resource is a
 * tangible good; pass through unchanged for services.
 */
export const wholeUnitsForTransaction = (resource: ResourceId, qty: number): number => {
  if (isServiceTransaction(resource)) return Math.max(0, qty);
  return wholeUnits(qty);
};

// ---------------------------------------------------------------------------
// Integer-coin prices
//
// Per docs/08 §"Integer-coin prices": every per-unit price quoted by the
// market layer is an integer ≥ 1 coin. Asks round UP (sellers never quote
// below their real cost), bids round DOWN (buyers never quote above their
// reserve), and the clearing price rounds to nearest. Sub-1 positive
// values clamp to the 1-coin floor; a true zero stays zero so demand
// sources whose backing budget is empty can still represent "no bid".
//
// Internal MC arithmetic (recipe input cost × kg, wage basket math, etc.)
// stays float — only the EXTERNALLY QUOTED per-unit price quantizes.
// ---------------------------------------------------------------------------

/**
 * Quote a producer ask (reservation price) as an integer ≥ 1 coin.
 * Used by `src/sim/market/supply.ts` at the final assignment of
 * `reservationPrice`. Sub-1 positive values clamp UP to 1 (the floor of
 * the quoted ladder); non-finite or ≤ 0 inputs also return 1.
 */
export const integerCoinAsk = (price: number): number => {
  if (!Number.isFinite(price) || price <= 0) return 1;
  const ceil = Math.ceil(price);
  return ceil >= 1 ? ceil : 1;
};

/**
 * Quote a consumer bid (max willingness-to-pay) as an integer ≥ 1 coin
 * when the underlying value is positive, OR 0 when the source has no
 * actual willingness (e.g. comfort segment with zero discretionary
 * budget). Used by `src/sim/market/demand.ts` for comfort, status, and
 * derived-input sources. Subsistence stays +Infinity (does not call this
 * helper).
 *
 * Positive sub-1 inputs clamp UP to 1 (the floor of the quoted ladder).
 */
export const integerCoinBid = (price: number): number => {
  if (!Number.isFinite(price)) return 0;
  if (price <= 0) return 0;
  const floored = Math.floor(price);
  return floored >= 1 ? floored : 1;
};

/**
 * Round the clearing price (and the residual bid-ask book's best-bid /
 * best-ask / midPrice) to the nearest integer ≥ 1 coin. Used by
 * `src/sim/market/clear.ts` after the CDA has located an algebraic
 * intersection price (which may have landed inside a continuous
 * subsistence/comfort segment as a non-integer).
 *
 * Non-finite values pass through (+Infinity is a legitimate famine
 * sentinel; the caller decides whether to record it).
 */
export const integerCoinClearing = (price: number): number => {
  if (!Number.isFinite(price)) return price;
  if (price <= 0) return 1;
  const rounded = Math.round(price);
  return rounded >= 1 ? rounded : 1;
};
