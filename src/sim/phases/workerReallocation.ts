/**
 * Monthly worker reallocation.
 *
 * Every settlement keeps a per-job `jobAllocations` headcount. Once
 * every ~30 days (docs/04 §"Worker reallocation by demand"), this
 * phase nudges ~8% of the workforce out of low-demand roles into
 * jobs that the economy is asking for, based on two signals:
 *
 *   1. **Blocked-labor counters.** During every tick the production
 *      engine emits `recipe_blocked` events with `reason='no_labor'`.
 *      `ingestLaborBlockedEvents` (called by the tick orchestrator
 *      right after the production + market phases) increments a
 *      WeakMap-keyed per-settlement / per-job counter so we can spot
 *      jobs that consistently run short.
 *
 *   2. **Price-driven economic demand.** `economicLaborDemandForSettlement`
 *      walks the recipe catalog at the runnable capacity present in
 *      each settlement and scores each labor role by
 *      `productionPriority × runnableCapacity × workerDays/recipe`. A
 *      town with iron piling up and tool prices climbing will want
 *      smiths even if no recipe was explicitly *blocked* — the price
 *      signal pulls labor pre-emptively.
 *
 * Selection: donor role is the lowest demand-per-worker (tie-break by
 * largest headcount), recipient roles are split by their share of the
 * combined demand vector. Both choices are deterministic ID-tie-broken
 * so re-running a tick with the same seed produces identical moves.
 *
 * Originally lived inline in `src/sim/tick.ts`.
 */

import {
  buildingsByKindForSettlement,
  mineRecipeHasMismatchedDeposit,
  productionPriority,
} from './production.js';
import { allRecipes } from '../production/recipes.js';
import type { Day, JobId, RecipeId, SettlementId } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import { dayOfYearToSeason, type Season } from '../world/terrain.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

/**
 * Per-(settlement, job) rolling counter of how many recipe_blocked /
 * reason="labor" landed on each job role over the last ~30 days. We refresh
 * the counter at every monthly reallocation; it accumulates between resets.
 *
 * Stored in a WeakMap keyed by Settlement reference (matching the famine
 * pressure pattern elsewhere) so a fresh world built in a test starts clean
 * regardless of id reuse.
 */
const recentLaborBlockedByJob: WeakMap<Settlement, Map<JobId, number>> = new WeakMap();

/**
 * Recipe id → RecipeDef cache (built once at module load). Used to resolve
 * the labor map for a recipe_blocked event without an O(N) scan.
 */
const recipeIdToDef: ReadonlyMap<RecipeId, ReturnType<typeof allRecipes>[number]> = (() => {
  const m = new Map<RecipeId, ReturnType<typeof allRecipes>[number]>();
  for (const r of allRecipes()) m.set(r.id, r);
  return m;
})();

/**
 * Walk the events emitted this tick and increment per-(settlement, job)
 * recipe_blocked-labor counters. Called by the tick orchestrator right
 * after the production + market phases so the counters stay in sync.
 */
export const ingestLaborBlockedEvents = (
  world: WorldState,
  events: readonly TickEvent[],
): void => {
  for (const e of events) {
    if (e.type !== 'recipe_blocked') continue;
    // The production engine emits 'no_labor' (see ShortfallReason in
    // src/sim/production/engine.ts). docs/04 describes this generically as
    // "labor"; we match the engine's enum here.
    if (e.reason !== 'no_labor') continue;
    const recipeDef = recipeIdToDef.get(e.recipe);
    if (recipeDef === undefined) continue;
    const settlement = world.settlements.get(e.settlement as SettlementId);
    if (settlement === undefined) continue;
    let bucket = recentLaborBlockedByJob.get(settlement);
    if (bucket === undefined) {
      bucket = new Map<JobId, number>();
      recentLaborBlockedByJob.set(settlement, bucket);
    }
    for (const role of recipeDef.labor.keys()) {
      bucket.set(role, (bucket.get(role) ?? 0) + 1);
    }
  }
};

const mergeLaborDemand = (
  target: Map<JobId, number>,
  source: ReadonlyMap<JobId, number> | undefined,
): void => {
  if (source === undefined) return;
  for (const [job, score] of source) {
    if (score <= 0) continue;
    target.set(job, (target.get(job) ?? 0) + score);
  }
};

const economicLaborDemandForSettlement = (
  world: WorldState,
  settlement: Settlement,
  season: Season,
): Map<JobId, number> => {
  const out = new Map<JobId, number>();
  const buildingsByKind = buildingsByKindForSettlement(settlement);

  for (const recipe of allRecipes()) {
    const buildings = buildingsByKind.get(recipe.building);
    if (buildings === undefined || buildings.length === 0) continue;
    const priority = productionPriority(settlement, recipe, season);
    if (!Number.isFinite(priority) || priority <= 0) continue;

    let runnableCapacity = 0;
    for (const building of buildings) {
      if (building.capacity <= 0) continue;
      if (mineRecipeHasMismatchedDeposit(world, building, recipe)) continue;
      runnableCapacity += Math.max(0, building.capacity);
    }
    if (runnableCapacity <= 0) continue;

    const score = priority * runnableCapacity;
    for (const [job, workerDaysPerRun] of recipe.labor) {
      if (workerDaysPerRun <= 0) continue;
      out.set(job, (out.get(job) ?? 0) + score * workerDaysPerRun);
    }
  }

  return out;
};

