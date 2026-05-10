/**
 * Per-day tick loop — the integration capstone.
 *
 * Runs the six locked sub-phases from docs/01-simulation-frame.md in fixed
 * order, mutating the WorldState in place and accumulating diagnostic
 * TickEvents:
 *
 *   1. Production   — every settlement runs its recipes; outputs land in
 *                     building-owner stockpiles.
 *   2. Consumption  — population draws subsistence rations from local
 *                     stockpiles; shortfalls accrue into a famine-pressure
 *                     scalar that produces cohort_deaths after several
 *                     consecutive shortage days.
 *   3. Movement     — caravans (T22/T23) advance; news carriers (T18) walk.
 *   4. Trade        — every settlement clears one local market per resource
 *                     using subsistence/comfort/status demand against
 *                     owner-stockpile supply (T12/T13/T14). Trades update
 *                     coin and stockpile balances.
 *   5. Demographics — population vital rates tick (T5); endemic disease
 *                     mortality and infection ticks run (T24).
 *   6. Politics     — reputation table decays (T17). Other political
 *                     decisions (governor edicts, family decisions, tax
 *                     spawning) are stubs in v1 — the tick frame is here so
 *                     they can plug in without restructuring.
 *
 * Annual hook: when `day` rolls past a 365-day boundary, the population
 * pyramid is aged via tickYearly (cohorts shift up one band).
 *
 * Determinism: every subsystem RNG is derived from `rng.derive(label)` so
 * adding randomness in one place does not perturb another (per
 * src/sim/rng.ts contract). A second tick with the same world + seed
 * produces the same events.
 */

import { allBuildings } from './buildings/catalog.js';
import { tickCaravanMovement } from './caravan/movement.js';
import {
  aggregateDemand,
  comfortDemand,
  subsistenceDemand,
  type DemandSource,
} from './market/demand.js';
import { aggregateSupply, ownerSupply, type SupplySource } from './market/supply.js';
import { clearMarket } from './market/clear.js';
import {
  applyEndemicMortality,
  maybeTriggerEpidemic,
  tickInfection,
  createSettlementHealth,
  type SettlementHealth,
} from './population/disease.js';
import { tickDaily, tickYearly, ROMAN_VITAL_RATES } from './population/vitalRates.js';
import { runRecipe, type RecipeRunResult } from './production/engine.js';
import { recipesByOutput } from './production/recipes.js';
import { allRecipes } from './production/recipes.js';
// News-carrier ticking is handled by docs/13's tickCarrier; the world doesn't
// yet hold a Map for them so the orchestration call sits with the news
// subsystem until that storage lands.
import type { Rng } from './rng.js';
import {
  recordClearingPrice,
  recordInflow,
  recordOutflow,
  type Settlement,
} from './world/settlement.js';
import { dayOfYearToSeason, type Season } from './world/terrain.js';
import { hexEquals, type Hex } from './world/hex.js';
import {
  resourceId,
  type ActorId,
  type BanditCampId,
  type BuildingId,
  type CaravanId,
  type Day,
  type JobId,
  type Quantity,
  type RecipeId,
  type ResourceId,
  type SettlementId,
} from './types.js';
import type { Actor } from './politics/actor.js';
import { getResource } from './resources/catalog.js';
import { getJob } from './jobs/catalog.js';
import type { ReputationKey } from './reputation/table.js';
import type { WorldState } from '../procgen/seed.js';

// --- Public API -------------------------------------------------------------

export interface TickInputs {
  readonly world: WorldState;
  readonly rng: Rng;
}

export type TickEvent =
  | {
      readonly type: 'recipe_ran';
      readonly settlement: SettlementId;
      readonly recipe: RecipeId;
      readonly fraction: number;
    }
  | {
      readonly type: 'recipe_blocked';
      readonly settlement: SettlementId;
      readonly recipe: RecipeId;
      readonly reason: string;
    }
  | {
      readonly type: 'cohort_deaths';
      readonly settlement: SettlementId;
      readonly deaths: number;
      readonly cause: 'famine' | 'disease' | 'baseline' | 'war';
    }
  | {
      readonly type: 'caravan_moved';
      readonly caravan: CaravanId;
      readonly from: Hex;
      readonly to: Hex;
    }
  | { readonly type: 'caravan_arrived'; readonly caravan: CaravanId; readonly at: Hex }
  | {
      readonly type: 'market_cleared';
      readonly settlement: SettlementId;
      readonly resource: ResourceId;
      readonly price: number;
      readonly volume: number;
    }
  | {
      readonly type: 'epidemic_started';
      readonly settlement: SettlementId;
      readonly disease: string;
    }
  | {
      readonly type: 'caravan_robbed';
      readonly caravan: CaravanId;
      readonly by: BanditCampId | null;
      readonly cargoLost: number;
    }
  | {
      readonly type: 'reputation_updated';
      readonly holder: ReputationKey;
      readonly subject: ReputationKey;
      readonly delta: number;
    };

