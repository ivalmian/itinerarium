/**
 * Per-day tick loop — the integration capstone.
 *
 * Runs the six locked sub-phases from docs/01-simulation-frame.md in fixed
 * order, mutating the WorldState in place and accumulating diagnostic
 * TickEvents:
 *
 *   1. Production   — every settlement runs its recipes; outputs land in
 *                     building-owner stockpiles.
 *   2. Production cleanup — construction/demolition apply after recipes.
 *   3. Movement     — caravans (T22/T23) advance; news carriers (T18) walk.
 *   4. Trade        — every settlement clears one local market per resource
 *                     using subsistence/comfort/status demand against
 *                     owner-stockpile supply (T12/T13/T14). Trades update
 *                     coin and stockpile balances.
 *      Consumption  — market-cleared subsistence purchases plus fallback
 *                     non-grain ration stockpiles determine famine pressure.
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

import { allBuildings, getBuilding } from './buildings/catalog.js';
import { tickCaravanMovement } from './caravan/movement.js';
import { planCaravanRoute } from './caravan/ai.js';
import { createCamp, decideCampAction, recruit, type BanditCamp } from './bandit/camp.js';
import { createActor } from './politics/actor.js';
import { createCharacter, generateFullName } from './politics/character.js';
import { createFaction } from './politics/faction.js';
import {
  buildGuildByMember,
  depositObservation,
  mergeLedgerInto,
  type Guild,
} from './politics/guild.js';
import { isGoalComplete, peekGoal, popGoal, type Goal } from './caravan/goal.js';
import { actorId, banditCampId as makeBanditCampId, characterId, factionId } from './types.js';
import { resolveAmbush, type AmbushResult } from './conflict/ambush.js';
import { tickEdgeHubs, DEFAULT_GLOBAL_PRICES, DEFAULT_IMPORT_PALETTE } from './caravan/edgeHub.js';
import {
  assessTaxes,
  createTaxShipmentCaravan,
  isHarvestTributeDay,
  isMonthlyAssessmentDay,
  type SettlementTaxView,
  type TaxAssessment,
  type TaxRatesPercent,
} from './politics/taxShipment.js';
import { caravanId as makeCaravanIdLocal } from './types.js';
import { resolveBattle } from './conflict/battle.js';
import { tickPatrol, type Patrol } from './conflict/patrol.js';
import { resolveRaid, type WallLevel } from './conflict/raid.js';
import {
  dailyCrewRationKg,
  totalCrewCount,
  totalCarryKg,
  totalCargoWeightKg,
  type Caravan,
} from './caravan/caravan.js';
import { createNewsItem, createNewsCarrier } from './reputation/news.js';
import { tickCarrierWithGrid } from './reputation/newsMovement.js';
import { processNewsArrival } from './reputation/newsArrival.js';
import type { NamedCharacter } from './politics/character.js';
import type { ReputationMagnitude } from './reputation/table.js';
import { clearMarket } from './market/clear.js';
import {
  buildSettlementSchedules,
  institutionalProcurementResourcesForBuilding,
  laborCostPerWorkerDay,
} from './market/scheduleBuilder.js';
import {
  applyEndemicMortality,
  maybeTriggerEpidemic,
  tickInfection,
  createSettlementHealth,
  type SettlementHealth,
} from './population/disease.js';
import { tickDaily, tickYearly, ROMAN_VITAL_RATES } from './population/vitalRates.js';
import { runRecipe, type RecipeRunResult } from './production/engine.js';
import { recipesByOutput, type RecipeDef } from './production/recipes.js';
import { allRecipes } from './production/recipes.js';
// News-carrier ticking is handled by docs/13's tickCarrier; the world doesn't
// yet hold a Map for them so the orchestration call sits with the news
// subsystem until that storage lands.
import type { Rng } from './rng.js';
import {
  addBuilding,
  computeStorageCapacity,
  recomputeCatchment,
  recordClearingPrice,
  recordInflow,
  recordOutflow,
  removeBuilding,
  shouldRecomputeCatchment,
  type PendingBuilding,
  type PendingDemolition,
  type Settlement,
  type SettlementBuilding,
} from './world/settlement.js';
import { dayOfYearToSeason, isPassable, type Season } from './world/terrain.js';
import {
  HEX_DIRECTIONS,
  hexAdd,
  hexDistance,
  hexEquals,
  hexKey,
  hexesWithinRange,
  type Hex,
} from './world/hex.js';
import {
  jobId,
  buildingId,
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
import {
  allocatedWorkersForJob,
  buildLaborClassContext,
  isWageEarningLaborClass,
  ownerCanUseLaborClass,
  type LaborClassContext,
  wageEarningWorkerDaysForLaborForOwner,
} from './jobs/laborEconomics.js';
import type { CharacterClass } from './population/types.js';
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
      readonly type: 'caravan_disbanded';
      readonly caravan: CaravanId;
      readonly at: Hex;
      readonly reason: 'zero_health' | 'zero_crew' | 'idle_too_long';
    }
  | {
      readonly type: 'market_cleared';
      readonly settlement: SettlementId;
      readonly resource: ResourceId;
      readonly price: number;
      readonly volume: number;
    }
  | {
      readonly type: 'market_shortage';
      readonly settlement: SettlementId;
      readonly resource: ResourceId;
      readonly price: number;
      readonly unmetDemand: number;
    }
  | {
      readonly type: 'caravan_traded';
      readonly caravan: CaravanId;
      readonly settlement: SettlementId;
      readonly side: 'bought' | 'sold';
      readonly resource: ResourceId;
      readonly quantity: number;
      readonly coin: number;
    }
  | {
      readonly type: 'caravan_exported_off_map';
      readonly caravan: CaravanId;
      readonly resource: ResourceId;
      readonly quantity: number;
      readonly coin: number;
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
      readonly type: 'settlement_abandoned';
      readonly settlement: SettlementId;
    }
  | {
      readonly type: 'storage_spoilage';
      readonly settlement: SettlementId;
      readonly resource: ResourceId;
      readonly spoiled: number;
    }
  | {
      readonly type: 'riot';
      readonly settlement: SettlementId;
      readonly trigger: ResourceId;
      readonly priceMultipleOfBaseline: number;
    }
  | {
      readonly type: 'edict_issued';
      readonly settlement: SettlementId;
      readonly resource: ResourceId;
      readonly priceCap: number;
    }
  | {
      readonly type: 'mob_looting';
      readonly settlement: SettlementId;
      readonly resource: ResourceId;
      readonly fromActor: ActorId;
      readonly looted: number;
    }
  | {
      readonly type: 'edge_hub_spawned';
      readonly newCaravans: number;
    }
  | {
      readonly type: 'tax_shipment_dispatched';
      readonly fromSettlement: SettlementId;
      readonly toSettlement: SettlementId;
      readonly grainModii: number;
      readonly coin: number;
    }
  | {
      readonly type: 'road_upgraded';
      readonly hex: Hex;
      readonly toGrade: 'dirt';
    }
  | {
      readonly type: 'road_unmaintained';
      readonly hex: Hex;
    }
  | {
      readonly type: 'road_downgraded';
      readonly hex: Hex;
      readonly fromGrade: 'dirt';
    }
  | {
      readonly type: 'road_reset';
      readonly promotedToDirt: number;
      readonly demotedToNone: number;
      readonly romanKept: number;
    }
  | {
      readonly type: 'building_invested';
      readonly settlement: SettlementId;
      readonly building: BuildingId;
      readonly ownerActor: ActorId;
      readonly costCoin: number;
    }
  | {
      readonly type: 'building_completed';
      readonly settlement: SettlementId;
      readonly building: BuildingId;
      readonly ownerActor: ActorId;
      readonly daysToBuild: number;
    }
  | {
      readonly type: 'building_demolished';
      readonly settlement: SettlementId;
      readonly building: BuildingId;
      readonly ownerActor: ActorId;
    }
  | {
      readonly type: 'workers_reallocated';
      readonly settlement: SettlementId;
      readonly fromJob: JobId;
      readonly toJob: JobId;
      readonly count: number;
    }
  | {
      readonly type: 'local_trade';
      readonly fromSettlement: SettlementId;
      readonly toSettlement: SettlementId;
      readonly resource: ResourceId;
      readonly quantity: number;
      readonly coinPaid: number;
    };

export interface TickResult {
  readonly world: WorldState;
  readonly events: readonly TickEvent[];
  readonly stats: TickStats;
}

export interface TickStats {
  recipeRuns: number;
  marketsCleared: number;
  famineDeaths: number;
  diseaseDeaths: number;
  baselineDeaths: number;
  epidemicsTriggered: number;
}

/** One-day reputation half-life: 90 days. Tunable per docs/13. */
const REPUTATION_HALF_LIFE_DAYS = 90;

const YEAR_DAYS = 365;

const SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY = 0.4; // docs/04
const KG_PER_MODIUS = 6.7; // resources/catalog.ts food.grain unit

/**
 * Public entry point. Mutates world in place and returns a structured
 * result. The world reference and all top-level Maps are preserved (we never
 * replace them) so callers can hold stable references across ticks.
 */
export const tick = (inputs: TickInputs): TickResult => {
  const { world, rng } = inputs;
  const events: TickEvent[] = [];
  const stats: TickStats = {
    recipeRuns: 0,
    marketsCleared: 0,
    famineDeaths: 0,
    diseaseDeaths: 0,
    baselineDeaths: 0,
    epidemicsTriggered: 0,
  };
  const today: Day = world.day;
  const season: Season = dayOfYearToSeason(today);

  // Refresh the per-tick id→Settlement lookup used by subsystems (e.g. the
  // worker-reallocation phase) to resolve a settlement reference from a
  // recipe_blocked event without re-walking world.settlements.
  settlementsById = world.settlements;

  // --- Phase 1: Production -------------------------------------------------
  productionPhase(world, season, events, stats);
  // After production, drain mason+carpenter worker-days toward each
  // settlement's pendingBuildings. Per docs/15 §C8 — construction takes
  // real time and labor; new buildings don't appear instantly.
  constructionPhase(world, today, events);
  // Demolition phase: buildings on released catchment hexes get torn
  // down over time, refunding ~50% of materials to the owner. Per
  // docs/15 §C8 demolition.
  demolitionPhase(world, today, events);

  // --- Phase 3: Movement ---------------------------------------------------
  movementPhase(world, season, today, events);

  // --- Phase 4: Trade ------------------------------------------------------
  const subsistenceAccess = initializeSubsistenceAccess(world);
  tradePhase(world, season, today, events, stats, subsistenceAccess);
  // After every settlement clears its market, run the petty-merchant /
  // villager-pickup-cart pass that arbitrages price spreads between
  // settlements within 3 hexes (docs/06 §"Local trade between nearby
  // settlements", docs/08 §"Per-settlement markets, regional smoothing").
  // This is what keeps ~8000 separate markets aligned into a regional
  // price gradient instead of 8000 disconnected wells.
  localTradePhase(world, season, today, events);

  // --- Phase 4b: Consumption / famine pressure -----------------------------
  consumptionPhase(world, today, events, stats, subsistenceAccess);

  // --- Phase 5: Demographics ----------------------------------------------
  demographicsPhase(world, today, rng.derive('demographics'), events, stats);

  // --- Phase 6: Politics ---------------------------------------------------
  politicsPhase(world, rng.derive('politics'), today, events);

  // --- Edge-hub off-map trade ---------------------------------------------
  // Per docs/06 §"Edge-hub caravans" + docs/08 §"off-map global market":
  // exotic imports + high-value exports cross the map border via real
  // Caravan instances spawned at edge hexes. Without this call,
  // off-map trade only fires in standalone tests.
  edgeHubPhase(world, season, today, rng.derive('edge-hub'), events);

  // --- Merchant guild cross-guild rumor (docs/15 §C17) -------------------
  // Co-located caravans of different guilds exchange ledger slices.
  crossGuildRumorPhase(world, today);

  // --- Civil unrest cascade (docs/15 §C16) -------------------------------
  // Sustained grain-price spikes trigger: riot → governor edict (price
  // cap + forced patrician sales) → mob looting (if cap fails). Self-
  // regulates because each step relaxes the underlying constraint.
  civilUnrestPhase(world, today, events);

  // --- Storage spoilage (docs/15 §C10) ----------------------------------
  // Stockpiles above the settlement's storage capacity rot at a gentle
  // rate (1%/day above cap) instead of being force-sold. Avoids the
  // cascading inflation bug from the prior C10 attempt.
  storageSpoilagePhase(world, events);

  // --- Trail wear decay + threshold check ---------------------------------
  // Daily decay: -1 wear per hex; on threshold, upgrade 'none' → 'dirt';
  // sustained low wear demotes 'dirt' → 'none'. Roman roads exempt.
  // Per docs/06 §"Trail wear → emergent dirt roads".
  trailWearTickPhase(world, events);

  // --- Roman road maintenance (docs/15 §C11) -----------------------------
  // Quarterly: governor pays per-Roman-hex maintenance from treasury.
  // If they can't pay, the hex's romanQuartersUnmaintained counter
  // increments; after 4 missed quarters the hex downgrades to 'dirt'
  // and starts accruing/decaying wear like any other dirt road.
  if ((today + 1) % 91 === 0) {
    roadMaintenancePhase(world, events);
  }

  // --- Day-1825 road reset (one-time) ------------------------------------
  // Per docs/07 §"Phase 2 — Stabilization" + docs/14 §"Year-5 road reset":
  // promote heavily-worn trails, demote unused dirt roads, reset wear.
  // The reset day is open-coded so it's identical across worlds.
  if (today === ROAD_RESET_DAY) {
    roadResetPhase(world, events);
  }

  // --- Empty settlements disappear (docs/05 §"Growth and decay") ----------
  // When pop hits 0, remove the settlement immediately (don't wait for the
  // year boundary). Catchment hexes return to wilderness; urban hexes
  // become `ruin`. Buildings vanish with the settlement object; stockpile
  // actors survive on world.actors.
  abandonmentPhase(world, today, events);

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

  return { world, events, stats };
};

// --- Phase 1: Production ----------------------------------------------------

/**
 * Per-settlement production: for every recipe that has a building present in
 * the settlement, attempt to run it. Outputs land in the building owner's
 * stockpile; inputs are drained from there too. Labor availability comes
 * from per-job/per-class labor pools derived from settlement job allocations.
 * Successful runs transfer a local subsistence-basket wage for the actual
 * free/paid worker-days consumed by that owner to a household/civic worker
 * actor. Enslaved worker-days are real labor but do not receive cash wages.
 *
 * Phase ordering: recipes are processed in topological order (raw inputs →
 * refined → manufactured) so a bake_bread call in the same tick can see the
 * flour produced by a mill_grain earlier in the same phase.
 */
const productionPhase = (
  world: WorldState,
  season: Season,
  events: TickEvent[],
  stats: TickStats,
): void => {
  const productionPasses = 2;
  for (const settlement of world.settlements.values()) {
    const laborClassContext = buildLaborClassContext(settlement);
    const laborPools = laborPoolsForSettlement(settlement, laborClassContext);
    const buildingsById = buildingsByKindForSettlement(settlement);
    const wagePriceSignal = wagePriceSignalForSettlement(settlement);
    const recipesForToday = productionOrderForSettlement(settlement, season);
    for (let pass = 0; pass < productionPasses; pass++) {
      const finalPass = pass === productionPasses - 1;
      for (const recipe of recipesForToday) {
        const buildings = buildingsById.get(recipe.building);
        if (buildings === undefined) continue;
        for (const b of buildings) {
          const ownerActor = world.actors.get(b.ownerActor);
          if (ownerActor === undefined) continue;
          if (b.capacity <= 0) continue;
          const laborForOwner = laborAvailableFromPoolsForOwner(laborPools, ownerActor.kind);
          const wageAffordableCapacity = wageAffordableCapacityForRecipe(
            world,
            settlement,
            recipe,
            laborClassContext,
            ownerActor,
            wagePriceSignal,
          );
          if (wageAffordableCapacity <= 0) {
            if (finalPass) {
              events.push({
                type: 'recipe_blocked',
                settlement: settlement.id,
                recipe: recipe.id,
                reason: 'cash',
              });
            }
            continue;
          }
          const result: RecipeRunResult = runRecipe({
            recipe,
            building: {
              id: b.buildingId,
              capacityRemaining: Math.min(b.capacity, wageAffordableCapacity),
            },
            ownerActor: b.ownerActor,
            laborAvailable: laborForOwner,
            inputStocks: ownerActor.stockpile,
            season,
          });
          if (result.shortfall !== undefined && result.ranAtFraction === 0) {
            if (finalPass) {
              events.push({
                type: 'recipe_blocked',
                settlement: settlement.id,
                recipe: recipe.id,
                reason: result.shortfall.reason,
              });
            }
            continue;
          }
          if (result.ranAtFraction > 0) {
            // Apply the deltas to the owner's stockpile.
            for (const [resId, qty] of result.inputsConsumed) {
              decreaseStockpile(ownerActor, resId, qty);
            }
            for (const [resId, qty] of result.outputsProduced) {
              if (isServiceResource(resId)) continue;
              increaseStockpile(ownerActor, resId, qty);
              recordInflow(settlement, resId, qty);
            }
            // Decrement the labor pool we estimated locally so subsequent
            // recipes in this phase don't double-count workers.
            const paidWorkerDays = consumeLaborFromPoolsForOwner(
              laborPools,
              result.laborUsed,
              ownerActor.kind,
            );
            payProductionWagesForWorkerDays(
              world,
              settlement,
              ownerActor,
              paidWorkerDays,
              wagePriceSignal,
            );
            // Decrement building capacity for the day.
            b.capacity = Math.max(0, b.capacity - result.buildingCapacityUsed);
            stats.recipeRuns += 1;
            events.push({
              type: 'recipe_ran',
              settlement: settlement.id,
              recipe: recipe.id,
              fraction: result.ranAtFraction,
            });
          }
        }
      }
    }
    // Reset building capacity for tomorrow. Starter and completed buildings
    // keep their own installed capacity; the catalog default is only the
    // legacy fallback for older snapshots/tests.
    for (const b of settlement.buildings) {
      b.capacity = maxCapacityForBuilding(b);
    }
  }
};

const WAGE_RECIPIENT_KIND_PRIORITY: readonly Actor['kind'][] = [
  'common_household',
  'hamlet_household',
  'free_village',
  'city_corporation',
  'patrician_family',
  'governor_office',
  'player',
];

