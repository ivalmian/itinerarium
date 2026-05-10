/**
 * Steady-state analyzer for the recipe input-output system.
 *
 * Treats the recipe catalog as a Leontief input-output system: every
 * recipe consumes a vector of inputs and produces a vector of outputs
 * per recipe-instance per day. Given a final-demand vector (what the
 * population eats + what exports leave the map), we can solve for the
 * recipe intensities that produce a steady state — and identify whether
 * any building's capacity is the binding constraint.
 *
 * This is a tuning tool, not a runtime component. Run it after changing
 * recipe ratios or building capacities to see the implied equilibrium.
 *
 * Output:
 *   1. Per-recipe required intensity (recipes/day across the whole world)
 *      to satisfy the chosen demand.
 *   2. Per-resource net flow at that intensity (sanity check: should be
 *      ≈ demand for non-raw resources).
 *   3. Per-building required capacity vs. what procgen actually seeds —
 *      flags bottlenecks.
 *   4. Money-supply analysis: silver/gold mining + minting balanced
 *      against population growth + import/export expectation.
 *
 * Usage:
 *   npx tsx scripts/analyze-steady-state.ts [population]
 *   default population: 700,000 (matches our 80×80 grid burn-in)
 */

import { allRecipes, recipesByOutput } from '../src/sim/production/recipes.ts';
import { allBuildings, getBuilding } from '../src/sim/buildings/catalog.ts';
import { allResources, getResource } from '../src/sim/resources/catalog.ts';
import {
  resourceId,
  type RecipeId,
  type ResourceId,
  type BuildingId,
} from '../src/sim/types.ts';

// --- 1. Build the recipe catalog as input/output vectors ------------------

const recipes = allRecipes();
const resourceList = allResources();
const buildings = allBuildings();

// Build a season-averaged effective output multiplier (averaged over 365 days).
// For a recipe with seasonalMultiplier = {spring: 1, summer: 0.5, ...},
// the average factor is mean of the four seasons (each season is 1/4 of year).
const seasonalAvg = (recipe: ReturnType<typeof allRecipes>[number]): number => {
  const m = recipe.seasonalMultiplier;
  if (m === undefined) return 1;
  const s = (m.spring ?? 1) + (m.summer ?? 1) + (m.autumn ?? 1) + (m.winter ?? 1);
  return s / 4;
};

// --- 2. Per-capita daily demand ------------------------------------------

interface Demand {
  readonly resource: ResourceId;
  readonly perCapitaPerDay: number;
  readonly notes: string;
}

// docs/04 + docs/02. All in resource units (modii for grain, kg for materials).
// These are the FINAL demands — what people consume that doesn't feed back
// into the production chain.
const PER_CAPITA_DEMAND: readonly Demand[] = [
  // Subsistence: ~0.4 kg grain-equiv/day = 0.06 modii/day for an adult.
  // Adjusted to ~0.05 to account for non-grain food substitution.
  {
    resource: resourceId('food.grain'),
    perCapitaPerDay: 0.05,
    notes: 'subsistence (eaten as bread, but bread chain consumes grain)',
  },
  // Comfort goods (status + comfort), per docs/02 §"Demand stratification"
  // — heavily skewed toward elites, but population-averaged.
  {
    resource: resourceId('food.wine'),
    perCapitaPerDay: 0.005, // ~1.8 L/yr per capita avg
    notes: 'comfort (heavy elite consumption, avg low)',
  },
  {
    resource: resourceId('food.olive_oil'),
    perCapitaPerDay: 0.003,
    notes: 'comfort + lighting + cooking',
  },
  {
    resource: resourceId('food.cheese'),
    perCapitaPerDay: 0.01,
    notes: 'pastoral protein',
  },
  {
    resource: resourceId('goods.cloth'),
    perCapitaPerDay: 0.001, // ~0.4 kg cloth/yr = 1 garment / 2 yrs
    notes: 'clothing replacement',
  },
];

// --- 3. Solve for recipe intensities (greedy back-chain) ------------------

