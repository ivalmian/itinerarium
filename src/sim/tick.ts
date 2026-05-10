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
import { planCaravanRoute } from './caravan/ai.js';
import {
  createCamp,
  decideCampAction,
  recruit,
  type BanditCamp,
} from './bandit/camp.js';
import { createActor } from './politics/actor.js';
import { createCharacter, generateFullName } from './politics/character.js';
import { createFaction } from './politics/faction.js';
import {
  actorId,
  banditCampId as makeBanditCampId,
  characterId,
  factionId,
} from './types.js';
import { resolveAmbush, type AmbushResult } from './conflict/ambush.js';
import { resolveBattle } from './conflict/battle.js';
import { tickPatrol, type Patrol } from './conflict/patrol.js';
import { resolveRaid, type WallLevel } from './conflict/raid.js';
import type { Caravan } from './caravan/caravan.js';
import { createNewsItem, createNewsCarrier } from './reputation/news.js';
import { tickCarrierWithGrid } from './reputation/newsMovement.js';
import { processNewsArrival } from './reputation/newsArrival.js';
import type { NamedCharacter } from './politics/character.js';
import type { ReputationMagnitude } from './reputation/table.js';
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
  recomputeCatchment,
  recordClearingPrice,
  recordInflow,
  recordOutflow,
  shouldRecomputeCatchment,
  type Settlement,
} from './world/settlement.js';
import { dayOfYearToSeason, type Season } from './world/terrain.js';
import { hexDistance, hexEquals, type Hex } from './world/hex.js';
import {
  resourceId,
  type ActorId,
  type BanditCampId,
  type BuildingId,
  type CaravanId,
  type Day,
  type FactionId,
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
    }
  | {
      readonly type: 'news_carrier_spawned';
      readonly id: string;
      readonly perpetrator: ReputationKey;
      readonly victim: ReputationKey | null;
      readonly destination: Hex;
      readonly magnitude: ReputationMagnitude;
    }
  | {
      readonly type: 'news_carrier_arrived';
      readonly id: string;
      readonly settlement: SettlementId;
      readonly receiverCount: number;
      readonly deltasApplied: number;
    }
  | {
      readonly type: 'patrol_dispatched';
      readonly patrolId: string;
      readonly from: SettlementId;
      readonly target: Hex;
    }
  | {
      readonly type: 'patrol_engaged';
      readonly patrolId: string;
      readonly camp: BanditCampId;
      readonly outcome: 'patrol_won' | 'bandits_won' | 'mutual_rout';
    }
  | {
      readonly type: 'settlement_raided';
      readonly settlement: SettlementId;
      readonly by: BanditCampId;
      readonly cargoLost: number;
      readonly defendersKilled: number;
    }
  | {
      readonly type: 'fence_traded';
      readonly camp: BanditCampId;
      readonly through: SettlementId;
      readonly coinPaid: number;
    }
  | {
      readonly type: 'bandit_recruited';
      readonly camp: BanditCampId;
      readonly fromSettlement: SettlementId;
      readonly count: number;
    }
  | {
      readonly type: 'catchment_resized';
      readonly settlement: SettlementId;
      readonly oldRadius: number;
      readonly newRadius: number;
      readonly claimed: number;
      readonly released: number;
    }
  | {
      readonly type: 'workers_reallocated';
      readonly settlement: SettlementId;
      readonly fromJob: JobId;
      readonly toJob: JobId;
      readonly count: number;
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

  // Refresh the per-tick id→Settlement lookup used by subsystems (e.g. the
  // worker-reallocation phase) to resolve a settlement reference from a
  // recipe_blocked event without re-walking world.settlements.
  settlementsById = world.settlements;

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
  politicsPhase(world, rng.derive('politics'), today, events);

  // --- Annual hook (after the day's main work, before incrementing day) ----
  // The "year boundary" is when (day + 1) % YEAR_DAYS === 0 — i.e. the day
  // that just ended completed a full year. We hook in here so the new year
  // begins on the freshly aged pyramid.
  if ((today + 1) % YEAR_DAYS === 0) {
    annualPhase(world, rng.derive(`annual-${today + 1}`), today, events);
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
 * Per-role labor estimate read from the settlement's `jobAllocations` (per
 * docs/04 §"Worker reallocation by demand"). The production engine sees a
 * separate worker count per role; idle adults aren't available for any
 * skilled job. Reallocation between roles happens on a monthly hook (see
 * `workerReallocationPhase`) — not in this hot path.
 *
 * Fallback: if a settlement has zero jobAllocations (legacy snapshot or a
 * test stub built without procgen), fall back to the v1 behavior of
 * treating every adult as universally available so existing tests don't
 * break. The procgen seeder always populates jobAllocations.
 */
const laborAvailableInSettlement = (settlement: Settlement): Map<JobId, number> => {
  const out = new Map<JobId, number>();
  if (settlement.jobAllocations.size > 0) {
    for (const [job, n] of settlement.jobAllocations) {
      if (n > 0) out.set(job, n);
    }
    return out;
  }
  // Fallback: legacy uniform availability. Used only when a settlement was
  // constructed without procgen seeding job allocations (e.g. test stubs).
  let adults = 0;
  for (const [key, count] of settlement.population.cohorts()) {
    const ageNum = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (ageNum >= 15 && ageNum < 60) adults += count;
  }
  void getJob;
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
  // News carriers walk per docs/13. Their arrival → reputation update is
  // handled in the politics phase below.
  if (world.newsCarriers !== undefined) {
    for (const [id, carrier] of world.newsCarriers) {
      if (carrier.arrived) continue;
      const next = tickCarrierWithGrid({ carrier, grid: world.grid, season, today });
      world.newsCarriers.set(id, next);
    }
  }
  void hexEquals;
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

const politicsPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  // Reputation decay applies once per tick; entries below ε are pruned.
  world.reputation.decayTick(REPUTATION_HALF_LIFE_DAYS);
  // Caravan re-planning: every NPC caravan sitting at its destination
  // observes local prices, restocks its price book, and picks a new
  // destination via the NPC AI. Without this loop trade circulates
  // exactly ZERO after the seeded caravans complete their first leg —
  // the v1 baseline issue (see docs/06 §"Caravan lifecycle in the tick
  // loop").
  caravanReplanPhase(world, rng.derive('caravan-replan'), today);
  // Bandit emergence + decisions + raid resolution. Without this loop,
  // the seeded bandit camps are inert decorations — see docs/12
  // §"Bandit emergence in the tick loop".
  banditPhase(world, rng.derive('bandit'), today, events);
  // Patrols walk routes and engage bandit camps they encounter. The
  // garrison + city-watch units seeded by procgen do this — without it,
  // bandits face no enforcement and grow unchecked.
  patrolPhase(world, rng.derive('patrol'), today, events);
  // Process arrived news carriers → apply reputation deltas to local
  // characters. Per docs/13: news doesn't teleport, every reputation
  // update is anchored to a specific carrier walking a specific route.
  newsArrivalPhase(world, today, events);
  // Track per-settlement labor-blocked events for the rolling 30-day
  // reallocation window (docs/04 §"Worker reallocation by demand"). We
  // ingest the events accumulated by THIS tick so the counters stay in
  // sync with the production phase that ran a few microseconds ago.
  ingestLaborBlockedEvents(events);
  // Monthly hook (every 30 days): nudge ~0.66% of workers from over-supplied
  // to under-supplied roles. Picking 30 (not exactly month-length) so the
  // cadence is independent of calendar bookkeeping.
  if ((today + 1) % 30 === 0) {
    workerReallocationPhase(world, today, events);
  }
};

// --- Worker reallocation (docs/04 §"Worker reallocation by demand") --------

/**
 * Per-settlement rolling counter: how many `recipe_blocked` events with
 * reason="labor" landed on each job role over the last ~30 days. We refresh
 * the counter at every monthly reallocation; it accumulates between resets.
 *
 * Stored in a WeakMap keyed by Settlement reference (matching the famine
 * pressure pattern above) so a fresh world built in a test starts clean
 * regardless of id reuse.
 */
const recentLaborBlockedByJob: WeakMap<Settlement, Map<JobId, number>> = new WeakMap();

/**
 * Walk the events emitted this tick and increment per-(settlement, job)
 * recipe_blocked-labor counters. Used by `workerReallocationPhase` below.
 */
const ingestLaborBlockedEvents = (events: readonly TickEvent[]): void => {
  for (const e of events) {
    if (e.type !== 'recipe_blocked') continue;
    // The production engine emits 'no_labor' (see ShortfallReason in
    // src/sim/production/engine.ts). docs/04 describes this generically as
    // "labor"; we match the engine's enum here.
    if (e.reason !== 'no_labor') continue;
    const recipeDef = recipeIdToDef.get(e.recipe);
    if (recipeDef === undefined) continue;
    // Find the settlement object — we need the Settlement reference for the
    // WeakMap key. Iterate world.settlements lazily via a callback set just
    // before this is called by the politics phase. Simpler: we attach the
    // Settlement directly via a one-time index keyed by SettlementId, set
    // in the tick entry path. For now resolve via the cache below.
    const settlement = settlementsById?.get(e.settlement);
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

/**
 * In-tick lookup table: SettlementId → Settlement. Refreshed by
 * `tick()` at the top of every day so subsystem code (e.g.
 * ingestLaborBlockedEvents) can resolve a settlement reference from
 * an event without re-walking world.settlements.
 */
let settlementsById: Map<SettlementId, Settlement> | null = null;

/**
 * Recipe id → RecipeDef cache (built once at module load). Used to resolve
 * the labor map for a recipe_blocked event without an O(N) scan.
 */
const recipeIdToDef: ReadonlyMap<RecipeId, ReturnType<typeof allRecipes>[number]> = (() => {
  const m = new Map<RecipeId, ReturnType<typeof allRecipes>[number]>();
  for (const r of allRecipes()) m.set(r.id, r);
  return m;
})();

/** Per-month per-settlement reallocation rate (docs/04: ~0.66%/month). */
const REALLOCATION_RATE = 0.0066;

/**
 * Move ~0.66% of workers per month from over-supplied roles to under-supplied
 * roles. Algorithm:
 *
 *   1. The set of "demanded" roles = roles whose recipes were blocked by
 *      labor over the last ~30 days (from `recentLaborBlockedByJob`).
 *      Pick the role with the highest blocked count as the target.
 *   2. The set of "over-supplied" roles = the role with the largest current
 *      allocation that is NOT in the demanded set. (We always have an
 *      'idle' bucket from procgen if there are no productive over-suppliers,
 *      and idle is a perfect "give me your spare workers" source.)
 *   3. Move floor(fromCount × REALLOCATION_RATE) workers, with a floor of 1
 *      so something happens when fractions are tiny but workers exist.
 *
 * Emits a `workers_reallocated` TickEvent per move so burn-in telemetry can
 * see the system at work.
 */
const workerReallocationPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.jobAllocations.size === 0) continue;

    const demanded = recentLaborBlockedByJob.get(settlement);
    if (demanded === undefined || demanded.size === 0) {
      // Nothing demanded this month; reset and continue.
      recentLaborBlockedByJob.delete(settlement);
      continue;
    }

    // Pick the most-demanded job (deterministic tie-break by job-id).
    const orderedDemand = [...demanded.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0;
    });
    const targetJob = orderedDemand[0]?.[0];
    if (targetJob === undefined) {
      recentLaborBlockedByJob.delete(settlement);
      continue;
    }

    // Pick the donor: the largest non-target allocation.
    let donorJob: JobId | null = null;
    let donorCount = 0;
    const allocOrdered = [...settlement.jobAllocations.entries()].sort((a, b) => {
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
    if (donorJob === null || donorCount <= 0) {
      recentLaborBlockedByJob.delete(settlement);
      continue;
    }

    // Move at least 1 worker, at most floor(donorCount × rate) — but never
    // more than the donor's whole bucket.
    const moveExact = donorCount * REALLOCATION_RATE;
    const move = Math.max(1, Math.floor(moveExact));
    const actualMove = Math.min(move, donorCount);

    settlement.jobAllocations.set(donorJob, donorCount - actualMove);
    settlement.jobAllocations.set(
      targetJob,
      (settlement.jobAllocations.get(targetJob) ?? 0) + actualMove,
    );

    events.push({
      type: 'workers_reallocated',
      settlement: settlement.id,
      fromJob: donorJob,
      toJob: targetJob,
      count: actualMove,
    });

    // Reset the rolling counter for next month's window.
    recentLaborBlockedByJob.delete(settlement);
  }
};

const caravanReplanPhase = (world: WorldState, rng: Rng, today: Day): void => {
  // Build the candidate-settlements list once per tick (constant per day).
  const candidates: { id: SettlementId; hex: Hex; tier: Settlement['tier'] }[] = [];
  for (const s of world.settlements.values()) {
    candidates.push({ id: s.id, hex: s.anchor, tier: s.tier });
  }
  if (candidates.length < 2) return;

  // Index settlements by anchor hex for the price-book observation step.
  const settlementByAnchor = new Map<string, Settlement>();
  for (const s of world.settlements.values()) {
    settlementByAnchor.set(`${s.anchor.q},${s.anchor.r}`, s);
  }

  for (const [cId, c] of world.caravans) {
    if (c.destination === null) continue;
    if (!hexEquals(c.position, c.destination)) continue; // not yet arrived

    // 1. Record observed local prices into caravan's price book.
    const local = settlementByAnchor.get(`${c.position.q},${c.position.r}`);
    if (local !== undefined) {
      for (const [resource, price] of local.market.lastClearingPrice) {
        if (!Number.isFinite(price) || price <= 0) continue;
        let book = c.priceBook.get(resource);
        if (book === undefined) {
          book = new Map<string, { price: number; observedOnDay: Day }>();
          c.priceBook.set(resource, book);
        }
        book.set(`${c.position.q},${c.position.r}`, { price, observedOnDay: today });
      }
    }

    // 2. Plan next route.
    const plan = planCaravanRoute({
      caravan: c,
      candidateSettlements: candidates,
      knownPrices: c.priceBook,
      knownBanditDensity: new Map(), // v1: no bandit-density signal yet
      knownToll: () => 0, // v1: no toll signal yet
      rng: rng.derive(String(cId)),
    });

    if (plan !== null) {
      // Set new destination. Cargo isn't restocked here (that's a market
      // operation handled separately); the planner's expected profit
      // reflects what it expects to be able to load.
      c.destination = plan.destination;
    } else {
      // No profitable plan — usually because the caravan has empty cargo
      // and/or hasn't observed enough destinations to compute spreads.
      // Fall back to "scout to a random different settlement" so the
      // caravan keeps moving and accumulates price observations. This is
      // what unspecialized merchants did historically: travel to gossip
      // and find out where prices are good.
      const rngHere = rng.derive(`${String(cId)}-fallback`);
      const filtered = candidates.filter((s) => !hexEquals(s.hex, c.position));
      if (filtered.length > 0) {
        const pick = rngHere.pick(filtered);
        c.destination = { q: pick.hex.q, r: pick.hex.r };
      }
    }
  }
};

// --- Bandit phase -----------------------------------------------------------

/**
 * Per-camp last-success tracker. WeakMap by camp id string so it survives
 * camp re-creation through `recruit()` (which returns a new BanditCamp with
 * the same id). Stores the day on which the camp last had a successful
 * raid; used by `decideCampAction` to favour `lay_low` after a fresh hit.
 */
const lastSuccessfulRaidDay: Map<BanditCampId, Day> = new Map();

/**
 * Per-camp recruit-pressure tracker (active multiplier after a recruit_drive
 * action). Counts down toward 1 each day. Used by recruitFromIdle.
 */
const recruitDriveMultiplier: Map<BanditCampId, number> = new Map();

const RECRUIT_RANGE_HEXES = 50;
const BASE_RECRUIT_FRAC_PER_DAY = 0.0005;
const POOR_VILLAGE_RECRUIT_BOOST = 4;
/**
 * Per-camp soft cap. Beyond this size a camp is no longer recruiting (it's
 * conspicuous, food logistics break down, and historically warlord bands
 * fragmented at this scale). Recruits go to the next-nearest camp under
 * the cap, or the recruitment skips for that day.
 */
const CAMP_RECRUIT_CAP = 500;

const banditPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  // Don't early-exit when banditCamps is empty: recruitFromIdle below is
  // the only path by which the world's bandit population can recover from
  // zero (after patrols wipe out the seeded camps).
  if (world.banditCamps === undefined) return;

  // Step 1: bandit decisions + raid resolution.
  for (const [campId, camp] of [...world.banditCamps]) {
    if (camp.banditCount <= 0) {
      world.banditCamps.delete(campId);
      continue;
    }
    const subRng = rng.derive(`camp-${String(campId)}`);

    // Build the inputs for decideCampAction.
    const knownNearbyCaravans: {
      hex: Hex;
      estimatedCargoValue: number;
      guards: number;
    }[] = [];
    for (const c of world.caravans.values()) {
      if (hexDistance(c.position, camp.hex) > 8) continue;
      // Skip caravans currently at a settlement (urban hex) — too risky,
      // bandits prefer the road. We approximate "urban" by checking a
      // settlement anchor.
      const atSettlement = [...world.settlements.values()].some((s) =>
        hexEquals(s.anchor, c.position),
      );
      if (atSettlement) continue;
      knownNearbyCaravans.push({
        hex: c.position,
        estimatedCargoValue: estimateCargoValue(c),
        guards: countGuards(c),
      });
    }

    const lastDay = lastSuccessfulRaidDay.get(campId) ?? -1000;
    const daysSinceLastSuccessfulRaid = today - lastDay;

    // Patrols visible to the camp: any patrol whose current position is
    // within 8 hexes (matches our PATROL_DETECTION_HEXES symmetry).
    const knownNearbyPatrols: { hex: Hex; size: number }[] = [];
    if (world.patrols !== undefined) {
      for (const p of world.patrols.values()) {
        if (hexDistance(p.position, camp.hex) <= 8) {
          knownNearbyPatrols.push({ hex: p.position, size: p.unit.count });
        }
      }
    }

    // "Friendly" settlements: bandits know nearby small unfortified villages
    // (raid targets) AND nearby large cities with a corrupt fence (looting
    // outlets). v1 shorthand: any settlement within 30 hexes whose tier is
    // hamlet/village/town qualifies as a raid target; cities qualify as
    // fence outlets if the bandit's reputation with them is non-negative.
    const knownFriendlySettlements: { id: SettlementId; hex: Hex }[] = [];
    for (const s of world.settlements.values()) {
      if (hexDistance(s.anchor, camp.hex) > 30) continue;
      if (s.tier === 'hamlet' || s.tier === 'village' || s.tier === 'town') {
        knownFriendlySettlements.push({ id: s.id, hex: s.anchor });
      } else {
        // City: include only if the city's authority isn't actively hostile
        // to the camp. Authority = governor_office or city_corporation
        // anchored at the settlement.
        let hostile = false;
        for (const oId of s.stockpileOwners) {
          const a = world.actors.get(oId);
          if (
            a !== undefined &&
            (a.kind === 'governor_office' || a.kind === 'city_corporation')
          ) {
            const rep = world.reputation.get(camp.ownerActor, a.id);
            if (rep < -0.3) {
              hostile = true;
              break;
            }
          }
        }
        if (!hostile) knownFriendlySettlements.push({ id: s.id, hex: s.anchor });
      }
    }

    const action = decideCampAction({
      camp,
      knownNearbyCaravans,
      knownNearbyPatrols,
      knownFriendlySettlements,
      daysSinceLastSuccessfulRaid,
      rng: subRng.derive('decide'),
    });

    applyCampAction(world, campId, camp, action, today, subRng.derive('act'), events);
  }

  // Step 2: recruitment from settlements with idle pop / hardship.
  recruitFromIdle(world, rng.derive('recruit'), today, events);

  // Step 3: starvation desertion (camps with empty loot lose bandits).
  applyBanditStarvation(world, rng.derive('starve'), today);

  // Step 4: decay recruit drives.
  for (const [campId, mult] of [...recruitDriveMultiplier]) {
    const next = mult <= 1.05 ? 1 : mult - 0.1;
    if (next <= 1) recruitDriveMultiplier.delete(campId);
    else recruitDriveMultiplier.set(campId, next);
  }
};

