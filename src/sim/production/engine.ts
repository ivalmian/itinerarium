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

export const runRecipe = (req: RecipeRunRequest): RecipeRunResult => {
  const { recipe, building, laborAvailable, inputStocks, season } = req;

  // Seasonal gate. A recipe with a seasonalMultiplier dictionary that omits
  // the current season is considered off-season (treated as 0). A recipe
  // with no seasonalMultiplier at all runs in every season at full rate.
  const seasonMul = seasonalMultiplier(recipe, season);
  if (seasonMul <= 0) {
    return noRun({
      reason: 'no_building',
      detail: `recipe ${String(recipe.id)} is out of season (${season})`,
    });
  }

  // Building gate. The recipe must run in a building of the right type
  // with positive remaining capacity. One full recipe-run consumes
  // exactly one capacity unit; partial runs scale linearly.
  if (building.id !== recipe.building) {
    return noRun({
      reason: 'no_building',
      detail: `recipe requires building ${String(recipe.building)}, got ${String(building.id)}`,
    });
  }
  if (!Number.isFinite(building.capacityRemaining) || building.capacityRemaining <= 0) {
    return noRun({
      reason: 'no_building',
      detail: `building ${String(building.id)} has no remaining capacity`,
    });
  }

  // Labor gate. Every required role must be present in some quantity;
  // otherwise no run. Once present, the recipe scales by the worst-case
  // ratio of available / required across roles.
  let laborFraction = 1;
  for (const [role, required] of recipe.labor) {
    if (required <= 0) continue;
    const available = laborAvailable.get(role) ?? 0;
    if (available <= 0) {
      return noRun({
        reason: 'no_labor',
        detail: `missing labor role ${String(role)} for recipe ${String(recipe.id)}`,
      });
    }
    laborFraction = Math.min(laborFraction, available / required);
  }

  // Input gate. A required input that is entirely missing aborts the
  // recipe; a present-but-short input scales the run by available /
  // required, taking the worst case.
  let inputFraction = 1;
  for (const [resource, required] of recipe.inputs) {
    if (required <= 0) continue;
    const available = inputStocks.get(resource) ?? 0;
    if (available <= 0) {
      return noRun({
        reason: 'missing_input',
        detail: `missing input ${String(resource)} for recipe ${String(recipe.id)}`,
      });
    }
    inputFraction = Math.min(inputFraction, available / required);
  }

  // Building capacity ratio. capacityRemaining of 1 = one full recipe-
  // instance, 0.5 = half. Cap at 1 so a building with ample slack does
  // not let a recipe over-run its own per-day inputs/labor.
  const buildingFraction = Math.min(1, building.capacityRemaining);

  // The actual run fraction is the minimum constraint, scaled by the
  // seasonal multiplier (which is also a fractional cap in [0, 1] — a
  // multiplier > 1 is allowed in principle but not used by docs/03).
  const fraction = Math.min(buildingFraction, laborFraction, inputFraction) * seasonMul;
  if (fraction <= 0) {
    return noRun({
      reason: 'no_building',
      detail: `recipe ${String(recipe.id)} resolved to zero fraction`,
    });
  }

  const inputsConsumed = scaleQuantityMap(recipe.inputs, fraction);
  const outputsProduced = scaleQuantityMap(recipe.outputs, fraction);
  const laborUsed = scaleQuantityMap(recipe.labor, fraction);

  return {
    ranAtFraction: fraction,
    inputsConsumed,
    outputsProduced,
    laborUsed,
    buildingCapacityUsed: fraction,
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