/**
 * Given a final demand vector (resource → kg/units per day), compute the
 * recipe intensities (recipes/day) needed to satisfy it. We back-chain:
 * for each demanded resource, pick the cheapest producer recipe (lowest
 * input-cost), recursively add its inputs to the demand. Stop at "raw"
 * resources (no producer) or labor.
 *
 * Returns: { intensities: Map<recipeId, recipes/day>,
 *            netSupply: Map<resourceId, units/day> }
 */
const solveBackchain = (finalDemand: Map<ResourceId, number>): {
  intensities: Map<RecipeId, number>;
  rawConsumed: Map<ResourceId, number>;
  laborByJob: Map<string, number>;
} => {
  const intensities = new Map<RecipeId, number>();
  const rawConsumed = new Map<ResourceId, number>();
  const laborByJob = new Map<string, number>();

  // Pending demands, processed FIFO with depth limit to break any cycles.
  const pending: { res: ResourceId; qty: number; depth: number }[] = [];
  for (const [res, qty] of finalDemand) pending.push({ res, qty, depth: 0 });

  const MAX_DEPTH = 10;
  while (pending.length > 0) {
    const { res, qty, depth } = pending.shift() as { res: ResourceId; qty: number; depth: number };
    if (qty <= 0) continue;
    if (depth > MAX_DEPTH) {
      rawConsumed.set(res, (rawConsumed.get(res) ?? 0) + qty);
      continue;
    }
    const producers = recipesByOutput(res);
    if (producers.length === 0) {
      // Raw resource (no producer): mining yield, terrain extraction, etc.
      rawConsumed.set(res, (rawConsumed.get(res) ?? 0) + qty);
      continue;
    }
    // Pick the producer that produces this resource with the most output
    // per recipe-instance (avoids picking trivial side outputs).
    let best = producers[0];
    let bestOutput = 0;
    for (const p of producers) {
      const out = (p?.outputs.get(res) ?? 0) * seasonalAvg(p as ReturnType<typeof allRecipes>[number]);
      if (out > bestOutput) {
        bestOutput = out;
        best = p;
      }
    }
    if (best === undefined || bestOutput <= 0) {
      rawConsumed.set(res, (rawConsumed.get(res) ?? 0) + qty);
      continue;
    }
    // Need x recipe-instances such that x * bestOutput = qty.
    const x = qty / bestOutput;
    intensities.set(best.id, (intensities.get(best.id) ?? 0) + x);
    // Recursively demand inputs and labor.
    for (const [inp, inpQty] of best.inputs) {
      pending.push({ res: inp, qty: inpQty * x, depth: depth + 1 });
    }
    for (const [job, jobQty] of best.labor) {
      laborByJob.set(String(job), (laborByJob.get(String(job)) ?? 0) + jobQty * x);
    }
  }
  return { intensities, rawConsumed, laborByJob };
};

// --- 4. Run the analysis -------------------------------------------------

const POPULATION = process.argv[2] !== undefined ? Number(process.argv[2]) : 700_000;
console.log(`# Steady-state analysis for population = ${POPULATION.toLocaleString()}\n`);

// Build daily final demand vector.
const finalDemand = new Map<ResourceId, number>();
for (const d of PER_CAPITA_DEMAND) {
  finalDemand.set(d.resource, d.perCapitaPerDay * POPULATION);
}

console.log('## Per-capita daily demand');
console.log('resource,per_capita_units_per_day,total_population_per_day,notes');
for (const d of PER_CAPITA_DEMAND) {
  console.log(
    `${String(d.resource)},${d.perCapitaPerDay},${(d.perCapitaPerDay * POPULATION).toFixed(1)},${d.notes}`,
  );
}

const { intensities, rawConsumed, laborByJob } = solveBackchain(finalDemand);

// --- 5. Required recipe intensities -------------------------------------

console.log('\n## Required recipe intensities (recipes/day across whole world)');
console.log('recipe,intensity_per_day,building,labor_kind,notes');
const sortedRecipes = [...intensities.entries()].sort((a, b) => b[1] - a[1]);
for (const [rId, x] of sortedRecipes) {
  const r = recipes.find((rr) => rr.id === rId);
  if (r === undefined) continue;
  const labor = [...r.labor.entries()].map(([j, c]) => `${String(j)}:${c}`).join('+');
  console.log(`${String(rId)},${x.toFixed(2)},${String(r.building)},${labor},${r.notes ?? ''}`);
}