export interface TickResult {
  readonly world: WorldState;
  readonly events: readonly TickEvent[];
}

/** One-day reputation half-life: 90 days. Tunable per docs/13. */
const REPUTATION_HALF_LIFE_DAYS = 90;

const YEAR_DAYS = 365;

const SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY = 0.4; // docs/04
const KG_PER_MODIUS = 6.7; // resources/catalog.ts food.grain unit
const GRAIN_DEMAND_BUDGET_PER_PERSON = 2; // coin/day; coarse Roman wage proxy
const COMFORT_BUDGET_PER_PLEBEIAN_PER_DAY = 1; // coin/day for comfort goods

/**
 * Public entry point. Mutates world in place and returns a structured
 * result. The world reference and all top-level Maps are preserved (we never
 * replace them) so callers can hold stable references across ticks.
 */
export const tick = (inputs: TickInputs): TickResult => {
  const { world, rng } = inputs;
  const events: TickEvent[] = [];
  const today: Day = world.day;
  const season: Season = dayOfYearToSeason(today);

  // --- Phase 1: Production -------------------------------------------------
  productionPhase(world, season, events);

  // --- Phase 2: Consumption ------------------------------------------------
  consumptionPhase(world, today, events);

  // --- Phase 3: Movement ---------------------------------------------------
  movementPhase(world, season, today, events);

  // --- Phase 4: Trade ------------------------------------------------------
  tradePhase(world, events);

  // --- Phase 5: Demographics ----------------------------------------------
  demographicsPhase(world, today, rng.derive('demographics'), events);

  // --- Phase 6: Politics ---------------------------------------------------
  politicsPhase(world);

  // --- Annual hook (after the day's main work, before incrementing day) ----
  // The "year boundary" is when (day + 1) % YEAR_DAYS === 0 — i.e. the day
  // that just ended completed a full year. We hook in here so the new year
  // begins on the freshly aged pyramid.
  if ((today + 1) % YEAR_DAYS === 0) {
    annualPhase(world, rng.derive(`annual-${today + 1}`));
  }

  // Advance the calendar last so all phases above saw the day-of-year that
  // matched the season they ran in.
  world.day = today + 1;

  return { world, events };
};

// --- Phase 1: Production ----------------------------------------------------

/**
 * Per-settlement production: for every recipe that has a building present in
 * the settlement, attempt to run it. Outputs land in the building owner's
 * stockpile; inputs are drained from there too. Labor availability is
 * estimated from the settlement's working-age cohorts.
 *
 * Phase ordering: recipes are processed in topological order (raw inputs →
 * refined → manufactured) so a bake_bread call in the same tick can see the
 * flour produced by a mill_grain earlier in the same phase.
 */