const wagePriceSignalForSettlement = (settlement: Settlement): ReadonlyMap<ResourceId, number> => {
  const prices = new Map<ResourceId, number>();
  for (const [resource, price] of settlement.market.lastClearingPrice) {
    if (Number.isFinite(price) && price > 0) prices.set(resource, price);
  }
  for (const [resource, price] of DEFAULT_GLOBAL_PRICES) {
    if (!prices.has(resource) && Number.isFinite(price) && price > 0) prices.set(resource, price);
  }
  return prices;
};

const selectWageRecipient = (
  world: WorldState,
  settlement: Settlement,
  payer: Actor,
): Actor | undefined => {
  const candidates = settlement.stockpileOwners
    .map((id) => world.actors.get(id))
    .filter((a): a is Actor => a !== undefined);
  for (const kind of WAGE_RECIPIENT_KIND_PRIORITY) {
    const found = candidates.find((a) => a.kind === kind && a.id !== payer.id);
    if (found !== undefined) return found;
  }
  return candidates.find((a) => a.id === payer.id);
};

const wageAffordableCapacityForRecipe = (
  world: WorldState,
  settlement: Settlement,
  recipe: RecipeDef,
  laborClassContext: LaborClassContext,
  payer: Actor,
  prices: ReadonlyMap<ResourceId, number>,
): number => {
  const wagePerDay = laborCostPerWorkerDay(prices);
  if (wagePerDay <= 0) return Infinity;
  const paidWorkerDaysPerRun = wageEarningWorkerDaysForLaborForOwner(
    laborClassContext,
    recipe.labor,
    payer.kind,
  );
  if (paidWorkerDaysPerRun <= 0) return Infinity;
  const recipient = selectWageRecipient(world, settlement, payer);
  if (recipient === undefined || recipient.id === payer.id) return Infinity;
  const liquidBudget = payer.treasury + inKindWageBudget(payer, prices);
  return Math.max(0, liquidBudget / (paidWorkerDaysPerRun * wagePerDay));
};

const payProductionWages = (
  world: WorldState,
  settlement: Settlement,
  laborClassContext: LaborClassContext,
  payer: Actor,
  laborUsed: ReadonlyMap<JobId, number>,
  prices: ReadonlyMap<ResourceId, number>,
): void => {
  const workerDays = wageEarningWorkerDaysForLaborForOwner(
    laborClassContext,
    laborUsed,
    payer.kind,
  );
  payProductionWagesForWorkerDays(world, settlement, payer, workerDays, prices);
};

const payProductionWagesForWorkerDays = (
  world: WorldState,
  settlement: Settlement,
  payer: Actor,
  workerDays: number,
  prices: ReadonlyMap<ResourceId, number>,
): void => {
  if (workerDays <= 0) return;
  const wagePerDay = laborCostPerWorkerDay(prices);
  if (wagePerDay <= 0) return;
  const recipient = selectWageRecipient(world, settlement, payer);
  if (recipient === undefined || recipient.id === payer.id) return;
  const wageBill = workerDays * wagePerDay;
  let remaining = wageBill;
  const paidCoin = Math.min(remaining, payer.treasury);
  if (paidCoin > 0) {
    payer.treasury -= paidCoin;
    recipient.treasury += paidCoin;
    remaining -= paidCoin;
  }
  if (remaining > 1e-9) payInKindWages(payer, recipient, remaining, prices);
};

const WAGE_IN_KIND_RESOURCES: readonly ResourceId[] = [
  resourceId('food.grain'),
  resourceId('food.flour'),
  resourceId('food.bread'),
];

const inKindWageBudget = (payer: Actor, prices: ReadonlyMap<ResourceId, number>): number => {
  let value = 0;
  for (const resource of WAGE_IN_KIND_RESOURCES) {
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    value += (payer.stockpile.get(resource) ?? 0) * price;
  }
  return value;
};

const payInKindWages = (
  payer: Actor,
  recipient: Actor,
  targetValue: number,
  prices: ReadonlyMap<ResourceId, number>,
): void => {
  let remainingValue = targetValue;
  for (const resource of WAGE_IN_KIND_RESOURCES) {
    if (remainingValue <= 1e-9) break;
    const price = prices.get(resource) ?? 0;
    if (price <= 0) continue;
    const stock = payer.stockpile.get(resource) ?? 0;
    if (stock <= 0) continue;
    const units = Math.min(stock, remainingValue / price);
    if (units <= 1e-9) continue;
    decreaseStockpile(payer, resource, units);
    increaseStockpile(recipient, resource, units);
    remainingValue -= units * price;
  }
};

const buildingsByKindForSettlement = (
  settlement: Settlement,
): ReadonlyMap<BuildingId, readonly Settlement['buildings'][number][]> => {
  const cached = buildingsByKindCache.get(settlement);
  if (cached !== undefined && cached.buildingCount === settlement.buildings.length) {
    return cached.byKind;
  }
  const out = new Map<BuildingId, Settlement['buildings'][number][]>();
  for (const b of settlement.buildings) {
    let bucket = out.get(b.buildingId);
    if (bucket === undefined) {
      bucket = [];
      out.set(b.buildingId, bucket);
    }
    bucket.push(b);
  }
  buildingsByKindCache.set(settlement, { buildingCount: settlement.buildings.length, byKind: out });
  return out;
};

const buildingsByKindCache: WeakMap<
  Settlement,
  {
    readonly buildingCount: number;
    readonly byKind: ReadonlyMap<BuildingId, readonly Settlement['buildings'][number][]>;
  }
> = new WeakMap();

type LaborClassPools = Map<JobId, Map<CharacterClass, number>>;

const laborPoolsForSettlement = (
  settlement: Settlement,
  laborClassContext: LaborClassContext,
): LaborClassPools => {
  const out: LaborClassPools = new Map();

  if (laborClassContext.workersByJobAndClass.size > 0) {
    for (const [job, byClass] of laborClassContext.workersByJobAndClass) {
      const copy = new Map<CharacterClass, number>();
      for (const [klass, count] of byClass) {
        if (count > 0) copy.set(klass, count);
      }
      if (copy.size > 0) out.set(job, copy);
    }
    return out;
  }

  if (settlement.jobAllocations.size > 0) {
    // Legacy/unit fixtures can have job allocations without a population
    // pyramid. Preserve the old "paid workers exist" behavior by treating
    // those allocation-only workers as plebeian labor.
    for (const [job, count] of settlement.jobAllocations) {
      if (count > 0) out.set(job, new Map([['plebeian' as CharacterClass, count]]));
    }
    return out;
  }

  const adults = settlement.population.totalAdults();
  if (adults <= 0) return out;
  for (const recipe of allRecipes()) {
    for (const role of recipe.labor.keys()) {
      out.set(role, new Map([['plebeian' as CharacterClass, adults]]));
    }
  }
  return out;
};

const laborAvailableFromPoolsForOwner = (
  pools: LaborClassPools,
  ownerKind: Actor['kind'],
): Map<JobId, number> => {
  const out = new Map<JobId, number>();
  for (const [job, byClass] of pools) {
    let total = 0;
    for (const [klass, count] of byClass) {
      if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
      total += count;
    }
    if (total > 0) out.set(job, total);
  }
  return out;
};

const LABOR_CONSUMPTION_CLASS_ORDER: readonly CharacterClass[] = [
  'slave',
  'plebeian',
  'freedman',
  'foreigner',
  'patrician',
];