const estimateCargoValue = (c: Caravan): number => {
  // Coarse: sum of cargo weights ≈ proxy for value. 1 unit cargo ≈ 1 coin.
  let v = 0;
  for (const qty of c.cargo.values()) v += qty;
  v += c.treasury * 0.5; // treasury is coin, slightly less prized than goods
  return v;
};

const countGuards = (c: Caravan): number => {
  let guards = 0;
  for (const m of c.crew) {
    if (m.kind === 'soldier' || m.kind === 'caravan_guard') guards += m.count;
  }
  return guards;
};

const applyCampAction = (
  world: WorldState,
  campId: BanditCampId,
  camp: BanditCamp,
  action: ReturnType<typeof decideCampAction>,
  today: Day,
  rng: Rng,
  events: TickEvent[],
): void => {
  if (world.banditCamps === undefined) return;
  switch (action.type) {
    case 'lay_low':
      return;
    case 'recruit_drive':
      recruitDriveMultiplier.set(campId, 2);
      return;
    case 'move_camp': {
      // Walk one hex toward the target.
      const from = camp.hex;
      const dq = Math.sign(action.toHex.q - from.q);
      const dr = Math.sign(action.toHex.r - from.r);
      const stepHex = { q: from.q + dq, r: from.r + dr };
      // Only step if the destination tile exists and is wilderness.
      const tile = world.grid.get(stepHex);
      if (tile === undefined) return;
      const moved: BanditCamp = { ...camp, hex: stepHex };
      world.banditCamps.set(campId, moved);
      return;
    }
    case 'raid_caravan': {
      const target = findCaravanAtHex(world, action.targetHex);
      if (target === null) return;
      const tile = world.grid.get(target.position);
      if (tile === undefined) return;
      const result = resolveAmbush({
        attacker: camp,
        target,
        ambushHexTerrain: tile.terrain,
        rng: rng.derive('ambush'),
      });

      // Apply caravan casualties: remove crew, animals (animals deferred —
      // caravan model doesn't separate them yet; v1 just records the loss).
      let deathsRemaining = result.caravanCasualties.crewDeaths;
      for (const m of target.crew) {
        if (deathsRemaining <= 0) break;
        const take = Math.min(m.count, deathsRemaining);
        m.count -= take;
        deathsRemaining -= take;
      }
      // Remove zero-count crew entries to keep validation invariants.
      target.crew = target.crew.filter((m) => m.count > 0);

      // Transfer cargo from caravan to camp loot.
      for (const [resId, qty] of result.cargoTaken) {
        const have = target.cargo.get(resId) ?? 0;
        const newQty = have - qty;
        if (newQty <= 1e-9) target.cargo.delete(resId);
        else target.cargo.set(resId, newQty);
        const lootHave = camp.loot.get(resId) ?? 0;
        camp.loot.set(resId, lootHave + qty);
      }
      target.treasury = Math.max(0, target.treasury - result.coinTaken);
      camp.treasury += result.coinTaken;

      // Apply bandit casualties → new camp record.
      const banditDeaths = result.banditCasualties.deaths;
      const remaining = Math.max(0, camp.banditCount - banditDeaths);
      const updated: BanditCamp = { ...camp, banditCount: remaining };
      if (remaining <= 0) world.banditCamps.delete(campId);
      else world.banditCamps.set(campId, updated);

      if (result.outcome === 'attacker_won' || result.outcome === 'caravan_fled') {
        lastSuccessfulRaidDay.set(campId, today);
      }

      let cargoLost = 0;
      for (const qty of result.cargoTaken.values()) cargoLost += qty;
      if (cargoLost > 0 || result.coinTaken > 0 || result.caravanCasualties.crewDeaths > 0) {
        events.push({
          type: 'caravan_robbed',
          caravan: target.id,
          by: campId,
          cargoLost,
        });
      }

      // Emit news carriers for fled_escaped survivors on the caravan side.
      // They walk to the nearest settlement at refugee speed (~20 hex/day)
      // and on arrival apply reputation deltas via processNewsArrival.
      // docs/13 §"Battle survivor system": survivors are the ONLY route by
      // which battle outcomes propagate to the world's reputation slates.
      spawnNewsFromAmbush(world, today, target, campId, camp, result, cargoLost, events);
      return;
    }
    case 'raid_settlement': {
      const target = world.settlements.get(action.targetSettlement);
      if (target === undefined) return;
      executeSettlementRaid(world, today, campId, camp, target, rng.derive('raid'), events);
      return;
    }
    case 'fence_loot': {
      const through = world.settlements.get(action.throughSettlement);
      if (through === undefined) return;
      executeFenceTransaction(world, today, campId, camp, through, events);
      return;
    }
    case 'bribe_settlement': {
      const target = world.settlements.get(action.settlement);
      if (target === undefined) return;
      // Find a stockpile-owning actor to receive the bribe.
      let receiver: Actor | undefined;
      for (const oId of target.stockpileOwners) {
        const a = world.actors.get(oId);
        if (a !== undefined && (a.kind === 'city_corporation' || a.kind === 'governor_office')) {
          receiver = a;
          break;
        }
      }
      const amount = Math.min(camp.treasury, action.amount);
      if (amount <= 0) return;
      camp.treasury -= amount;
      if (receiver !== undefined) receiver.treasury += amount;
      // Reputation: receiver becomes friendlier to bandit camp owner.
      if (receiver !== undefined) {
        world.reputation.apply(camp.ownerActor, receiver.id, 0.05);
        world.reputation.apply(receiver.id, camp.ownerActor, 0.1);
      }
      return;
    }
  }
};