const productionPhase = (world: WorldState, season: Season, events: TickEvent[]): void => {
  const recipesInOrder = topoSortedRecipes();
  for (const settlement of world.settlements.values()) {
    const labor = laborAvailableInSettlement(settlement);
    for (const recipe of recipesInOrder) {
      // Find any building in the settlement matching this recipe's building.
      for (const b of settlement.buildings) {
        if (b.buildingId !== recipe.building) continue;
        const ownerActor = world.actors.get(b.ownerActor);
        if (ownerActor === undefined) continue;
        if (b.capacity <= 0) continue;
        const result: RecipeRunResult = runRecipe({
          recipe,
          building: { id: b.buildingId, capacityRemaining: b.capacity },
          ownerActor: b.ownerActor,
          laborAvailable: labor,
          inputStocks: ownerActor.stockpile,
          season,
        });
        if (result.shortfall !== undefined && result.ranAtFraction === 0) {
          events.push({
            type: 'recipe_blocked',
            settlement: settlement.id,
            recipe: recipe.id,
            reason: result.shortfall.reason,
          });
          continue;
        }
        if (result.ranAtFraction > 0) {
          // Apply the deltas to the owner's stockpile.
          for (const [resId, qty] of result.inputsConsumed) {
            decreaseStockpile(ownerActor, resId, qty);
          }
          for (const [resId, qty] of result.outputsProduced) {
            increaseStockpile(ownerActor, resId, qty);
            recordInflow(settlement, resId, qty);
          }
          // Decrement the labor pool we estimated locally so subsequent
          // recipes in this phase don't double-count workers.
          for (const [jId, used] of result.laborUsed) {
            const remaining = (labor.get(jId) ?? 0) - used;
            labor.set(jId, Math.max(0, remaining));
          }
          // Decrement building capacity for the day.
          b.capacity = Math.max(0, b.capacity - result.buildingCapacityUsed);
          events.push({
            type: 'recipe_ran',
            settlement: settlement.id,
            recipe: recipe.id,
            fraction: result.ranAtFraction,
          });
        }
      }
    }
    // Reset building capacity for tomorrow. We did not store the original
    // capacity here (T2 catalog has it but per-instance decay also matters),
    // so we restore from the catalog default for v1.
    for (const b of settlement.buildings) {
      b.capacity = capacityForBuilding(b.buildingId);
    }
  }
};

/**
 * Coarse labor estimate from the settlement's adult population. We treat
 * every adult as "available for any role" — the production engine then
 * scales the recipe down by min(available/required) across every required
 * role. This is intentionally generous; finer per-role assignment is a
 * tuning lever (docs/04 §"Worker → labor pool reconciliation": ~2%
 * retraining per month, not per day).
 */
const laborAvailableInSettlement = (settlement: Settlement): Map<JobId, number> => {
  let adults = 0;
  for (const [key, count] of settlement.population.cohorts()) {
    // Working-age = 15-59 inclusive across all classes.
    const ageNum = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (ageNum >= 15 && ageNum < 60) adults += count;
  }
  // Distribute adults uniformly across jobs as a coarse v1 estimate.
  // Productivity is per-recipe, not per-person, so we cap each role at the
  // total adult count (recipes only need 1 worker-day per recipe).
  const out = new Map<JobId, number>();
  // We don't enumerate the full job catalog here to avoid a circular import
  // with jobs; the recipe layer references roles by id and the engine does
  // the lookup.
  // Touch getJob so unused-import lint doesn't fire — see file top.
  void getJob;
  // For each unique role mentioned in any recipe's labor map, set
  // availability to the adult count. The engine will scale down per recipe.
  for (const recipe of allRecipes()) {
    for (const role of recipe.labor.keys()) {
      out.set(role, adults);
    }
  }
  return out;
};

/**
 * Topologically sort recipes so producers run before consumers within the
 * same tick. We approximate with: a recipe whose inputs include the output
 * of recipe X must run after X. With cycles (none in docs/03 v1), the order
 * is undefined.
 */
const topoSortedRecipes = (): readonly ReturnType<typeof allRecipes>[number][] => {
  const recipes = allRecipes();
  // Build dependency: recipeA depends on recipeB if any of A's inputs is in
  // B's outputs.
  const idToRecipe = new Map(recipes.map((r) => [r.id, r] as const));
  const out: (typeof recipes)[number][] = [];
  const visited = new Set<RecipeId>();
  const visiting = new Set<RecipeId>();

  const visit = (r: (typeof recipes)[number]): void => {
    if (visited.has(r.id)) return;
    if (visiting.has(r.id)) return; // cycle guard
    visiting.add(r.id);
    for (const input of r.inputs.keys()) {
      const producers = recipesByOutput(input);
      for (const p of producers) {
        const pr = idToRecipe.get(p.id);
        if (pr === undefined) continue;
        if (pr.id === r.id) continue;
        visit(pr);
      }
    }
    visiting.delete(r.id);
    visited.add(r.id);
    out.push(r);
  };
  for (const r of recipes) visit(r);
  return out;
};

