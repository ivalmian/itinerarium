/**
 * Production engine tests.
 *
 * Uses synthetic Recipe-shaped fixtures so the tests do not depend on the
 * full RECIPES catalog landing first. Wiring the catalog into a real tick
 * loop is a later integration task.
 */

import { describe, expect, it } from 'vitest';
import {
  actorId,
  buildingId,
  jobId,
  recipeId,
  resourceId,
  type JobId,
  type Quantity,
  type ResourceId,
} from '../types.js';
import type { Season } from '../world/terrain.js';
import { runRecipe, type ProductionRecipe, type RecipeRunRequest } from './engine.js';

const RES = {
  grain: resourceId('food.grain'),
  flour: resourceId('food.flour'),
  wood: resourceId('material.wood'),
  bread: resourceId('food.bread'),
  olives: resourceId('food.olives'),
  amphora: resourceId('material.amphora'),
  oil: resourceId('food.olive_oil'),
};

const JOB = {
  miller: jobId('miller'),
  baker: jobId('baker'),
  presser: jobId('presser'),
};

const BUILDING = {
  mill: buildingId('mill'),
  bakery: buildingId('bakery'),
  oilPress: buildingId('oil_press'),
};

const RECIPE = {
  millGrain: recipeId('mill_grain'),
  bakeBread: recipeId('bake_bread'),
  pressOlives: recipeId('press_olives'),
};

const OWNER = actorId('actor:miller-1');

const millGrainRecipe: ProductionRecipe = {
  id: RECIPE.millGrain,
  inputs: new Map<ResourceId, Quantity>([[RES.grain, 50]]),
  outputs: new Map<ResourceId, Quantity>([[RES.flour, 45]]),
  labor: new Map<JobId, number>([[JOB.miller, 1]]),
  building: BUILDING.mill,
};

const bakeBreadRecipe: ProductionRecipe = {
  id: RECIPE.bakeBread,
  inputs: new Map<ResourceId, Quantity>([
    [RES.flour, 30],
    [RES.wood, 5],
  ]),
  outputs: new Map<ResourceId, Quantity>([[RES.bread, 40]]),
  labor: new Map<JobId, number>([[JOB.baker, 1]]),
  building: BUILDING.bakery,
};

const pressOlivesRecipe: ProductionRecipe = {
  id: RECIPE.pressOlives,
  inputs: new Map<ResourceId, Quantity>([
    [RES.olives, 300],
    [RES.amphora, 5],
  ]),
  outputs: new Map<ResourceId, Quantity>([[RES.oil, 60]]),
  labor: new Map<JobId, number>([[JOB.presser, 1]]),
  building: BUILDING.oilPress,
  seasonalMultiplier: { spring: 0, summer: 0, autumn: 1, winter: 0 },
};

const baseRequest = (overrides: Partial<RecipeRunRequest> = {}): RecipeRunRequest => ({
  recipe: millGrainRecipe,
  building: { id: BUILDING.mill, capacityRemaining: 1 },
  ownerActor: OWNER,
  laborAvailable: new Map<JobId, number>([[JOB.miller, 1]]),
  inputStocks: new Map<ResourceId, Quantity>([[RES.grain, 50]]),
  season: 'spring',
  ...overrides,
});

describe('runRecipe — happy path', () => {
  it('runs at full fraction when inputs, labor, and building are all sufficient', () => {
    const result = runRecipe(baseRequest());
    expect(result.ranAtFraction).toBe(1);
    expect(result.inputsConsumed.get(RES.grain)).toBe(50);
    expect(result.outputsProduced.get(RES.flour)).toBe(45);
    expect(result.laborUsed.get(JOB.miller)).toBe(1);
    expect(result.buildingCapacityUsed).toBe(1);
    expect(result.shortfall).toBeUndefined();
  });

  it('returns the configured ownerActor implicitly via caller — engine returns deltas only', () => {
    const result = runRecipe(baseRequest({ ownerActor: actorId('actor:patrician-3') }));
    expect(result.ranAtFraction).toBe(1);
  });

  it('handles a multi-input recipe correctly', () => {
    const result = runRecipe(
      baseRequest({
        recipe: bakeBreadRecipe,
        building: { id: BUILDING.bakery, capacityRemaining: 1 },
        laborAvailable: new Map<JobId, number>([[JOB.baker, 1]]),
        inputStocks: new Map<ResourceId, Quantity>([
          [RES.flour, 30],
          [RES.wood, 5],
        ]),
      }),
    );
    expect(result.ranAtFraction).toBe(1);
    expect(result.inputsConsumed.get(RES.flour)).toBe(30);
    expect(result.inputsConsumed.get(RES.wood)).toBe(5);
    expect(result.outputsProduced.get(RES.bread)).toBe(40);
  });
});