// --- Settlement raid execution ---------------------------------------------

const tierToWallLevel = (tier: Settlement['tier']): WallLevel => {
  switch (tier) {
    case 'hamlet':
      return 0;
    case 'village':
      return 0;
    case 'town':
      return 1;
    case 'small_city':
      return 2;
    case 'large_city':
      return 3;
  }
};

const aggregateSettlementStockpile = (
  world: WorldState,
  settlement: Settlement,
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  for (const oId of settlement.stockpileOwners) {
    const a = world.actors.get(oId);
    if (a === undefined) continue;
    for (const [res, qty] of a.stockpile) {
      out.set(res, (out.get(res) ?? 0) + qty);
    }
  }
  return out;
};

const drainSettlementStockpile = (
  world: WorldState,
  settlement: Settlement,
  loot: ReadonlyMap<ResourceId, Quantity>,
): void => {
  // Drain each resource proportionally across stockpile owners.
  for (const [res, qty] of loot) {
    let remaining = qty;
    for (const oId of settlement.stockpileOwners) {
      if (remaining <= 1e-9) break;
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      const have = a.stockpile.get(res) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, remaining);
      const newQty = have - take;
      if (newQty > 1e-9) a.stockpile.set(res, newQty);
      else a.stockpile.delete(res);
      remaining -= take;
    }
  }
};