const consumeLaborFromPoolsForOwner = (
  pools: LaborClassPools,
  laborUsed: ReadonlyMap<JobId, number>,
  ownerKind: Actor['kind'],
): number => {
  let paidWorkerDays = 0;
  for (const [job, required] of laborUsed) {
    let remaining = required;
    if (remaining <= 0) continue;
    const byClass = pools.get(job);
    if (byClass === undefined) continue;
    for (const klass of LABOR_CONSUMPTION_CLASS_ORDER) {
      if (remaining <= 1e-9) break;
      if (!ownerCanUseLaborClass(klass, ownerKind)) continue;
      const available = byClass.get(klass) ?? 0;
      if (available <= 0) continue;
      const used = Math.min(available, remaining);
      const next = available - used;
      if (next > 1e-9) byClass.set(klass, next);
      else byClass.delete(klass);
      if (isWageEarningLaborClass(klass)) paidWorkerDays += used;
      remaining -= used;
    }
  }
  return paidWorkerDays;
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

const RECIPES_IN_TOPO_ORDER = topoSortedRecipes();
const RECIPE_TOPO_INDEX: ReadonlyMap<RecipeId, number> = (() => {
  const m = new Map<RecipeId, number>();
  RECIPES_IN_TOPO_ORDER.forEach((recipe, index) => m.set(recipe.id, index));
  return m;
})();

const recipeSeasonalMultiplier = (recipe: RecipeDef, season: Season): number => {
  if (recipe.seasonalMultiplier === undefined) return 1;
  return recipe.seasonalMultiplier[season] ?? 0;
};

const productionSignalPrice = (settlement: Settlement, resource: ResourceId): number => {
  const local = settlement.market.lastClearingPrice.get(resource);
  if (local !== undefined && Number.isFinite(local) && local > 0) return local;
  const global = DEFAULT_GLOBAL_PRICES.get(resource);
  if (global !== undefined && Number.isFinite(global) && global > 0) return global;
  return 0;
};

const resourceMapValue = (
  settlement: Settlement,
  resources: ReadonlyMap<ResourceId, number>,
): number => {
  let total = 0;
  for (const [resource, qty] of resources) {
    if (qty <= 0) continue;
    total += qty * productionSignalPrice(settlement, resource);
  }
  return total;
};

const laborDaysForRecipe = (recipe: RecipeDef): number => {
  let total = 0;
  for (const qty of recipe.labor.values()) total += Math.max(0, qty);
  return total;
};

const productionPriority = (
  settlement: Settlement,
  recipe: RecipeDef,
  season: Season,
): number => {
  const seasonMul = recipeSeasonalMultiplier(recipe, season);
  if (seasonMul <= 0) return Number.NEGATIVE_INFINITY;
  const outputValue = resourceMapValue(settlement, recipe.outputs);
  const inputCost = resourceMapValue(settlement, recipe.inputs);
  const margin = outputValue - inputCost;
  const laborDays = Math.max(0.1, laborDaysForRecipe(recipe));
  // Producers react to observed marginal prices: high-value downstream
  // goods should get scarce labor before low-price intermediates. A small
  // gross-output term keeps extraction running early in a save before input
  // prices have formed.
  return ((margin * 2 + outputValue * 0.05) * seasonMul) / laborDays;
};

const productionOrderForSettlement = (
  settlement: Settlement,
  season: Season,
): readonly RecipeDef[] => {
  const out = [...RECIPES_IN_TOPO_ORDER];
  out.sort((a, b) => {
    const pa = productionPriority(settlement, a, season);
    const pb = productionPriority(settlement, b, season);
    if (pb !== pa) return pb - pa;
    return (RECIPE_TOPO_INDEX.get(a.id) ?? 0) - (RECIPE_TOPO_INDEX.get(b.id) ?? 0);
  });
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

const isServiceResource = (resource: ResourceId): boolean =>
  String(resource).startsWith('service.');

// Default capacity-by-id table, computed once at module load. Individual
// buildings may have a larger installed capacity, especially procgen starter
// buildings that represent many farms/workshops under one logical building.
const _capacityCache: ReadonlyMap<BuildingId, number> = (() => {
  const m = new Map<BuildingId, number>();
  for (const b of allBuildings()) m.set(b.id, b.capacityUnits);
  return m;
})();
const capacityForBuilding = (id: BuildingId): number => _capacityCache.get(id) ?? 1;

const maxCapacityForBuilding = (building: SettlementBuilding): number => {
  const installed = building.maxCapacity ?? capacityForBuilding(building.buildingId);
  return Number.isFinite(installed) ? Math.max(0, installed) : 0;
};

// --- Phase 2: Consumption ---------------------------------------------------

interface FaminePressureRecord {
  consecutiveShortageDays: number;
  lastShortageDay: Day;
}

interface SubsistenceAccessRecord {
  readonly needModii: number;
  fulfilledModii: number;
}

type SubsistenceAccessMap = Map<Settlement, SubsistenceAccessRecord>;

/**
 * Per-Settlement famine pressure. Keyed by the Settlement object reference
 * (not its id) so a fresh world built in a test starts with empty pressure
 * regardless of whether the previous test used the same string id.
 */
const faminePressure: WeakMap<Settlement, FaminePressureRecord> = new WeakMap();

const initializeSubsistenceAccess = (world: WorldState): SubsistenceAccessMap => {
  const out: SubsistenceAccessMap = new Map();
  for (const settlement of world.settlements.values()) {
    const needModii = subsistenceNeedModii(settlement);
    if (needModii <= 0) continue;
    out.set(settlement, { needModii, fulfilledModii: 0 });
  }
  return out;
};

/**
 * Each settlement resolves subsistence calories from two sources:
 *   1. food.grain bought and consumed in the local grain market; and
 *   2. non-grain ration stockpiles still held locally after markets clear.
 *
 * The grain draw lives in market clearing so subsistence has a price and a
 * concrete buyer. The fallback ration draw keeps bread/flour/legumes/etc.
 * usable as emergency food without double-consuming grain. When the combined
 * access is short of need, famine pressure accrues; sustained pressure emits
 * cohort_deaths.
 */
const consumptionPhase = (
  world: WorldState,
  today: Day,
  events: TickEvent[],
  stats: TickStats,
  accessBySettlement: SubsistenceAccessMap,
): void => {
  for (const settlement of world.settlements.values()) {
    const access = accessBySettlement.get(settlement);
    if (access === undefined || access.needModii <= 0) continue;

    // Source: any stockpileOwner in the settlement holding non-grain food.
    const owners = settlement.stockpileOwners
      .map((id) => world.actors.get(id))
      .filter((a): a is Actor => a !== undefined);
    let drawn = 0;
    const fallbackMarkets = new Map<ResourceId, FallbackRationMarket>();
    for (const o of owners) {
      const remainingNeed = access.needModii - access.fulfilledModii - drawn;
      if (remainingNeed <= 0) break;
      drawn += buyFallbackRationsFromOwner(world, settlement, o, remainingNeed, fallbackMarkets);
    }
    if (drawn > 0) {
      access.fulfilledModii += drawn;
      for (const [resource, market] of fallbackMarkets) {
        recordOutflow(settlement, resource, market.quantity);
        recordClearingPrice(settlement, resource, market.price);
        stats.marketsCleared += 1;
        events.push({
          type: 'market_cleared',
          settlement: settlement.id,
          resource,
          price: market.price,
          volume: market.quantity,
        });
      }
    }
    const shortfall = access.needModii - access.fulfilledModii;
    const rec = faminePressure.get(settlement) ?? {
      consecutiveShortageDays: 0,
      lastShortageDay: -1,
    };
    if (shortfall > 0.05 * access.needModii) {
      rec.consecutiveShortageDays =
        rec.lastShortageDay === today - 1 ? rec.consecutiveShortageDays + 1 : 1;
      rec.lastShortageDay = today;
      // After several consecutive shortage days, deaths begin.
      if (rec.consecutiveShortageDays >= 5) {
        const deaths = computeFamineDeaths(settlement, shortfall / Math.max(1, access.needModii));
        if (deaths > 0) {
          stats.famineDeaths += deaths;
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

const subsistenceNeedModii = (settlement: Settlement): number => {
  const { adults, children, elders } = populationAgeBuckets(settlement);
  // Children consume ~0.5×, elders ~0.8× per docs/04.
  const adultEquivalent = adults + children * 0.5 + elders * 0.8;
  if (adultEquivalent <= 0) return 0;
  const grainNeededKg = adultEquivalent * SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY;
  return grainNeededKg / KG_PER_MODIUS;
};

const populationAgeBuckets = (
  s: Settlement,
): { readonly adults: number; readonly children: number; readonly elders: number } => {
  return {
    adults: s.population.totalAdults(),
    children: s.population.totalChildren(),
    elders: s.population.totalElders(),
  };
};

const adultPopulation = (s: Settlement): number => s.population.totalAdults();
const GRAIN_RESOURCE = resourceId('food.grain');
const FOOD_PRIORITY: readonly ResourceId[] = [
  resourceId('food.bread'),
  resourceId('food.flour'),
  GRAIN_RESOURCE,
  resourceId('food.legumes'),
  resourceId('food.cheese'),
  resourceId('food.salted_meat'),
  resourceId('food.salted_fish'),
];
const NON_GRAIN_FOOD_PRIORITY: readonly ResourceId[] = FOOD_PRIORITY.filter(
  (r) => String(r) !== String(GRAIN_RESOURCE),
);

/**
 * Fallback ration purchases cover edible non-grain stock that did not clear
 * in the main market. This keeps flour/bread/legumes usable during shortages
 * without making them free: a local household/civic/estate actor buys the
 * ration, consumes it immediately, and the seller receives coin unless the
 * same actor owns the ration stock.
 */
interface FallbackRationMarket {
  quantity: number;
  price: number;
}

const buyFallbackRationsFromOwner = (
  world: WorldState,
  settlement: Settlement,
  seller: Actor,
  wantModii: number,
  fallbackMarkets: Map<ResourceId, FallbackRationMarket>,
): number => {
  if (wantModii <= 0) return 0;
  let remaining = wantModii;
  for (const id of NON_GRAIN_FOOD_PRIORITY) {
    if (remaining <= 0) break;
    const have = seller.stockpile.get(id) ?? 0;
    if (have <= 0) continue;
    // Convert each food line to grain-equivalent modii using its kg weight.
    const grainEqPerUnit = grainEquivalentModiiPerUnit(id);
    const haveAsModii = have * grainEqPerUnit;
    let takeAsModii = Math.min(haveAsModii, remaining);
    let takeUnits = takeAsModii / Math.max(1e-9, grainEqPerUnit);
    const price = fallbackRationUnitPrice(settlement, id);
    const buyers = fallbackRationBuyers(world, settlement, seller);
    if (buyers.length === 0) continue;

    let unitsRemainingForThisResource = takeUnits;
    let unitsConsumed = 0;
    let modiiConsumed = 0;
    for (const buyer of buyers) {
      if (unitsRemainingForThisResource <= 1e-9) break;
      const buyerPaysSeller = buyer.id !== seller.id;
      const maxByTreasury =
        buyerPaysSeller && price > 0 ? buyer.treasury / price : unitsRemainingForThisResource;
      const buyerUnits = Math.min(unitsRemainingForThisResource, maxByTreasury);
      if (buyerUnits <= 1e-9) continue;
      if (buyerPaysSeller) {
        const coin = buyerUnits * price;
        if (coin > 0) {
          buyer.treasury -= coin;
          seller.treasury += coin;
        }
      }
      unitsConsumed += buyerUnits;
      modiiConsumed += buyerUnits * grainEqPerUnit;
      unitsRemainingForThisResource -= buyerUnits;
    }
    if (unitsConsumed <= 1e-9) continue;

    takeUnits = unitsConsumed;
    takeAsModii = modiiConsumed;
    decreaseStockpile(seller, id, takeUnits);
    const prev = fallbackMarkets.get(id);
    if (prev === undefined) {
      fallbackMarkets.set(id, { quantity: takeUnits, price });
    } else {
      prev.quantity += takeUnits;
      prev.price = price;
    }
    remaining -= takeAsModii;
  }
  return wantModii - Math.max(0, remaining);
};

const FALLBACK_RATION_BUYER_KIND_PRIORITY: readonly Actor['kind'][] = [
  'common_household',
  'hamlet_household',
  'free_village',
  'city_corporation',
  'patrician_family',
  'governor_office',
  'player',
];

const fallbackRationBuyers = (
  world: WorldState,
  settlement: Settlement,
  seller: Actor,
): readonly Actor[] => {
  const candidates = settlement.stockpileOwners
    .map((id) => world.actors.get(id))
    .filter((a): a is Actor => a !== undefined);
  const out: Actor[] = [];
  for (const kind of FALLBACK_RATION_BUYER_KIND_PRIORITY) {
    for (const buyer of candidates) {
      if (buyer.kind !== kind || buyer.id === seller.id) continue;
      if (!out.some((a) => a.id === buyer.id)) out.push(buyer);
    }
  }
  if (candidates.some((a) => a.id === seller.id)) {
    out.push(seller);
  } else {
    const fallback = candidates[0];
    if (fallback !== undefined && !out.some((a) => a.id === fallback.id)) out.push(fallback);
  }
  return out;
};

const fallbackRationUnitPrice = (settlement: Settlement, resource: ResourceId): number => {
  const local = settlement.market.lastClearingPrice.get(resource);
  if (local !== undefined && Number.isFinite(local) && local > 0) return local;
  const global = DEFAULT_GLOBAL_PRICES.get(resource);
  if (global !== undefined && Number.isFinite(global) && global > 0) return global;
  const grainPrice = settlement.market.lastClearingPrice.get(GRAIN_RESOURCE);
  const staple =
    grainPrice !== undefined && Number.isFinite(grainPrice) && grainPrice > 0
      ? grainPrice
      : (DEFAULT_GLOBAL_PRICES.get(GRAIN_RESOURCE) ?? 1.5);
  return Math.max(
    0.01,
    staple * grainEquivalentModiiPerUnit(resource) * rationProcessingMarkup(resource),
  );
};

const grainEquivalentModiiPerUnit = (id: ResourceId): number => {
  const def = getResource(id);
  return (def.weightKgPerUnit / KG_PER_MODIUS) * grainEquivalentMultiplier(id);
};

const rationProcessingMarkup = (id: ResourceId): number => {
  const idStr = String(id);
  if (idStr === 'food.bread') return 1.35;
  if (idStr === 'food.flour') return 1.15;
  if (idStr === 'food.cheese') return 1.5;
  if (idStr === 'food.salted_meat' || idStr === 'food.salted_fish') return 1.4;
  return 1;
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
    settlement.population.forEachCohort((key, count) => {
      if (key.age === age && count > 0) snapshot.push([key, count]);
    });
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
  // Disband caravans whose health or crew hit 0 BEFORE moving. A 0% HP
  // caravan means crew + animals are dead/incapacitated; zero crew means
  // prior combat already removed everyone. The cargo is loose goods on the
  // road (we don't model the loose-goods drop yet).
  // Per the user's note + docs/06 §"Consumption en route".
  const disbanded: { readonly id: CaravanId; readonly reason: 'zero_health' | 'zero_crew' }[] = [];
  for (const [cId, c] of world.caravans) {
    if (c.health <= 0) disbanded.push({ id: cId, reason: 'zero_health' });
    else if (totalCrewCount(c) <= 0) disbanded.push({ id: cId, reason: 'zero_crew' });
  }
  for (const entry of disbanded) {
    const c = world.caravans.get(entry.id);
    if (c === undefined) continue;
    world.caravans.delete(entry.id);
    events.push({
      type: 'caravan_disbanded',
      caravan: entry.id,
      at: { q: c.position.q, r: c.position.r },
      reason: entry.reason,
    });
  }

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
    // Trail wear: per docs/06 §"Trail wear → emergent dirt roads".
    // Each pack animal + crew member entering this hex compacts the
    // trail. A 50-mule + 12-crew caravan adds ~56 wear per hex.
    const wearPerHex = caravanTrailWear(c);
    for (const moved of result.hexesMoved) {
      events.push({
        type: 'caravan_moved',
        caravan: cId,
        from: before,
        to: { q: moved.q, r: moved.r },
      });
      addRoadWear(world, moved, wearPerHex);
    }
  }
  // News carriers walk per docs/13. Their arrival → reputation update is
  // handled in the politics phase below.
  if (world.newsCarriers !== undefined) {
    for (const [id, carrier] of world.newsCarriers) {
      if (carrier.arrived) continue;
      const before = { q: carrier.position.q, r: carrier.position.r };
      const next = tickCarrierWithGrid({ carrier, grid: world.grid, season, today });
      world.newsCarriers.set(id, next);
      // News carriers are single people on foot — small wear contribution.
      if (!hexEquals(before, next.position)) {
        addRoadWear(world, next.position, WEAR_PER_NEWS_CARRIER);
      }
    }
  }
  // Patrols are handled in politicsPhase, but they walk a route step
  // per tick — wear is added inside patrolPhase where the step is taken.
  void hexEquals;
};

// --- Trail wear helpers (docs/06 §"Trail wear → emergent dirt roads") ----

const WEAR_PER_PACK_ANIMAL = 0.2;
const WEAR_PER_CREW = 0.05;
const WEAR_PER_NEWS_CARRIER = 0.2;
const WEAR_PER_PATROL_SOLDIER = 0.5;
const WEAR_DECAY_PER_DAY = 1.0;
const DIRT_ROAD_DECAY_PER_DAY = 3.0;
const DIRT_UPGRADE_THRESHOLD = 100;
const DIRT_DOWNGRADE_THRESHOLD = 20;
const MAX_ROAD_WEAR = 200;
const MAX_ROAD_WEAR_ADDED_PER_ENTRY = 10;
/** Day 1825 = end of pre-road burn-in phase (per docs/07 + docs/14). */
const ROAD_RESET_DAY = 1825;

const caravanTrailWear = (c: Caravan): number => {
  let crew = 0;
  for (const m of c.crew) crew += m.count;
  let animals = 0;
  for (const k of Object.keys(c.animals) as (keyof typeof c.animals)[]) {
    animals += c.animals[k] ?? 0;
  }
  return crew * WEAR_PER_CREW + animals * WEAR_PER_PACK_ANIMAL;
};

const addRoadWear = (world: WorldState, h: Hex, amount: number): void => {
  if (amount <= 0) return;
  const tile = world.grid.get(h);
  if (tile === undefined) return;
  // Roman roads neither accrue wear nor decay (engineered + maintained).
  if (tile.road === 'roman') return;
  const boundedAmount = Math.min(amount, MAX_ROAD_WEAR_ADDED_PER_ENTRY);
  tile.roadWear = Math.min(MAX_ROAD_WEAR, (tile.roadWear ?? 0) + boundedAmount);
};

// --- Demolition phase (docs/15 §C8 demolition) ---------------------------

/**
 * Drain mason+carpenter worker-days toward each settlement's
 * pendingDemolitions. When workerDaysRemaining hits 0, removeBuilding
 * the entry, refund 50% of the original constructionCost to the
 * owner's stockpile, and emit a `building_demolished` event.
 */
const demolitionPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.pendingDemolitions.length === 0) continue;
    let masonBudget = settlement.jobAllocations.get(jobId('mason')) ?? 0;
    let carpenterBudget = settlement.jobAllocations.get(jobId('carpenter')) ?? 0;
    let budget = masonBudget + carpenterBudget;
    if (budget <= 0) continue;

    const completed: number[] = [];
    for (let i = 0; i < settlement.pendingDemolitions.length && budget > 0; i++) {
      const pd = settlement.pendingDemolitions[i] as PendingDemolition;
      const apply = Math.min(budget, pd.workerDaysRemaining);
      pd.workerDaysRemaining -= apply;
      budget -= apply;
      if (pd.workerDaysRemaining <= 0) completed.push(i);
    }
    void masonBudget;
    void carpenterBudget;

    for (let j = completed.length - 1; j >= 0; j--) {
      const idx = completed[j] as number;
      const pd = settlement.pendingDemolitions[idx] as PendingDemolition;
      settlement.pendingDemolitions.splice(idx, 1);
      // Remove the building if still present.
      const stillPresent = settlement.buildings.some(
        (b) => b.buildingId === pd.buildingId && hexEquals(b.hex, pd.hex),
      );
      if (stillPresent) {
        try {
          removeBuilding(settlement, pd.hex, pd.buildingId);
        } catch {
          // Already gone (raced); ignore.
        }
      }
      // Refund 50% of materials.
      const def = getBuilding(pd.buildingId);
      const owner = world.actors.get(pd.ownerActor);
      if (owner !== undefined) {
        for (const [r, qty] of def.constructionCost) {
          const refund = qty * 0.5;
          if (refund <= 0) continue;
          owner.stockpile.set(r, (owner.stockpile.get(r) ?? 0) + refund);
        }
      }
      events.push({
        type: 'building_demolished',
        settlement: settlement.id,
        building: pd.buildingId,
        ownerActor: pd.ownerActor,
      });
    }
  }
};

// --- GoalStack helpers (docs/15 §C18) ------------------------------------

const goalDestination = (
  goal: Goal,
  settlementAnchorByCity: ReadonlyMap<SettlementId, Hex>,
): Hex | null => {
  switch (goal.type) {
    case 'move_to':
      return { q: goal.hex.q, r: goal.hex.r };
    case 'return_home':
      return { q: goal.home.q, r: goal.home.r };
    case 'flee_to':
      return { q: goal.safe.q, r: goal.safe.r };
    case 'trade_at': {
      const a = settlementAnchorByCity.get(goal.settlement);
      return a === undefined ? null : { q: a.q, r: a.r };
    }
    case 'escort':
    case 'patrol':
      // Engine-driven: the patrol/escort layer sets destinations
      // based on target/route. Caravan AI doesn't override.
      return null;
  }
};

// --- Merchant guilds (docs/15 §C17) --------------------------------------

const GUILD_LEDGER_MAX_AGE_DAYS = 60;

/** Cached per-tick: caravan_owner Actor → Guild. */
let guildByMemberCache: ReadonlyMap<ActorId, Guild> | null = null;
let guildByMemberCacheDay: Day | null = null;
let guildByMemberCacheWorld: WorldState | null = null;

const getGuildByMember = (world: WorldState, today: Day): ReadonlyMap<ActorId, Guild> => {
  if (
    guildByMemberCache !== null &&
    guildByMemberCacheDay === today &&
    guildByMemberCacheWorld === world &&
    world.guilds !== undefined
  ) {
    return guildByMemberCache;
  }
  const guilds = world.guilds?.values() ?? [];
  guildByMemberCache = buildGuildByMember(guilds);
  guildByMemberCacheDay = today;
  guildByMemberCacheWorld = world;
  return guildByMemberCache;
};

/**
 * On caravan arrival at a settlement: deposit the caravan's recent
 * observations into the local guild's ledger (if the caravan's owner
 * is a member of any guild). Then read the guild's collective ledger
 * back into the caravan's priceBook so the next leg uses the freshest
 * collective intel.
 */
const syncCaravanWithLocalGuild = (world: WorldState, c: Caravan, today: Day): void => {
  if (world.guilds === undefined || world.guilds.size === 0) return;
  const memberGuilds = getGuildByMember(world, today);
  const ownerGuild = memberGuilds.get(c.ownerActor);
  if (ownerGuild === undefined) return;

  // Deposit recent observations.
  for (const [resource, byHex] of c.priceBook) {
    for (const [hexK, obs] of byHex) {
      depositObservation(ownerGuild, resource, hexK, {
        price: obs.price,
        observedOnDay: obs.observedOnDay,
      });
    }
  }

  // Pull the ledger back into the caravan's priceBook (only fresher entries).
  for (const [resource, byHex] of ownerGuild.priceLedger) {
    let book = c.priceBook.get(resource);
    if (book === undefined) {
      book = new Map();
      c.priceBook.set(resource, book);
    }
    for (const [hexK, obs] of byHex) {
      if (today - obs.observedOnDay > GUILD_LEDGER_MAX_AGE_DAYS) continue;
      const prev = book.get(hexK);
      if (prev === undefined || obs.observedOnDay > prev.observedOnDay) {
        book.set(hexK, { price: obs.price, observedOnDay: obs.observedOnDay });
      }
    }
  }
};

/**
 * Cross-guild rumor: when caravans owned by members of DIFFERENT
 * guilds happen to be on the same hex, exchange a slice of their
 * ledgers (the long-haul rumor channel). Runs once per tick.
 */
const crossGuildRumorPhase = (world: WorldState, today: Day): void => {
  if (world.guilds === undefined || world.guilds.size < 2) return;
  const memberGuilds = getGuildByMember(world, today);
  if (memberGuilds.size === 0) return;

  // Group caravans by hex so we can find co-located members of distinct guilds.
  const byHex = new Map<string, Caravan[]>();
  for (const c of world.caravans.values()) {
    const k = `${c.position.q},${c.position.r}`;
    let arr = byHex.get(k);
    if (arr === undefined) {
      arr = [];
      byHex.set(k, arr);
    }
    arr.push(c);
  }
  for (const [, caravans] of byHex) {
    if (caravans.length < 2) continue;
    // Pair members of different guilds.
    for (let i = 0; i < caravans.length; i++) {
      const cI = caravans[i] as Caravan;
      const gI = memberGuilds.get(cI.ownerActor);
      if (gI === undefined) continue;
      for (let j = i + 1; j < caravans.length; j++) {
        const cJ = caravans[j] as Caravan;
        const gJ = memberGuilds.get(cJ.ownerActor);
        if (gJ === undefined) continue;
        if (gI === gJ) continue;
        // Bidirectional exchange.
        mergeLedgerInto(gI, gJ.priceLedger, today, GUILD_LEDGER_MAX_AGE_DAYS);
        mergeLedgerInto(gJ, gI.priceLedger, today, GUILD_LEDGER_MAX_AGE_DAYS);
      }
    }
  }
};

// --- Civil unrest cascade (docs/15 §C16) ---------------------------------

/** Number of consecutive days of price > RIOT_PRICE_MULT × baseline before riot. */
const RIOT_PRICE_STREAK_DAYS = 14;
const RIOT_PRICE_MULT = 5;
/** Days a riot persists before triggering an edict (governor must respond). */
const EDICT_TRIGGER_AFTER_RIOT_DAYS = 7;
/** Edict caps grain at this multiple of the baseline. */
const EDICT_PRICE_CAP_MULT = 3;
/** Days an edict can be in effect before mob looting if it isn't enough. */
const LOOTING_TRIGGER_AFTER_EDICT_DAYS = 14;
/** Mob takes this fraction of patrician + city-corp grain stockpile. */
const LOOTING_FRACTION = 0.08;

interface UnrestState {
  /** Per-settlement, per-resource consecutive days price >= mult × baseline. */
  readonly priceSpikeStreak: Map<string, number>;
  /** Per-settlement: days since current riot started, or undefined if no riot. */
  readonly riotDays: Map<SettlementId, number>;
  /** Per-settlement: days since current edict issued, or undefined. */
  readonly edictDays: Map<SettlementId, number>;
}

const unrest: UnrestState = {
  priceSpikeStreak: new Map(),
  riotDays: new Map(),
  edictDays: new Map(),
};

const civilUnrestPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
  const grainResource = resourceId('food.grain');
  const baseline = DEFAULT_GLOBAL_PRICES.get(grainResource) ?? 1.5;

  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const price = settlement.market.lastClearingPrice.get(grainResource) ?? 0;
    const streakKey = `${String(settlement.id)}|food.grain`;

    // Update streak.
    if (price >= baseline * RIOT_PRICE_MULT) {
      unrest.priceSpikeStreak.set(streakKey, (unrest.priceSpikeStreak.get(streakKey) ?? 0) + 1);
    } else {
      unrest.priceSpikeStreak.set(streakKey, 0);
    }

    const streak = unrest.priceSpikeStreak.get(streakKey) ?? 0;
    const inRiot = unrest.riotDays.has(settlement.id);
    const inEdict = unrest.edictDays.has(settlement.id);

    // Trigger riot.
    if (!inRiot && streak >= RIOT_PRICE_STREAK_DAYS) {
      unrest.riotDays.set(settlement.id, 0);
      events.push({
        type: 'riot',
        settlement: settlement.id,
        trigger: grainResource,
        priceMultipleOfBaseline: price / baseline,
      });
    }

    // Advance riot timer.
    if (inRiot) {
      const days = (unrest.riotDays.get(settlement.id) ?? 0) + 1;
      unrest.riotDays.set(settlement.id, days);

      // Trigger edict after enough riot days.
      if (!inEdict && days >= EDICT_TRIGGER_AFTER_RIOT_DAYS) {
        unrest.edictDays.set(settlement.id, 0);
        events.push({
          type: 'edict_issued',
          settlement: settlement.id,
          resource: grainResource,
          priceCap: baseline * EDICT_PRICE_CAP_MULT,
        });
        // Force-cap the recorded clearing price (next-tick demand sources
        // will see the lower price and not bid as high).
        recordClearingPrice(settlement, grainResource, baseline * EDICT_PRICE_CAP_MULT);
      }
    }

    // Advance edict timer + trigger looting if cap insufficient.
    if (inEdict) {
      const days = (unrest.edictDays.get(settlement.id) ?? 0) + 1;
      unrest.edictDays.set(settlement.id, days);

      if (days >= LOOTING_TRIGGER_AFTER_EDICT_DAYS && price > baseline * RIOT_PRICE_MULT) {
        // Mob loots grain from richest patricians + city corp.
        for (const oId of settlement.stockpileOwners) {
          const a = world.actors.get(oId);
          if (a === undefined) continue;
          if (a.kind !== 'patrician_family' && a.kind !== 'city_corporation') continue;
          const have = a.stockpile.get(grainResource) ?? 0;
          if (have <= 0) continue;
          const looted = have * LOOTING_FRACTION;
          if (looted < 1) continue;
          const remaining = have - looted;
          if (remaining > 1e-9) a.stockpile.set(grainResource, remaining);
          else a.stockpile.delete(grainResource);
          events.push({
            type: 'mob_looting',
            settlement: settlement.id,
            resource: grainResource,
            fromActor: a.id,
            looted,
          });
        }
        // Reset edict timer (governor re-issues + waits another window).
        unrest.edictDays.set(settlement.id, 0);
      }
    }

    // Cool-off: prices back to normal → end riot + edict.
    if (price < baseline * RIOT_PRICE_MULT && streak === 0) {
      unrest.riotDays.delete(settlement.id);
      unrest.edictDays.delete(settlement.id);
    }
  }
};

// --- Roman road maintenance (docs/15 §C11) -------------------------------

/** Per-Roman-hex coin cost per quarter (docs/15 §C11). 0.1 coin/hex/qtr =
 *  ~0.4/yr. With ~50-200 Roman hexes per province, that's 20-80 coin/yr,
 *  trivial against the seeded 20-50k governor treasury. */
const ROMAN_HEX_COIN_PER_QUARTER = 0.1;
/** Quarters of missed maintenance before a Roman hex demotes to dirt. */
const MISSED_QUARTERS_TO_DOWNGRADE = 4;

const roadMaintenancePhase = (world: WorldState, events: TickEvent[]): void => {
  // Find the governor's office.
  let governor: Actor | undefined;
  for (const a of world.actors.values()) {
    if (a.kind === 'governor_office') {
      governor = a;
      break;
    }
  }
  if (governor === undefined) return;

  for (const [h, tile] of world.grid.tiles()) {
    if (tile.road !== 'roman') continue;
    // Try to drain the per-hex cost from the governor.
    if (governor.treasury >= ROMAN_HEX_COIN_PER_QUARTER) {
      governor.treasury -= ROMAN_HEX_COIN_PER_QUARTER;
      // Reset missed-quarters counter (paid).
      if (tile.romanQuartersUnmaintained !== undefined) {
        tile.romanQuartersUnmaintained = 0;
      }
    } else {
      const missed = (tile.romanQuartersUnmaintained ?? 0) + 1;
      tile.romanQuartersUnmaintained = missed;
      if (missed >= MISSED_QUARTERS_TO_DOWNGRADE) {
        // Demote this hex to dirt; trail wear takes over from here.
        tile.road = 'dirt';
        tile.roadWear = 100; // start at the upgrade threshold so daily decay doesn't reclaim it instantly
        tile.romanQuartersUnmaintained = 0;
        events.push({ type: 'road_unmaintained', hex: { q: h.q, r: h.r } });
      }
    }
  }
};

// --- Storage spoilage (docs/15 §C10) -------------------------------------

const SPOILAGE_RATE_PER_DAY = 0.002; // 0.2% per day above cap
/** Grace period: bootstrap stockpiles get a year to be consumed naturally
 *  before spoilage kicks in. Without this the procgen-seeded bootstrap
 *  (90 days of grain in a 30k city = 161k modii vs. one granary's 5k)
 *  spoils away in months and the world starves. */
const SPOILAGE_GRACE_DAYS = 365;

/**
 * Whether a resource can spoil at all. Hard goods (iron, tools,
 * weapons, cut stone) never spoil; perishables (grain, bread, meat,
 * fish, milk) can. We use the catalog's `perishableDays` as the
 * proxy: present = spoils, absent = inert. Per docs/02 + docs/15 §C10.
 */
const isPerishable = (resource: ResourceId): boolean => {
  const def = getResource(resource);
  return def.perishableDays !== undefined && def.perishableDays > 0;
};

/**
 * Per-day, for each settlement: compute its aggregate storage capacity
 * (per-resource + wildcard kg). For each (owner, resource): if the
 * settlement's combined stockpile of `resource` exceeds the cap,
 * each owner's share spoils proportionally at 0.2%/day. The spoiled
 * goods evaporate (we don't model rats), and emit a `storage_spoilage`
 * event so telemetry can see the rejected delta.
 *
 * Why gentle: the prior C10 attempt did instant force-sales at a
 * floor price, which cascaded into inflation+market-collapse. Slow
 * decay lets the trade phase find equilibrium first; if cap is
 * still exceeded after the grace period, production naturally backs
 * off (output goes nowhere → seller's stockpile stays full → next
 * round's market clears at lower prices → derived input demand
 * falls). The system self-regulates instead of imploding.
 */
const storageSpoilagePhase = (world: WorldState, events: TickEvent[]): void => {
  if (world.day < SPOILAGE_GRACE_DAYS) return;
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const cap = computeStorageCapacity(settlement);

    // Aggregate stockpiles across owners + count owners holding each
    // resource so we can split the spoilage fairly.
    const totalByResource = new Map<ResourceId, number>();
    const ownersWithStock = new Map<ResourceId, Actor[]>();
    let wildcardKgUsed = 0;

    for (const oId of settlement.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      for (const [r, qty] of a.stockpile) {
        if (qty <= 0) continue;
        totalByResource.set(r, (totalByResource.get(r) ?? 0) + qty);
        let arr = ownersWithStock.get(r);
        if (arr === undefined) {
          arr = [];
          ownersWithStock.set(r, arr);
        }
        arr.push(a);
        // Resources with a per-resource cap don't draw on wildcard.
        if (!cap.perResource.has(r)) {
          wildcardKgUsed += qty * getResource(r).weightKgPerUnit;
        }
      }
    }

    // Per-resource caps first. Only PERISHABLE resources spoil — iron,
    // tools, cut stone, etc. sit in stockpiles indefinitely.
    for (const [r, total] of totalByResource) {
      if (!isPerishable(r)) continue;
      const limit = cap.perResource.get(r);
      if (limit === undefined) continue;
      if (total <= limit) continue;
      const excess = total - limit;
      const spoil = excess * SPOILAGE_RATE_PER_DAY;
      drainSpoilageProportional(ownersWithStock.get(r) ?? [], r, spoil);
      events.push({
        type: 'storage_spoilage',
        settlement: settlement.id,
        resource: r,
        spoiled: spoil,
      });
    }

    // Wildcard pool: only perishables spoil. Hard goods (iron, tools,
    // weapons) just stack up.
    if (wildcardKgUsed > cap.wildcardKg && cap.wildcardKg > 0) {
      let perishableKgUsed = 0;
      for (const [r, total] of totalByResource) {
        if (cap.perResource.has(r)) continue;
        if (!isPerishable(r)) continue;
        perishableKgUsed += total * getResource(r).weightKgPerUnit;
      }
      if (perishableKgUsed <= 0) continue;
      const overflowKg = wildcardKgUsed - cap.wildcardKg;
      const overflowPerishableShare = Math.min(overflowKg, perishableKgUsed);
      const spoilFraction = (overflowPerishableShare * SPOILAGE_RATE_PER_DAY) / perishableKgUsed;
      for (const [r, total] of totalByResource) {
        if (cap.perResource.has(r)) continue;
        if (!isPerishable(r)) continue;
        const spoil = total * spoilFraction;
        if (spoil <= 0) continue;
        drainSpoilageProportional(ownersWithStock.get(r) ?? [], r, spoil);
        events.push({
          type: 'storage_spoilage',
          settlement: settlement.id,
          resource: r,
          spoiled: spoil,
        });
      }
    }
  }
};