describe('runRecipe — building constraints', () => {
  it('returns 0 when building id does not match', () => {
    const result = runRecipe(
      baseRequest({ building: { id: BUILDING.bakery, capacityRemaining: 1 } }),
    );
    expect(result.ranAtFraction).toBe(0);
    expect(result.inputsConsumed.size).toBe(0);
    expect(result.outputsProduced.size).toBe(0);
    expect(result.laborUsed.size).toBe(0);
    expect(result.buildingCapacityUsed).toBe(0);
    expect(result.shortfall?.reason).toBe('no_building');
  });

  it('returns 0 when building has zero capacity remaining', () => {
    const result = runRecipe(
      baseRequest({ building: { id: BUILDING.mill, capacityRemaining: 0 } }),
    );
    expect(result.ranAtFraction).toBe(0);
    expect(result.shortfall?.reason).toBe('no_building');
  });

  it('scales down to building capacity when capacity < 1', () => {
    const result = runRecipe(
      baseRequest({ building: { id: BUILDING.mill, capacityRemaining: 0.5 } }),
    );
    expect(result.ranAtFraction).toBe(0.5);
    expect(result.inputsConsumed.get(RES.grain)).toBe(25);
    expect(result.outputsProduced.get(RES.flour)).toBe(22.5);
    expect(result.laborUsed.get(JOB.miller)).toBe(0.5);
    expect(result.buildingCapacityUsed).toBe(0.5);
  });
});

describe('runRecipe — labor constraints', () => {
  it('returns 0 when no labor present at all', () => {
    const result = runRecipe(baseRequest({ laborAvailable: new Map() }));
    expect(result.ranAtFraction).toBe(0);
    expect(result.shortfall?.reason).toBe('no_labor');
  });

  it('scales by labor available / labor required when labor is short', () => {
    const result = runRecipe(
      baseRequest({ laborAvailable: new Map<JobId, number>([[JOB.miller, 0.25]]) }),
    );
    expect(result.ranAtFraction).toBeCloseTo(0.25);
    expect(result.inputsConsumed.get(RES.grain)).toBeCloseTo(12.5);
    expect(result.outputsProduced.get(RES.flour)).toBeCloseTo(11.25);
    expect(result.laborUsed.get(JOB.miller)).toBeCloseTo(0.25);
  });

  it('returns 0 if a labor role is missing entirely', () => {
    const result = runRecipe(
      baseRequest({ laborAvailable: new Map<JobId, number>([[JOB.baker, 1]]) }),
    );
    expect(result.ranAtFraction).toBe(0);
    expect(result.shortfall?.reason).toBe('no_labor');
  });

  it('uses the worst-case role when multiple labor roles are required', () => {
    const multiLaborRecipe: ProductionRecipe = {
      ...millGrainRecipe,
      labor: new Map<JobId, number>([
        [JOB.miller, 1],
        [JOB.baker, 2],
      ]),
    };
    const result = runRecipe(
      baseRequest({
        recipe: multiLaborRecipe,
        laborAvailable: new Map<JobId, number>([
          [JOB.miller, 1],
          [JOB.baker, 1],
        ]),
      }),
    );
    expect(result.ranAtFraction).toBeCloseTo(0.5);
    expect(result.laborUsed.get(JOB.miller)).toBeCloseTo(0.5);
    expect(result.laborUsed.get(JOB.baker)).toBeCloseTo(1);
  });
});

describe('runRecipe — input constraints', () => {
  it('scales by the most-limiting input when one is short', () => {
    const result = runRecipe(
      baseRequest({
        recipe: bakeBreadRecipe,
        building: { id: BUILDING.bakery, capacityRemaining: 1 },
        laborAvailable: new Map<JobId, number>([[JOB.baker, 1]]),
        inputStocks: new Map<ResourceId, Quantity>([
          [RES.flour, 30],
          [RES.wood, 1],
        ]),
      }),
    );
    expect(result.ranAtFraction).toBeCloseTo(0.2);
    expect(result.inputsConsumed.get(RES.flour)).toBeCloseTo(6);
    expect(result.inputsConsumed.get(RES.wood)).toBeCloseTo(1);
    expect(result.outputsProduced.get(RES.bread)).toBeCloseTo(8);
  });

  it('returns 0 with shortfall when an input is missing entirely', () => {
    const result = runRecipe(
      baseRequest({
        recipe: bakeBreadRecipe,
        building: { id: BUILDING.bakery, capacityRemaining: 1 },
        laborAvailable: new Map<JobId, number>([[JOB.baker, 1]]),
        inputStocks: new Map<ResourceId, Quantity>([[RES.flour, 30]]),
      }),
    );
    expect(result.ranAtFraction).toBe(0);
    expect(result.shortfall?.reason).toBe('missing_input');
    expect(result.shortfall?.detail).toContain('material.wood');
  });

  it('partial inputs consumed proportionally — does not overdraw the wood stock', () => {
    const result = runRecipe(
      baseRequest({
        recipe: bakeBreadRecipe,
        building: { id: BUILDING.bakery, capacityRemaining: 1 },
        laborAvailable: new Map<JobId, number>([[JOB.baker, 1]]),
        inputStocks: new Map<ResourceId, Quantity>([
          [RES.flour, 100],
          [RES.wood, 2],
        ]),
      }),
    );
    expect(result.ranAtFraction).toBeCloseTo(0.4);
    expect(result.inputsConsumed.get(RES.wood)).toBeLessThanOrEqual(2);
  });
});