const decreaseStockpile = (actor: Actor, resource: ResourceId, qty: Quantity): void => {
  if (qty <= 0) return;
  const current = actor.stockpile.get(resource) ?? 0;
  const remaining = current - qty;
  if (remaining <= 1e-9) {
    actor.stockpile.delete(resource);
  } else {
    actor.stockpile.set(resource, remaining);
  }
};

const increaseStockpile = (actor: Actor, resource: ResourceId, qty: Quantity): void => {
  if (qty <= 0) return;
  const current = actor.stockpile.get(resource) ?? 0;
  actor.stockpile.set(resource, current + qty);
};

// Default capacity-by-id table, computed once at module load. Decay can
// reduce a specific building's capacity below this default, but the daily
// reset uses the catalog default as the upper bound.
const _capacityCache: ReadonlyMap<BuildingId, number> = (() => {
  const m = new Map<BuildingId, number>();
  for (const b of allBuildings()) m.set(b.id, b.capacityUnits);
  return m;
})();
const capacityForBuilding = (id: BuildingId): number => _capacityCache.get(id) ?? 1;

// --- Phase 2: Consumption ---------------------------------------------------

interface FaminePressureRecord {
  consecutiveShortageDays: number;
  lastShortageDay: Day;
}

/**
 * Per-Settlement famine pressure. Keyed by the Settlement object reference
 * (not its id) so a fresh world built in a test starts with empty pressure
 * regardless of whether the previous test used the same string id.
 */
const faminePressure: WeakMap<Settlement, FaminePressureRecord> = new WeakMap();

/**
 * Each settlement's population draws subsistence calories. We pull from any
 * stockpile owner in the settlement that holds an edible resource, in
 * priority order (bread → flour → grain → legumes → cheese → salted meat /
 * fish). When the day's draw is short of need, famine pressure accrues; if
 * pressure stays elevated for several days, cohort_deaths fire.
 */
const consumptionPhase = (world: WorldState, today: Day, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    const adults = adultPopulation(settlement);
    const children = childPopulation(settlement);
    const elders = elderPopulation(settlement);
    // Children consume ~0.5×, elders ~0.8× per docs/04.
    const adultEquivalent = adults + children * 0.5 + elders * 0.8;
    if (adultEquivalent <= 0) continue;
    const grainNeededKg = adultEquivalent * SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY;
    const grainNeededModii = grainNeededKg / KG_PER_MODIUS;

    // Source: any stockpileOwner in the settlement holding food.
    const owners = settlement.stockpileOwners
      .map((id) => world.actors.get(id))
      .filter((a): a is Actor => a !== undefined);
    let drawn = 0;
    for (const o of owners) {
      if (drawn >= grainNeededModii) break;
      drawn += drawFromOwner(o, grainNeededModii - drawn);
    }
    if (drawn > 0) {
      recordOutflow(settlement, resourceId('food.grain'), drawn);
    }
    const shortfall = grainNeededModii - drawn;
    const rec = faminePressure.get(settlement) ?? {
      consecutiveShortageDays: 0,
      lastShortageDay: -1,
    };
    if (shortfall > 0.05 * grainNeededModii) {
      rec.consecutiveShortageDays =
        rec.lastShortageDay === today - 1 ? rec.consecutiveShortageDays + 1 : 1;
      rec.lastShortageDay = today;
      // After several consecutive shortage days, deaths begin.
      if (rec.consecutiveShortageDays >= 5) {
        const deaths = computeFamineDeaths(settlement, shortfall / Math.max(1, grainNeededModii));
        if (deaths > 0) {
          events.push({
            type: 'cohort_deaths',
            settlement: settlement.id,
            deaths,
            cause: 'famine',
          });
        }
      }
    } else {
      rec.consecutiveShortageDays = 0;
    }
    faminePressure.set(settlement, rec);
  }
};

const adultPopulation = (s: Settlement): number => {
  let n = 0;
  for (const [key, count] of s.population.cohorts()) {
    const a = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (a >= 15 && a < 60) n += count;
  }
  return n;
};
const childPopulation = (s: Settlement): number => {
  let n = 0;
  for (const [key, count] of s.population.cohorts()) {
    const a = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (a < 15) n += count;
  }
  return n;
};
const elderPopulation = (s: Settlement): number => {
  let n = 0;
  for (const [key, count] of s.population.cohorts()) {
    const a = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (a >= 60) n += count;
  }
  return n;
};

