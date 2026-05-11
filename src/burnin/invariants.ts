/**
 * Sim-stability invariants library.
 *
 * Pure functions over WorldState. The burn-in CLI (T30) and individual
 * tests both call these to check that the simulation has not drifted
 * into an impossible state — negative populations, NaN prices, orphaned
 * references, runaway demographics, and so on.
 *
 * Severity scale:
 *   - 'fatal' — the world is mathematically broken (negative count,
 *               non-finite price). Burn-in should abort.
 *   - 'error' — the world is internally inconsistent (orphaned ref,
 *               out-of-range reputation, demographic catastrophe). Burn-in
 *               should log loudly and consider aborting.
 *   - 'warn'  — the world is plausible but unusual (debt, missing
 *               clearing price for a traded resource). Burn-in records.
 *
 * No invariant mutates state. They build a list of violations and the
 * caller decides what to do.
 *
 * Reference: docs/07-geography.md "Phase 2 — Burn-in stabilization" and
 * docs/10-scope-and-questions.md (build plan §"burn-in").
 */

import type { Day } from '../sim/types.js';
import type { WorldState } from '../procgen/seed.js';
import {
  loadFraction,
  totalCargoWeightKg,
  totalCarryKg,
  totalCrewCount,
} from '../sim/caravan/caravan.js';
import { MAX_ACTIVE_WORLD_CARAVANS } from '../sim/caravan/limits.js';
import { hexKey } from '../sim/world/hex.js';

// --- Types ------------------------------------------------------------------

export type InvariantSeverity = 'warn' | 'error' | 'fatal';

export interface InvariantViolation {
  readonly invariant: string;
  readonly detail: string;
  readonly severity: InvariantSeverity;
}

/**
 * Snapshot taken on a previous tick so demographic / market trend
 * invariants can compare against it. Burn-in is expected to keep one
 * around per yearly checkpoint.
 */
export interface PreviousSummary {
  readonly day: Day;
  readonly totalPop: number;
}

export interface InvariantContext {
  readonly world: WorldState;
  readonly day: Day;
  /**
   * Recent tick events from the tick loop (T29, in flight). Typed loose so
   * this library does not block on the tick-loop interface landing. Future
   * invariants (e.g. battle/death rate sanity) may consume them.
   */
  readonly recentEvents?: readonly unknown[];
  readonly previousSummary?: PreviousSummary;
}

export type Invariant = (ctx: InvariantContext) => InvariantViolation[];

// --- Helpers ----------------------------------------------------------------

const violation = (
  invariant: string,
  detail: string,
  severity: InvariantSeverity,
): InvariantViolation => ({ invariant, detail, severity });

// --- Individual invariants --------------------------------------------------

export const populationNonNegative: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const settlement of world.settlements.values()) {
    for (const [key, count] of settlement.population.cohorts()) {
      if (!Number.isFinite(count) || count < 0) {
        out.push(
          violation(
            'populationNonNegative',
            `settlement ${String(settlement.id)} cohort ${key.age}|${key.sex}|${key.class} = ${count}`,
            'fatal',
          ),
        );
      }
    }
  }
  return out;
};

export const stockpileNonNegative: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const actor of world.actors.values()) {
    for (const [resource, qty] of actor.stockpile) {
      if (!Number.isFinite(qty) || qty < 0) {
        out.push(
          violation(
            'stockpileNonNegative',
            `actor ${String(actor.id)} stockpile ${String(resource)} = ${qty}`,
            'fatal',
          ),
        );
      }
    }
  }
  return out;
};

/**
 * Treasury must be non-negative. Debt is plausible in some economies but the
 * v1 sim has no credit instruments, so a negative treasury is almost always
 * a ledger bug. We mark it 'warn' rather than 'fatal' so burn-in can still
 * proceed while we investigate.
 */
export const treasuryNonNegative: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  const EPSILON_DEBT = 1e-9;
  for (const actor of world.actors.values()) {
    if (!Number.isFinite(actor.treasury) || actor.treasury < -EPSILON_DEBT) {
      out.push(
        violation(
          'treasuryNonNegative',
          `actor ${String(actor.id)} treasury = ${actor.treasury}`,
          'warn',
        ),
      );
    }
  }
  return out;
};