// --- 6. Required building capacity vs. seeded ----------------------------

const requiredCapacityByBuilding = new Map<BuildingId, number>();
for (const [rId, x] of intensities) {
  const r = recipes.find((rr) => rr.id === rId);
  if (r === undefined) continue;
  requiredCapacityByBuilding.set(
    r.building,
    (requiredCapacityByBuilding.get(r.building) ?? 0) + x,
  );
}

console.log('\n## Required building capacity (recipes/day) vs. catalog default');
console.log('building,required_world_total,catalog_default_per_building,implied_buildings_needed');
const sortedBuildings = [...requiredCapacityByBuilding.entries()].sort((a, b) => b[1] - a[1]);
for (const [bId, req] of sortedBuildings) {
  const b = getBuilding(bId);
  const each = b.capacityUnits;
  const need = req / Math.max(1, each);
  console.log(
    `${String(bId)},${req.toFixed(0)},${each},${need.toFixed(2)}`,
  );
}
void buildings;

// --- 7. Raw resource consumption (terrain extraction floor) -------------

console.log('\n## Raw resource demand (extraction-only, per day)');
console.log('resource,units_per_day,kg_per_day,notes');
const sortedRaw = [...rawConsumed.entries()].sort((a, b) => b[1] - a[1]);
for (const [res, qty] of sortedRaw) {
  const def = getResource(res);
  console.log(`${String(res)},${qty.toFixed(2)},${(qty * def.weightKgPerUnit).toFixed(1)},${def.notes ?? ''}`);
}

// --- 8. Labor demand vs. population --------------------------------------

console.log('\n## Total labor demand (worker-days/day) vs. working-age population');
console.log('job,worker_days_per_day,fraction_of_pop');
const sortedLabor = [...laborByJob.entries()].sort((a, b) => b[1] - a[1]);
let totalLabor = 0;
for (const [job, wd] of sortedLabor) {
  totalLabor += wd;
  console.log(`${job},${wd.toFixed(1)},${((wd / POPULATION) * 100).toFixed(2)}%`);
}
console.log(`TOTAL,${totalLabor.toFixed(1)},${((totalLabor / POPULATION) * 100).toFixed(2)}%`);

// --- 9. Money supply analysis -------------------------------------------

console.log('\n## Money supply balance');
const popGrowthRate = 0.005; // 0.5%/yr per docs/04
const perCapitaCoinTarget = 50; // coarse: each person needs ~50 coin in circulation (savings + transactions)
const annualCoinDemand = POPULATION * popGrowthRate * perCapitaCoinTarget;
console.log(`Annual coin demand for pop growth: ${annualCoinDemand.toFixed(0)} coin/yr`);

// Money supply growth from minting (mint_coin recipe).
const mint = recipes.find((r) => String(r.id) === 'mint_coin');
if (mint !== undefined) {
  const coinPerInstance = mint.outputs.get(resourceId('goods.coin')) ?? 0;
  const silverPerInstance = mint.inputs.get(resourceId('metal.silver')) ?? 0;
  console.log(`Mint produces ${coinPerInstance} coin per ${silverPerInstance} silver`);
  // From silver supply: cupel_silver outputs.
  const cupel = recipes.find((r) => String(r.id) === 'cupel_silver');
  if (cupel !== undefined) {
    const silverPerCupel = cupel.outputs.get(resourceId('metal.silver')) ?? 0;
    console.log(`Cupel_silver produces ${silverPerCupel} silver/recipe-instance`);
    // To produce annualCoinDemand coin, need:
    const cupelInstancesPerYear = annualCoinDemand / coinPerInstance * silverPerInstance / silverPerCupel;
    console.log(
      `To match coin demand: ${(cupelInstancesPerYear / 365).toFixed(2)} cupel_silver instances/day = ${cupelInstancesPerYear.toFixed(0)}/yr`,
    );
  }
}

console.log('\nDone. Compare required intensities vs. world burn-in to spot bottlenecks.');
