/**
 * Per-day production engine.
 *
 * Runs a single recipe at a building owned by a single actor. The caller
 * is responsible for stockpile bookkeeping — the engine returns the
 * deltas (inputs consumed, outputs produced, labor used, capacity used)
 * so the caller can apply them to whatever data structures hold actor
 * stockpiles, building capacity, and labor pools.
 *
 * Design references:
 *   docs/03-production.md  — recipe shape, building+specialist rule,
 *                            seasonal multipliers, scale-down rule.
 *   docs/05-settlements.md — buildings/labor live at a settlement; the
 *                            engine is intentionally stateless and works
 *                            on any owner+building pair.
 *   docs/11-politics-and-ownership.md — outputs go to the owner actor's
 *                            stockpile, not a generic settlement pool.
 *
 * Locked rules (docs/03):
 *   - Both building AND specialist labor required. Either missing → no run.
 *   - Scale down proportionally if building capacity, labor, or any input
 *     is short. Final fraction = min across all four constraints.
 *   - Seasonal multiplier applies multiplicatively. Multiplier 0 → no run.
 *
 * The engine is pure and deterministic: same input → same output.
 */

import type { ActorId, BuildingId, JobId, Quantity, RecipeId, ResourceId } from '../types.js';
import type { Season } from '../world/terrain.js';

/**
 * Minimal recipe shape the engine consumes. The full recipe registry
 * (in this same package) is a superset; the engine intentionally types
 * against a structural minimum so tests and integration callers can
 * supply synthetic recipes without depending on the catalog.
 */
export interface ProductionRecipe {
  readonly id: RecipeId;
  readonly inputs: ReadonlyMap<ResourceId, Quantity>;
  /**
   * Resources that must be PRESENT in the owner's stockpile but are NOT
   * consumed. Factors into the fraction calculation (recipe scales down if
   * `requires[r] / available < 1`) but no deduction happens at run-time.
   * See docs/03 "livestock are stocks, not flows". Optional for callers
   * with synthetic test recipes.
   */
  readonly requires?: ReadonlyMap<ResourceId, Quantity>;
  readonly outputs: ReadonlyMap<ResourceId, Quantity>;
  readonly labor: ReadonlyMap<JobId, number>;
  readonly building: BuildingId;
  readonly seasonalMultiplier?: Partial<Record<Season, number>>;
}

export interface RecipeRunRequest {
  readonly recipe: ProductionRecipe;
  readonly building: { readonly id: BuildingId; readonly capacityRemaining: number };
  /** Outputs are produced for this actor; the engine just emits the delta. */
  readonly ownerActor: ActorId;
  readonly laborAvailable: ReadonlyMap<JobId, number>;
  readonly inputStocks: ReadonlyMap<ResourceId, Quantity>;
  readonly season: Season;
}

export type ShortfallReason = 'no_building' | 'no_labor' | 'missing_input';

export interface RecipeRunShortfall {
  readonly reason: ShortfallReason;
  readonly detail: string;
}

export interface RecipeRunResult {
  readonly ranAtFraction: number;
  readonly inputsConsumed: ReadonlyMap<ResourceId, Quantity>;
  readonly outputsProduced: ReadonlyMap<ResourceId, Quantity>;
  readonly laborUsed: ReadonlyMap<JobId, number>;
  readonly buildingCapacityUsed: number;
  readonly shortfall?: RecipeRunShortfall;
}

export interface RecipeRunPlan {
  readonly ranAtFraction: number;
  readonly buildingCapacityUsed: number;
  readonly shortfall?: RecipeRunShortfall;
}

export interface RecipeRunPlanSummary {
  readonly ranAtFraction: number;
  readonly buildingCapacityUsed: number;
  readonly shortfallReason?: ShortfallReason;
}

const EMPTY_RESOURCES: ReadonlyMap<ResourceId, Quantity> = new Map();
const EMPTY_LABOR: ReadonlyMap<JobId, number> = new Map();

const noRun = (shortfall: RecipeRunShortfall): RecipeRunResult => ({
  ranAtFraction: 0,
  inputsConsumed: EMPTY_RESOURCES,
  outputsProduced: EMPTY_RESOURCES,
  laborUsed: EMPTY_LABOR,
  buildingCapacityUsed: 0,
  shortfall,
});