const executeSettlementRaid = (
  world: WorldState,
  today: Day,
  campId: BanditCampId,
  camp: BanditCamp,
  target: Settlement,
  rng: Rng,
  events: TickEvent[],
): void => {
  if (world.banditCamps === undefined) return;

  // Gather defenders: any patrol based at this settlement.
  const defendingPatrols: Patrol[] = [];
  if (world.patrols !== undefined) {
    for (const p of world.patrols.values()) {
      if (p.basedAt === target.id && p.unit.count > 0) defendingPatrols.push(p);
    }
  }

  // Coarse militia estimate: 5% of working-age adults rally.
  const militiaCount = Math.floor(adultPopulation(target) * 0.05);

  const stockpile = aggregateSettlementStockpile(world, target);
  const wallLevel = tierToWallLevel(target.tier);

  const result = resolveRaid({
    attacker: camp,
    target,
    defendingPatrols,
    militiaCount,
    wallLevel,
    settlementStockpile: stockpile,
    rng: rng.derive('raid'),
  });

  // Apply loot drain.
  drainSettlementStockpile(world, target, result.lootTaken);
  // Add loot to camp.
  for (const [res, qty] of result.lootTaken) {
    camp.loot.set(res, (camp.loot.get(res) ?? 0) + qty);
  }

  // Apply civilian deaths.
  if (result.settlementCasualties.civilianDeaths > 0) {
    const killed = applyCivilianDeaths(target, result.settlementCasualties.civilianDeaths);
    if (killed > 0) {
      events.push({
        type: 'cohort_deaths',
        settlement: target.id,
        deaths: killed,
        cause: 'war',
      });
    }
  }
  // Apply patrol casualties (one defender unit aggregates them all; we
  // distribute proportionally across patrols by their size).
  const totalPatrolCount = defendingPatrols.reduce((acc, p) => acc + p.unit.count, 0);
  if (totalPatrolCount > 0 && result.settlementCasualties.defenderDeaths > 0) {
    let remaining = result.settlementCasualties.defenderDeaths;
    for (const p of defendingPatrols) {
      if (remaining <= 0) break;
      const share = Math.round((p.unit.count / totalPatrolCount) * result.settlementCasualties.defenderDeaths);
      const take = Math.min(share, p.unit.count, remaining);
      if (take <= 0) continue;
      p.unit = { ...p.unit, count: p.unit.count - take };
      remaining -= take;
      if (p.unit.count <= 0 && world.patrols !== undefined) world.patrols.delete(p.id);
    }
  }
  // Apply bandit casualties.
  const banditDeaths = result.banditCasualties.deaths;
  const survivingCamp = Math.max(0, camp.banditCount - banditDeaths);
  if (survivingCamp <= 0) world.banditCamps.delete(campId);
  else world.banditCamps.set(campId, { ...camp, banditCount: survivingCamp });

  // Total cargo lost (count) for telemetry.
  let cargoLost = 0;
  for (const qty of result.lootTaken.values()) cargoLost += qty;
  events.push({
    type: 'settlement_raided',
    settlement: target.id,
    by: campId,
    cargoLost,
    defendersKilled: result.settlementCasualties.defenderDeaths,
  });

  // News from survivors. Settlement raids are visible — every village
  // family that lost livestock has a witness. Spawn a carrier to the
  // nearest large settlement (likely the city the village reports to)
  // OR back to the village itself (if it has named characters present).
  // Magnitude scales with civilian deaths + cargo lost.
  let mag: ReputationMagnitude = 'moderate';
  if (result.settlementCasualties.civilianDeaths > 20 || cargoLost > 200) mag = 'severe';
  if (result.settlementCasualties.civilianDeaths > 100 || cargoLost > 1000) mag = 'atrocious';
  // Always emit news of the attack — the village itself is the spawn point.
  const dest = nearestSettlementWithinRange(world, target.anchor, NEWS_CARRIER_MAX_DESTINATION_HEXES);
  if (dest !== null && world.newsCarriers !== undefined) {
    const id = `news-${today}-raid-${String(campId)}-${String(target.id)}`;
    if (!world.newsCarriers.has(id)) {
      const news = createNewsItem({
        id,
        perpetrator: camp.ownerActor as ReputationKey,
        victim: null,
        magnitude: mag,
        isCriminalAct: true,
        occurredAtHex: target.anchor,
        occurredOnDay: today,
      });
      const carrier = createNewsCarrier({
        id,
        news,
        spawnHex: target.anchor,
        destination: dest.anchor,
        spawnDay: today,
        speed: NEWS_CARRIER_SPEED,
      });
      world.newsCarriers.set(id, carrier);
      events.push({
        type: 'news_carrier_spawned',
        id,
        perpetrator: news.perpetrator,
        victim: null,
        destination: dest.anchor,
        magnitude: mag,
      });
    }
  }
  if (banditDeaths > 0 || result.lootTaken.size > 0) {
    lastSuccessfulRaidDay.set(campId, today);
  }
};