describe('runRecipe — seasonal multiplier', () => {
  it('runs at full rate in autumn for press_olives', () => {
    const result = runRecipe(
      baseRequest({
        recipe: pressOlivesRecipe,
        building: { id: BUILDING.oilPress, capacityRemaining: 1 },
        laborAvailable: new Map<JobId, number>([[JOB.presser, 1]]),
        inputStocks: new Map<ResourceId, Quantity>([
          [RES.olives, 300],
          [RES.amphora, 5],
        ]),
        season: 'autumn',
      }),
    );
    expect(result.ranAtFraction).toBe(1);
    expect(result.outputsProduced.get(RES.oil)).toBe(60);
  });

  it('does not run in winter for press_olives (multiplier 0)', () => {
    const result = runRecipe(
      baseRequest({
        recipe: pressOlivesRecipe,
        building: { id: BUILDING.oilPress, capacityRemaining: 1 },
        laborAvailable: new Map<JobId, number>([[JOB.presser, 1]]),
        inputStocks: new Map<ResourceId, Quantity>([
          [RES.olives, 300],
          [RES.amphora, 5],
        ]),
        season: 'winter',
      }),
    );
    expect(result.ranAtFraction).toBe(0);
    expect(result.inputsConsumed.size).toBe(0);
    expect(result.outputsProduced.size).toBe(0);
    expect(result.shortfall?.reason).toBe('no_building');
    // The reason for the off-season block is encoded in the detail.
    expect(result.shortfall?.detail.toLowerCase()).toContain('season');
  });

  it('treats unspecified season in seasonalMultiplier as 0 (only declared seasons run)', () => {
    const partialSeasonal: ProductionRecipe = {
      ...millGrainRecipe,
      seasonalMultiplier: { autumn: 1 },
    };
    const result = runRecipe(baseRequest({ recipe: partialSeasonal, season: 'spring' as Season }));
    expect(result.ranAtFraction).toBe(0);
  });

  it('scales output by a fractional seasonal multiplier', () => {
    const halfSpring: ProductionRecipe = {
      ...millGrainRecipe,
      seasonalMultiplier: { spring: 0.5, summer: 1, autumn: 1, winter: 0.25 },
    };
    const result = runRecipe(baseRequest({ recipe: halfSpring, season: 'spring' }));
    expect(result.ranAtFraction).toBe(0.5);
    expect(result.inputsConsumed.get(RES.grain)).toBe(25);
    expect(result.outputsProduced.get(RES.flour)).toBe(22.5);
  });

  it('runs normally when seasonalMultiplier is undefined', () => {
    const result = runRecipe(baseRequest({ season: 'winter' }));
    expect(result.ranAtFraction).toBe(1);
  });
});

describe('runRecipe — combined constraints', () => {
  it('multiplies the minimum gating constraint by the seasonal multiplier', () => {
    const halfAutumn: ProductionRecipe = {
      ...millGrainRecipe,
      seasonalMultiplier: { autumn: 0.6, summer: 1, spring: 1, winter: 0 },
    };
    const result = runRecipe(
      baseRequest({
        recipe: halfAutumn,
        building: { id: BUILDING.mill, capacityRemaining: 0.8 },
        laborAvailable: new Map<JobId, number>([[JOB.miller, 0.4]]),
        inputStocks: new Map<ResourceId, Quantity>([[RES.grain, 50]]),
        season: 'autumn',
      }),
    );
    // Min(0.8 capacity, 0.4 labor, 1.0 inputs) = 0.4, scaled by 0.6 season.
    expect(result.ranAtFraction).toBeCloseTo(0.24);
  });

  it('takes the minimum across building, labor, and inputs at full season', () => {
    const result = runRecipe(
      baseRequest({
        building: { id: BUILDING.mill, capacityRemaining: 0.8 },
        laborAvailable: new Map<JobId, number>([[JOB.miller, 0.4]]),
        inputStocks: new Map<ResourceId, Quantity>([[RES.grain, 50]]),
      }),
    );
    expect(result.ranAtFraction).toBeCloseTo(0.4);
  });
});

