/**
 * Migration column arrival → population absorption.
 *
 * Reference: docs/04-population.md §"Migration". Migration is real population
 * transfer: cohorts are removed from the origin at column-creation time
 * (T32), the column travels (T33 movement), people may die en route
 * (T32 starvation), and the survivors *physically arrive* somewhere where
 * they must increase that settlement's population pool. Without this step
 * the loop "block food → people flee → arrive somewhere → that place grows"
 * is broken (columns either vanish or stay in transit forever).
 *
 * This is intentionally narrow: no decision-making, no mortality, no class
 * remapping. The decision to spawn the column belongs to T32; the removal
 * of cohorts from the origin happens at column-creation time. Here we only
 * merge the surviving cohorts into the destination's PopulationPool.
 *
 * Class remapping (e.g. "cross-cluster migrants are absorbed as
 * foreigner-resident") is intentionally deferred — the cluster registry
 * doesn't exist yet. v1 preserves the original class.
 */

import type { Day } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import type { CohortKey } from './cohort.js';
import { createCohortCounts, type CohortCounts, type MigrationColumn } from './migration.js';

export interface MigrationArrivalInputs {
  readonly column: MigrationColumn;
  readonly destinationSettlement: Settlement;
  /** Game day of arrival; passed for diagnostic emission upstream. */
  readonly today: Day;
}

export interface MigrationArrivalResult {
  /**
   * Cohorts merged into the destination pool. Excludes zero-count entries.
   * Backed by CohortCounts so that lookups with freshly-constructed CohortKey
   * objects work the same as cached references.
   */
  readonly arrivalsByCohort: CohortCounts;
  /**
   * v1: PopulationPool is unbounded, so this is always omitted. Kept on the
   * type so the tick loop can begin to surface capacity warnings later
   * without an interface break.
   */
  readonly destinationOverflow?: number;
}

const requireValidCount = (count: number, key: CohortKey): void => {
  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    throw new Error(
      `absorbArrival: cohort ${key.age}|${key.sex}|${key.class} count must be an integer, got ${count}`,
    );
  }
  if (count < 0) {
    throw new Error(
      `absorbArrival: cohort ${key.age}|${key.sex}|${key.class} count must be non-negative, got ${count}`,
    );
  }
};

export const absorbArrival = (
  inputs: MigrationArrivalInputs,
): MigrationArrivalResult => {
  const arrivals = createCohortCounts();
  for (const [key, n] of inputs.column.cohorts) {
    requireValidCount(n, key);
    if (n === 0) continue;
    const existing = inputs.destinationSettlement.population.count(key);
    inputs.destinationSettlement.population.set(key, existing + n);
    arrivals.set(key, n);
  }
  return { arrivalsByCohort: arrivals };
};