const applyCivilianDeaths = (settlement: Settlement, count: number): number => {
  // Use the same priority-by-vulnerability as famine deaths.
  let remaining = count;
  let killed = 0;
  const order: readonly string[] = ['0-4', '80+', '5-9', '75-79', '70-74'];
  const fallback: readonly string[] = ['10-14', '15-19', '20-24', '25-29', '30-34', '35-39'];
  const all: readonly string[] = [...order, ...fallback];
  for (const ageStr of all) {
    if (remaining <= 0) break;
    const age = ageStr as unknown as Parameters<Settlement['population']['totalByAgeBand']>[0];
    const inBand = settlement.population.totalByAgeBand(age);
    if (inBand <= 0) continue;
    const take = Math.min(remaining, inBand);
    let drained = 0;
    const snap: Array<[Parameters<Settlement['population']['set']>[0], number]> = [];
    for (const [key, c] of settlement.population.cohorts()) {
      if (key.age === age && c > 0) snap.push([key, c]);
    }
    for (const [key, c] of snap) {
      if (drained >= take) break;
      const share = Math.max(1, Math.round((c / inBand) * take));
      const drop = Math.min(share, c, take - drained);
      if (drop <= 0) continue;
      settlement.population.set(key, c - drop);
      drained += drop;
      killed += drop;
    }
    remaining -= drained;
  }
  return killed;
};

const FENCE_PRICE_FRACTION = 0.6;

const executeFenceTransaction = (
  world: WorldState,
  _today: Day,
  campId: BanditCampId,
  camp: BanditCamp,
  through: Settlement,
  events: TickEvent[],
): void => {
  // Pick a fence-eligible actor at the target settlement: prefer city
  // corporation; fall back to first stockpile owner with positive treasury.
  let fence: Actor | undefined;
  for (const oId of through.stockpileOwners) {
    const a = world.actors.get(oId);
    if (a === undefined) continue;
    if (a.kind === 'city_corporation' && a.treasury > 0) {
      fence = a;
      break;
    }
  }
  if (fence === undefined) {
    for (const oId of through.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a !== undefined && a.treasury > 0) {
        fence = a;
        break;
      }
    }
  }
  if (fence === undefined) return;

  // Compute total coin value of camp loot using local clearing prices
  // (fall back to 1 coin/unit when no price observed).
  let totalCoin = 0;
  const transferable: { res: ResourceId; qty: number; price: number }[] = [];
  for (const [res, qty] of camp.loot) {
    if (qty <= 0) continue;
    const lastPrice = through.market.lastClearingPrice.get(res) ?? 1;
    const fencePrice = lastPrice * FENCE_PRICE_FRACTION;
    const value = qty * fencePrice;
    if (value <= 0) continue;
    transferable.push({ res, qty, price: fencePrice });
    totalCoin += value;
  }
  if (totalCoin <= 0) return;
  // Cap at fence's treasury.
  const coinPaid = Math.min(totalCoin, fence.treasury);
  if (coinPaid <= 0) return;
  const fraction = coinPaid / totalCoin;

  for (const t of transferable) {
    const moveQty = t.qty * fraction;
    if (moveQty <= 1e-9) continue;
    const have = camp.loot.get(t.res) ?? 0;
    const newCampQty = have - moveQty;
    if (newCampQty > 1e-9) camp.loot.set(t.res, newCampQty);
    else camp.loot.delete(t.res);
    fence.stockpile.set(t.res, (fence.stockpile.get(t.res) ?? 0) + moveQty);
  }
  fence.treasury -= coinPaid;
  camp.treasury += coinPaid;
  // Reputation: fence becomes friendlier to camp; camp likewise.
  world.reputation.apply(fence.id, camp.ownerActor, 0.05);
  world.reputation.apply(camp.ownerActor, fence.id, 0.05);
  events.push({
    type: 'fence_traded',
    camp: campId,
    through: through.id,
    coinPaid,
  });
};

const findCaravanAtHex = (world: WorldState, hex: Hex): Caravan | null => {
  for (const c of world.caravans.values()) {
    if (hexEquals(c.position, hex)) return c;
  }
  return null;
};

const recruitFromIdle = (
  world: WorldState,
  rng: Rng,
  _today: Day,
  events: TickEvent[],
): void => {
  // Note: we don't early-exit on banditCamps.size === 0. When patrols wipe
  // all camps, the founding branch below is the ONLY way the world's
  // bandit population can recover — exiting here would freeze the world
  // in a no-bandits state forever.
  if (world.banditCamps === undefined) return;
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const adults = adultPopulation(settlement);
    if (adults <= 0) continue;
    // Pressure pool ≈ adults × jobless fraction. v1 proxy: 5% of adults
    // are "idle-ish" by default; 20% in settlements with food shortfall.
    const isPoor = (faminePressure.get(settlement)?.consecutiveShortageDays ?? 0) >= 1;
    const pressureFraction = isPoor ? 0.2 : 0.05;
    const pressurePool = adults * pressureFraction;
    if (pressurePool <= 0) continue;

    // Find the nearest camp within RECRUIT_RANGE_HEXES that is still under
    // the soft size cap. Above-cap camps don't accept recruits.
    let nearest: { id: BanditCampId; dist: number } | null = null;
    for (const [campId, camp] of world.banditCamps) {
      if (camp.banditCount >= CAMP_RECRUIT_CAP) continue;
      const d = hexDistance(camp.hex, settlement.anchor);
      if (d > RECRUIT_RANGE_HEXES) continue;
      if (nearest === null || d < nearest.dist) nearest = { id: campId, dist: d };
    }

    // Found a new camp if no nearby host exists. Probability is tiny per
    // settlement-day; this gives the bandit population a slow recovery
    // path after patrols wipe out existing camps. Per docs/12 §"Joining
    // vs founding". Without this, once the seeded camps are eliminated
    // the bandit count stays at zero forever (unrealistic).
    if (nearest === null && pressurePool >= 5) {
      const foundProb = isPoor ? 0.005 : 0.001; // poor villages found camps faster
      const noise2 = rng.derive(`found-${String(settlement.id)}-roll`).next();
      if (noise2 < foundProb) {
        const founded = foundNewCamp(
          world,
          settlement,
          rng.derive(`found-${String(settlement.id)}`),
        );
        if (founded !== null) nearest = { id: founded, dist: 0 };
      }
    }
    if (nearest === null) continue;

    let frac = BASE_RECRUIT_FRAC_PER_DAY;
    if (isPoor) frac *= POOR_VILLAGE_RECRUIT_BOOST;
    const driveMult = recruitDriveMultiplier.get(nearest.id) ?? 1;
    frac *= driveMult;

    const expected = pressurePool * frac;
    // Stochastic recruit count (Poisson-ish via uniform jitter).
    const noise = rng.derive(`pool-${String(settlement.id)}`).next();
    const newRecruits = Math.floor(expected + noise);
    if (newRecruits <= 0) continue;

    const actuallyTake = Math.min(newRecruits, Math.floor(adults * 0.01));
    if (actuallyTake <= 0) continue;
    drainAdultsFromSettlement(settlement, actuallyTake);
    const camp = world.banditCamps.get(nearest.id);
    if (camp === undefined) continue;
    world.banditCamps.set(nearest.id, recruit(camp, actuallyTake));
    events.push({
      type: 'bandit_recruited',
      camp: nearest.id,
      fromSettlement: settlement.id,
      count: actuallyTake,
    });
  }
};

