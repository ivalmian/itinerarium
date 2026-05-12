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