export const caravanCrewPositive: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const caravan of world.caravans.values()) {
    if (totalCrewCount(caravan) <= 0) {
      out.push(
        violation(
          'caravanCrewPositive',
          `caravan ${String(caravan.id)} has zero crew (should have been removed from world)`,
          'error',
        ),
      );
    }
  }
  return out;
};

export const activeCaravanCountWithinCap: Invariant = ({ world }) => {
  if (world.caravans.size <= MAX_ACTIVE_WORLD_CARAVANS) return [];
  return [
    violation(
      'activeCaravanCountWithinCap',
      `${world.caravans.size} active caravans exceeds province cap ${MAX_ACTIVE_WORLD_CARAVANS}`,
      'error',
    ),
  ];
};

export const caravanCargoNonNegative: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const caravan of world.caravans.values()) {
    let sawNegative = false;
    for (const [resource, qty] of caravan.cargo) {
      if (!Number.isFinite(qty) || qty < 0) {
        out.push(
          violation(
            'caravanCargoNonNegative',
            `caravan ${String(caravan.id)} cargo ${String(resource)} = ${qty}`,
            'fatal',
          ),
        );
        sawNegative = true;
      }
    }
    // Only check capacity if all entries are non-negative; an over-capacity
    // signal would be drowned out by the negative-cargo signal otherwise.
    if (!sawNegative) {
      const capacity = totalCarryKg(caravan);
      const weight = totalCargoWeightKg(caravan);
      if (capacity > 0 && weight > capacity * (1 + 1e-9)) {
        out.push(
          violation(
            'caravanCargoNonNegative',
            `caravan ${String(caravan.id)} cargo weight ${weight.toFixed(1)}kg exceeds carry capacity ${capacity.toFixed(1)}kg (load ${loadFraction(caravan).toFixed(2)})`,
            'error',
          ),
        );
      }
    }
  }
  return out;
};

export const priceFinite: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const settlement of world.settlements.values()) {
    for (const [resource, price] of settlement.market.lastClearingPrice) {
      if (!Number.isFinite(price) || price < 0) {
        out.push(
          violation(
            'priceFinite',
            `settlement ${String(settlement.id)} resource ${String(resource)} lastClearingPrice = ${price}`,
            'fatal',
          ),
        );
      }
    }
  }
  return out;
};

/**
 * Pathological clearing prices: a healthy market never has its clearing
 * price go to literal 0 (free goods don't exist when production has any
 * cost). If >50% of cleared markets are at price 0 (after a startup
 * grace period of 30 days), the market clearing logic is broken and
 * the burn-in should fast-fail instead of running for 6 years
 * collecting garbage data. Per the user observation: "pathological
 * clearing prices should cause burn in to fast fail."
 */
export const noPathologicalZeroPrices: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  if (world.day < 30) return out; // grace period
  // "Pathological" = price below 1e-3 coins/unit. The cheapest sane
  // good in the canonical price table is grain at 1.5; anything more
  // than three orders of magnitude below that is sellers giving goods
  // away because of a numerical death spiral, not a real equilibrium.
  // Per the user: "most clearing prices are like 1e-7... this is
  // pathological. we should aim for prices that are in single digits."
  const PATHOLOGICAL_PRICE = 1e-3;
  let total = 0;
  let pathological = 0;
  for (const settlement of world.settlements.values()) {
    for (const [, price] of settlement.market.lastClearingPrice) {
      total++;
      if (price < PATHOLOGICAL_PRICE) pathological++;
    }
  }
  if (total === 0) return out;
  const fraction = pathological / total;
  if (fraction > 0.5) {
    out.push(
      violation(
        'noPathologicalZeroPrices',
        `${pathological}/${total} (${(fraction * 100).toFixed(0)}%) of cleared markets have prices < ${PATHOLOGICAL_PRICE} coins/unit — sellers giving goods away. The trade phase is broken.`,
        'fatal',
      ),
    );
  }
  return out;
};