/**
 * Found a fresh bandit camp in wilderness 5-10 hexes from `near`. Returns
 * the new camp's id, or null if no acceptable hex was found. Wires up
 * the necessary actor + faction + leader so reputation propagation works
 * the same as procgen-seeded camps.
 */
const foundNewCamp = (
  world: WorldState,
  near: Settlement,
  rng: Rng,
): BanditCampId | null => {
  if (world.banditCamps === undefined) return null;
  // Search outward from settlement anchor for an acceptable wilderness hex.
  const acceptable: Hex[] = [];
  for (let radius = 5; radius <= 12 && acceptable.length === 0; radius++) {
    for (let dq = -radius; dq <= radius; dq++) {
      for (let dr = -radius; dr <= radius; dr++) {
        const cand = { q: near.anchor.q + dq, r: near.anchor.r + dr };
        if (hexDistance(cand, near.anchor) !== radius) continue;
        const tile = world.grid.get(cand);
        if (tile === undefined) continue;
        // Bandits prefer cover but desperate bands settle anywhere. Reject
        // only "obviously impossible" terrain (water + urban). Forest /
        // hills get scored higher implicitly because the spiral search
        // returns them first.
        if (
          tile.terrain === 'lake' ||
          tile.terrain === 'river' ||
          tile.terrain === 'urban'
        ) {
          continue;
        }
        // Don't found ON top of an existing camp.
        let occupied = false;
        for (const c of world.banditCamps.values()) {
          if (hexEquals(c.hex, cand)) {
            occupied = true;
            break;
          }
        }
        if (occupied) continue;
        acceptable.push(cand);
      }
    }
  }
  if (acceptable.length === 0) return null;
  const hex = rng.pick(acceptable);

  // Spawn actor + faction + named leader, mirroring procgen seeding.
  const aId = actorId(`actor-emergent-${String(near.id)}-${world.day}-${rng.next().toFixed(6)}`);
  const fId = factionId(`faction-${String(aId)}`);
  const leaderId = characterId(`char-${String(aId)}`);
  const newId = makeBanditCampId(`camp-${String(aId)}`);
  const leaderName = generateFullName(rng.derive('leader'), 'male');
  const actor = createActor({
    id: aId,
    kind: 'bandit_camp',
    name: `${leaderName}'s band`,
    treasury: rng.int(0, 30),
  });
  world.actors.set(aId, actor);
  const leader = createCharacter({
    id: leaderId,
    name: leaderName,
    age: rng.int(22, 50),
    sex: 'male',
    class: 'plebeian',
    faction: fId,
    role: 'bandit_leader',
    location: hex,
  });
  world.characters.set(leaderId, leader);
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `${leaderName}'s band`,
    members: [leaderId],
  });
  world.factions.set(fId, faction);
  const camp = createCamp({
    id: newId,
    name: `${leaderName}'s band`,
    hex,
    ownerActor: aId,
    banditCount: 5,
    hangersOnCount: 1,
    weaponsPerBandit: 0.3,
    armorPerBandit: 0.05,
    averageHealth: 0.8,
    treasury: actor.treasury,
  });
  world.banditCamps.set(newId, camp);
  return newId;
};

const drainAdultsFromSettlement = (settlement: Settlement, count: number): void => {
  let remaining = count;
  // Prefer the working-age bands.
  const order: readonly string[] = [
    '20-24',
    '25-29',
    '15-19',
    '30-34',
    '35-39',
    '40-44',
    '45-49',
    '50-54',
  ];
  for (const ageStr of order) {
    if (remaining <= 0) break;
    const age = ageStr as unknown as Parameters<Settlement['population']['totalByAgeBand']>[0];
    const inBand = settlement.population.totalByAgeBand(age);
    if (inBand <= 0) continue;
    const take = Math.min(remaining, inBand);
    let drained = 0;
    const snap: Array<[Parameters<Settlement['population']['set']>[0], number]> = [];
    for (const [key, c] of settlement.population.cohorts()) {
      if (key.age === age && c > 0) snap.push([key, c]);
    }
    for (const [key, c] of snap) {
      if (drained >= take) break;
      const share = Math.max(1, Math.floor((c / inBand) * take));
      const drop = Math.min(share, c, take - drained);
      if (drop <= 0) continue;
      settlement.population.set(key, c - drop);
      drained += drop;
    }
    remaining -= drained;
  }
};

const applyBanditStarvation = (world: WorldState, rng: Rng, _today: Day): void => {
  if (world.banditCamps === undefined) return;
  for (const [campId, camp] of [...world.banditCamps]) {
    let lootKg = 0;
    for (const [resId, qty] of camp.loot) {
      const def = getResource(resId);
      lootKg += qty * def.weightKgPerUnit;
    }
    const dailyNeedKg = camp.banditCount * 0.4;
    if (lootKg >= dailyNeedKg) {
      // Consume from the highest-weight food first (grain prefers to be
      // eaten before luxuries).
      let remaining = dailyNeedKg;
      const eatable: ResourceId[] = [
        resourceId('food.grain'),
        resourceId('food.bread'),
        resourceId('food.flour'),
        resourceId('food.legumes'),
        resourceId('food.cheese'),
        resourceId('food.salted_meat'),
        resourceId('food.salted_fish'),
      ];
      for (const id of eatable) {
        if (remaining <= 0) break;
        const have = camp.loot.get(id) ?? 0;
        if (have <= 0) continue;
        const def = getResource(id);
        const haveKg = have * def.weightKgPerUnit;
        const takeKg = Math.min(haveKg, remaining);
        const takeUnits = takeKg / Math.max(1e-9, def.weightKgPerUnit);
        const newQty = have - takeUnits;
        if (newQty > 1e-9) camp.loot.set(id, newQty);
        else camp.loot.delete(id);
        remaining -= takeKg;
      }
    } else {
      // Starvation: 5% desert per day at zero food, scaled.
      const shortfallFrac = 1 - lootKg / Math.max(1, dailyNeedKg);
      const desertRate = 0.05 * shortfallFrac;
      const noise = rng.derive(`starve-${String(campId)}`).next();
      const desertCount = Math.floor(camp.banditCount * desertRate + noise);
      if (desertCount > 0) {
        const remaining = Math.max(0, camp.banditCount - desertCount);
        if (remaining < 3) world.banditCamps.delete(campId);
        else world.banditCamps.set(campId, { ...camp, banditCount: remaining });
      }
    }
  }
};

// --- News-carrier spawn from ambush + arrival processing -------------------

const NEWS_CARRIER_SPEED = 20;
const NEWS_CARRIER_MAX_DESTINATION_HEXES = 60;

const ambushMagnitude = (
  cargoLost: number,
  crewDeaths: number,
  coinLost: number,
): ReputationMagnitude => {
  if (cargoLost > 200 || crewDeaths > 10 || coinLost > 500) return 'atrocious';
  if (cargoLost > 50 || crewDeaths > 3 || coinLost > 100) return 'severe';
  if (cargoLost > 10 || crewDeaths > 0 || coinLost > 20) return 'moderate';
  return 'petty';
};

const nearestSettlementWithinRange = (
  world: WorldState,
  from: Hex,
  maxDist: number,
): Settlement | null => {
  let best: { s: Settlement; d: number } | null = null;
  for (const s of world.settlements.values()) {
    const d = hexDistance(s.anchor, from);
    if (d > maxDist) continue;
    if (best === null || d < best.d) best = { s, d };
  }
  return best?.s ?? null;
};