const drainSpoilageProportional = (
  owners: readonly Actor[],
  resource: ResourceId,
  totalSpoil: number,
): void => {
  if (owners.length === 0 || totalSpoil <= 1e-9) return;
  // Weighted by current stock. Spoil more from the bigger holders.
  let totalStock = 0;
  for (const a of owners) totalStock += a.stockpile.get(resource) ?? 0;
  if (totalStock <= 0) return;
  for (const a of owners) {
    const have = a.stockpile.get(resource) ?? 0;
    if (have <= 0) continue;
    const share = (have / totalStock) * totalSpoil;
    const remaining = have - share;
    if (remaining > 1e-9) a.stockpile.set(resource, remaining);
    else a.stockpile.delete(resource);
  }
};

// --- Tax shipment phase (docs/11 §"Taxes" + codex review #2) -------------

const DEFAULT_TAX_RATES: TaxRatesPercent = {
  harvestPct: 10, // 1/10 of recent harvest as grain tribute
  cartTollPerCart: 0,
  coinTaxPctOfWealth: 1, // 1% monthly coin assessment
};

const MAX_TAX_SHIPMENTS_DISPATCHED_PER_DAY = 8;
const pendingTaxAssessmentsByWorld: WeakMap<WorldState, TaxAssessment[]> = new WeakMap();

const compareTaxAssessments = (a: TaxAssessment, b: TaxAssessment): number => {
  const settlement = String(a.fromSettlement).localeCompare(String(b.fromSettlement));
  if (settlement !== 0) return settlement;
  const owner = String(a.fromOwnerActor).localeCompare(String(b.fromOwnerActor));
  if (owner !== 0) return owner;
  const resource = String(a.resource).localeCompare(String(b.resource));
  if (resource !== 0) return resource;
  return a.quantityOwed - b.quantityOwed;
};

const pendingTaxQueueForWorld = (world: WorldState): TaxAssessment[] => {
  let queue = pendingTaxAssessmentsByWorld.get(world);
  if (queue === undefined) {
    queue = [];
    pendingTaxAssessmentsByWorld.set(world, queue);
  }
  return queue;
};

const taxShipmentPhase = (world: WorldState, today: Day, rng: Rng, events: TickEvent[]): void => {
  // Find the governor (one per province; per docs/11 there's one
  // governor_office actor anchored at the capital).
  let governor: Actor | undefined;
  let capital: Settlement | undefined;
  for (const a of world.actors.values()) {
    if (a.kind === 'governor_office') {
      governor = a;
      break;
    }
  }
  if (governor === undefined) return;
  for (const s of world.settlements.values()) {
    if (s.tier === 'large_city' && s.id === governor.homeSettlement) {
      capital = s;
      break;
    }
  }
  if (capital === undefined) {
    // Fall back: use the largest settlement as the capital.
    let bestPop = -1;
    for (const s of world.settlements.values()) {
      const p = s.population.total();
      if (p > bestPop) {
        bestPop = p;
        capital = s;
      }
    }
  }
  if (capital === undefined) return;

  // Build settlement views: recent harvest = recent grain inflows; coin
  // wealth = sum of stockpile owners' treasuries.
  const settlementViews: SettlementTaxView[] = [];
  for (const s of world.settlements.values()) {
    if (s.id === capital.id) continue; // capital doesn't tax itself
    const harvest = s.market.recentInflows.get(resourceId('food.grain')) ?? 0;
    const cloth = s.market.recentInflows.get(resourceId('goods.cloth')) ?? 0;
    const owners: { id: ActorId; treasury: number }[] = [];
    for (const oId of s.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      owners.push({ id: a.id, treasury: a.treasury });
    }
    if (owners.length === 0) continue;
    settlementViews.push({
      id: s.id,
      tier: s.tier,
      recentHarvestQuantity: Math.max(0, Math.floor(harvest)),
      recentClothProduction: Math.max(0, Math.floor(cloth)),
      ownerActors: owners,
    });
  }

  const assessments = assessTaxes({
    governor,
    taxRatesPercent: DEFAULT_TAX_RATES,
    settlements: settlementViews,
    today,
  });
  const pending = pendingTaxQueueForWorld(world);
  if (assessments.length > 0) {
    pending.push(...assessments.slice().sort(compareTaxAssessments));
  }

  // Spawn a bounded number of tax-shipment caravans per day and keep the
  // rest queued. Harvest assessments can touch hundreds of settlements; a
  // province dispatches wagons over weeks, not as a single discontinuous
  // caravan burst.
  let dispatched = 0;
  while (pending.length > 0 && dispatched < MAX_TAX_SHIPMENTS_DISPATCHED_PER_DAY) {
    const a = pending.shift() as TaxAssessment;
    const fromS = world.settlements.get(a.fromSettlement);
    if (fromS === undefined) continue;
    const owner = world.actors.get(a.fromOwnerActor);
    if (owner === undefined) continue;
    const have = owner.stockpile.get(a.resource) ?? 0;
    const drain = Math.min(have, a.quantityOwed);
    if (drain <= 0) continue;
    const remaining = have - drain;
    if (remaining > 1e-9) owner.stockpile.set(a.resource, remaining);
    else owner.stockpile.delete(a.resource);

    const cId = makeCaravanIdLocal(
      `tax-${today}-${String(a.fromSettlement)}-${String(a.fromOwnerActor)}-${String(a.resource)}`,
    );
    if (world.caravans.has(cId)) continue; // dedupe within a tick
    const caravan = createTaxShipmentCaravan({
      id: cId,
      assessment: { ...a, quantityOwed: drain },
      fromHex: fromS.anchor,
      toHex: capital.anchor,
      governorActor: governor.id,
      rng: rng.derive(String(cId)),
    });
    world.caravans.set(cId, caravan);
    dispatched += 1;
    events.push({
      type: 'tax_shipment_dispatched',
      fromSettlement: a.fromSettlement,
      toSettlement: capital.id,
      grainModii: a.resource === resourceId('food.grain') ? drain : 0,
      coin: a.resource === resourceId('goods.coin') ? drain : 0,
    });
  }
};

// --- Edge-hub phase (docs/06 + docs/08) -----------------------------------

/**
 * Per-day off-map trade: spawn import + export caravans at edge hexes
 * with the same Caravan type used by NPC trade. Per docs/06 §"Edge-hub
 * caravans" + docs/08 §"off-map global market".
 *
 * Edge hexes are the hexes on the perimeter of the map (q or r at min /
 * max of the grid bounds). Cities + capital are import targets and
 * export sources. Import palette + global prices use library defaults.
 */
const edgeHubPhase = (
  world: WorldState,
  season: Season,
  today: Day,
  rng: Rng,
  events: TickEvent[],
): void => {
  const edgeHexes = selectEdgeHubGates(computeEdgeHexes(world.grid));
  if (edgeHexes.length === 0) return;

  // City + capital settlements as import targets / export sources.
  const cityImportTargets: { settlementId: SettlementId; hex: Hex }[] = [];
  const cityExportSources: {
    settlementId: SettlementId;
    hex: Hex;
    ownerActor: ActorId;
    localPrices: ReadonlyMap<ResourceId, number>;
    availableForExport: ReadonlyMap<ResourceId, Quantity>;
  }[] = [];
  for (const s of world.settlements.values()) {
    if (s.tier !== 'small_city' && s.tier !== 'large_city') continue;
    cityImportTargets.push({ settlementId: s.id, hex: s.anchor });
    // Export source: pick the wealthiest stockpile owner anchored at the
    // city; use their stockpile as availableForExport.
    let owner: Actor | undefined;
    let bestTreasury = -1;
    for (const oId of s.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      if (a.kind !== 'patrician_family' && a.kind !== 'city_corporation') continue;
      if (a.treasury <= bestTreasury) continue;
      owner = a;
      bestTreasury = a.treasury;
    }
    if (owner === undefined) continue;
    cityExportSources.push({
      settlementId: s.id,
      hex: s.anchor,
      ownerActor: owner.id,
      localPrices: s.market.lastClearingPrice,
      availableForExport: owner.stockpile,
    });
  }
  if (cityImportTargets.length === 0 && cityExportSources.length === 0) return;

  const result = tickEdgeHubs({
    config: {
      edgeHexes,
      globalPrices: DEFAULT_GLOBAL_PRICES,
      // Off-map trade enters through a small number of abstract border
      // gates, not every passable perimeter hex. This keeps imports/exports
      // as a paced long-haul flow instead of random-looking perimeter bursts.
      baseImportSpawnProbPerDay: 0.05,
      baseExportSpawnProbPerDay: 0.03,
      maxImportSpawnsPerDay: 2,
      maxExportSpawnsPerDay: 1,
      maxTotalSpawnsPerDay: 3,
      importPalette: DEFAULT_IMPORT_PALETTE,
    },
    today,
    season,
    cityImportTargets,
    cityExportSources,
    rng,
  });

  // Add new caravans into world.caravans. The export-side cargo was
  // implicitly drawn from the owner's stockpile by tickEdgeHubs (per
  // docs/06 §"Exports" — the owner intends to fund the trip), so we
  // drain it here.
  for (const c of result.newCaravans) {
    ensureCaravanOwnerActor(world, c);
    world.caravans.set(c.id, c);
    // For exports, drain the cargo from the owner's stockpile.
    const owner = world.actors.get(c.ownerActor);
    if (owner === undefined) continue;
    for (const [res, qty] of c.cargo) {
      const have = owner.stockpile.get(res) ?? 0;
      const remaining = have - qty;
      if (remaining > 1e-9) owner.stockpile.set(res, remaining);
      else owner.stockpile.delete(res);
    }
  }

  if (result.newCaravans.length > 0) {
    events.push({
      type: 'edge_hub_spawned',
      newCaravans: result.newCaravans.length,
    });
  }
};

const ensureCaravanOwnerActor = (world: WorldState, caravan: Caravan): void => {
  if (world.actors.has(caravan.ownerActor)) return;
  world.actors.set(
    caravan.ownerActor,
    createActor({
      id: caravan.ownerActor,
      kind: 'off_map_house',
      name: `Off-map merchant house ${String(caravan.ownerActor)}`,
      treasury: 100_000,
    }),
  );
};

const edgeHexCache: WeakMap<WorldState['grid'], readonly Hex[]> = new WeakMap();
const EDGE_HUB_GATE_COUNT = 8;

const computeEdgeHexes = (grid: WorldState['grid']): readonly Hex[] => {
  const cached = edgeHexCache.get(grid);
  if (cached !== undefined) return cached;

  let minQ = Infinity,
    maxQ = -Infinity,
    minR = Infinity,
    maxR = -Infinity;
  for (const [h] of grid.tiles()) {
    if (h.q < minQ) minQ = h.q;
    if (h.q > maxQ) maxQ = h.q;
    if (h.r < minR) minR = h.r;
    if (h.r > maxR) maxR = h.r;
  }
  const out: Hex[] = [];
  for (const [h, t] of grid.tiles()) {
    if (h.q === minQ || h.q === maxQ || h.r === minR || h.r === maxR) {
      // Skip impassable edge hexes (lakes, mountains).
      if (t.terrain === 'lake' || t.terrain === 'mountains') continue;
      out.push({ q: h.q, r: h.r });
    }
  }
  edgeHexCache.set(grid, out);
  return out;
};