export const reputationClamped: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const entry of world.reputation.entries()) {
    if (!Number.isFinite(entry.value) || entry.value < -1 || entry.value > 1) {
      out.push(
        violation(
          'reputationClamped',
          `reputation(${String(entry.holder)} → ${String(entry.subject)}) = ${entry.value}`,
          'error',
        ),
      );
    }
  }
  return out;
};

const totalPopulation = (world: WorldState): number => {
  let total = 0;
  for (const settlement of world.settlements.values()) {
    total += settlement.population.total();
  }
  return total;
};

/**
 * Compares world.totalPop against a previous snapshot, normalized to an
 * annual rate. Catches both runaway growth (>5%/yr compound) and instant
 * collapse (>50%/yr shrinkage). Skipped silently when no previousSummary
 * is provided (first tick, or invariant-checker called ad-hoc).
 */
export const populationSane: Invariant = ({ world, day, previousSummary }) => {
  if (previousSummary === undefined) return [];
  const dt = Number(day) - Number(previousSummary.day);
  if (dt <= 0) return [];
  const cur = totalPopulation(world);
  const prev = previousSummary.totalPop;
  if (prev <= 0 && cur <= 0) return [];
  if (prev <= 0) {
    // Growing from zero would mean a settlement got re-founded between
    // ticks — that doesn't happen in the current sim, but if it ever
    // does, we don't want to flag it as runaway growth.
    return [];
  }
  const yearsElapsed = dt / 365;
  const ratio = cur / prev;
  if (ratio >= 1) {
    // Annualized growth: ratio^(1/years) - 1.
    const annualGrowth = Math.pow(ratio, 1 / yearsElapsed) - 1;
    if (annualGrowth > 0.05) {
      return [
        violation(
          'populationSane',
          `total population grew from ${prev} to ${cur} over ${yearsElapsed.toFixed(2)}y (${(annualGrowth * 100).toFixed(1)}%/yr, threshold 5%/yr)`,
          'error',
        ),
      ];
    }
    return [];
  }
  // Shrinkage: a 50%/yr loss → ratio of 0.5 over one year.
  // annualShrinkage = 1 - ratio^(1/years).
  const annualShrinkage = 1 - Math.pow(ratio, 1 / yearsElapsed);
  if (annualShrinkage > 0.5) {
    return [
      violation(
        'populationSane',
        `total population fell from ${prev} to ${cur} over ${yearsElapsed.toFixed(2)}y (${(annualShrinkage * 100).toFixed(1)}%/yr, threshold 50%/yr)`,
        'error',
      ),
    ];
  }
  return [];
};

export const noOrphanedActorRefs: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  const known = world.actors;
  for (const settlement of world.settlements.values()) {
    for (const ownerId of settlement.stockpileOwners) {
      if (!known.has(ownerId)) {
        out.push(
          violation(
            'noOrphanedActorRefs',
            `settlement ${String(settlement.id)}.stockpileOwners references missing actor ${String(ownerId)}`,
            'error',
          ),
        );
      }
    }
    for (const b of settlement.buildings) {
      if (!known.has(b.ownerActor)) {
        out.push(
          violation(
            'noOrphanedActorRefs',
            `settlement ${String(settlement.id)} building at ${hexKey(b.hex)} references missing actor ${String(b.ownerActor)}`,
            'error',
          ),
        );
      }
    }
  }
  for (const caravan of world.caravans.values()) {
    if (!known.has(caravan.ownerActor)) {
      out.push(
        violation(
          'noOrphanedActorRefs',
          `caravan ${String(caravan.id)} references missing actor ${String(caravan.ownerActor)}`,
          'error',
        ),
      );
    }
  }
  return out;
};