const spawnNewsFromAmbush = (
  world: WorldState,
  today: Day,
  caravan: Caravan,
  campId: BanditCampId,
  camp: BanditCamp,
  result: AmbushResult,
  cargoLost: number,
  events: TickEvent[],
): void => {
  if (world.newsCarriers === undefined) return;

  // Aggregate fled_escaped count across all caravan-side survivor entries.
  let fledEscaped = 0;
  for (const s of result.survivors) {
    if (s.unitId === 'caravan' && s.fate === 'fled_escaped') fledEscaped += s.count;
  }

  // Floor: per docs/12 §"Battles aren't total annihilation", even a clean
  // attacker_won leaves rumor traces. If no eyewitnesses escaped but the
  // attack was material, still emit a "rumor" carrier — the missing
  // caravan eventually triggers an investigation upstream.
  const incidentMaterial =
    cargoLost > 0 || result.caravanCasualties.crewDeaths > 0 || result.coinTaken > 0;
  if (fledEscaped <= 0 && !incidentMaterial) return;

  const dest = nearestSettlementWithinRange(world, caravan.position, NEWS_CARRIER_MAX_DESTINATION_HEXES);
  if (dest === null) return;

  const fullMagnitude = ambushMagnitude(
    cargoLost,
    result.caravanCasualties.crewDeaths,
    result.coinTaken,
  );
  // Rumor-only events drop to petty regardless of incident size — without a
  // first-hand witness the news loses specificity.
  const magnitude: ReputationMagnitude = fledEscaped > 0 ? fullMagnitude : 'petty';

  // One carrier per ambush — multiple survivors converge on the same news.
  // Per docs/12: even one survivor is enough to update reputation; numbers
  // matter more for credibility than for delta magnitude.
  const id = `news-${today}-${String(campId)}-${String(caravan.id)}`;
  if (world.newsCarriers.has(id)) return; // dedupe within the same tick

  const news = createNewsItem({
    id,
    perpetrator: camp.ownerActor as ReputationKey,
    victim: caravan.ownerActor as ReputationKey,
    magnitude,
    isCriminalAct: true,
    occurredAtHex: caravan.position,
    occurredOnDay: today,
    battleSurvivors: fledEscaped,
  });
  const carrier = createNewsCarrier({
    id,
    news,
    spawnHex: caravan.position,
    destination: dest.anchor,
    spawnDay: today,
    speed: NEWS_CARRIER_SPEED,
  });
  world.newsCarriers.set(id, carrier);
  events.push({
    type: 'news_carrier_spawned',
    id,
    perpetrator: news.perpetrator,
    victim: news.victim,
    destination: dest.anchor,
    magnitude,
  });
};

const newsArrivalPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
  if (world.newsCarriers === undefined || world.newsCarriers.size === 0) return;

  // Index settlements by anchor hex once per call.
  const settlementByAnchor = new Map<string, Settlement>();
  for (const s of world.settlements.values()) {
    settlementByAnchor.set(`${s.anchor.q},${s.anchor.r}`, s);
  }

  // Build per-settlement character list. NamedCharacter.location is the hex
  // they're currently at; we group by anchor hex match. Cached so multiple
  // arrivals at the same settlement reuse the list.
  const charsBySettlementAnchor = new Map<string, NamedCharacter[]>();
  const factionByActor = buildActorToFactionIndex(world);
  for (const c of world.characters.values()) {
    const key = `${c.location.q},${c.location.r}`;
    const list = charsBySettlementAnchor.get(key);
    if (list === undefined) charsBySettlementAnchor.set(key, [c]);
    else list.push(c);
  }

  for (const [id, carrier] of [...world.newsCarriers]) {
    if (!carrier.arrived) continue;
    const destKey = `${carrier.destination.q},${carrier.destination.r}`;
    const settlement = settlementByAnchor.get(destKey);
    if (settlement === undefined) {
      // Carrier arrived somewhere with no settlement (shouldn't happen
      // since we picked anchors as destinations) — drop it.
      world.newsCarriers.delete(id);
      continue;
    }
    const characters = charsBySettlementAnchor.get(destKey) ?? [];

    const victimFaction =
      carrier.carrying.victim !== null
        ? factionByActor.get(String(carrier.carrying.victim))
        : undefined;
    const perpetratorFaction = factionByActor.get(String(carrier.carrying.perpetrator));

    const inputs = {
      carrier,
      destinationSettlement: settlement,
      charactersAtSettlement: characters,
      reputation: world.reputation,
      ...(victimFaction !== undefined ? { victimFaction } : {}),
      ...(perpetratorFaction !== undefined
        ? { banditAlignedFactions: [perpetratorFaction] as readonly FactionId[] }
        : {}),
    };
    const result = processNewsArrival(inputs);
    events.push({
      type: 'news_carrier_arrived',
      id,
      settlement: settlement.id,
      receiverCount: result.charactersUpdated,
      deltasApplied: result.reputationDeltasApplied.length,
    });
    for (const d of result.reputationDeltasApplied) {
      events.push({
        type: 'reputation_updated',
        holder: d.holder,
        subject: d.subject,
        delta: d.delta,
      });
    }
    world.newsCarriers.delete(id);
  }
};

const buildActorToFactionIndex = (world: WorldState): Map<string, FactionId> => {
  const out = new Map<string, FactionId>();
  for (const f of world.factions.values()) {
    out.set(String(f.actor), f.id);
  }
  return out;
};

// --- Patrol phase ----------------------------------------------------------

/**
 * Per-day patrol tick. For each patrol:
 *   1. Build the known-bandit-camps-on-route list (camps whose hex is on or
 *      near the patrol's route — v1 uses "any camp within 2 hexes of the
 *      patrol's current position").
 *   2. tickPatrol → advances the patrol, may emit pendingBattles.
 *   3. For each pending battle, run resolveBattle, apply casualties to
 *      both sides, emit news carriers from camp-side fled_escaped.
 */
const patrolPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (world.patrols === undefined || world.patrols.size === 0) return;
  // Patrols still walk their routes even if camps are momentarily zero —
  // they're salaried; not exiting here also avoids missing newly-founded
  // camps that emerged within this tick.
  if (world.banditCamps === undefined) return;

  // Build a quick hex → camps index for proximity lookup.
  const campsByHex = new Map<string, BanditCamp[]>();
  for (const camp of world.banditCamps.values()) {
    const k = `${camp.hex.q},${camp.hex.r}`;
    const list = campsByHex.get(k);
    if (list === undefined) campsByHex.set(k, [camp]);
    else list.push(camp);
  }

  for (const [patrolId, patrol] of [...world.patrols]) {
    if (patrol.unit.count <= 0) {
      world.patrols.delete(patrolId);
      continue;
    }
    const subRng = rng.derive(`patrol-${patrolId}`);

    // Detection: a patrol "knows" any camp within DETECTION hexes of EITHER
    // its current position OR the next hex on its route. Real Roman patrols
    // had local informants tipping them off, so the strict same-hex check
    // in tickPatrol's contract is too narrow. We shim each detected camp's
    // hex to the patrol's next route hex so the engagement resolves there
    // (representing the patrol diverting from its loop briefly).
    const nextIndex = (patrol.routeIndex + 1) % patrol.route.length;
    const nextHex = patrol.route[nextIndex];
    if (nextHex === undefined) continue;
    const PATROL_DETECTION_HEXES = 15;
    const known: { camp: BanditCamp; hex: Hex }[] = [];
    for (const camp of world.banditCamps.values()) {
      const dCurrent = hexDistance(camp.hex, patrol.position);
      const dNext = hexDistance(camp.hex, nextHex);
      if (Math.min(dCurrent, dNext) <= PATROL_DETECTION_HEXES) {
        known.push({ camp, hex: nextHex });
      }
    }
    // Caravan inspection list — patrol checks for suspicious caravans on hex.
    const knownCaravans: { caravanId: CaravanId; ownerActor: ActorId; hex: Hex; suspicious: boolean }[] = [];
    for (const c of world.caravans.values()) {
      if (hexDistance(c.position, nextHex) <= 1) {
        knownCaravans.push({
          caravanId: c.id,
          ownerActor: c.ownerActor,
          hex: c.position,
          suspicious: false, // v1: no caravan-suspicion signal yet
        });
      }
    }

    const result = tickPatrol({
      patrol,
      rng: subRng.derive('tick'),
      knownBanditCampsOnRoute: known,
      knownCaravansOnRoute: knownCaravans,
      reputation: world.reputation,
      today,
    });

    // Persist patrol mutations.
    world.patrols.set(patrolId, result.patrol);

    // Emit dispatch event when the patrol steps into a hex containing a
    // known camp — proxy for "patrol detected & moved on it". Helps the
    // burn-in observability layer.
    for (const e of result.events) {
      if (e.type === 'tactical_retreat' || e.type === 'turned_blind_eye') {
        events.push({
          type: 'patrol_dispatched',
          patrolId,
          from: result.patrol.basedAt,
          target: e.detail.hex,
        });
      }
    }

    // Resolve any pending battles.
    for (const pb of result.pendingBattles) {
      if (pb.with.kind !== 'bandit_camp') continue;
      const camp = world.banditCamps.get(pb.with.campId);
      if (camp === undefined) continue; // already destroyed earlier this tick

      const battle = resolveBattle(result.patrol.unit, pb.defenderUnit, {
        ambush: false,
        rng: subRng.derive(`battle-${pb.with.campId}`),
      });

      // Determine outcome category.
      let outcome: 'patrol_won' | 'bandits_won' | 'mutual_rout';
      if (battle.winnerId === result.patrol.unit.id) outcome = 'patrol_won';
      else if (battle.winnerId === pb.defenderUnit.id) outcome = 'bandits_won';
      else outcome = 'mutual_rout';

      events.push({
        type: 'patrol_engaged',
        patrolId,
        camp: pb.with.campId,
        outcome,
      });
      events.push({
        type: 'patrol_dispatched',
        patrolId,
        from: result.patrol.basedAt,
        target: camp.hex,
      });

      // Apply casualties. Patrol unit count is mutated inside Patrol.
      const patrolCas = battle.casualties.find((c) => c.unitId === result.patrol.unit.id);
      const campCas = battle.casualties.find((c) => c.unitId === pb.defenderUnit.id);
      const patrolDeaths = patrolCas?.deaths ?? 0;
      const campDeaths = campCas?.deaths ?? 0;

      // Update patrol unit (in place since `result.patrol` is the live one).
      const survivingPatrol = Math.max(0, result.patrol.unit.count - patrolDeaths);
      result.patrol.unit = { ...result.patrol.unit, count: survivingPatrol };
      if (survivingPatrol <= 0) {
        world.patrols.delete(patrolId);
      } else {
        world.patrols.set(patrolId, result.patrol);
      }

      // Update camp.
      const survivingCamp = Math.max(0, camp.banditCount - campDeaths);
      if (survivingCamp <= 0) {
        world.banditCamps.delete(pb.with.campId);
      } else {
        world.banditCamps.set(pb.with.campId, { ...camp, banditCount: survivingCamp });
      }

      // Emit news carriers — for patrol vs camp, the WITNESSES who carry
      // news are the survivors who flee back to civilization.
      // - patrol-side fled_escaped → tell the patrol's settlement
      // - camp-side fled_escaped → tell other bandits / sympathetic
      //   villages (we approximate by routing to nearest settlement)
      const patrolSettlement = world.settlements.get(result.patrol.basedAt);
      if (patrolSettlement !== undefined) {
        spawnNewsFromPatrolBattle(
          world,
          today,
          patrolId,
          camp,
          battle.survivors,
          patrolSettlement,
          outcome,
          events,
        );
      }
    }
  }
};

const spawnNewsFromPatrolBattle = (
  world: WorldState,
  today: Day,
  patrolId: string,
  camp: BanditCamp,
  survivors: ReturnType<typeof resolveBattle>['survivors'],
  patrolHome: Settlement,
  outcome: 'patrol_won' | 'bandits_won' | 'mutual_rout',
  events: TickEvent[],
): void => {
  if (world.newsCarriers === undefined) return;

  // Patrol-side fled_escaped → news of the engagement reaches patrolHome.
  let patrolFled = 0;
  for (const s of survivors) {
    if (s.unitId.startsWith('patrol:') && s.fate === 'fled_escaped') patrolFled += s.count;
  }
  // If patrol won and is alive, count is implicitly > 0; we still want news
  // home. So spawn one carrier from the patrol position to home if outcome
  // is patrol_won OR there are explicit fled_escaped.
  const wantPatrolNews = outcome === 'patrol_won' || patrolFled > 0;
  if (wantPatrolNews) {
    const id = `news-${today}-patrol-${patrolId}-${String(camp.id)}`;
    if (!world.newsCarriers.has(id)) {
      const magnitude: ReputationMagnitude =
        outcome === 'patrol_won' ? 'severe' : 'moderate';
      const news = createNewsItem({
        id,
        perpetrator: camp.ownerActor as ReputationKey,
        victim: null,
        magnitude,
        isCriminalAct: true,
        occurredAtHex: camp.hex,
        occurredOnDay: today,
      });
      const carrier = createNewsCarrier({
        id,
        news,
        spawnHex: camp.hex,
        destination: patrolHome.anchor,
        spawnDay: today,
        speed: NEWS_CARRIER_SPEED,
      });
      world.newsCarriers.set(id, carrier);
      events.push({
        type: 'news_carrier_spawned',
        id,
        perpetrator: news.perpetrator,
        victim: null,
        destination: patrolHome.anchor,
        magnitude,
      });
    }
  }
};

// --- Annual hook ------------------------------------------------------------

const annualPhase = (world: WorldState, rng: Rng, today: Day, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    tickYearly(settlement.population, rng.derive(`settle-${String(settlement.id)}`));
    // Reset famine pressure each year so a one-bad-harvest year doesn't
    // permanently haunt the settlement.
    faminePressure.set(settlement, { consecutiveShortageDays: 0, lastShortageDay: -1 });
  }
  // docs/05 §"Dynamic catchment recompute": when pop has moved >25% from the
  // last baseline AND >365 days have passed, claim or release catchment hexes
  // to match the new tier+pop.
  for (const settlement of world.settlements.values()) {
    const pop = settlement.population.total();
    if (!shouldRecomputeCatchment(settlement, pop, today + 1)) continue;
    const owner = pickCatchmentOwnerForSettlement(world, settlement);
    const result = recomputeCatchment({
      settlement,
      currentPop: pop,
      today: today + 1,
      grid: world.grid,
      ownerActorForClaimed: owner,
      otherSettlements: world.settlements.values(),
    });
    if (result.resized) {
      events.push({
        type: 'catchment_resized',
        settlement: settlement.id,
        oldRadius: result.oldRadius,
        newRadius: result.newRadius,
        claimed: result.claimed.length,
        released: result.released.length,
      });
    }
  }
};

/**
 * Pick the actor that should own newly-claimed catchment hexes for `settlement`.
 *
 * Mirrors the procgen ownership rules (see seed.ts Phase 7): for cities/towns
 * we prefer the city corporation, falling back to the first stockpile owner;
 * for villages/hamlets we use the first stockpile owner. Returns null only if
 * the settlement has no actors at all (defensive).
 */
const pickCatchmentOwnerForSettlement = (
  world: WorldState,
  settlement: Settlement,
): ActorId | null => {
  for (const a of world.actors.values()) {
    if (a.kind === 'city_corporation' && a.homeSettlement === settlement.id) {
      return a.id;
    }
  }
  if (settlement.stockpileOwners.length > 0) {
    return settlement.stockpileOwners[0] ?? null;
  }
  return null;
};