const noRunPlan = (shortfall: RecipeRunShortfall): RecipeRunPlan => ({
  ranAtFraction: 0,
  buildingCapacityUsed: 0,
  shortfall,
});

const noRunPlanSummary = (shortfallReason: ShortfallReason): RecipeRunPlanSummary => ({
  ranAtFraction: 0,
  buildingCapacityUsed: 0,
  shortfallReason,
});

export const planRecipeRunSummary = (
  recipe: ProductionRecipe,
  buildingId: BuildingId,
  capacityRemaining: number,
  laborAvailable: ReadonlyMap<JobId, number>,
  inputStocks: ReadonlyMap<ResourceId, Quantity>,
  season: Season,
): RecipeRunPlanSummary => {
  const seasonMul = seasonalMultiplier(recipe, season);
  if (seasonMul <= 0) return noRunPlanSummary('no_building');

  if (buildingId !== recipe.building) return noRunPlanSummary('no_building');
  if (!Number.isFinite(capacityRemaining) || capacityRemaining <= 0) {
    return noRunPlanSummary('no_building');
  }

  let laborFraction = Number.POSITIVE_INFINITY;
  for (const [role, required] of recipe.labor) {
    if (required <= 0) continue;
    const available = laborAvailable.get(role) ?? 0;
    if (available <= 0) return noRunPlanSummary('no_labor');
    laborFraction = Math.min(laborFraction, available / required);
  }

  let inputFraction = Number.POSITIVE_INFINITY;
  for (const [resource, required] of recipe.inputs) {
    if (required <= 0) continue;
    const available = inputStocks.get(resource) ?? 0;
    if (available <= 0) return noRunPlanSummary('missing_input');
    inputFraction = Math.min(inputFraction, available / required);
  }

  if (recipe.requires !== undefined) {
    for (const [resource, needed] of recipe.requires) {
      if (needed <= 0) continue;
      const available = inputStocks.get(resource) ?? 0;
      if (available <= 0) return noRunPlanSummary('missing_input');
      inputFraction = Math.min(inputFraction, available / needed);
    }
  }

  const fraction = Math.min(capacityRemaining, laborFraction, inputFraction) * seasonMul;
  if (fraction <= 0) return noRunPlanSummary('no_building');

  return {
    ranAtFraction: fraction,
    buildingCapacityUsed: fraction,
  };
};