const FOOD_PRIORITY: readonly ResourceId[] = [
  resourceId('food.bread'),
  resourceId('food.flour'),
  resourceId('food.grain'),
  resourceId('food.legumes'),
  resourceId('food.cheese'),
  resourceId('food.salted_meat'),
  resourceId('food.salted_fish'),
];

/**
 * Pull `wantModii` of grain-equivalent food from the actor's stockpile, in
 * priority order. Returns the modii actually drawn (may be < want).
 */
const drawFromOwner = (actor: Actor, wantModii: number): number => {
  if (wantModii <= 0) return 0;
  let remaining = wantModii;
  for (const id of FOOD_PRIORITY) {
    if (remaining <= 0) break;
    const have = actor.stockpile.get(id) ?? 0;
    if (have <= 0) continue;
    // Convert each food line to grain-equivalent modii using its kg weight.
    const def = getResource(id);
    const grainEqPerUnit = (def.weightKgPerUnit / KG_PER_MODIUS) * grainEquivalentMultiplier(id);
    const haveAsModii = have * grainEqPerUnit;
    const takeAsModii = Math.min(haveAsModii, remaining);
    const takeUnits = takeAsModii / Math.max(1e-9, grainEqPerUnit);
    const newQty = have - takeUnits;
    if (newQty > 1e-9) {
      actor.stockpile.set(id, newQty);
    } else {
      actor.stockpile.delete(id);
    }
    remaining -= takeAsModii;
  }
  return wantModii - Math.max(0, remaining);
};

/**
 * Roughly how many calories per kg one food carries relative to grain.
 * docs/04 doesn't pin precise values; this is a coarse first-pass.
 */
const grainEquivalentMultiplier = (id: ResourceId): number => {
  const idStr = String(id);
  if (idStr === 'food.bread') return 1.3; // 1.3 kg bread ≈ 1 kg grain
  if (idStr === 'food.cheese') return 0.6;
  if (idStr === 'food.salted_meat') return 0.5;
  if (idStr === 'food.salted_fish') return 0.5;
  return 1;
};

/**
 * When food is short, the population takes deaths. Magnitude scales with
 * the shortfall fraction; the priority order is infants → elders → adults
 * (per docs/04 §"Famine"). For v1 we apply uniformly across the most
 * vulnerable cohorts.
 */
const computeFamineDeaths = (settlement: Settlement, shortfallFrac: number): number => {
  const total = settlement.population.total();
  if (total === 0) return 0;
  // Coarse: 0.5% of population dies per day at 100% shortfall, scaled.
  const baseRate = 0.005 * Math.min(1, shortfallFrac);
  const target = Math.max(1, Math.floor(total * baseRate));
  // Take from the youngest and oldest cohorts first; if those are empty,
  // fall back to whatever cohorts have people. (A settlement of all
  // working-age adults — common in tests and small frontier outposts —
  // would otherwise be invulnerable to famine, which is wrong.)
  let remaining = target;
  let actuallyKilled = 0;
  const priority: readonly string[] = ['0-4', '80+', '5-9', '75-79', '70-74'];
  const fallback: readonly string[] = [
    '15-19',
    '20-24',
    '25-29',
    '30-34',
    '35-39',
    '40-44',
    '45-49',
    '50-54',
    '55-59',
    '60-64',
    '65-69',
    '10-14',
  ];
  const order: readonly string[] = [...priority, ...fallback];
  for (const ageStr of order) {
    if (remaining <= 0) break;
    const age = ageStr as unknown as Parameters<Settlement['population']['totalByAgeBand']>[0];
    const inBand = settlement.population.totalByAgeBand(age);
    if (inBand <= 0) continue;
    const take = Math.min(remaining, inBand);
    let drained = 0;
    const snapshot: Array<[Parameters<Settlement['population']['set']>[0], number]> = [];
    for (const [key, count] of settlement.population.cohorts()) {
      if (key.age === age && count > 0) snapshot.push([key, count]);
    }
    for (const [key, count] of snapshot) {
      if (drained >= take) break;
      const share = Math.max(1, Math.round((count / inBand) * take));
      const kill = Math.min(share, count, take - drained);
      if (kill <= 0) continue;
      settlement.population.set(key, count - kill);
      drained += kill;
      actuallyKilled += kill;
    }
    remaining -= drained;
  }
  return actuallyKilled;
};