describe('runRecipe — requires (present-but-not-consumed)', () => {
  // Synthetic "shear wool" style recipe: 0.01 sheep PRESENT (not consumed)
  // → 0.55 wool / instance. Mirrors recipes.ts shear_wool semantics so the
  // engine behavior stays in sync with the catalog representation.
  const wool = resourceId('material.wool');
  const sheep = resourceId('livestock.sheep');
  const shepherd = jobId('shepherd');
  const pasture = buildingId('pasture');
  const shearRecipe: ProductionRecipe = {
    id: recipeId('shear_wool'),
    inputs: new Map<ResourceId, Quantity>(),
    requires: new Map<ResourceId, Quantity>([[sheep, 0.01]]),
    outputs: new Map<ResourceId, Quantity>([[wool, 0.55]]),
    labor: new Map<JobId, number>([[shepherd, 0.1]]),
    building: pasture,
  };

  const shearRequest = (overrides: Partial<RecipeRunRequest> = {}): RecipeRunRequest => ({
    recipe: shearRecipe,
    building: { id: pasture, capacityRemaining: 1 },
    ownerActor: OWNER,
    laborAvailable: new Map<JobId, number>([[shepherd, 0.1]]),
    inputStocks: new Map<ResourceId, Quantity>([[sheep, 100]]),
    season: 'spring',
    ...overrides,
  });

  it('runs at full fraction when the required-present resource is abundant', () => {
    const r = runRecipe(shearRequest());
    expect(r.ranAtFraction).toBe(1);
    expect(r.outputsProduced.get(wool)).toBe(0.55);
  });

  it('does NOT consume the required-present resource (no entry in inputsConsumed)', () => {
    const r = runRecipe(shearRequest());
    // The whole point of requires: the herd is present, not eaten.
    expect(r.inputsConsumed.get(sheep)).toBeUndefined();
    expect(r.inputsConsumed.size).toBe(0);
  });

  it('aborts with missing_input when the required-present resource is absent', () => {
    const r = runRecipe(shearRequest({ inputStocks: new Map() }));
    expect(r.ranAtFraction).toBe(0);
    expect(r.shortfall?.reason).toBe('missing_input');
    expect(r.shortfall?.detail).toContain('livestock.sheep');
  });

  it('scales down when the required-present resource is short', () => {
    // Need 0.01 per instance, only 0.005 present → fraction 0.5.
    const r = runRecipe(
      shearRequest({ inputStocks: new Map<ResourceId, Quantity>([[sheep, 0.005]]) }),
    );
    expect(r.ranAtFraction).toBeCloseTo(0.5);
    expect(r.outputsProduced.get(wool)).toBeCloseTo(0.275);
    // Still no consumption of the herd.
    expect(r.inputsConsumed.get(sheep)).toBeUndefined();
  });

  it('takes the worst-case across inputs and requires', () => {
    // Hybrid recipe: needs salt (consumed) AND sheep (present).
    const salt = resourceId('mineral.salt');
    const hybrid: ProductionRecipe = {
      ...shearRecipe,
      inputs: new Map<ResourceId, Quantity>([[salt, 1]]),
      requires: new Map<ResourceId, Quantity>([[sheep, 0.01]]),
    };
    // Inputs allow 2 instances (2 salt / 1 needed), requires allows 0.5
    // (0.005 sheep / 0.01 needed). worst case = 0.5.
    const r = runRecipe(
      shearRequest({
        recipe: hybrid,
        inputStocks: new Map<ResourceId, Quantity>([
          [salt, 2],
          [sheep, 0.005],
        ]),
      }),
    );
    expect(r.ranAtFraction).toBeCloseTo(0.5);
    expect(r.inputsConsumed.get(salt)).toBeCloseTo(0.5);
    expect(r.inputsConsumed.get(sheep)).toBeUndefined();
  });
});

describe('runRecipe — determinism', () => {
  it('produces identical results for identical requests', () => {
    const a = runRecipe(baseRequest());
    const b = runRecipe(baseRequest());
    expect(a.ranAtFraction).toBe(b.ranAtFraction);
    expect(Array.from(a.inputsConsumed.entries())).toEqual(Array.from(b.inputsConsumed.entries()));
    expect(Array.from(a.outputsProduced.entries())).toEqual(
      Array.from(b.outputsProduced.entries()),
    );
    expect(Array.from(a.laborUsed.entries())).toEqual(Array.from(b.laborUsed.entries()));
    expect(a.buildingCapacityUsed).toBe(b.buildingCapacityUsed);
  });
});

describe('runRecipe — input validation', () => {
  it('returns 0 when capacityRemaining is negative', () => {
    const result = runRecipe(
      baseRequest({ building: { id: BUILDING.mill, capacityRemaining: -1 } }),
    );
    expect(result.ranAtFraction).toBe(0);
    expect(result.shortfall?.reason).toBe('no_building');
  });
});