const selectEdgeHubGates = (edgeHexes: readonly Hex[]): readonly Hex[] => {
  if (edgeHexes.length <= EDGE_HUB_GATE_COUNT) return edgeHexes;
  const sorted = edgeHexes.slice().sort((a, b) => {
    if (a.q !== b.q) return a.q - b.q;
    return a.r - b.r;
  });
  const out: Hex[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < EDGE_HUB_GATE_COUNT; i++) {
    const idx = Math.round((i * (sorted.length - 1)) / (EDGE_HUB_GATE_COUNT - 1));
    const h = sorted[Math.min(sorted.length - 1, Math.max(0, idx))] as Hex;
    const key = hexKey(h);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ q: h.q, r: h.r });
  }
  return out;
};

/**
 * Count axial neighbors whose tile has any road (dirt or roman). Used by
 * the trail-wear decay step to scale dirt-road decay exponentially with
 * local road density.
 */
const countRoadNeighbors = (grid: WorldState['grid'], h: Hex): number => {
  let n = 0;
  for (const dir of HEX_DIRECTIONS) {
    const neighbor = grid.get(hexAdd(h, dir));
    if (neighbor !== undefined && neighbor.road !== 'none') n++;
  }
  return n;
};

/**
 * Daily wear maintenance: unbuilt trail memory decays slowly, while dirt
 * roads decay faster so unused roads disappear from both sim state and the
 * viewer. Wear past DIRT_UPGRADE_THRESHOLD on a 'none' hex promotes to
 * 'dirt'. Sustained wear < DIRT_DOWNGRADE_THRESHOLD on a 'dirt' hex demotes
 * back to 'none'.
 *
 * Iterates the entire grid; cheap because the per-tile work is just a
 * subtract + branch. At 6,400 hexes (80×80) this is ~0.1 ms.
 */
const trailWearTickPhase = (world: WorldState, events: TickEvent[]): void => {
  for (const [h, tile] of world.grid.tiles()) {
    if (tile.road === 'roman') continue;
    let wear = tile.roadWear ?? 0;
    if (wear > 0) {
      // Dirt-road decay scales exponentially with the number of road
      // neighbors (any grade): 2^(n-2) × DIRT_ROAD_DECAY_PER_DAY. Isolated
      // dirt stubs (n=0..1) persist with minimal traffic; dense crossroads
      // (n=3+) are fragile because parallel routes compete and dirt-grade
      // sections at a busy junction get superseded. See docs/06.
      let decay: number;
      if (tile.road === 'dirt') {
        const n = countRoadNeighbors(world.grid, h);
        decay = DIRT_ROAD_DECAY_PER_DAY * Math.pow(2, n - 2);
      } else {
        decay = WEAR_DECAY_PER_DAY;
      }
      wear = Math.max(0, wear - decay);
      tile.roadWear = wear;
    }
    if (tile.road === 'none' && wear >= DIRT_UPGRADE_THRESHOLD) {
      // Skip impassable terrain — no road can be there.
      const t = tile.terrain;
      if (t === 'lake' || t === 'river' || t === 'mountains') continue;
      tile.road = 'dirt';
      events.push({ type: 'road_upgraded', hex: { q: h.q, r: h.r }, toGrade: 'dirt' });
    } else if (tile.road === 'dirt' && wear < DIRT_DOWNGRADE_THRESHOLD) {
      tile.road = 'none';
      tile.roadWear = 0;
      events.push({ type: 'road_downgraded', hex: { q: h.q, r: h.r }, fromGrade: 'dirt' });
    }
  }
};

/**
 * One-time road reset at day 1825 (end of phase 2a, before phase 2b).
 * Per docs/07 + docs/14:
 *   - Roman roads kept (engineered, maintained).
 *   - Worn-in trails (roadWear ≥ DIRT_UPGRADE_THRESHOLD on a non-Roman
 *     hex) become 'dirt'.
 *   - Procgen-laid 'dirt' hexes with roadWear < DIRT_DOWNGRADE_THRESHOLD
 *     reset to 'none'.
 *   - All wear counters reset to baseline (100 for kept dirt, 0 for none).
 */
const roadResetPhase = (world: WorldState, events: TickEvent[]): void => {
  let promotedToDirt = 0;
  let demotedToNone = 0;
  let romanKept = 0;
  for (const [, tile] of world.grid.tiles()) {
    if (tile.road === 'roman') {
      romanKept++;
      tile.roadWear = 100;
      continue;
    }
    const wear = tile.roadWear ?? 0;
    const t = tile.terrain;
    const passable = t !== 'lake' && t !== 'river' && t !== 'mountains';
    if (tile.road === 'dirt') {
      if (wear < DIRT_DOWNGRADE_THRESHOLD) {
        tile.road = 'none';
        tile.roadWear = 0;
        demotedToNone++;
      } else {
        tile.roadWear = 100;
      }
    } else if (tile.road === 'none' && wear >= DIRT_UPGRADE_THRESHOLD && passable) {
      tile.road = 'dirt';
      tile.roadWear = 100;
      promotedToDirt++;
    } else {
      tile.roadWear = 0;
    }
  }
  events.push({ type: 'road_reset', promotedToDirt, demotedToNone, romanKept });
};

// --- Phase 4: Trade ---------------------------------------------------------

/**
 * For each settlement and each tradable resource present in any owner's
 * stockpile (or demanded by population/producers/institutions), build a
 * modern microeconomic demand schedule (willingness to pay, budget limits,
 * derived input demand), build a reservation-price supply schedule, and call
 * clearMarket. Trades transfer goods from sellers to buyer actors or direct
 * consumption, and coin in the other direction, treasury-capped.
 */
const tradePhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
  stats: TickStats,
  subsistenceAccess: SubsistenceAccessMap,
): void => {
  // Per docs/08 + codex review #5: replaced the v1 8-resource hardcoded
  // "grain or comfort" model with the full demand/supply schedule
  // builder (subsistence + comfort + status + derived-input demand)
  // for every tradable resource. Without this swap, market prices
  // never moved off their hardcoded reservation values (user
  // observation #1 in the viewer: grain/flour/bread always 0.5,
  // cheese/tool/wine always 1000).
  const tradable = TRADABLE_RESOURCES;
  const ownerKindByActor = ownerKindByActorForWorld(world);

  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;

    // Stockpiles by owner — buildSettlementSchedules expects this shape.
    const stockpilesByOwner = new Map<ActorId, ReadonlyMap<ResourceId, Quantity>>();
    const owners: Actor[] = [];
    for (const oId of settlement.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      stockpilesByOwner.set(a.id, a.stockpile);
      owners.push(a);
    }
    if (owners.length === 0) continue;

    // Only clear resources that are economically visible here: stock is
    // present, population wants it, or a local building can use it as an
    // input. Demand-only resources still matter because scarcity prices
    // are the signal that attracts caravans into shortages.
    const presentResources = new Set<ResourceId>();
    for (const o of owners) {
      for (const [res, qty] of o.stockpile) {
        if (qty > 0) presentResources.add(res);
      }
    }
    const demandCandidateResources = demandCandidateResourcesForSettlement(settlement);
    const localTradable = tradable.filter(
      (r) => presentResources.has(r) || demandCandidateResources.has(r),
    );
    if (localTradable.length === 0) continue;

    // Synthesize a recentLocalPrices map. We seed *every* resource we
    // might need to reason about — not just locally-tradable ones —
    // because the marginal-cost anchor in scheduleBuilder needs to
    // look up input prices (grain, salt, wood, etc.) when computing
    // MC of a refined good, even if those inputs aren't currently in
    // someone's local stockpile. Sources, in priority order:
    //   1. Last observed local clearing price (the truest local
    //      signal).
    //   2. Off-map global price, IF this resource has one (caravans
    //      from outside the province know the empire-wide reference
    //      for grain, oil, wine, cloth, tools, weapons, silver,
    //      gold, exotics, slaves — these are the high-value
    //      long-distance goods worth shipping at scale; this is a
    //      real economic signal, not an arbitrary pin).
    //   3. Otherwise: unseeded. Local-only goods (flour, bread,
    //      charcoal, lumber, pottery, hides) have no external
    //      anchor; their price has to emerge from local marginal
    //      cost. The MC formula tolerates missing input prices
    //      (contributes 0 for that input), so the chain bootstraps
    //      itself within a few ticks: grain has a global price → MC
    //      of flour computable → flour clears → MC of bread
    //      computable → bread clears, etc.
    // Per the user: "i don't think pinning prices to some arbitrary
    // values is good, that's not what happens irl either."
    const seededPrices = new Map<ResourceId, number>();
    for (const r of tradable) {
      const observed = settlement.market.lastClearingPrice.get(r) ?? 0;
      if (observed > 0) {
        seededPrices.set(r, observed);
        continue;
      }
      const globalPrice = DEFAULT_GLOBAL_PRICES.get(r);
      if (globalPrice !== undefined && globalPrice > 0) {
        seededPrices.set(r, globalPrice);
      }
    }

    const schedules = buildSettlementSchedules({
      settlement,
      stockpilesByOwner,
      resources: localTradable,
      recentLocalPrices: seededPrices,
      today,
      season,
      ownerKindByActor,
      actorTreasuryByActor: new Map(owners.map((a) => [a.id, a.treasury] as const)),
    });

    for (const [resId, pair] of schedules.schedulesByResource) {
      if (pair.demand.sources.length === 0 && pair.supply.sources.length === 0) continue;
      const result = clearMarket(pair.demand, pair.supply, { maxPrice: 10000 });
      if (result.totalTraded <= 0) {
        if (
          pair.demand.sources.length > 0 &&
          result.unmetDemandAtClearingPrice > 0 &&
          Number.isFinite(result.clearingPrice) &&
          result.clearingPrice > 0
        ) {
          recordClearingPrice(settlement, resId, result.clearingPrice);
          events.push({
            type: 'market_shortage',
            settlement: settlement.id,
            resource: resId,
            price: result.clearingPrice,
            unmetDemand: result.unmetDemandAtClearingPrice,
          });
        }
        continue;
      }
      const demandSourceById = new Map(pair.demand.sources.map((source) => [source.id, source]));
      const supplySourceById = new Map(pair.supply.sources.map((source) => [source.id, source]));
      let actualTraded = 0;
      for (const trade of result.trades) {
        const sellerActorId = supplySourceById.get(trade.sellerSourceId)?.ownerActor;
        if (sellerActorId === undefined) continue;
        const seller = world.actors.get(sellerActorId);
        if (seller === undefined) continue;

        const demandSource = demandSourceById.get(trade.buyerSourceId);
        const buyerActorId = demandSource?.buyerActor;
        const buyer = buyerActorId !== undefined ? world.actors.get(buyerActorId) : undefined;
        const buyerPaysSeller = buyer !== undefined && buyer.id !== seller.id;
        const maxByBuyerTreasury =
          buyerPaysSeller && trade.price > 0 ? buyer.treasury / trade.price : trade.quantity;
        const qty = Math.min(trade.quantity, maxByBuyerTreasury);
        if (qty <= 1e-9) continue;

        const coin = buyerPaysSeller ? Math.min(qty * trade.price, buyer.treasury) : 0;
        decreaseStockpile(seller, resId, qty);
        if (buyer !== undefined) {
          if (buyerPaysSeller) {
            if (coin > 0) {
              buyer.treasury -= coin;
              seller.treasury += coin;
            }
          }
          if (demandSource?.buyerDisposition === 'stockpile') {
            increaseStockpile(buyer, resId, qty);
          }
        } else {
          // Population/comfort/status demand sources are consumed directly:
          // the seller receives coin, but there is no concrete household
          // stockpile yet to hold the good after purchase.
          seller.treasury += qty * trade.price;
        }
        if (demandSource?.buyerDisposition !== 'stockpile') {
          recordOutflow(settlement, resId, qty);
        }
        if (String(resId) === String(GRAIN_RESOURCE) && demandSource?.curve === 'subsistence') {
          const access = subsistenceAccess.get(settlement);
          if (access !== undefined) access.fulfilledModii += qty;
        }
        actualTraded += qty;
      }
      if (actualTraded <= 1e-9) {
        if (
          pair.demand.sources.length > 0 &&
          Number.isFinite(result.clearingPrice) &&
          result.clearingPrice > 0
        ) {
          recordClearingPrice(settlement, resId, result.clearingPrice);
          events.push({
            type: 'market_shortage',
            settlement: settlement.id,
            resource: resId,
            price: result.clearingPrice,
            unmetDemand: Math.max(result.unmetDemandAtClearingPrice, result.totalTraded),
          });
        }
        continue;
      }
      recordClearingPrice(settlement, resId, result.clearingPrice);
      stats.marketsCleared += 1;
      events.push({
        type: 'market_cleared',
        settlement: settlement.id,
        resource: resId,
        price: result.clearingPrice,
        volume: actualTraded,
      });
    }
  }
};

interface OwnerKindCache {
  readonly actorCount: number;
  readonly ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>;
}

const ownerKindCache: WeakMap<WorldState, OwnerKindCache> = new WeakMap();

const ownerKindByActorForWorld = (world: WorldState): ReadonlyMap<ActorId, Actor['kind']> => {
  const cached = ownerKindCache.get(world);
  if (cached !== undefined && cached.actorCount === world.actors.size) {
    return cached.ownerKindByActor;
  }
  const ownerKindByActor = new Map<ActorId, Actor['kind']>();
  for (const a of world.actors.values()) ownerKindByActor.set(a.id, a.kind);
  ownerKindCache.set(world, { actorCount: world.actors.size, ownerKindByActor });
  return ownerKindByActor;
};

const POPULATION_DEMAND_RESOURCES: readonly ResourceId[] = Object.freeze(
  [
    'food.grain',
    'mineral.salt',
    'material.wood',
    'food.wine',
    'food.olive_oil',
    'food.cheese',
    'food.salted_meat',
    'food.salted_fish',
    'goods.cloth',
    'goods.clothing',
    'goods.furniture',
    'material.pottery',
    'goods.luxury_textiles',
    'metal.silver',
    'metal.gold',
    'exotic.spices',
    'exotic.silk',
    'exotic.incense',
    'exotic.dyes',
  ].map(resourceId),
);

const RECIPE_INPUT_RESOURCES_BY_BUILDING: ReadonlyMap<string, readonly ResourceId[]> = (() => {
  const tmp = new Map<string, Map<string, ResourceId>>();
  for (const recipe of allRecipes()) {
    const buildingKey = String(recipe.building);
    let bucket = tmp.get(buildingKey);
    if (bucket === undefined) {
      bucket = new Map<string, ResourceId>();
      tmp.set(buildingKey, bucket);
    }
    for (const input of recipe.inputs.keys()) {
      bucket.set(String(input), input);
    }
  }

  const out = new Map<string, readonly ResourceId[]>();
  for (const [buildingKey, byResource] of tmp) {
    out.set(buildingKey, Object.freeze(Array.from(byResource.values())));
  }
  return out;
})();

const demandCandidateResourcesForSettlement = (settlement: Settlement): ReadonlySet<ResourceId> => {
  const out = new Set<ResourceId>();
  if (settlement.population.total() > 0) {
    for (const r of POPULATION_DEMAND_RESOURCES) out.add(r);
  }
  for (const building of settlement.buildings) {
    if (building.capacity <= 0) continue;
    const inputs = RECIPE_INPUT_RESOURCES_BY_BUILDING.get(String(building.buildingId));
    if (inputs !== undefined) {
      for (const r of inputs) out.add(r);
    }
    for (const r of institutionalProcurementResourcesForBuilding(building.buildingId)) {
      out.add(r);
    }
  }
  return out;
};

/**
 * The full set of resources cleared each tick. Built once at module load
 * from resources that appear in recipes, population demand, or off-map
 * global trade. We exclude `service.*` (institutional capacity, not cargo)
 * and `people.*` (handled by separate slave/migrant flows).
 */
const TRADABLE_RESOURCES: readonly ResourceId[] = (() => {
  const seen = new Set<string>();
  const out: ResourceId[] = [];
  const add = (id: ResourceId): void => {
    const k = String(id);
    if (seen.has(k)) return;
    if (k.startsWith('service.') || k.startsWith('people.')) return;
    seen.add(k);
    out.push(id);
  };
  for (const r of allRecipes()) {
    for (const id of r.inputs.keys()) add(id);
    for (const id of r.outputs.keys()) add(id);
  }
  for (const id of POPULATION_DEMAND_RESOURCES) add(id);
  for (const id of DEFAULT_GLOBAL_PRICES.keys()) add(id);
  for (const resources of RECIPE_INPUT_RESOURCES_BY_BUILDING.values()) {
    for (const id of resources) add(id);
  }
  for (const building of ['barracks', 'temple', 'forum_market']) {
    for (const id of institutionalProcurementResourcesForBuilding(buildingId(building))) add(id);
  }
  return Object.freeze(out);
})();

// --- Phase 4b: Local trade (regional smoothing) -----------------------------

/**
 * Petty merchants and villager pickup carts that walk between nearby
 * settlements (≤3 hexes) every day, arbitraging local price spreads with
 * small loads. Per docs/06 §"Local trade between nearby settlements" and
 * docs/08 §"Per-settlement markets, regional smoothing".
 *
 * For each unordered settlement pair (A, B) within 3 hexes whose anchors are
 * both on passable terrain in the current season:
 *   - For each tradable resource R for which BOTH settlements have observed
 *     a clearing price:
 *       - Add a transport-cost surcharge per the docs/06 distance table.
 *       - If the spread (after transport cost) is positive, pick the cheaper
 *         settlement as seller and the dearer as buyer.
 *       - Find any seller-side actor with stock>0 and any buyer-side actor
 *         with treasury>0; move ≤MAX_PETTY_LOAD_KG worth of R from seller
 *         to buyer at the midpoint price (split the spread).
 *       - The petty merchant takes a 5% cut on the spread; in v1.5 we just
 *         absorb it (no separate merchant household ledger; tracked as a
 *         follow-up).
 *
 * Determinism: settlements are visited in insertion order; pairs are formed
 * with seller.id < buyer.id (lexicographic) so each unordered pair is
 * visited at most once per tick. Within a pair, owners are scanned in their
 * current `stockpileOwners` order (the same order all other phases use).
 *
 * Performance: a hex-keyed spatial index of settlement anchors is built once
 * per phase; each settlement enumerates only its 3-radius hex neighborhood
 * (~37 hexes) instead of comparing against all N settlements (an O(N²) walk
 * is unacceptable at the future-state ~8000-settlement scale).
 *
 * Same-hex (distance 0) is supported with zero transport cost — that is the
 * canonical pagus + dependent-hamlets case from docs/05 §"Same-hex
 * coexistence".
 */
const localTradePhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
): void => {
  void today;
  const settlementsByAnchorHex = settlementAnchorIndexForWorld(world).byAnchorHex;

  // Cache anchor passability per phase. v1 approximation: a pair is feasible
  // if both anchors are on passable terrain this season. Real path
  // reachability across intervening hexes would require an A* call per pair
  // and is deferred to v1.5+ when long-haul caravan AI consolidation lands.
  const passableAtAnchor = new Map<string, boolean>();
  const isAnchorPassable = (s: Settlement): boolean => {
    const k = hexKey(s.anchor);
    const cached = passableAtAnchor.get(k);
    if (cached !== undefined) return cached;
    const tile = world.grid.get(s.anchor);
    // If the tile isn't in the grid (test stub), treat as passable so unit
    // tests don't have to populate every hex with terrain just to exercise
    // local trade.
    const ok = tile === undefined ? true : isPassable(tile.terrain, season);
    passableAtAnchor.set(k, ok);
    return ok;
  };

  for (const a of world.settlements.values()) {
    if (!isAnchorPassable(a)) continue;
    // Enumerate every hex within 3 of A's anchor and look up settlements
    // anchored there. This is O(37 * pairsPerHex) per A, vs O(N) naive.
    for (const neighborHex of hexesWithinRange(a.anchor, LOCAL_TRADE_MAX_HEX_DISTANCE)) {
      const bucket = settlementsByAnchorHex.get(hexKey(neighborHex));
      if (bucket === undefined) continue;
      for (const b of bucket) {
        // Determinism: visit each unordered pair once, with id ordering.
        if (String(a.id) >= String(b.id)) continue;
        if (!isAnchorPassable(b)) continue;
        const dist = hexDistance(a.anchor, b.anchor);
        if (dist > LOCAL_TRADE_MAX_HEX_DISTANCE) continue;
        // Per docs/06 §"Distance and cost", the table is in coin/kg, not
        // coin/unit. tryLocalTrade scales by the resource's weightKgPerUnit
        // before comparing prices.
        const transportCostPerKg = TRANSPORT_COST_BY_DISTANCE[dist] ?? 0;
        for (const resId of LOCAL_TRADE_RESOURCES) {
          tryLocalTrade(world, a, b, resId, transportCostPerKg, events);
        }
      }
    }
  }
};

interface SettlementAnchorIndex {
  readonly settlementCount: number;
  readonly byAnchorHex: ReadonlyMap<string, readonly Settlement[]>;
  readonly candidates: readonly {
    readonly id: SettlementId;
    readonly hex: Hex;
    readonly tier: Settlement['tier'];
  }[];
}

const settlementAnchorIndexCache: WeakMap<WorldState, SettlementAnchorIndex> = new WeakMap();

const settlementAnchorIndexForWorld = (world: WorldState): SettlementAnchorIndex => {
  const cached = settlementAnchorIndexCache.get(world);
  if (cached !== undefined && cached.settlementCount === world.settlements.size) return cached;

  const byAnchorHex = new Map<string, Settlement[]>();
  const candidates: { id: SettlementId; hex: Hex; tier: Settlement['tier'] }[] = [];
  for (const s of world.settlements.values()) {
    candidates.push({ id: s.id, hex: s.anchor, tier: s.tier });
    const k = hexKey(s.anchor);
    let bucket = byAnchorHex.get(k);
    if (bucket === undefined) {
      bucket = [];
      byAnchorHex.set(k, bucket);
    }
    bucket.push(s);
  }

  const index: SettlementAnchorIndex = {
    settlementCount: world.settlements.size,
    byAnchorHex,
    candidates,
  };
  settlementAnchorIndexCache.set(world, index);
  return index;
};

const tryLocalTrade = (
  world: WorldState,
  a: Settlement,
  b: Settlement,
  resId: ResourceId,
  transportCostPerKg: number,
  events: TickEvent[],
): void => {
  const priceA = a.market.lastClearingPrice.get(resId);
  const priceB = b.market.lastClearingPrice.get(resId);
  if (priceA === undefined || priceB === undefined) return;
  if (priceA <= 0 || priceB <= 0) return;

  // Per docs/06 §"Distance and cost", transport is a coin/kg surcharge.
  // Convert to coin/unit using the resource's weight before comparing
  // prices (which are themselves coin/unit). Heavy goods like grain
  // (~6.7 kg/modius) eat a meaningful chunk of any price spread; tiny
  // luxuries like spices barely notice.
  const weightKgPerUnit =
    LOCAL_TRADE_WEIGHT_KG_BY_RESOURCE.get(resId) ?? getResource(resId).weightKgPerUnit;
  if (weightKgPerUnit <= 0) return;
  const transportCostPerUnit = transportCostPerKg * weightKgPerUnit;

  // Pick seller = cheaper, buyer = dearer; only fire if spread covers
  // transport. The PETTY_MERCHANT_CUT is also netted out so we don't trade
  // away the merchant's livelihood.
  let seller: Settlement;
  let buyer: Settlement;
  let sellerPrice: number;
  let buyerPrice: number;
  if (priceA + transportCostPerUnit < priceB) {
    seller = a;
    buyer = b;
    sellerPrice = priceA;
    buyerPrice = priceB;
  } else if (priceB + transportCostPerUnit < priceA) {
    seller = b;
    buyer = a;
    sellerPrice = priceB;
    buyerPrice = priceA;
  } else {
    return;
  }
  const spread = buyerPrice - sellerPrice - transportCostPerUnit;
  if (spread <= 0) return;
  // Petty merchant absorbs a small cut of the spread; if the residual
  // spread is non-positive, no trade is attractive enough to walk.
  const netSpread = spread * (1 - PETTY_MERCHANT_CUT);
  if (netSpread <= 0) return;

  // Settle at the midpoint price (split the spread). The buyer pays
  // mid; the seller receives mid. Transport cost is implicit in the
  // gap between sellerPrice + transportCostPerUnit ≤ mid ≤ buyerPrice.
  const midPrice = (sellerPrice + buyerPrice) / 2;
  if (midPrice <= 0) return;

  const sellerActor = pickSellerActor(world, seller, resId);
  if (sellerActor === null) return;
  const buyerActor = pickBuyerActor(world, buyer);
  if (buyerActor === null) return;

  const sellerStock = sellerActor.stockpile.get(resId) ?? 0;
  if (sellerStock <= 0) return;
  const maxByLoad = MAX_PETTY_LOAD_KG / weightKgPerUnit;
  const maxByTreasury = buyerActor.treasury / midPrice;
  const qty = Math.min(maxByLoad, sellerStock, maxByTreasury);
  if (qty <= 1e-9) return;

  const coinPaid = qty * midPrice;
  // Apply the transfer.
  decreaseStockpile(sellerActor, resId, qty);
  const buyerCurrent = buyerActor.stockpile.get(resId) ?? 0;
  buyerActor.stockpile.set(resId, buyerCurrent + qty);
  sellerActor.treasury = sellerActor.treasury + coinPaid;
  buyerActor.treasury = buyerActor.treasury - coinPaid;
  recordOutflow(seller, resId, qty);
  recordInflow(buyer, resId, qty);

  events.push({
    type: 'local_trade',
    fromSettlement: seller.id,
    toSettlement: buyer.id,
    resource: resId,
    quantity: qty,
    coinPaid,
  });
};

const pickSellerActor = (
  world: WorldState,
  settlement: Settlement,
  resId: ResourceId,
): Actor | null => {
  for (const id of settlement.stockpileOwners) {
    const actor = world.actors.get(id);
    if (actor === undefined) continue;
    const stock = actor.stockpile.get(resId) ?? 0;
    if (stock > 0) return actor;
  }
  return null;
};

const pickBuyerActor = (world: WorldState, settlement: Settlement): Actor | null => {
  for (const id of settlement.stockpileOwners) {
    const actor = world.actors.get(id);
    if (actor === undefined) continue;
    if (actor.treasury > 0) return actor;
  }
  return null;
};

/** Maximum hex distance for petty trade (docs/06 §"Distance and cost"). */
const LOCAL_TRADE_MAX_HEX_DISTANCE = 3;

/**
 * Per-pair, per-day, per-resource cap. ~50 kg is a single villager's basket
 * or one-mule load. Larger flows are long-haul caravan work; keeping this
 * small prevents petty arbitrage from draining subsistence liquidity.
 * docs/06 §"Local trade between nearby settlements".
 */
const MAX_PETTY_LOAD_KG = 50;

/**
 * Petty-merchant cut on the spread. v1.5 just absorbs this (no separate
 * merchant household actor); deferred follow-up tracks merchant
 * household ledgers so the cut accrues somewhere.
 */
const PETTY_MERCHANT_CUT = 0.05;

/**
 * Coin-per-kg surcharge for moving petty cargo across the pair distance.
 * Tabled by hex distance per docs/06 §"Distance and cost".
 */
const TRANSPORT_COST_BY_DISTANCE: Readonly<Record<number, number>> = {
  0: 0,
  1: 0.005,
  2: 0.01,
  3: 0.02,
};

/**
 * Resources eligible for the local-trade pass. Mirrors the trade phase's
 * tradable set, plus the small-volume goods listed in the implementation
 * plan that have observed prices via production inflow→supply chains.
 */
const LOCAL_TRADE_RESOURCES: readonly ResourceId[] = [
  resourceId('food.grain'),
  resourceId('food.flour'),
  resourceId('food.bread'),
  resourceId('food.wine'),
  resourceId('food.olive_oil'),
  resourceId('food.cheese'),
  resourceId('food.salted_fish'),
  resourceId('food.salted_meat'),
  resourceId('goods.cloth'),
  resourceId('goods.clothing'),
  resourceId('goods.furniture'),
  resourceId('goods.tools'),
  resourceId('food.olives'),
  resourceId('food.grapes'),
  resourceId('material.pottery'),
  resourceId('material.amphora'),
  resourceId('material.leather'),
  resourceId('material.linen_fiber'),
  resourceId('material.wood'),
  resourceId('material.charcoal'),
  resourceId('material.lumber'),
  resourceId('material.clay'),
  resourceId('metal.iron'),
  resourceId('exotic.spices'),
  resourceId('exotic.silk'),
  resourceId('exotic.incense'),
  resourceId('exotic.dyes'),
];

const LOCAL_TRADE_WEIGHT_KG_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, getResource(id).weightKgPerUnit] as const),
);

// --- Phase 5: Demographics --------------------------------------------------

/** Per-Settlement health record, keyed by reference for the same reason as faminePressure. */
const settlementHealthMap: WeakMap<Settlement, SettlementHealth> = new WeakMap();

const demographicsPhase = (
  world: WorldState,
  today: Day,
  rng: Rng,
  events: TickEvent[],
  stats: TickStats,
): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const rngLabel = `settle-${String(settlement.id)}`;
    // 1) Vital rates.
    tickDaily(settlement.population, ROMAN_VITAL_RATES, rng.derive(`${rngLabel}|vital`));

    // 2) Endemic mortality + epidemic.
    const tile = world.grid.get(settlement.anchor);
    if (tile === undefined) continue;
    const endemic = applyEndemicMortality(
      settlement.population,
      tile.climate,
      tile.terrain,
      rng.derive(`${rngLabel}|endemic`),
      today,
    );
    if (endemic.deaths > 0) {
      stats.baselineDeaths += endemic.deaths;
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
      rng.derive(`${rngLabel}|epidemic-spawn`),
      today,
    );
    if (trigger.triggered !== null) {
      stats.epidemicsTriggered += 1;
      events.push({
        type: 'epidemic_started',
        settlement: settlement.id,
        disease: trigger.triggered.id,
      });
    }
    const infRes =
      health.infections.size === 0
        ? { deaths: 0, recovered: 0 }
        : tickInfection(health, settlement.population, rng.derive(`${rngLabel}|infection`), today);
    if (infRes.deaths > 0) {
      stats.diseaseDeaths += infRes.deaths;
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

const politicsPhase = (world: WorldState, rng: Rng, today: Day, events: TickEvent[]): void => {
  // Reputation decay applies once per tick; entries below ε are pruned.
  world.reputation.decayTick(REPUTATION_HALF_LIFE_DAYS);
  // Caravan re-planning: every NPC caravan sitting at its destination
  // observes local prices, restocks its price book, and picks a new
  // destination via the NPC AI. Without this loop trade circulates
  // exactly ZERO after the seeded caravans complete their first leg —
  // the v1 baseline issue (see docs/06 §"Caravan lifecycle in the tick
  // loop").
  caravanReplanPhase(world, rng.derive('caravan-replan'), today, events);
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
  // Quarterly hook (every 90 days): each settlement's stockpile-owning
  // actors evaluate observed prices and invest in profitable buildings.
  // Per docs/15 §C4 — Stage 2 specialization. Without this, the
  // procgen seed is the FINAL building layout for the world's lifetime.
  if ((today + 1) % 90 === 0) {
    investmentPhase(world, today, events);
  }
  // Tax shipments: per docs/11 §"Taxes" + the codex review #2.
  // Governor assesses on harvest-tribute day (autumn) + monthly coin
  // assessments. Each non-zero owed becomes a real Caravan walking
  // toward the capital — bandits can ambush it, the road network
  // matters, etc.
  if (
    isHarvestTributeDay(today) ||
    isMonthlyAssessmentDay(today) ||
    (pendingTaxAssessmentsByWorld.get(world)?.length ?? 0) > 0
  ) {
    taxShipmentPhase(world, today, rng.derive('tax'), events);
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
const workerReallocationPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
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

const CARAVAN_RATION_RESERVE_DAYS = 21;

const CARAVAN_RATION_RESOURCES: ReadonlySet<string> = new Set([
  'food.bread',
  'food.flour',
  'food.grain',
  'food.legumes',
  'food.salted_meat',
  'food.salted_fish',
  'food.cheese',
]);

const caravanRationCargoKg = (c: Caravan): number => {
  let total = 0;
  for (const [resource, qty] of c.cargo) {
    if (!CARAVAN_RATION_RESOURCES.has(String(resource))) continue;
    total += Math.max(0, qty) * getResource(resource).weightKgPerUnit;
  }
  return total;
};

const caravanRationReserveKg = (c: Caravan): number =>
  dailyCrewRationKg(c) * CARAVAN_RATION_RESERVE_DAYS;

const caravanMissingRationReserveKg = (c: Caravan): number =>
  Math.max(0, caravanRationReserveKg(c) - caravanRationCargoKg(c));

const caravanRationDays = (c: Caravan): number => {
  const dailyKg = dailyCrewRationKg(c);
  if (dailyKg <= 0) return Number.POSITIVE_INFINITY;
  return caravanRationCargoKg(c) / dailyKg;
};

const caravanTradeCargoCapacityRemainingKg = (c: Caravan): number =>
  Math.max(0, totalCarryKg(c) - totalCargoWeightKg(c) - caravanMissingRationReserveKg(c));

const caravanSellableQuantity = (c: Caravan, resource: ResourceId, qty: number): number => {
  if (qty <= 0) return 0;
  if (!CARAVAN_RATION_RESOURCES.has(String(resource))) return qty;
  const surplusKg = caravanRationCargoKg(c) - caravanRationReserveKg(c);
  if (surplusKg <= 0) return 0;
  const weightKg = getResource(resource).weightKgPerUnit;
  if (weightKg <= 0) return qty;
  return Math.min(qty, surplusKg / weightKg);
};

const caravanHasMarketCargo = (c: Caravan): boolean => {
  for (const [resource, qty] of c.cargo) {
    if (caravanSellableQuantity(c, resource, qty) > 1e-9) return true;
  }
  return false;
};

interface LocalBuyerQuote {
  readonly settlement: Settlement;
  readonly actor: Actor;
  readonly price: number;
}

interface LocalSellerQuote {
  readonly settlement: Settlement;
  readonly actor: Actor;
  readonly price: number;
  readonly stock: number;
}

const localSellerQuotes = (
  world: WorldState,
  settlements: readonly Settlement[],
  resource: ResourceId,
): LocalSellerQuote[] => {
  const quotes: LocalSellerQuote[] = [];
  for (const settlement of settlements) {
    const price = settlement.market.lastClearingPrice.get(resource);
    if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
    for (const ownerId of settlement.stockpileOwners) {
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const stock = actor.stockpile.get(resource) ?? 0;
      if (stock <= 0) continue;
      quotes.push({ settlement, actor, price, stock });
    }
  }
  quotes.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    if (b.stock !== a.stock) return b.stock - a.stock;
    return String(a.actor.id).localeCompare(String(b.actor.id));
  });
  return quotes;
};

const localSupplyAvailabilityByResource = (
  world: WorldState,
  settlements: readonly Settlement[],
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  for (const settlement of settlements) {
    for (const resource of settlement.market.lastClearingPrice.keys()) {
      const price = settlement.market.lastClearingPrice.get(resource);
      if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
      let total = 0;
      for (const ownerId of settlement.stockpileOwners) {
        const actor = world.actors.get(ownerId);
        if (actor === undefined) continue;
        total += Math.max(0, actor.stockpile.get(resource) ?? 0);
      }
      if (total > 0) out.set(resource, (out.get(resource) ?? 0) + total);
    }
  }
  return out;
};

const bestLocalBuyer = (
  world: WorldState,
  settlements: readonly Settlement[],
  caravan: Caravan,
  resource: ResourceId,
): LocalBuyerQuote | null => {
  let best: LocalBuyerQuote | null = null;
  for (const settlement of settlements) {
    const price = settlement.market.lastClearingPrice.get(resource);
    if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
    for (const ownerId of settlement.stockpileOwners) {
      if (ownerId === caravan.ownerActor) continue;
      const actor = world.actors.get(ownerId);
      if (actor === undefined || actor.treasury <= 0) continue;
      if (
        best === null ||
        price > best.price ||
        (price === best.price && actor.treasury > best.actor.treasury)
      ) {
        best = { settlement, actor, price };
      }
    }
  }
  return best;
};

const sellCaravanCargoAtLocalMarkets = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): void => {
  for (const [resource, currentQty] of Array.from(caravan.cargo.entries())) {
    const sellableQty = caravanSellableQuantity(caravan, resource, currentQty);
    if (sellableQty <= 1e-9) continue;
    const buyer = bestLocalBuyer(world, settlements, caravan, resource);
    if (buyer === null) continue;
    const maxByTreasury = buyer.actor.treasury / buyer.price;
    const qty = Math.min(sellableQty, maxByTreasury);
    if (qty <= 1e-9) continue;
    const coin = qty * buyer.price;
    const remaining = currentQty - qty;
    if (remaining > 1e-9) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    caravan.treasury += coin;
    buyer.actor.treasury -= coin;
    increaseStockpile(buyer.actor, resource, qty);
    recordInflow(buyer.settlement, resource, qty);
    events.push({
      type: 'caravan_traded',
      caravan: caravan.id,
      settlement: buyer.settlement.id,
      side: 'sold',
      resource,
      quantity: qty,
      coin,
    });
  }
};