// --- Phase 3: Movement ------------------------------------------------------

/**
 * Caravans advance via tickCaravanMovement (T23); news carriers advance via
 * tickCarrier (T18). Both already encode the per-day movement budget in
 * their own modules, so this phase is mostly orchestration.
 */
const movementPhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
): void => {
  for (const [cId, c] of world.caravans) {
    const before = { q: c.position.q, r: c.position.r };
    const result = tickCaravanMovement({ caravan: c, grid: world.grid, season, today });
    for (const e of result.events) {
      if (e.type === 'arrived') {
        events.push({
          type: 'caravan_arrived',
          caravan: cId,
          at: { q: c.position.q, r: c.position.r },
        });
      }
    }
    for (const moved of result.hexesMoved) {
      events.push({
        type: 'caravan_moved',
        caravan: cId,
        from: before,
        to: { q: moved.q, r: moved.r },
      });
    }
  }
  // News carriers — the world doesn't currently track a Map for them; T18
  // owns its own collection. The tick frame is here so the wiring lands
  // without restructuring later.
  void hexEquals; // referenced for future news-arrival comparisons
};

// --- Phase 4: Trade ---------------------------------------------------------

/**
 * For each settlement and each tradable resource present in any owner's
 * stockpile (or demanded by population), build a demand schedule (subsistence
 * + comfort), build a supply schedule (one source per stockpile owner), and
 * call clearMarket. Trades transfer goods from sellers to buyers and coin
 * the other way; the resulting clearing price is recorded on the settlement.
 *
 * v1 simplifications:
 *   - Each population segment is one big "plebeian" demand for grain
 *     (subsistence) and one comfort segment for wine + olive oil + cloth.
 *   - Suppliers are every owner with a positive stockpile of that resource,
 *     all at a uniform reservation price for v1 (a tuning lever later).
 *   - Coin transfers are clamped to the buyer's treasury; if the buyer is
 *     "the population" (no actor), we skip coin transfer (the consumption
 *     phase already drained the food). Trade phase mostly clears things
 *     not already eaten — finished goods, comfort food.
 */
const tradePhase = (world: WorldState, events: TickEvent[]): void => {
  const TRADABLE: readonly ResourceId[] = [
    resourceId('food.grain'),
    resourceId('food.flour'),
    resourceId('food.bread'),
    resourceId('food.wine'),
    resourceId('food.olive_oil'),
    resourceId('food.cheese'),
    resourceId('goods.cloth'),
    resourceId('goods.tools'),
  ];

  for (const settlement of world.settlements.values()) {
    const total = settlement.population.total();
    if (total === 0) continue;
    const owners = settlement.stockpileOwners
      .map((id) => world.actors.get(id))
      .filter((a): a is Actor => a !== undefined);
    for (const resId of TRADABLE) {
      // Demand: subsistence on grain only; comfort for the rest.
      const demand: DemandSource[] = [];
      const isSubsistence = String(resId) === 'food.grain' || String(resId) === 'food.bread';
      const adults = adultPopulation(settlement);
      const totalSegmentWealth = total * GRAIN_DEMAND_BUDGET_PER_PERSON;
      if (isSubsistence) {
        demand.push(
          subsistenceDemand({
            id: `${String(resId)}@${String(settlement.id)}`,
            needPerDay: adults * 0.06, // ~0.4 kg / 6.7 kg/modius
            segmentWealth: totalSegmentWealth,
          }),
        );
      } else {
        demand.push(
          comfortDemand({
            id: `${String(resId)}@${String(settlement.id)}`,
            wantQuantity: adults * 0.05,
            budget: total * COMFORT_BUDGET_PER_PLEBEIAN_PER_DAY,
          }),
        );
      }

      // Supply: each owner's stockpile of this resource at a uniform
      // reservation. The reservation price is a v1 placeholder (1 coin /
      // unit) — the supply module's full math comes later when the tick
      // wires up production-cost tracking.
      const supplies: SupplySource[] = [];
      for (const o of owners) {
        const stock = o.stockpile.get(resId) ?? 0;
        if (stock <= 0) continue;
        supplies.push(
          ownerSupply({
            id: `${String(o.id)}@${String(resId)}`,
            ownerActor: o.id,
            stockpile: stock,
            reservedForOwnUse: 0,
            productionCost: 0.5,
            expectedFuturePrice: 1,
            ownerUrgencyFactor: 1,
            storageHoldingDays: 30,
          }),
        );
      }
      if (demand.length === 0 || supplies.length === 0) continue;
      const dSchedule = aggregateDemand(demand);
      const sSchedule = aggregateSupply(supplies);
      const result = clearMarket(dSchedule, sSchedule, { maxPrice: 1000 });
      if (result.totalTraded <= 0) continue;
      // Apply trades. With our coarse model the buyer is "the settlement
      // population" (no specific actor); we just decrement seller stocks
      // and credit them in coin proportional to their share.
      for (const trade of result.trades) {
        const sellerActorId = parseSellerOwner(trade.sellerSourceId);
        if (sellerActorId === null) continue;
        const seller = world.actors.get(sellerActorId);
        if (seller === undefined) continue;
        decreaseStockpile(seller, resId, trade.quantity);
        seller.treasury = seller.treasury + trade.quantity * trade.price;
      }
      recordClearingPrice(settlement, resId, result.clearingPrice);
      events.push({
        type: 'market_cleared',
        settlement: settlement.id,
        resource: resId,
        price: result.clearingPrice,
        volume: result.totalTraded,
      });
    }
  }
};