const combinedLaborDemandForSettlement = (
  world: WorldState,
  settlement: Settlement,
  season: Season,
): Map<JobId, number> => {
  const out = economicLaborDemandForSettlement(world, settlement, season);
  mergeLaborDemand(out, recentLaborBlockedByJob.get(settlement));
  return out;
};

/** Per-month per-settlement reallocation rate (docs/04: ~8%/month). */
const REALLOCATION_RATE = 0.08;

/**
 * Move ~8% of workers per month from over-supplied roles to under-supplied
 * roles. Algorithm:
 *
 *   1. The set of "demanded" roles = roles whose recipes were blocked by
 *      labor over the last ~30 days (from `recentLaborBlockedByJob`).
 *      Split this month's reallocation budget across those roles by blocked
 *      count so a single noisy bottleneck does not starve other shortages.
 *      Price-profitable recipes also add demand, so partial bottlenecks
 *      move labor even when a recipe can still run at a small fraction.
 *   2. The donor role is the allocation with the lowest demand-per-worker,
 *      tie-broken by largest headcount. This lets a town move surplus miners
 *      into smelting after ore piles up and iron/tool prices rise.
 *   3. Move floor(totalWorkers × REALLOCATION_RATE) workers per month, with a
 *      floor of 1 so something happens when fractions are tiny but workers
 *      exist.
 *
 * Emits a `workers_reallocated` TickEvent per move so burn-in telemetry can
 * see the system at work.
 */
export const workerReallocationPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  const season = dayOfYearToSeason(_today);
  for (const settlement of world.settlements.values()) {
    if (settlement.jobAllocations.size === 0) continue;

    const demanded = combinedLaborDemandForSettlement(world, settlement, season);
    if (demanded.size === 0) {
      // Nothing demanded this month; reset and continue.
      recentLaborBlockedByJob.delete(settlement);
      continue;
    }

    const totalWorkers = [...settlement.jobAllocations.values()].reduce(
      (sum, n) => sum + Math.max(0, n),
      0,
    );
    if (totalWorkers <= 0) {
      recentLaborBlockedByJob.delete(settlement);
      continue;
    }

    const totalDemand = [...demanded.values()].reduce((sum, n) => sum + Math.max(0, n), 0);
    if (totalDemand <= 0) {
      recentLaborBlockedByJob.delete(settlement);
      continue;
    }

    const orderedDemand = [...demanded.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0;
    });
    let remainingBudget = Math.max(1, Math.floor(totalWorkers * REALLOCATION_RATE));

    for (const [targetJob, demandCount] of orderedDemand) {
      if (remainingBudget <= 0) break;
      const targetShare = Math.max(0, demandCount) / totalDemand;
      const targetBudget = Math.min(
        remainingBudget,
        Math.max(1, Math.floor(totalWorkers * REALLOCATION_RATE * targetShare)),
      );
      if (targetBudget <= 0) continue;

      // Pick the donor: lowest demand per current worker, then largest allocation.
      let donorJob: JobId | null = null;
      let donorCount = 0;
      const allocOrdered = [...settlement.jobAllocations.entries()].sort((a, b) => {
        const demandA = demanded.get(a[0]) ?? 0;
        const demandB = demanded.get(b[0]) ?? 0;
        const intensityA = demandA / Math.max(1, a[1]);
        const intensityB = demandB / Math.max(1, b[1]);
        if (intensityA !== intensityB) return intensityA - intensityB;
        if (b[1] !== a[1]) return b[1] - a[1];
        return String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0;
      });
      for (const [j, n] of allocOrdered) {
        if (j === targetJob) continue;
        if (n <= 0) continue;
        donorJob = j;
        donorCount = n;
        break;
      }
      if (donorJob === null || donorCount <= 0) break;

      const actualMove = Math.min(targetBudget, donorCount, remainingBudget);
      if (actualMove <= 0) continue;

      settlement.jobAllocations.set(donorJob, donorCount - actualMove);
      settlement.jobAllocations.set(
        targetJob,
        (settlement.jobAllocations.get(targetJob) ?? 0) + actualMove,
      );
      remainingBudget -= actualMove;

      events.push({
        type: 'workers_reallocated',
        settlement: settlement.id,
        fromJob: donorJob,
        toJob: targetJob,
        count: actualMove,
      });
    }

    // Reset the rolling counter for next month's window.
    recentLaborBlockedByJob.delete(settlement);
  }
};