export const planRecipeRun = (req: RecipeRunRequest): RecipeRunPlan => {
  const { recipe, building, laborAvailable, inputStocks, season } = req;

  // Seasonal gate. A recipe with a seasonalMultiplier dictionary that omits
  // the current season is considered off-season (treated as 0). A recipe
  // with no seasonalMultiplier at all runs in every season at full rate.
  const seasonMul = seasonalMultiplier(recipe, season);
  if (seasonMul <= 0) {
    return noRunPlan({
      reason: 'no_building',
      detail: `recipe ${String(recipe.id)} is out of season (${season})`,
    });
  }

  // Building gate. The recipe must run in a building of the right type
  // with positive remaining capacity. One full recipe-run consumes
  // exactly one capacity unit; partial runs scale linearly.
  if (building.id !== recipe.building) {
    return noRunPlan({
      reason: 'no_building',
      detail: `recipe requires building ${String(recipe.building)}, got ${String(building.id)}`,
    });
  }
  if (!Number.isFinite(building.capacityRemaining) || building.capacityRemaining <= 0) {
    return noRunPlan({
      reason: 'no_building',
      detail: `building ${String(building.id)} has no remaining capacity`,
    });
  }

  // Labor gate. Every required role must be present in some quantity;
  // otherwise no run. Recipe instance count is bounded by the worst-case
  // ratio of available / required across roles. NOT capped at 1 — high
  // labor allows running many instances in parallel up to building cap.
  let laborFraction = Number.POSITIVE_INFINITY;
  for (const [role, required] of recipe.labor) {
    if (required <= 0) continue;
    const available = laborAvailable.get(role) ?? 0;
    if (available <= 0) {
      return noRunPlan({
        reason: 'no_labor',
        detail: `missing labor role ${String(role)} for recipe ${String(recipe.id)}`,
      });
    }
    laborFraction = Math.min(laborFraction, available / required);
  }
  if (!Number.isFinite(laborFraction)) {
    // Recipe declares no labor — labor is not a binding constraint.
    laborFraction = Number.POSITIVE_INFINITY;
  }

  // Input gate. A required input that is entirely missing aborts the
  // recipe; a present-but-short input scales the run by available /
  // required, taking the worst case. NOT capped at 1 — abundant inputs
  // allow many instances up to building cap.
  let inputFraction = Number.POSITIVE_INFINITY;
  for (const [resource, required] of recipe.inputs) {
    if (required <= 0) continue;
    const available = inputStocks.get(resource) ?? 0;
    if (available <= 0) {
      return noRunPlan({
        reason: 'missing_input',
        detail: `missing input ${String(resource)} for recipe ${String(recipe.id)}`,
      });
    }
    inputFraction = Math.min(inputFraction, available / required);
  }
  if (!Number.isFinite(inputFraction)) {
    inputFraction = Number.POSITIVE_INFINITY;
  }

  // Requires gate. A "present-but-not-consumed" resource (e.g. the
  // standing herd at a pasture). Factors into the fraction calculation
  // — entirely missing aborts the run, present-but-short scales it down
  // — but the resource is NEVER deducted from the stockpile downstream.
  // Modeling pattern: shearing/milking are flow extractions on top of a
  // standing herd stock. See docs/03 "livestock are stocks, not flows".
  if (recipe.requires !== undefined) {
    for (const [resource, needed] of recipe.requires) {
      if (needed <= 0) continue;
      const available = inputStocks.get(resource) ?? 0;
      if (available <= 0) {
        return noRunPlan({
          reason: 'missing_input',
          detail: `missing required-present ${String(resource)} for recipe ${String(recipe.id)}`,
        });
      }
      inputFraction = Math.min(inputFraction, available / needed);
    }
  }

  // Building capacity is in recipe-instances per day. capacityRemaining=50
  // means up to 50 instances of this recipe today (subject to labor and
  // inputs). Each instance consumes its share of capacity, labor, and
  // inputs proportionally. The previous min(1, ...) clamp was wrong: it
  // limited every building to a single instance/day no matter the catalog
  // cap, which is why the burn-in's grain stockpile fell linearly even
  // though farms were configured at cap=50 (one farm produced ~80 modii
  // /day instead of the expected ~4000).
  const buildingFraction = building.capacityRemaining;

  // The actual run fraction is the minimum constraint, scaled by the
  // seasonal multiplier (which is also a fractional cap in [0, 1] — a
  // multiplier > 1 is allowed in principle but not used by docs/03).
  const fraction = Math.min(buildingFraction, laborFraction, inputFraction) * seasonMul;
  if (fraction <= 0) {
    return noRunPlan({
      reason: 'no_building',
      detail: `recipe ${String(recipe.id)} resolved to zero fraction`,
    });
  }

  return {
    ranAtFraction: fraction,
    buildingCapacityUsed: fraction,
  };
};

export const runRecipe = (req: RecipeRunRequest): RecipeRunResult => {
  const plan = planRecipeRun(req);
  if (plan.shortfall !== undefined || plan.ranAtFraction <= 0) {
    return plan.shortfall !== undefined
      ? noRun(plan.shortfall)
      : noRun({
          reason: 'no_building',
          detail: `recipe ${String(req.recipe.id)} resolved to zero fraction`,
        });
  }
  const fraction = plan.ranAtFraction;
  const inputsConsumed = scaleQuantityMap(req.recipe.inputs, fraction);
  const outputsProduced = scaleQuantityMap(req.recipe.outputs, fraction);
  const laborUsed = scaleQuantityMap(req.recipe.labor, fraction);

  return {
    ranAtFraction: fraction,
    inputsConsumed,
    outputsProduced,
    laborUsed,
    buildingCapacityUsed: plan.buildingCapacityUsed,
  };
};

const seasonalMultiplier = (recipe: ProductionRecipe, season: Season): number => {
  if (recipe.seasonalMultiplier === undefined) return 1;
  const m = recipe.seasonalMultiplier[season];
  return m === undefined ? 0 : m;
};

const scaleQuantityMap = <K>(
  src: ReadonlyMap<K, number>,
  factor: number,
): ReadonlyMap<K, number> => {
  const out = new Map<K, number>();
  for (const [k, v] of src) {
    out.set(k, v * factor);
  }
  return out;
};