const buyPlannedCargoAtLocalMarkets = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  cargoPlan: ReadonlyMap<ResourceId, Quantity>,
  events: TickEvent[],
): number => {
  let boughtUnits = 0;
  for (const [resource, targetQty] of cargoPlan) {
    if (targetQty <= 0) continue;
    const weightKg = getResource(resource).weightKgPerUnit;
    const quotes = localSellerQuotes(world, settlements, resource);
    let remainingTarget = targetQty;
    for (const seller of quotes) {
      if (remainingTarget <= 1e-9) break;
      const capacityRemainingKg = caravanTradeCargoCapacityRemainingKg(caravan);
      if (capacityRemainingKg <= 1e-9) break;
      const maxByCapacity = weightKg > 0 ? capacityRemainingKg / weightKg : remainingTarget;
      const sameOwner = seller.actor.id === caravan.ownerActor;
      const maxByTreasury = sameOwner ? remainingTarget : caravan.treasury / seller.price;
      const qty = Math.min(remainingTarget, seller.stock, maxByCapacity, maxByTreasury);
      if (qty <= 1e-9) continue;
      const coin = sameOwner ? 0 : qty * seller.price;
      decreaseStockpile(seller.actor, resource, qty);
      increaseCaravanCargo(caravan, resource, qty);
      if (!sameOwner) {
        caravan.treasury -= coin;
        seller.actor.treasury += coin;
      }
      recordOutflow(seller.settlement, resource, qty);
      remainingTarget -= qty;
      boughtUnits += qty;
      events.push({
        type: 'caravan_traded',
        caravan: caravan.id,
        settlement: seller.settlement.id,
        side: 'bought',
        resource,
        quantity: qty,
        coin,
      });
    }
  }
  return boughtUnits;
};

const buyCaravanRationsAtLocalMarkets = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): number => {
  const targetKg = dailyCrewRationKg(caravan) * CARAVAN_RATION_RESERVE_DAYS;
  let remainingKg = targetKg - caravanRationCargoKg(caravan);
  if (remainingKg <= 1e-9) return 0;

  const quotes: Array<{
    readonly resource: ResourceId;
    readonly seller: LocalSellerQuote;
    readonly weightKgPerUnit: number;
    readonly pricePerKg: number;
  }> = [];
  for (const resourceKey of CARAVAN_RATION_RESOURCES) {
    const resource = resourceId(resourceKey);
    const weightKgPerUnit = getResource(resource).weightKgPerUnit;
    if (weightKgPerUnit <= 0) continue;
    for (const seller of localSellerQuotes(world, settlements, resource)) {
      quotes.push({
        resource,
        seller,
        weightKgPerUnit,
        pricePerKg: seller.price / weightKgPerUnit,
      });
    }
  }
  quotes.sort((a, b) => {
    if (a.pricePerKg !== b.pricePerKg) return a.pricePerKg - b.pricePerKg;
    return String(a.resource).localeCompare(String(b.resource));
  });

  let boughtKg = 0;
  for (const quote of quotes) {
    if (remainingKg <= 1e-9) break;
    const capacityRemainingKg = Math.max(0, totalCarryKg(caravan) - totalCargoWeightKg(caravan));
    if (capacityRemainingKg <= 1e-9) break;
    const sameOwner = quote.seller.actor.id === caravan.ownerActor;
    const maxByNeed = remainingKg / quote.weightKgPerUnit;
    const maxByCapacity = capacityRemainingKg / quote.weightKgPerUnit;
    const maxByTreasury = sameOwner ? maxByNeed : caravan.treasury / quote.seller.price;
    const qty = Math.min(maxByNeed, maxByCapacity, maxByTreasury, quote.seller.stock);
    if (qty <= 1e-9) continue;
    const coin = sameOwner ? 0 : qty * quote.seller.price;
    decreaseStockpile(quote.seller.actor, quote.resource, qty);
    increaseCaravanCargo(caravan, quote.resource, qty);
    if (!sameOwner) {
      caravan.treasury -= coin;
      quote.seller.actor.treasury += coin;
    }
    recordOutflow(quote.seller.settlement, quote.resource, qty);
    remainingKg -= qty * quote.weightKgPerUnit;
    boughtKg += qty * quote.weightKgPerUnit;
    events.push({
      type: 'caravan_traded',
      caravan: caravan.id,
      settlement: quote.seller.settlement.id,
      side: 'bought',
      resource: quote.resource,
      quantity: qty,
      coin,
    });
  }

  return boughtKg;
};

const increaseCaravanCargo = (caravan: Caravan, resource: ResourceId, qty: Quantity): void => {
  if (qty <= 0) return;
  caravan.cargo.set(resource, (caravan.cargo.get(resource) ?? 0) + qty);
};

const completeOffMapExportIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
  events: TickEvent[],
): boolean => {
  if (caravan.destination === null) return false;
  if (!hexEquals(caravan.position, caravan.destination)) return false;
  if (!edgeHexKeys.has(hexKey(caravan.position))) return false;
  let exportedAny = false;
  for (const [resource, qty] of Array.from(caravan.cargo.entries())) {
    const price = DEFAULT_GLOBAL_PRICES.get(resource);
    if (price === undefined || price <= 0 || qty <= 0) continue;
    const coin = qty * price;
    const owner = world.actors.get(caravan.ownerActor);
    if (owner !== undefined) owner.treasury += coin;
    else caravan.treasury += coin;
    caravan.cargo.delete(resource);
    exportedAny = true;
    events.push({
      type: 'caravan_exported_off_map',
      caravan: caravan.id,
      resource,
      quantity: qty,
      coin,
    });
  }
  if (exportedAny && caravan.cargo.size === 0) {
    world.caravans.delete(caravanId);
    return true;
  }
  return false;
};

const knownBanditDensityForCaravans = (world: WorldState): Map<string, number> => {
  const out = new Map<string, number>();
  if (world.banditCamps === undefined) return out;
  for (const camp of world.banditCamps.values()) {
    if (camp.banditCount <= 0) continue;
    const perHexRisk = Math.min(0.08, camp.banditCount / 5_000);
    if (perHexRisk <= 0) continue;
    for (const h of hexesWithinRange(camp.hex, 6)) {
      const key = hexKey(h);
      out.set(key, Math.max(out.get(key) ?? 0, perHexRisk));
    }
  }
  return out;
};