export const noOrphanedHexRefs: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  const grid = world.grid;
  for (const settlement of world.settlements.values()) {
    for (const h of settlement.urbanHexes) {
      if (!grid.has(h)) {
        out.push(
          violation(
            'noOrphanedHexRefs',
            `settlement ${String(settlement.id)} urban hex ${hexKey(h)} not in grid`,
            'error',
          ),
        );
      }
    }
    for (const h of settlement.catchmentHexes) {
      if (!grid.has(h)) {
        out.push(
          violation(
            'noOrphanedHexRefs',
            `settlement ${String(settlement.id)} catchment hex ${hexKey(h)} not in grid`,
            'error',
          ),
        );
      }
    }
    for (const b of settlement.buildings) {
      if (!grid.has(b.hex)) {
        out.push(
          violation(
            'noOrphanedHexRefs',
            `settlement ${String(settlement.id)} building at ${hexKey(b.hex)} not in grid`,
            'error',
          ),
        );
      }
    }
  }
  for (const caravan of world.caravans.values()) {
    if (!grid.has(caravan.position)) {
      out.push(
        violation(
          'noOrphanedHexRefs',
          `caravan ${String(caravan.id)} position ${hexKey(caravan.position)} not in grid`,
          'error',
        ),
      );
    }
    if (caravan.destination !== null && !grid.has(caravan.destination)) {
      out.push(
        violation(
          'noOrphanedHexRefs',
          `caravan ${String(caravan.id)} destination ${hexKey(caravan.destination)} not in grid`,
          'error',
        ),
      );
    }
  }
  for (const character of world.characters.values()) {
    if (!grid.has(character.location)) {
      out.push(
        violation(
          'noOrphanedHexRefs',
          `character ${String(character.id)} location ${hexKey(character.location)} not in grid`,
          'error',
        ),
      );
    }
  }
  return out;
};

/**
 * For every settlement, every resource with a recent outflow must have an
 * entry in lastClearingPrice. Pure recent inflow can be production output
 * (a mine produced iron ore; a farm harvested grain) and does not imply a
 * market trade happened yet. Outflow means goods left the local owner pool
 * through market consumption, local trade, tax, or caravan loading; that
 * should have a price signal.
 */
export const marketClearedAtAllSettlements: Invariant = ({ world }) => {
  const out: InvariantViolation[] = [];
  for (const settlement of world.settlements.values()) {
    const m = settlement.market;
    const traded = new Set<string>();
    for (const [resource, qty] of m.recentOutflows) {
      if (qty > 0) traded.add(String(resource));
    }
    for (const resource of traded) {
      let found = false;
      for (const knownResource of m.lastClearingPrice.keys()) {
        if (String(knownResource) === resource) {
          found = true;
          break;
        }
      }
      if (!found) {
        out.push(
          violation(
            'marketClearedAtAllSettlements',
            `settlement ${String(settlement.id)} traded ${resource} but has no lastClearingPrice for it`,
            'warn',
          ),
        );
      }
    }
  }
  return out;
};

// --- Standard set + runner --------------------------------------------------

export const STANDARD_INVARIANTS: readonly Invariant[] = Object.freeze([
  populationNonNegative,
  stockpileNonNegative,
  treasuryNonNegative,
  caravanCrewPositive,
  activeCaravanCountWithinCap,
  caravanCargoNonNegative,
  priceFinite,
  noPathologicalZeroPrices,
  reputationClamped,
  populationSane,
  noOrphanedActorRefs,
  noOrphanedHexRefs,
  marketClearedAtAllSettlements,
]);

export const checkInvariants = (
  ctx: InvariantContext,
  invariants: readonly Invariant[] = STANDARD_INVARIANTS,
): readonly InvariantViolation[] => {
  const out: InvariantViolation[] = [];
  for (const inv of invariants) {
    out.push(...inv(ctx));
  }
  return out;
};

// --- Daily snapshot ---------------------------------------------------------

export interface DailySummary {
  readonly day: Day;
  readonly totalPop: number;
  readonly totalSettlements: number;
  readonly activeCaravans: number;
  readonly banditCamps: number;
  readonly recentDeaths: number;
}

/**
 * Lightweight structured snapshot for periodic logging by the burn-in CLI.
 *
 * `banditCamps` is currently 0 because WorldState (T26) does not yet
 * track a top-level bandit camps map; once the camp registry lands this
 * invariant module will be extended (no schema changes required at the
 * call site).
 *
 * `recentDeaths` is 0 unless the caller passes recentEvents from the
 * tick loop and a future revision of this function consumes them.
 */
export const summarizeForDay = (world: WorldState, day: Day): DailySummary => ({
  day,
  totalPop: totalPopulation(world),
  totalSettlements: world.settlements.size,
  activeCaravans: world.caravans.size,
  banditCamps: 0,
  recentDeaths: 0,
});