const parseSellerOwner = (sourceId: string): ActorId | null => {
  // Source ids are formatted "actorId@resourceId" by the construction above.
  const at = sourceId.indexOf('@');
  if (at <= 0) return null;
  return sourceId.slice(0, at) as ActorId;
};

// --- Phase 5: Demographics --------------------------------------------------

/** Per-Settlement health record, keyed by reference for the same reason as faminePressure. */
const settlementHealthMap: WeakMap<Settlement, SettlementHealth> = new WeakMap();

const demographicsPhase = (world: WorldState, today: Day, rng: Rng, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const subRng = rng.derive(`settle-${String(settlement.id)}`);
    // 1) Vital rates.
    tickDaily(settlement.population, ROMAN_VITAL_RATES, subRng.derive('vital'));

    // 2) Endemic mortality + epidemic.
    const tile = world.grid.get(settlement.anchor);
    if (tile === undefined) continue;
    const endemic = applyEndemicMortality(
      settlement.population,
      tile.climate,
      tile.terrain,
      subRng.derive('endemic'),
      today,
    );
    if (endemic.deaths > 0) {
      events.push({
        type: 'cohort_deaths',
        settlement: settlement.id,
        deaths: endemic.deaths,
        cause: 'baseline',
      });
    }
    let health = settlementHealthMap.get(settlement);
    if (health === undefined) {
      health = createSettlementHealth();
      settlementHealthMap.set(settlement, health);
    }
    const density = settlement.population.total() / Math.max(1, settlement.urbanHexes.length);
    const trigger = maybeTriggerEpidemic(
      health,
      settlement.population,
      density,
      tile.climate,
      subRng.derive('epidemic-spawn'),
      today,
    );
    if (trigger.triggered !== null) {
      events.push({
        type: 'epidemic_started',
        settlement: settlement.id,
        disease: trigger.triggered.id,
      });
    }
    const infRes = tickInfection(health, settlement.population, subRng.derive('infection'), today);
    if (infRes.deaths > 0) {
      events.push({
        type: 'cohort_deaths',
        settlement: settlement.id,
        deaths: infRes.deaths,
        cause: 'disease',
      });
    }
  }
};

// --- Phase 6: Politics ------------------------------------------------------

const politicsPhase = (world: WorldState): void => {
  // Reputation decay applies once per tick; entries below ε are pruned.
  world.reputation.decayTick(REPUTATION_HALF_LIFE_DAYS);
  // Other political moves (governor edicts, family decisions, tax spawning)
  // plug in here in later iterations.
};

// --- Annual hook ------------------------------------------------------------

const annualPhase = (world: WorldState, rng: Rng): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    tickYearly(settlement.population, rng.derive(`settle-${String(settlement.id)}`));
    // Reset famine pressure each year so a one-bad-harvest year doesn't
    // permanently haunt the settlement.
    faminePressure.set(settlement, { consecutiveShortageDays: 0, lastShortageDay: -1 });
  }
};