const caravanReplanPhase = (world: WorldState, rng: Rng, today: Day, events: TickEvent[]): void => {
  const settlementIndex = settlementAnchorIndexForWorld(world);
  const candidates = settlementIndex.candidates;
  const edgeHexKeys = new Set(computeEdgeHexes(world.grid).map(hexKey));
  const knownBanditDensity = knownBanditDensityForCaravans(world);

  const nearestDifferentCandidate = (from: Hex): (typeof candidates)[number] | undefined => {
    let best: (typeof candidates)[number] | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (hexEquals(candidate.hex, from)) continue;
      const distance = hexDistance(from, candidate.hex);
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          (best === undefined || String(candidate.id).localeCompare(String(best.id)) < 0))
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  };

  // Build a city-anchor lookup once per phase for goal-completion checks.
  const settlementAnchorByCity = new Map<SettlementId, Hex>();
  for (const s of world.settlements.values()) settlementAnchorByCity.set(s.id, s.anchor);

  for (const [cId, c] of Array.from(world.caravans.entries())) {
    if (completeOffMapExportIfArrived(world, cId, c, edgeHexKeys, events)) continue;

    // Per docs/15 §C18: if this caravan has a goalStack, advance it
    // BEFORE the legacy single-destination logic. When the top goal
    // completes, pop and adopt the next goal's implied destination.
    if (c.goalStack !== undefined && c.goalStack.length > 0) {
      while (c.goalStack.length > 0) {
        const top = peekGoal(c.goalStack) as Goal;
        if (!isGoalComplete(top, c.position, { settlementAnchorByCity })) break;
        popGoal(c.goalStack);
      }
      const next = peekGoal(c.goalStack);
      if (next !== undefined) {
        // Adopt the goal's implied destination so the existing movement
        // engine drives the caravan toward it. trade_at + return_home +
        // flee_to + move_to all imply a hex; escort + patrol use the
        // active route logic in the patrol/conflict layer.
        const dest = goalDestination(next, settlementAnchorByCity);
        if (dest !== null) c.destination = dest;
      }
    }
    if (c.destination === null) continue;
    if (!hexEquals(c.position, c.destination)) continue; // not yet arrived

    // 1. Record observed local prices into caravan's price book. The
    // priceBook key is the hex (the merchant remembers "this is what
    // bread cost in town X"); when multiple settlements share a hex we
    // average their clearing prices for each resource so the order in
    // which settlements were inserted into world.settlements does not
    // change what the caravan remembers.
    const localBucket = settlementIndex.byAnchorHex.get(hexKey(c.position));
    if (localBucket !== undefined && localBucket.length > 0) {
      const sumByResource = new Map<ResourceId, { sum: number; count: number }>();
      for (const local of localBucket) {
        for (const [resource, price] of local.market.lastClearingPrice) {
          if (!Number.isFinite(price) || price <= 0) continue;
          const acc = sumByResource.get(resource);
          if (acc === undefined) sumByResource.set(resource, { sum: price, count: 1 });
          else {
            acc.sum += price;
            acc.count += 1;
          }
        }
      }
      for (const [resource, { sum, count }] of sumByResource) {
        const avg = sum / count;
        let book = c.priceBook.get(resource);
        if (book === undefined) {
          book = new Map<string, { price: number; observedOnDay: Day }>();
          c.priceBook.set(resource, book);
        }
        book.set(`${c.position.q},${c.position.r}`, { price: avg, observedOnDay: today });
      }
      sellCaravanCargoAtLocalMarkets(world, c, localBucket, events);
      buyCaravanRationsAtLocalMarkets(world, c, localBucket, events);
    }

    // Per docs/15 §C17: deposit observations into the local guild's
    // ledger if the caravan owner is a member of any guild. Read the
    // freshest collective observations BACK into the priceBook so the
    // departing caravan inherits other members' recent intel.
    syncCaravanWithLocalGuild(world, c, today);

    if (candidates.length < 2) continue;

    const originAvailability =
      localBucket === undefined ? undefined : localSupplyAvailabilityByResource(world, localBucket);
    const missingRationKg = caravanMissingRationReserveKg(c);

    // 2. Plan next route.
    const plan = planCaravanRoute({
      caravan: c,
      candidateSettlements: candidates,
      knownPrices: c.priceBook,
      knownBanditDensity,
      knownToll: () => 0, // v1: no toll signal yet
      cargoConstraints: {
        reserveCapacityKg: missingRationKg,
        // Keep enough cash to buy the missing survival reserve later. This
        // uses the same 1 coin/kg ration-cost approximation as the planner's
        // travel-cost model, so cargo demand is cash-feasible instead of
        // spending the caravan into starvation.
        maxSpendCoin: Math.max(0, c.treasury - missingRationKg),
        ...(originAvailability !== undefined
          ? { originAvailableQuantity: originAvailability }
          : {}),
      },
      includeReason: false,
      rng: rng.derive(String(cId)),
    });

    if (plan !== null) {
      const boughtUnits =
        localBucket === undefined
          ? 0
          : buyPlannedCargoAtLocalMarkets(world, c, localBucket, plan.cargoToCarry, events);
      const rationDays = caravanRationDays(c);
      if (boughtUnits <= 1e-9 && !caravanHasMarketCargo(c)) {
        const rngHere = rng.derive(`${String(cId)}-fallback`);
        const nearest = rationDays < 7 ? nearestDifferentCandidate(c.position) : undefined;
        if (nearest !== undefined) {
          c.destination = { q: nearest.hex.q, r: nearest.hex.r };
        } else {
          const filtered = candidates.filter((s) => !hexEquals(s.hex, c.position));
          if (filtered.length <= 0) continue;
          const pick = rngHere.pick(filtered);
          c.destination = { q: pick.hex.q, r: pick.hex.r };
        }
        continue;
      }
      if (rationDays + 1e-9 < plan.estimatedDays) {
        const nearest = nearestDifferentCandidate(c.position);
        if (nearest !== undefined) {
          c.destination = { q: nearest.hex.q, r: nearest.hex.r };
          continue;
        }
      }
      // Set new destination. Cargo isn't restocked here (that's a market
      // operation handled above); the planner's expected profit reflects
      // what it expects to be able to load.
      c.destination = plan.destination;
    } else {
      // No profitable plan — usually because the caravan has empty cargo
      // and/or hasn't observed enough destinations to compute spreads.
      // Fall back to "scout to a random different settlement" so the
      // caravan keeps moving and accumulates price observations. This is
      // what unspecialized merchants did historically: travel to gossip
      // and find out where prices are good.
      const rationDays = caravanRationDays(c);
      const nearest = rationDays < 7 ? nearestDifferentCandidate(c.position) : undefined;
      if (nearest !== undefined) {
        c.destination = { q: nearest.hex.q, r: nearest.hex.r };
      } else {
        const rngHere = rng.derive(`${String(cId)}-fallback`);
        const filtered = candidates.filter((s) => !hexEquals(s.hex, c.position));
        if (filtered.length <= 0) continue;
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
// Recruitment rates: tuned ~5× the v1 starting numbers because the original
// constants left typical villages contributing < 0.01 recruits/day each
// (i.e. one new bandit every ~100+ village-days), which kept camps tiny and
// the bandit population invisible in the viewer over months of real
// playtime. The new rates give a normal 200-adult village ~1 recruit every
// 30–50 days; a famine-stricken (`isPoor`) village contributes one every
// 3–5 days. Still slow at the per-day scale but visible over a season.
const BASE_RECRUIT_FRAC_PER_DAY = 0.0025;
const POOR_VILLAGE_RECRUIT_BOOST = 4;
/**
 * Per-camp soft cap. Beyond this size a camp is no longer recruiting (it's
 * conspicuous, food logistics break down, and historically warlord bands
 * fragmented at this scale). Recruits go to the next-nearest camp under
 * the cap, or the recruitment skips for that day.
 */
const CAMP_RECRUIT_CAP = 500;

const banditPhase = (world: WorldState, rng: Rng, today: Day, events: TickEvent[]): void => {
  // Don't early-exit when banditCamps is empty: recruitFromIdle below is
  // the only path by which the world's bandit population can recover from
  // zero (after patrols wipe out the seeded camps).
  if (world.banditCamps === undefined) return;
  const settlementIndex = settlementAnchorIndexForWorld(world);

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
      const atSettlement = settlementIndex.byAnchorHex.has(hexKey(c.position));
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
          if (a !== undefined && (a.kind === 'governor_office' || a.kind === 'city_corporation')) {
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
      const caravanCrewWiped = totalCrewCount(target) <= 0;

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
      if (caravanCrewWiped) {
        world.caravans.delete(target.id);
        events.push({
          type: 'caravan_disbanded',
          caravan: target.id,
          at: { q: target.position.q, r: target.position.r },
          reason: 'zero_crew',
        });
      }
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
      const share = Math.round(
        (p.unit.count / totalPatrolCount) * result.settlementCasualties.defenderDeaths,
      );
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
  const dest = nearestSettlementWithinRange(
    world,
    target.anchor,
    NEWS_CARRIER_MAX_DESTINATION_HEXES,
  );
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
    settlement.population.forEachCohort((key, c) => {
      if (key.age === age && c > 0) snap.push([key, c]);
    });
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

const recruitFromIdle = (world: WorldState, rng: Rng, _today: Day, events: TickEvent[]): void => {
  // Note: we don't early-exit on banditCamps.size === 0. When patrols wipe
  // all camps, the founding branch below is the ONLY way the world's
  // bandit population can recover — exiting here would freeze the world
  // in a no-bandits state forever.
  if (world.banditCamps === undefined) return;
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const adults = adultPopulation(settlement);
    if (adults <= 0) continue;
    // Pressure pool ≈ adults × jobless fraction. Default 8% of adults are
    // "idle-ish" enough to be recruited; 25% in food-shortfall villages.
    // Bumped from 5%/20% in tandem with BASE_RECRUIT_FRAC_PER_DAY so the
    // bandit population is observable in the viewer.
    const isPoor = (faminePressure.get(settlement)?.consecutiveShortageDays ?? 0) >= 1;
    const pressureFraction = isPoor ? 0.25 : 0.08;
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
const foundNewCamp = (world: WorldState, near: Settlement, rng: Rng): BanditCampId | null => {
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
        if (tile.terrain === 'lake' || tile.terrain === 'river' || tile.terrain === 'urban') {
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
    settlement.population.forEachCohort((key, c) => {
      if (key.age === age && c > 0) snap.push([key, c]);
    });
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

  const dest = nearestSettlementWithinRange(
    world,
    caravan.position,
    NEWS_CARRIER_MAX_DESTINATION_HEXES,
  );
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

  // Index settlements by anchor hex once per call. Multiple settlements may
  // share a hex (the pagus + dependent-hamlets case from docs/05 §"Same-hex
  // coexistence"). The carrier physically arrives at the hex and would
  // talk to whoever it finds there — but processNewsArrival's receiver
  // list is `charactersAtSettlement`, which is itself hex-keyed (via
  // NamedCharacter.location), so calling processNewsArrival once per
  // same-hex settlement would apply the SAME reputation deltas to the
  // SAME characters multiple times. To avoid that double-counting we
  // process the carrier once against the FIRST same-hex settlement; the
  // settlement reference is otherwise diagnostic-only inside
  // processNewsArrival (per its docstring). The "settlement event log"
  // semantics from docs/13 §5 will fan out to all same-hex settlements
  // when that log lands.
  const settlementsByAnchor = new Map<string, Settlement[]>();
  for (const s of world.settlements.values()) {
    const k = `${s.anchor.q},${s.anchor.r}`;
    let bucket = settlementsByAnchor.get(k);
    if (bucket === undefined) {
      bucket = [];
      settlementsByAnchor.set(k, bucket);
    }
    bucket.push(s);
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
    const destBucket = settlementsByAnchor.get(destKey);
    if (destBucket === undefined || destBucket.length === 0) {
      // Carrier arrived somewhere with no settlement (shouldn't happen
      // since we picked anchors as destinations) — drop it.
      world.newsCarriers.delete(id);
      continue;
    }
    // Process against the first same-hex settlement (see comment above).
    const settlement = destBucket[0]!;
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
const patrolPhase = (world: WorldState, rng: Rng, today: Day, events: TickEvent[]): void => {
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
    const knownCaravans: {
      caravanId: CaravanId;
      ownerActor: ActorId;
      hex: Hex;
      suspicious: boolean;
    }[] = [];
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

    // Trail wear from the patrol step. Soldier-on-foot weight per docs/06.
    if (!hexEquals(patrol.position, result.patrol.position)) {
      addRoadWear(
        world,
        result.patrol.position,
        result.patrol.unit.count * WEAR_PER_PATROL_SOLDIER,
      );
    }

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
      const magnitude: ReputationMagnitude = outcome === 'patrol_won' ? 'severe' : 'moderate';
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

// --- Construction phase (docs/08 §"Construction is heavy", docs/15 §C8) -

/**
 * Each tick, drain mason + carpenter worker-days from each settlement's
 * jobAllocations toward its pendingBuildings (FIFO). When a building's
 * workerDaysRemaining hits 0, materialize it via addBuilding and remove
 * the pending entry. The pending building's hex MUST still be valid at
 * completion (catchment recompute can have shrunk the catchment); if it
 * isn't, the build aborts and the resources are lost (an unfortunate
 * but realistic outcome — the patron whose smithy site got abandoned
 * for the new town wall has to write off the lumber).
 */
const constructionPhase = (world: WorldState, today: Day, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.pendingBuildings.length === 0) continue;
    const wagePriceSignal = wagePriceSignalForSettlement(settlement);
    const laborClassContext = buildLaborClassContext(settlement);
    // Per docs/15 §C14: mason and carpenter pools drain INDEPENDENTLY.
    // A granary (heavy stone+brick) bottleneck on masons, a smithy
    // (heavy lumber) bottlenecks on carpenters.
    const shouldCapByClass = laborClassContext.totalWorkingAdults > 0;
    let masonBudget = settlement.jobAllocations.get(jobId('mason')) ?? 0;
    let carpenterBudget = settlement.jobAllocations.get(jobId('carpenter')) ?? 0;
    if (shouldCapByClass) {
      masonBudget = Math.min(
        masonBudget,
        allocatedWorkersForJob(laborClassContext, jobId('mason')),
      );
      carpenterBudget = Math.min(
        carpenterBudget,
        allocatedWorkersForJob(laborClassContext, jobId('carpenter')),
      );
    }
    if (masonBudget <= 0 && carpenterBudget <= 0) continue;

    const completed: number[] = [];
    for (let i = 0; i < settlement.pendingBuildings.length; i++) {
      const pb = settlement.pendingBuildings[i] as PendingBuilding;
      const owner = world.actors.get(pb.ownerActor);
      let masonApplied = 0;
      let carpenterApplied = 0;
      // Mason work first.
      if (pb.masonDaysRemaining !== undefined && pb.masonDaysRemaining > 0 && masonBudget > 0) {
        const apply = Math.min(masonBudget, pb.masonDaysRemaining);
        pb.masonDaysRemaining -= apply;
        pb.workerDaysRemaining -= apply;
        masonBudget -= apply;
        masonApplied += apply;
      }
      // Then carpenter work.
      if (
        pb.carpenterDaysRemaining !== undefined &&
        pb.carpenterDaysRemaining > 0 &&
        carpenterBudget > 0
      ) {
        const apply = Math.min(carpenterBudget, pb.carpenterDaysRemaining);
        pb.carpenterDaysRemaining -= apply;
        pb.workerDaysRemaining -= apply;
        carpenterBudget -= apply;
        carpenterApplied += apply;
      }
      // Legacy projects without the split: drain from combined pool.
      if (pb.masonDaysRemaining === undefined && pb.carpenterDaysRemaining === undefined) {
        const combined = masonBudget + carpenterBudget;
        if (combined > 0) {
          const apply = Math.min(combined, pb.workerDaysRemaining);
          pb.workerDaysRemaining -= apply;
          // Drain proportionally.
          const masonShare = combined > 0 ? masonBudget / combined : 0;
          const legacyMasonApplied = apply * masonShare;
          const legacyCarpenterApplied = apply * (1 - masonShare);
          masonBudget -= legacyMasonApplied;
          carpenterBudget -= legacyCarpenterApplied;
          masonApplied += legacyMasonApplied;
          carpenterApplied += legacyCarpenterApplied;
        }
      }
      if (owner !== undefined && (masonApplied > 0 || carpenterApplied > 0)) {
        payProductionWages(
          world,
          settlement,
          laborClassContext,
          owner,
          new Map([
            [jobId('mason'), masonApplied],
            [jobId('carpenter'), carpenterApplied],
          ]),
          wagePriceSignal,
        );
      }
      if (pb.workerDaysRemaining <= 0) completed.push(i);
      if (masonBudget <= 0 && carpenterBudget <= 0) break;
    }
    // Materialize completed builds in reverse index order so splice is safe.
    for (let j = completed.length - 1; j >= 0; j--) {
      const idx = completed[j] as number;
      const pb = settlement.pendingBuildings[idx] as PendingBuilding;
      // Catchment may have shrunk; check the hex is still in this
      // settlement before adding.
      const stillValid =
        settlement.urbanHexes.some((u) => hexEquals(u, pb.hex)) ||
        settlement.catchmentHexes.some((c) => hexEquals(c, pb.hex));
      settlement.pendingBuildings.splice(idx, 1);
      if (!stillValid) continue;
      const def = getBuilding(pb.buildingId);
      addBuilding(settlement, {
        buildingId: pb.buildingId,
        hex: pb.hex,
        ownerActor: pb.ownerActor,
        capacity: def.capacityUnits,
        maxCapacity: def.capacityUnits,
        daysSinceMaintained: 0,
      });
      events.push({
        type: 'building_completed',
        settlement: settlement.id,
        building: pb.buildingId,
        ownerActor: pb.ownerActor,
        daysToBuild: today - pb.beganOnDay,
      });
    }
  }
};

// --- Investment phase (docs/15 §C4 — Stage 2 specialization) --------------

/**
 * Quarterly per-settlement investment.
 *
 * For each settlement, find a single owner-actor and a single recipe
 * such that:
 *   1. The recipe's building isn't already at full daily capacity in
 *      the settlement.
 *   2. Expected daily profit (revenue - input cost) at the last
 *      observed clearing prices is positive.
 *   3. The actor has the resources in stockpile to pay the building's
 *      construction cost.
 *
 * If multiple recipes qualify, pick the one with the highest profit /
 * construction-cost-in-coin ratio. Cap to one investment per settlement
 * per quarter so a runaway profitable recipe doesn't balloon a city
 * with a hundred bakeries in one year.
 *
 * The new building goes on a settlement-owned hex with no existing
 * building of that type. Free urban hex preferred; first catchment hex
 * as fallback.
 */
const investmentPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    const owner = pickInvestor(world, settlement);
    if (owner === undefined) continue;

    const candidates = scoreInvestmentCandidates(settlement, owner);
    if (candidates.length === 0) continue;
    const best = candidates[0] as ScoredInvestment;
    if (best.profitPerDay <= 0) continue;
    if (best.profitPerDay / Math.max(1, best.coinCost) < INVESTMENT_ROI_THRESHOLD) continue;

    const placement = pickBuildingHex(world, settlement, best.buildingId);
    if (placement === null) continue;

    const def = getBuilding(best.buildingId);

    // Pay construction: drain inputs from owner's stockpile. We've already
    // confirmed sufficiency in scoreInvestmentCandidates; do it
    // unconditionally here.
    for (const [resId, qty] of def.constructionCost) {
      const have = owner.stockpile.get(resId) ?? 0;
      const remaining = have - qty;
      if (remaining > 1e-9) owner.stockpile.set(resId, remaining);
      else owner.stockpile.delete(resId);
    }

    // Per docs/08 §"Construction is heavy" + docs/15 §C8: don't add the
    // building immediately. Push a pendingBuilding; the construction
    // phase drains mason + carpenter worker-days each tick until done.
    // Per docs/15 §C14: split worker-days into mason (stone/brick work)
    // vs. carpenter (lumber work) pools per construction-cost mix.
    const totalDays = constructionWorkerDays(def.id);
    const masonShare = computeMasonShare(def.id);
    const masonDays = Math.round(totalDays * masonShare);
    const carpenterDays = totalDays - masonDays;
    settlement.pendingBuildings.push({
      buildingId: def.id,
      hex: placement,
      ownerActor: owner.id,
      beganOnDay: _today,
      workerDaysRemaining: totalDays,
      workerDaysTotal: totalDays,
      masonDaysRemaining: masonDays,
      carpenterDaysRemaining: carpenterDays,
    });

    events.push({
      type: 'building_invested',
      settlement: settlement.id,
      building: def.id,
      ownerActor: owner.id,
      costCoin: best.coinCost,
    });
  }
};

interface ScoredInvestment {
  readonly buildingId: BuildingId;
  readonly profitPerDay: number;
  readonly coinCost: number;
}

/** ROI threshold (profit per coin per day). 0.005 ≈ ~180% APR — a
 *  reasonable Roman-era ROI for new productive capacity. */
const INVESTMENT_ROI_THRESHOLD = 0.005;

const PROFITABLE_OWNER_KINDS: readonly Actor['kind'][] = [
  'patrician_family',
  'free_village',
  'city_corporation',
  'governor_office',
  'hamlet_household',
];

const pickInvestor = (world: WorldState, settlement: Settlement): Actor | undefined => {
  let best: Actor | undefined;
  let bestTreasury = -1;
  for (const oId of settlement.stockpileOwners) {
    const a = world.actors.get(oId);
    if (a === undefined) continue;
    if (!PROFITABLE_OWNER_KINDS.includes(a.kind)) continue;
    if (a.treasury <= bestTreasury) continue;
    best = a;
    bestTreasury = a.treasury;
  }
  return best;
};

const scoreInvestmentCandidates = (settlement: Settlement, owner: Actor): ScoredInvestment[] => {
  const out: ScoredInvestment[] = [];
  // Local existing buildings by type — for "saturation" check.
  const existingByType = new Map<BuildingId, number>();
  for (const b of settlement.buildings) {
    existingByType.set(b.buildingId, (existingByType.get(b.buildingId) ?? 0) + 1);
  }

  for (const recipe of allRecipes()) {
    // Compute revenue at last clearing prices.
    let revenue = 0;
    let revenueValid = true;
    for (const [resId, qty] of recipe.outputs) {
      const price = settlement.market.lastClearingPrice.get(resId);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        revenueValid = false;
        break;
      }
      revenue += qty * price;
    }
    if (!revenueValid) continue;

    let cost = 0;
    let costValid = true;
    for (const [resId, qty] of recipe.inputs) {
      const price = settlement.market.lastClearingPrice.get(resId);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        costValid = false;
        break;
      }
      cost += qty * price;
    }
    if (!costValid) continue;

    const profitPerDay = revenue - cost;
    if (profitPerDay <= 0) continue;

    // Construction cost in coin (using local prices).
    const def = getBuilding(recipe.building);
    let coinCost = 0;
    let payable = true;
    for (const [resId, qty] of def.constructionCost) {
      const have = owner.stockpile.get(resId) ?? 0;
      if (have < qty) {
        payable = false;
        break;
      }
      const price = settlement.market.lastClearingPrice.get(resId) ?? 1;
      coinCost += qty * price;
    }
    if (!payable) continue;

    // Saturation: don't add a building if the type is already abundant.
    const existingCount = existingByType.get(recipe.building) ?? 0;
    if (existingCount >= MAX_BUILDINGS_OF_TYPE) continue;

    out.push({ buildingId: recipe.building, profitPerDay, coinCost });
  }

  // Sort by profit / coinCost (descending).
  out.sort(
    (a, b) => b.profitPerDay / Math.max(1, b.coinCost) - a.profitPerDay / Math.max(1, a.coinCost),
  );
  return out;
};

const MAX_BUILDINGS_OF_TYPE = 6;

/**
 * Worker-days required to construct a building. Heuristic by building cost:
 * sum of constructionCost units, scaled by a per-building factor. Roughly:
 * - simple wood/tools structures (farm, pasture): ~30 worker-days
 * - brick/stone workshops (mill, bakery, smithy): ~60 worker-days
 * - large industrial (bloomery, charcoal_kiln, granary): ~90 worker-days
 *
 * Caps the multiplier so a typo in constructionCost doesn't make a
 * building take a year. Per docs/08 §"Construction is heavy" + docs/15
 * §C8.
 */
const constructionWorkerDays = (id: BuildingId): number => {
  const def = getBuilding(id);
  let totalUnits = 0;
  for (const qty of def.constructionCost.values()) totalUnits += qty;
  // Each cost unit ≈ ~5 worker-days on average. Floor 30, cap 90.
  const raw = Math.round(totalUnits * 5);
  return Math.max(30, Math.min(90, raw));
};

/**
 * Per docs/15 §C14: fraction of a building's construction labor that
 * masons handle (vs. carpenters). Derived from the construction-cost
 * mix: stone + brick + cut_stone weight → masons; lumber + wood
 * weight → carpenters. Default 0.5 if neither weighs in.
 */
const computeMasonShare = (id: BuildingId): number => {
  const def = getBuilding(id);
  let masonWeight = 0;
  let carpenterWeight = 0;
  for (const [r, qty] of def.constructionCost) {
    const k = String(r);
    if (k === 'material.stone' || k === 'material.cut_stone' || k === 'material.brick_tile') {
      masonWeight += qty;
    } else if (k === 'material.lumber' || k === 'material.wood') {
      carpenterWeight += qty;
    }
  }
  const total = masonWeight + carpenterWeight;
  if (total <= 0) return 0.5;
  return masonWeight / total;
};

/** Building types that need productive land — placed on a catchment hex.
 *  Everything else is a workshop / store and lives in the urban core. */
const LAND_USE_BUILDINGS = new Set<string>([
  'farm',
  'pasture',
  'olive_grove',
  'vineyard',
  'orchard',
  'fishery',
  'mine',
  'quarry',
  'forester_camp',
]);

const isPassableForBuilding = (world: WorldState, hex: Hex): boolean => {
  const t = world.grid.get(hex);
  if (t === undefined) return false;
  // Per the user's model: only lakes (huge water bodies that fully
  // occupy a hex) block building; rivers are smaller than 1 km so a
  // river hex still has plenty of riverbank for a structure.
  // Mountains + dense_forest are too rugged for normal workshop builds.
  if (t.terrain === 'lake') return false;
  if (t.terrain === 'mountains') return false;
  if (t.terrain === 'dense_forest') return false;
  return true;
};

const pickBuildingHex = (
  world: WorldState,
  settlement: Settlement,
  buildingId: BuildingId,
): Hex | null => {
  const occupied = new Set<string>();
  for (const b of settlement.buildings) {
    if (b.buildingId === buildingId) {
      occupied.add(`${b.hex.q},${b.hex.r}`);
    }
  }
  // Per the user's note: workshops (mill, smithy, kiln, etc.) belong inside
  // the village/city. Land-use buildings (farm, mine, forester) need
  // catchment land. Filter both for passable terrain.
  const isLandUse = LAND_USE_BUILDINGS.has(String(buildingId));
  if (isLandUse) {
    for (const c of settlement.catchmentHexes) {
      if (occupied.has(`${c.q},${c.r}`)) continue;
      if (!isPassableForBuilding(world, c)) continue;
      return c;
    }
    // Fallback: urban hex (rare — only when catchment is fully claimed).
    for (const u of settlement.urbanHexes) {
      if (occupied.has(`${u.q},${u.r}`)) continue;
      if (!isPassableForBuilding(world, u)) continue;
      return u;
    }
  } else {
    for (const u of settlement.urbanHexes) {
      if (occupied.has(`${u.q},${u.r}`)) continue;
      if (!isPassableForBuilding(world, u)) continue;
      return u;
    }
    for (const c of settlement.catchmentHexes) {
      if (occupied.has(`${c.q},${c.r}`)) continue;
      if (!isPassableForBuilding(world, c)) continue;
      return c;
    }
  }
  return null;
};

// --- Annual hook ------------------------------------------------------------

/**
 * Empty settlements disappear (locked rule, docs/05 §"Growth and decay").
 * When a settlement's population reaches 0, the settlement is removed
 * the next daily tick. All buildings vanish with the settlement object.
 * Catchment hexes have `ownerActor` cleared (back to wilderness). Urban
 * hexes have `ownerActor` cleared AND have their terrain converted to
 * `ruin` (the abandoned town is now physically a ruin, potentially
 * re-discoverable later as a hidden feature). Stockpile actors survive
 * on `world.actors` with whatever goods they had.
 *
 * Runs daily so the settlement disappears immediately when pop hits 0,
 * not at the next year boundary.
 */
const abandonmentPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
  const toRemove: Settlement[] = [];
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) toRemove.push(settlement);
  }
  for (const settlement of toRemove) {
    for (const c of settlement.catchmentHexes) {
      const t = world.grid.get(c);
      if (t !== undefined) t.ownerActor = null;
    }
    for (const u of settlement.urbanHexes) {
      const t = world.grid.get(u);
      if (t !== undefined) {
        t.ownerActor = null;
        if (t.terrain === 'urban') t.terrain = 'ruin';
      }
    }
    world.settlements.delete(settlement.id);
    events.push({ type: 'settlement_abandoned', settlement: settlement.id });
  }
};

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
