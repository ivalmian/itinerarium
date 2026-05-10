/**
 * Cross-catalog helpers: compute which job roles run inside each building,
 * derived from the recipe catalog. Per docs/04 §"Worker reallocation by
 * demand" + docs/05 §"Building catalog (v1)": a recipe needs both a
 * building of the right type AND specialist labor; this module surfaces
 * the building → primary-job mapping that the procgen worker
 * distribution + tick reallocation need.
 *
 * We compute these tables once at module load — neither the recipe nor
 * the building catalog changes at runtime.
 */

import { allRecipes } from '../production/recipes.js';
import type { BuildingId, JobId } from '../types.js';

/**
 * Aggregate labor weight per (building → job). Sums the recipe.labor entries
 * of every recipe that runs in that building, weighted by 1 (each recipe
 * counts once). The result is used to:
 *   1. Distribute initial workers across jobs at procgen, proportional to
 *      seeded building capacity.
 *   2. Identify the "primary" job role for a building (the one with the
 *      largest aggregated weight) when reallocating workers in/out.
 */
const buildIndex = (): ReadonlyMap<BuildingId, ReadonlyMap<JobId, number>> => {
  const idx = new Map<BuildingId, Map<JobId, number>>();
  for (const r of allRecipes()) {
    let entry = idx.get(r.building);
    if (entry === undefined) {
      entry = new Map<JobId, number>();
      idx.set(r.building, entry);
    }
    for (const [job, weight] of r.labor) {
      entry.set(job, (entry.get(job) ?? 0) + weight);
    }
  }
  // Freeze for safety.
  const frozen = new Map<BuildingId, ReadonlyMap<JobId, number>>();
  for (const [b, jobs] of idx) frozen.set(b, jobs);
  return frozen;
};

const BUILDING_TO_JOB_WEIGHTS = buildIndex();
const EMPTY_JOBS: ReadonlyMap<JobId, number> = new Map();

/**
 * The job roles that run inside `buildingId`, with the summed labor weight
 * across all of that building's recipes. Empty map for buildings with no
 * recipes (e.g. storage/civic/military).
 */
export const jobsForBuilding = (buildingId: BuildingId): ReadonlyMap<JobId, number> =>
  BUILDING_TO_JOB_WEIGHTS.get(buildingId) ?? EMPTY_JOBS;

/**
 * The single "primary" job for `buildingId` — the role with the largest
 * aggregated weight across that building's recipes. Returns null for
 * buildings with no recipes. Ties are broken deterministically by job-id
 * lexicographic order.
 */
export const primaryJobForBuilding = (buildingId: BuildingId): JobId | null => {
  const weights = jobsForBuilding(buildingId);
  let best: JobId | null = null;
  let bestWeight = -Infinity;
  // Sort by id so ties are deterministic.
  const entries = [...weights.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [job, w] of entries) {
    if (w > bestWeight) {
      best = job;
      bestWeight = w;
    }
  }
  return best;
};
