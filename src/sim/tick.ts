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

// pickBestHex / PlacementCandidate moved out with investmentPhase.
import { wholeUnitsForTransaction } from './market/wholeUnits.js';
import { abandonmentPhase } from './phases/abandonment.js';
import { ageRecentFlowsPhase } from './phases/ageRecentFlows.js';
import { annualPhase } from './phases/annual.js';
import { civilUnrestPhase } from './phases/civilUnrest.js';
import { constructionPhase } from './phases/construction.js';
import { consumptionPhase, fallbackRationUnitPrice } from './phases/consumption.js';
import { demographicsPhase } from './phases/demographics.js';
import { demolitionPhase } from './phases/demolition.js';
import { fiscalRedistributionPhase } from './phases/fiscalRedistribution.js';
import { investmentPhase } from './phases/investment.js';
import { movementPhase } from './phases/movement.js';
import {
  EDGE_HUB_EXPORT_CARAVAN_PREFIX,
  EDGE_HUB_IMPORT_CARAVAN_PREFIX,
  computeEdgeHexes,
  edgeHubHomeGateForCaravan,
  edgeHubPhase,
  isEdgeHubImportCaravan,
} from './phases/edgeHub.js';
import { newsArrivalPhase } from './phases/newsArrival.js';
import { patrolPartyEngagementPhase } from './phases/patrolPartyEngagement.js';
import { hasPendingTaxAssessments, taxShipmentPhase } from './phases/taxShipment.js';
import { roadMaintenancePhase } from './phases/roadMaintenance.js';
import { storageSpoilagePhase } from './phases/spoilage.js';
import { trailWearTickPhase } from './phases/trailWearTick.js';
import { tributePhase } from './phases/tribute.js';
import { banditPhase, banditPartyPhase } from './phases/bandit.js';
import { patrolPhase } from './phases/patrol.js';
import {
  buildingsByKindForSettlement,
  mineRecipeHasMismatchedDeposit,
  productionPhase,
  productionPriority,
} from './phases/production.js';
import { settlementAnchorIndexForWorld } from './world/settlementIndex.js';
import {
  decreaseStockpile,
  EMPTY_RESOURCE_MAP,
  increaseStockpile,
  isServiceResource,
  receiveResourceOrCoin,
} from './world/stockpileMutation.js';
// production-wage helpers moved with the production phase.
import {
  grainEquivalentModiiPerUnit,
  initializeSubsistenceAccess,
  type SubsistenceAccessMap,
} from './world/subsistence.js';
import {
  crossGuildRumorPhase,
  syncCaravanWithLocalGuild,
} from './politics/guildLedger.js';
// tickCaravanMovement moved out with the movement phase.
import { MAX_ACTIVE_WORLD_CARAVANS } from './caravan/limits.js';
import { expectedRiskOnApproximatePath, planCaravanRoute } from './caravan/ai.js';
// Bandit camp + party types/helpers moved out with the bandit phase.
import { actorStockEntriesAt, getStockAt } from './politics/actor.js';
// createCharacter, generateFullName, createFaction, createActor moved out with the bandit phase.
// Guild helpers (buildGuildByMember, mergeLedgerInto, Guild, GuildPriceObs)
// now live behind ./politics/guildLedger.ts.
import { isGoalComplete, peekGoal, popGoal, type Goal } from './caravan/goal.js';
// actorId + banditCampId + characterId + factionId moved out with
// the bandit phase. resolveAmbush + AmbushResult also moved.
import { DEFAULT_GLOBAL_PRICES } from './caravan/edgeHub.js';
import {
  isHarvestTributeDay,
  isMonthlyAssessmentDay,
} from './politics/taxShipment.js';
import { caravanId as makeCaravanIdLocal } from './types.js';
// Patrol, resolveRaid, WallLevel moved out with the bandit + patrol phases.
import {
  dailyCarriedFoodReserveKg,
  createCaravan,
  totalCarryKg,
  totalCargoWeightKg,
  type Caravan,
  type PriceObservation,
} from './caravan/caravan.js';
// createNewsItem, createNewsCarrier, NEWS_CARRIER_SPEED moved out
// with the bandit + patrol phases.
// tickCarrierWithGrid moved out with the movement phase.
// processNewsArrival + NamedCharacter moved out with newsArrivalPhase.
import type { ReputationMagnitude } from './reputation/table.js';
import { clearMarket } from './market/clear.js';
import {
  buildSettlementSchedules,
  createSettlementDemandSourceBuilder,
  institutionalProcurementResourcesForBuilding,
  serviceMarketResources,
  type SettlementDemandSourceBuilder,
} from './market/scheduleBuilder.js';
import type { DemandSource } from './market/demand.js';
// vital-rate ticking moved into per-phase modules.
import { allRecipes } from './production/recipes.js';
// News-carrier ticking is handled by docs/13's tickCarrier; the world doesn't
// yet hold a Map for them so the orchestration call sits with the news
// subsystem until that storage lands.
import type { Rng } from './rng.js';
import {
  clearMarketBook,
  recordClearingPrice,
  recordConsumption,
  recordExport,
  recordImport,
  recordLastClearedDay,
  recordMarketBook,
  recordMarketBookLadder,
  type MarketBookEntry,
  type MarketBookLadder,
  type MarketBookOrder,
  type Settlement,
} from './world/settlement.js';
import { dayOfYearToSeason, isPassable, type Season } from './world/terrain.js';
import {
  hexDistance,
  hexEquals,
  hexKey,
  hexesWithinRange,
  type Hex,
} from './world/hex.js';
import {
  buildingId,
  resourceId,
  type ActorId,
  type BanditCampId,
  type BanditPartyId,
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
import {
  buildLaborClassContext,
  type LaborClassContext,
} from './jobs/laborEconomics.js';
import type { ReputationKey } from './reputation/table.js';
import type { WorldState } from '../procgen/seed.js';

// --- Public API -------------------------------------------------------------

export interface TickInputs {
  readonly world: WorldState;
  readonly rng: Rng;
  /**
   * When false, tick suppresses returned diagnostic events while retaining
   * the small internal subset needed by same-tick systems such as worker
   * reallocation. Simulation state and stats are unchanged. Defaults to true.
   */
  readonly collectEvents?: boolean;
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
      readonly reason: 'zero_health' | 'zero_crew' | 'idle_too_long' | 'unprofitable';
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
      readonly type: 'caravan_profit_remitted';
      readonly caravan: CaravanId;
      readonly ownerActor: ActorId;
      readonly settlement: SettlementId;
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
      readonly type: 'merchant_caravan_dispatched';
      readonly caravan: CaravanId;
      readonly settlement: SettlementId;
      readonly ownerActor: ActorId;
    }
  | {
      /**
       * Per docs/15 §C31: a `free_village` actor dispatched a villager
       * caravan to carry village food surplus to the nearest city.
       */
      readonly type: 'villager_caravan_dispatched';
      readonly caravan: CaravanId;
      readonly settlement: SettlementId;
      readonly ownerActor: ActorId;
    }
  | {
      readonly type: 'tax_shipment_dispatched';
      readonly fromSettlement: SettlementId;
      readonly toSettlement: SettlementId;
      readonly grainModii: number;
      readonly coin: number;
    }
  | {
      /**
       * Per docs/15 §C29: quarterly coin tribute from a client village to its
       * patrician_family patron. Fires from `tributePhase` every 90 days.
       */
      readonly type: 'tribute_paid';
      readonly fromSettlement: SettlementId;
      readonly fromActor: ActorId;
      readonly toActor: ActorId;
      readonly coin: number;
    }
  | {
      /**
       * Per docs/15 §C32: a bandit camp split off a party to walk to a
       * target. Mission type carries the camp action that drove it.
       */
      readonly type: 'bandit_party_dispatched';
      readonly party: BanditPartyId;
      readonly fromCamp: BanditCampId;
      readonly missionType:
        | 'raid_settlement'
        | 'raid_caravan'
        | 'fence_loot'
        | 'recruit_drive'
        | 'migrate'
        | 'bribe_settlement';
      readonly at: Hex;
    }
  | {
      /**
       * Per docs/15 §C32: a bandit party finished its mission (success or
       * failure) and returned to camp. For one-way migrate missions the
       * party founded a new camp; for round-trip missions it merged back
       * into the home camp.
       */
      readonly type: 'bandit_party_returned';
      readonly party: BanditPartyId;
      readonly outcome: 'merged_home' | 'founded_camp' | 'lost';
      readonly at: Hex;
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
    }
  | {
      readonly type: 'fiscal_redistribution';
      /**
       * Channel of the transfer per docs/15 §C20:
       *   civic_dividend     — city corporation → patrician families
       *   tenant_rent        — free village / hamlet → patrician family
       *
       * `merchant_residual` was removed in §C22 — off-map house treasury
       * accumulates from import sales but does NOT redistribute back to
       * patricians via a synthetic transfer. The legitimate inbound coin
       * flow is the export caravan path (see
       * `completeOffMapExportIfArrived`).
       */
      readonly channel: 'civic_dividend' | 'tenant_rent';
      readonly payer: ActorId;
      readonly recipient: ActorId;
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

class TickEventBuffer implements Iterable<TickEvent> {
  private readonly collected: TickEvent[] = [];
  private readonly internalLaborEvents: TickEvent[] = [];

  constructor(private readonly collectAll: boolean) {}

  push(event: TickEvent): number {
    if (this.collectAll) {
      this.collected.push(event);
      return this.collected.length;
    }
    if (event.type === 'recipe_blocked') {
      this.internalLaborEvents.push(event);
      return this.internalLaborEvents.length;
    }
    return 0;
  }

  [Symbol.iterator](): Iterator<TickEvent> {
    return (this.collectAll ? this.collected : this.internalLaborEvents)[Symbol.iterator]();
  }

  resultEvents(): readonly TickEvent[] {
    return this.collectAll ? this.collected : [];
  }
}

/** One-day reputation half-life: 90 days. Tunable per docs/13. */
const REPUTATION_HALF_LIFE_DAYS = 90;

const YEAR_DAYS = 365;

// SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY + KG_PER_MODIUS moved to
// src/sim/world/subsistence.ts (imported above).
// COIN_RESOURCE moved to src/sim/world/stockpileMutation.ts.

/**
 * Public entry point. Mutates world in place and returns a structured
 * result. The world reference and all top-level Maps are preserved (we never
 * replace them) so callers can hold stable references across ticks.
 */
export const tick = (inputs: TickInputs): TickResult => {
  const { world, rng } = inputs;
  const eventBuffer = new TickEventBuffer(inputs.collectEvents !== false);
  const events = eventBuffer as unknown as TickEvent[];
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

  const laborContextCache = new Map<Settlement, LaborClassContext>();
  const laborContextForSettlement = (settlement: Settlement): LaborClassContext => {
    let cached = laborContextCache.get(settlement);
    if (cached === undefined) {
      cached = buildLaborClassContext(settlement);
      laborContextCache.set(settlement, cached);
    }
    return cached;
  };

  // --- Phase 0: age the per-settlement recent-flow counters ----------------
  // recentInflows / recentOutflows now follow exponential-decay semantics
  // with a ~30-day half-life (factor exp(-1/30) ≈ 0.967/day). Without this
  // the counters grew monotonically since world start, making "recent
  // volume" displays show lifetime totals and producing pathological
  // inflow/outflow imbalances on long-running worlds (e.g. a city's
  // food inflow accumulates over years while consumption — which is NOT
  // recorded as outflow — leaves outflow tiny by comparison). Decaying
  // here, BEFORE the day's new flows are recorded, gives every
  // recentInflows[r] the steady-state interpretation
  //   ≈ (daily inflow rate of r) × 30
  // i.e. roughly a one-month rolling window of trade activity.
  ageRecentFlowsPhase(world);

  // --- Phase 1: Production -------------------------------------------------
  productionPhase(world, season, events, stats, laborContextForSettlement);
  // After production, drain mason+carpenter worker-days toward each
  // settlement's pendingBuildings. Per docs/15 §C8 — construction takes
  // real time and labor; new buildings don't appear instantly.
  constructionPhase(world, today, events, laborContextForSettlement);
  // Demolition phase: buildings on released catchment hexes get torn
  // down over time, refunding ~50% of materials to the owner. Per
  // docs/15 §C8 demolition.
  demolitionPhase(world, today, events);

  // --- Phase 3: Movement ---------------------------------------------------
  movementPhase(world, season, today, events);

  // --- Phase 4: Trade ------------------------------------------------------
  const subsistenceAccess = initializeSubsistenceAccess(world);
  tradePhase(world, season, today, events, stats, subsistenceAccess, laborContextForSettlement);
  // After every settlement clears its market, run the petty-merchant /
  // villager-pickup-cart pass that arbitrages price spreads between
  // settlements within 3 hexes (docs/06 §"Local trade between nearby
  // settlements", docs/08 §"Per-settlement markets, regional smoothing").
  // This is what keeps ~8000 separate markets aligned into a regional
  // price gradient instead of 8000 disconnected wells.
  localTradePhase(world, season, today, events, subsistenceAccess, laborContextForSettlement);

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
    // Same quarterly cadence: client villages pay coin tribute to their
    // patron. Replaces the older model where the patron co-owned village
    // stockpile (docs/15 §C29).
    tributePhase(world, events);
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

  return { world, events: eventBuffer.resultEvents(), stats };
};

// productionPhase + helpers (labor pools, mine deposit helpers, recipe
// topo order, productionOrder/Priority, output inventory capacity)
// moved to src/sim/phases/production.ts. buildingsByKindForSettlement,
// productionPriority, and mineRecipeHasMismatchedDeposit are exported
// from there for use by workerReallocationPhase.

// --- Phase 3: Movement ------------------------------------------------------
//
// movementPhase moved to src/sim/phases/movement.ts.

// Trail-wear constants + helpers (addRoadWear, caravanTrailWear,
// WEAR_PER_*) moved to src/sim/world/roadWear.ts so both this file
// (movement phase, addRoadWear callers) and src/sim/phases/
// trailWearTick.ts can import them without circular references.

// MASON_JOB / CARPENTER_JOB moved to src/sim/buildings/constructionJobs.ts.

// demolitionPhase moved to src/sim/phases/demolition.ts.

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
//
// `getGuildByMember`, `syncCaravanWithLocalGuild`, and
// `crossGuildRumorPhase` moved to src/sim/politics/guildLedger.ts.

// civilUnrestPhase moved to src/sim/phases/civilUnrest.ts.

// roadMaintenancePhase moved to src/sim/phases/roadMaintenance.ts.

// tributePhase moved to src/sim/phases/tribute.ts.

// storageSpoilagePhase + helpers moved to src/sim/phases/spoilage.ts.

// --- Caravan spawn pressure ------------------------------------------------

const remainingWorldCaravanSlots = (world: WorldState, plannedSpawns = 0): number =>
  Math.max(0, MAX_ACTIVE_WORLD_CARAVANS - world.caravans.size - plannedSpawns);

// taxShipmentPhase + helpers moved to src/sim/phases/taxShipment.ts.

// edgeHubPhase + helpers moved to src/sim/phases/edgeHub.ts.

// ageRecentFlowsPhase + trailWearTickPhase moved to src/sim/phases/
// (with their shared road-wear helpers in src/sim/world/roadWear.ts).
// Imported at the top of this file.

// --- Phase 4: Trade ---------------------------------------------------------

/**
 * For each settlement and each tradable resource present in any owner's
 * stockpile (or demanded by population/producers/institutions), build a
 * modern microeconomic demand schedule (willingness to pay, budget limits,
 * derived input demand), build a reservation-price supply schedule, and call
 * clearMarket. Trades transfer goods from sellers to buyer actors or direct
 * consumption, and coin in the other direction, treasury-capped.
 */
const DEFAULT_MARKET_MAX_PRICE = 10_000;
const SCARCITY_PRICE_MULTIPLIER = 12;
const STRATEGIC_INPUT_SCARCITY_PRICE_MULTIPLIER = 40;
const MIN_SCARCITY_PRICE_CEILING = 5;
const MAX_LOCAL_FALLBACK_REFERENCE_PRICE = 50;

const STRATEGIC_PRODUCER_INPUTS: ReadonlySet<string> = new Set([
  'mineral.iron_ore',
  'material.charcoal',
  'metal.iron',
  'goods.tools',
]);

const scarcityPriceMultiplierForResource = (resource: ResourceId): number =>
  STRATEGIC_PRODUCER_INPUTS.has(String(resource))
    ? STRATEGIC_INPUT_SCARCITY_PRICE_MULTIPLIER
    : SCARCITY_PRICE_MULTIPLIER;

const fallbackScarcityReferencePrice = (resource: ResourceId): number => {
  const def = getResource(resource);
  const kg = Math.max(0.001, def.weightKgPerUnit);
  let coinPerKg: number;
  switch (def.category) {
    case 'food':
      coinPerKg = 1;
      break;
    case 'material':
      coinPerKg = def.tier === 0 ? 0.02 : 0.5;
      break;
    case 'mineral':
      coinPerKg = 0.2;
      break;
    case 'metal':
      coinPerKg = 2;
      break;
    case 'livestock':
      coinPerKg = 0.05;
      break;
    case 'goods':
      coinPerKg = 10;
      break;
    case 'exotic':
      coinPerKg = 50;
      break;
    case 'people':
      coinPerKg = 10;
      break;
    case 'service':
      coinPerKg = 0;
      break;
  }
  if (coinPerKg <= 0) return 0;
  return Math.min(MAX_LOCAL_FALLBACK_REFERENCE_PRICE, kg * coinPerKg);
};

const marketMaxPriceForResource = (
  resource: ResourceId,
  supplySources: readonly { readonly reservationPrice: number }[],
  recentLocalPrices: ReadonlyMap<ResourceId, number>,
): number => {
  const globalReference = DEFAULT_GLOBAL_PRICES.get(resource);
  let reference =
    globalReference !== undefined && Number.isFinite(globalReference) && globalReference > 0
      ? globalReference
      : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(reference)) {
    for (const source of supplySources) {
      const price = source.reservationPrice;
      if (Number.isFinite(price) && price > 0 && price < reference) reference = price;
    }
  }

  if (!Number.isFinite(reference)) {
    const observed = recentLocalPrices.get(resource);
    if (
      observed !== undefined &&
      Number.isFinite(observed) &&
      observed > 0 &&
      observed < DEFAULT_MARKET_MAX_PRICE
    ) {
      reference = observed;
    }
  }

  const fallback = fallbackScarcityReferencePrice(resource);
  if (globalReference === undefined && fallback > 0) {
    reference = Number.isFinite(reference) ? Math.min(reference, fallback) : fallback;
  }

  if (!Number.isFinite(reference)) return DEFAULT_MARKET_MAX_PRICE;
  const ceiling = Math.max(
    MIN_SCARCITY_PRICE_CEILING,
    reference * scarcityPriceMultiplierForResource(resource),
  );
  return Math.min(DEFAULT_MARKET_MAX_PRICE, ceiling);
};

const MIN_SHORTAGE_SIGNAL_KG = 0.25;

const isMeaningfulShortageSignal = (resource: ResourceId, unmetQuantity: number): boolean => {
  if (!Number.isFinite(unmetQuantity) || unmetQuantity <= 0) return false;
  const kgPerUnit = Math.max(0.001, getResource(resource).weightKgPerUnit);
  return unmetQuantity * kgPerUnit >= MIN_SHORTAGE_SIGNAL_KG;
};

const lowestFiniteAsk = (
  supplySources: readonly { readonly reservationPrice: number }[],
): number | null => {
  let best = Number.POSITIVE_INFINITY;
  for (const source of supplySources) {
    const price = source.reservationPrice;
    if (Number.isFinite(price) && price > 0 && price < best) best = price;
  }
  return Number.isFinite(best) ? best : null;
};

const boundedSellerOnlyAsk = (
  resource: ResourceId,
  supplySources: readonly { readonly reservationPrice: number }[],
  recentLocalPrices: ReadonlyMap<ResourceId, number>,
): number | null => {
  const ask = lowestFiniteAsk(supplySources);
  if (ask === null) return null;
  return Math.min(ask, marketMaxPriceForResource(resource, supplySources, recentLocalPrices));
};

const deleteClearingPriceIfNoRecordedOutflow = (
  settlement: Settlement,
  resource: ResourceId,
): void => {
  if ((settlement.market.recentOutflows.get(resource) ?? 0) > 0) return;
  settlement.market.lastClearingPrice.delete(resource);
  clearMarketBook(settlement, resource);
};

/**
 * Surface the residual bid-ask book from a clearing result onto the
 * settlement's MarketSnapshot. Per docs/08 §"Bid-ask book", the book is
 * derived per-tick from the residual schedules; we just persist whatever
 * the CDA emitted.
 */
const recordBookFromClearing = (
  settlement: Settlement,
  resource: ResourceId,
  result: {
    readonly bestAsk: number | null;
    readonly askDepth: number;
    readonly bestBid: number | null;
    readonly bidDepth: number;
    readonly midPrice: number | null;
    readonly spread: number | null;
  },
): void => {
  const entry: MarketBookEntry = {
    bestAsk: result.bestAsk,
    askDepth: result.askDepth,
    bestBid: result.bestBid,
    bidDepth: result.bidDepth,
    midPrice: result.midPrice,
    spread: result.spread,
  };
  recordMarketBook(settlement, resource, entry);
};

const BOOK_LADDER_MAX_ORDERS_PER_SIDE = 12;

const insertAskBookOrder = (orders: MarketBookOrder[], order: MarketBookOrder): void => {
  if (
    orders.length >= BOOK_LADDER_MAX_ORDERS_PER_SIDE &&
    order.price >= (orders[orders.length - 1]?.price ?? Infinity)
  ) {
    return;
  }
  let index = 0;
  while (index < orders.length && orders[index]!.price <= order.price) index++;
  orders.splice(index, 0, order);
  if (orders.length > BOOK_LADDER_MAX_ORDERS_PER_SIDE) orders.pop();
};

const insertBidBookOrder = (orders: MarketBookOrder[], order: MarketBookOrder): void => {
  if (
    orders.length >= BOOK_LADDER_MAX_ORDERS_PER_SIDE &&
    order.price <= (orders[orders.length - 1]?.price ?? 0)
  ) {
    return;
  }
  let index = 0;
  while (index < orders.length && orders[index]!.price >= order.price) index++;
  orders.splice(index, 0, order);
  if (orders.length > BOOK_LADDER_MAX_ORDERS_PER_SIDE) orders.pop();
};

/**
 * Per docs/15 §C19: build the per-source bid/ask ladder from the residual
 * schedules and stamp it on the settlement. Asks ascending, bids descending,
 * capped to BOOK_LADDER_MAX_ORDERS_PER_SIDE entries per side so the snapshot
 * doesn't balloon when a city has hundreds of tiny producer-input bids.
 */
const recordBookLadderFromClearing = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
  demandSources: readonly {
    readonly id: string;
    readonly curve: 'subsistence' | 'comfort' | 'status' | 'derived';
    quantityAt(price: number): number;
    readonly peakQuantity: number;
    readonly maxWillingnessToPay: number;
    readonly buyerActor?: ActorId;
    readonly buyerDisposition?: 'consume' | 'stockpile';
  }[],
  supplySources: readonly {
    readonly id: string;
    readonly ownerActor: ActorId;
    readonly reservationPrice: number;
    readonly availableToSell: number;
  }[],
  result: {
    readonly clearingPrice: number;
    readonly totalTraded: number;
    readonly trades: readonly {
      readonly buyerSourceId: string;
      readonly sellerSourceId: string;
      readonly quantity: number;
    }[];
  },
  today: Day,
): void => {
  // How much of each demand/supply source was filled today?
  let filledByBuyer: Map<string, number> | undefined;
  let filledBySeller: Map<string, number> | undefined;
  if (result.trades.length > 0) {
    filledByBuyer = new Map<string, number>();
    filledBySeller = new Map<string, number>();
    for (const trade of result.trades) {
      filledByBuyer.set(
        trade.buyerSourceId,
        (filledByBuyer.get(trade.buyerSourceId) ?? 0) + trade.quantity,
      );
      filledBySeller.set(
        trade.sellerSourceId,
        (filledBySeller.get(trade.sellerSourceId) ?? 0) + trade.quantity,
      );
    }
  }
  const evalPrice = Number.isFinite(result.clearingPrice)
    ? result.clearingPrice
    : Number.MAX_SAFE_INTEGER;
  const asks: MarketBookOrder[] = [];
  for (const s of supplySources) {
    const filled = filledBySeller?.get(s.id) ?? 0;
    const remaining = Math.max(0, s.availableToSell - filled);
    if (remaining <= 1e-6) continue;
    if (!Number.isFinite(s.reservationPrice)) continue;
    const actor = world.actors.get(s.ownerActor);
    if (actor === undefined) continue;
    insertAskBookOrder(asks, {
      actorId: s.ownerActor,
      actorKind: actor.kind,
      price: s.reservationPrice,
      quantity: remaining,
    });
  }
  const bids: MarketBookOrder[] = [];
  for (const d of demandSources) {
    const filled = filledByBuyer?.get(d.id) ?? 0;
    // Residual quantity that would still trade at the curve's max-WTP.
    // For subsistence (maxWtp = Infinity) we use quantityAt(eval) as a
    // representative current-day order size.
    const sampleQty = Number.isFinite(d.maxWillingnessToPay)
      ? d.peakQuantity
      : d.quantityAt(evalPrice);
    const remaining = Math.max(0, sampleQty - filled);
    if (remaining <= 1e-6) continue;
    if (!Number.isFinite(d.maxWillingnessToPay)) {
      // Subsistence: infinite-WTP. Show the bid at the current clearing
      // price for ladder purposes (its effective floor in this market).
      if (!Number.isFinite(result.clearingPrice) || result.clearingPrice <= 0) continue;
      const buyer = d.buyerActor !== undefined ? world.actors.get(d.buyerActor) : undefined;
      if (buyer === undefined) continue;
      insertBidBookOrder(bids, {
        actorId: d.buyerActor as ActorId,
        actorKind: buyer.kind,
        price: result.clearingPrice,
        quantity: remaining,
        curve: d.curve,
        ...(d.buyerDisposition !== undefined ? { buyerDisposition: d.buyerDisposition } : {}),
      });
      continue;
    }
    if (d.buyerActor === undefined) continue;
    const buyer = world.actors.get(d.buyerActor);
    if (buyer === undefined) continue;
    insertBidBookOrder(bids, {
      actorId: d.buyerActor,
      actorKind: buyer.kind,
      price: d.maxWillingnessToPay,
      quantity: remaining,
      curve: d.curve,
      ...(d.buyerDisposition !== undefined ? { buyerDisposition: d.buyerDisposition } : {}),
    });
  }
  const ladder: MarketBookLadder = { asks, bids };
  recordMarketBookLadder(settlement, resource, ladder, today);
};

const tradePhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
  stats: TickStats,
  subsistenceAccess: SubsistenceAccessMap,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
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

    // Stockpiles by owner — buildSettlementSchedules expects each owner's
    // slice AT THIS SETTLEMENT (docs/15 §C30 — inventory is physical).
    const stockpilesByOwner = new Map<ActorId, ReadonlyMap<ResourceId, Quantity>>();
    const actorTreasuryByActor = new Map<ActorId, number>();
    const owners: Actor[] = [];
    for (const oId of settlement.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      stockpilesByOwner.set(a.id, a.stockpile.get(settlement.id) ?? EMPTY_RESOURCE_MAP);
      actorTreasuryByActor.set(a.id, a.treasury);
      owners.push(a);
    }
    if (owners.length === 0) continue;

    // Only clear resources that are economically visible here: stock is
    // present, population wants it, or a local building can use it as an
    // input. Demand-only resources still matter because scarcity prices
    // are the signal that attracts caravans into shortages.
    const presentResources = new Set<ResourceId>();
    for (const o of owners) {
      for (const [res, qty] of actorStockEntriesAt(o, settlement.id)) {
        if (qty > 0) presentResources.add(res);
      }
    }
    const demandCandidateResources = demandCandidateResourcesForSettlement(settlement);
    const priceMemoryResources = settlement.market.lastClearingPrice;
    const localTradable = tradable.filter(
      (r) =>
        presentResources.has(r) || demandCandidateResources.has(r) || priceMemoryResources.has(r),
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
    const seededPrices = seededPricesForSettlement(settlement);

    const schedules = buildSettlementSchedules({
      settlement,
      stockpilesByOwner,
      resources: localTradable,
      recentLocalPrices: seededPrices,
      today,
      season,
      ownerKindByActor,
      actorTreasuryByActor,
      laborClassContext: laborContextForSettlement(settlement),
      grid: world.grid,
    });

    for (const [resId, pair] of schedules.schedulesByResource) {
      if (pair.demand.sources.length === 0 && pair.supply.sources.length === 0) {
        deleteClearingPriceIfNoRecordedOutflow(settlement, resId);
        continue;
      }
      const result = clearMarket(pair.demand, pair.supply, {
        maxPrice: marketMaxPriceForResource(resId, pair.supply.sources, seededPrices),
      });
      // Record the residual bid-ask book regardless of whether anything cleared
      // today. Caravans, viewer panels, and dormant-market diagnostics all read
      // from it.
      recordBookFromClearing(settlement, resId, result);
      // Per docs/15 §C19: also record the full per-source ladder so the
      // viewer can show the actual book depth (who is bidding/asking, not
      // just the best quote).
      recordBookLadderFromClearing(
        world,
        settlement,
        resId,
        pair.demand.sources,
        pair.supply.sources,
        result,
        today,
      );
      if (result.totalTraded <= 0) {
        if (
          pair.demand.sources.length > 0 &&
          result.unmetDemandAtClearingPrice > 0 &&
          isMeaningfulShortageSignal(resId, result.unmetDemandAtClearingPrice) &&
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
        } else if (pair.supply.sources.length > 0) {
          const ask = boundedSellerOnlyAsk(resId, pair.supply.sources, seededPrices);
          if (ask !== null) recordClearingPrice(settlement, resId, ask);
        } else {
          deleteClearingPriceIfNoRecordedOutflow(settlement, resId);
        }
        continue;
      }
      const demandSourceById = new Map<string, DemandSource>();
      for (const source of pair.demand.sources) demandSourceById.set(source.id, source);
      const supplySourceById = new Map<string, (typeof pair.supply.sources)[number]>();
      for (const source of pair.supply.sources) supplySourceById.set(source.id, source);
      let actualTraded = 0;
      for (const trade of result.trades) {
        const sellerActorId = supplySourceById.get(trade.sellerSourceId)?.ownerActor;
        if (sellerActorId === undefined) continue;
        const seller = world.actors.get(sellerActorId);
        if (seller === undefined) continue;

        const demandSource = demandSourceById.get(trade.buyerSourceId);
        const buyerActorId = demandSource?.buyerActor;
        const buyer = buyerActorId !== undefined ? world.actors.get(buyerActorId) : undefined;
        if (buyerActorId === undefined) continue;
        if (buyer === undefined) continue;
        const concreteBuyer = buyer;
        const buyerPaysSeller = concreteBuyer.id !== seller.id;
        const maxByBuyerTreasury =
          buyerPaysSeller && trade.price > 0
            ? concreteBuyer.treasury / trade.price
            : trade.quantity;
        const qty = Math.min(trade.quantity, maxByBuyerTreasury);
        if (qty <= 1e-9) continue;
        // Note: in-settlement market clearing (this loop) stays
        // fractional. The "whole units" rule per docs/08 governs
        // transactions that physically move goods OUT of a
        // settlement — caravan buy / sell, local trade between
        // neighboring settlements, off-map export. Settlement-
        // internal clearing is an aggregate accounting step over
        // many small household trades; flooring it makes small
        // populations look like they never buy daily perishables
        // because their per-tick demand is < 1 unit.

        const coin = buyerPaysSeller ? Math.min(qty * trade.price, concreteBuyer.treasury) : 0;
        const serviceTrade = isServiceResource(resId);
        if (!serviceTrade) decreaseStockpile(seller, settlement.id, resId, qty);
        if (buyerPaysSeller) {
          if (coin > 0) {
            concreteBuyer.treasury -= coin;
            seller.treasury += coin;
          }
        }
        if (demandSource?.buyerDisposition === 'stockpile' && !serviceTrade) {
          increaseStockpile(concreteBuyer, settlement.id, resId, qty);
        }
        if (demandSource?.buyerDisposition !== 'stockpile') {
          // Buyer is consuming immediately (not adding to stockpile),
          // so this is local consumption, not an export of the settlement.
          recordConsumption(settlement, resId, qty);
        }
        if (demandSource?.curve === 'subsistence') {
          const access = subsistenceAccess.get(settlement);
          if (access !== undefined)
            access.fulfilledModii += qty * grainEquivalentModiiPerUnit(resId);
        }
        actualTraded += qty;
      }
      if (actualTraded <= 1e-9) {
        const unmetDemand = Math.max(result.unmetDemandAtClearingPrice, result.totalTraded);
        if (
          pair.demand.sources.length > 0 &&
          isMeaningfulShortageSignal(resId, unmetDemand) &&
          Number.isFinite(result.clearingPrice) &&
          result.clearingPrice > 0
        ) {
          recordClearingPrice(settlement, resId, result.clearingPrice);
          events.push({
            type: 'market_shortage',
            settlement: settlement.id,
            resource: resId,
            price: result.clearingPrice,
            unmetDemand,
          });
        } else if (pair.supply.sources.length > 0) {
          const ask = boundedSellerOnlyAsk(resId, pair.supply.sources, seededPrices);
          if (ask !== null) recordClearingPrice(settlement, resId, ask);
        } else {
          deleteClearingPriceIfNoRecordedOutflow(settlement, resId);
        }
        continue;
      }
      recordClearingPrice(settlement, resId, result.clearingPrice);
      recordLastClearedDay(settlement, resId, today);
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
    'food.bread',
    'food.legumes',
    'mineral.salt',
    'material.wood',
    'food.milk',
    'food.fish',
    'food.game',
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

const CAPITAL_RESERVE_DEMAND_RESOURCES: readonly ResourceId[] = Object.freeze(
  [
    'material.lumber',
    'material.cut_stone',
    'material.brick_tile',
    'material.stone',
    'material.amphora',
    'material.pottery',
    'material.linen_fiber',
    'goods.tools',
    'livestock.equines',
    'goods.cart',
  ].map(resourceId),
);

const SERVICE_MARKET_RESOURCES: readonly ResourceId[] = serviceMarketResources();

const RECIPE_NEEDED_RESOURCES_BY_BUILDING: ReadonlyMap<string, readonly ResourceId[]> = (() => {
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
    for (const requirement of recipe.requires.keys()) {
      bucket.set(String(requirement), requirement);
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
  if (settlement.stockpileOwners.length > 0) {
    for (const r of CAPITAL_RESERVE_DEMAND_RESOURCES) out.add(r);
    for (const r of SERVICE_MARKET_RESOURCES) out.add(r);
  }
  for (const building of settlement.buildings) {
    if (building.capacity <= 0) continue;
    const neededResources = RECIPE_NEEDED_RESOURCES_BY_BUILDING.get(String(building.buildingId));
    if (neededResources !== undefined) {
      for (const r of neededResources) out.add(r);
    }
    for (const r of institutionalProcurementResourcesForBuilding(building.buildingId)) {
      out.add(r);
    }
  }
  return out;
};

/**
 * The full set of resources cleared each tick. Built once at module load
 * from resources that appear in recipes, population demand, local services,
 * or off-map global trade. We exclude `people.*` because slave/migrant flows
 * are handled by separate population/cargo systems.
 */
const TRADABLE_RESOURCES: readonly ResourceId[] = (() => {
  const seen = new Set<string>();
  const out: ResourceId[] = [];
  const add = (id: ResourceId): void => {
    const k = String(id);
    if (seen.has(k)) return;
    if (k.startsWith('people.')) return;
    seen.add(k);
    out.push(id);
  };
  for (const r of allRecipes()) {
    for (const id of r.inputs.keys()) add(id);
    for (const id of r.outputs.keys()) add(id);
  }
  for (const id of POPULATION_DEMAND_RESOURCES) add(id);
  for (const id of CAPITAL_RESERVE_DEMAND_RESOURCES) add(id);
  for (const id of SERVICE_MARKET_RESOURCES) add(id);
  for (const id of DEFAULT_GLOBAL_PRICES.keys()) add(id);
  for (const resources of RECIPE_NEEDED_RESOURCES_BY_BUILDING.values()) {
    for (const id of resources) add(id);
  }
  for (const building of ['barracks', 'temple', 'forum_market']) {
    for (const id of institutionalProcurementResourcesForBuilding(buildingId(building))) add(id);
  }
  return Object.freeze(out);
})();

const TRADABLE_RESOURCE_KEYS: ReadonlySet<string> = new Set(TRADABLE_RESOURCES.map(String));

const DEFAULT_GLOBAL_TRADABLE_PRICE_ENTRIES: readonly (readonly [ResourceId, number])[] =
  Object.freeze(
    Array.from(DEFAULT_GLOBAL_PRICES.entries()).filter(([resource, price]) => {
      return TRADABLE_RESOURCE_KEYS.has(String(resource)) && price > 0;
    }),
  );

// --- Phase 4b: Local trade (regional smoothing) -----------------------------

/**
 * Petty merchants and villager pickup carts that walk between nearby
 * settlements every day, arbitraging local price spreads with small loads.
 * Household goods use the classic ≤3-hex petty radius. Workshop and bulky
 * industrial inputs use ≤6-hex cartage so mine/charcoal/bloomery/smithy
 * clusters can feed each other without promoting every sack of grain to
 * regional teleportation. Per docs/06 §"Local trade between nearby
 * settlements" and docs/08 §"Per-settlement markets, regional smoothing".
 *
 * For each unordered settlement pair (A, B) within the resource's local
 * cartage radius whose anchors are both on passable terrain in the current
 * season:
 *   - For each tradable resource R for which BOTH settlements have observed
 *     a clearing price:
 *       - Add a transport-cost surcharge per the docs/06 distance table.
 *       - If the spread (after transport cost) is positive, pick the cheaper
 *         settlement as seller and the dearer as buyer.
 *       - Find any seller-side actor with stock>0 and any buyer-side actor
 *         with treasury>0; move a resource-appropriate load from seller to
 *         buyer at the midpoint price (split the spread). Household goods use
 *         basket loads; industrial inputs use cartage loads so mine/charcoal/
 *         bloomery clusters can actually feed each other.
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
 * per phase; each settlement enumerates only its bounded local-cartage
 * neighborhood instead of comparing against all N settlements (an O(N²) walk
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
  subsistenceAccess: SubsistenceAccessMap,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): void => {
  const localTradePairs = settlementAnchorIndexForWorld(world).localTradePairs;
  const ownerKindByActor = ownerKindByActorForWorld(world);
  const demandCache: LocalTradeDemandCache = new Map();
  const pricedResourceCache = new Map<Settlement, PricedLocalTradeResources>();
  const scheduleBaseCache = new Map<Settlement, LocalTradeScheduleBase>();

  // Cache anchor passability per phase. v1 approximation: a pair is feasible
  // if both anchors are on passable terrain this season. Real path
  // reachability across intervening hexes would require an A* call per pair
  // and is deferred to v1.5+ when long-haul caravan AI consolidation lands.
  const passableAtAnchor = new Map<Settlement, boolean>();
  const isAnchorPassable = (s: Settlement): boolean => {
    const cached = passableAtAnchor.get(s);
    if (cached !== undefined) return cached;
    const tile = world.grid.get(s.anchor);
    // If the tile isn't in the grid (test stub), treat as passable so unit
    // tests don't have to populate every hex with terrain just to exercise
    // local trade.
    const ok = tile === undefined ? true : isPassable(tile.terrain, season);
    passableAtAnchor.set(s, ok);
    return ok;
  };

  for (const pair of localTradePairs) {
    const { a, b, dist } = pair;
    if (!isAnchorPassable(a)) continue;
    if (!isAnchorPassable(b)) continue;
    // Per docs/06 §"Distance and cost", the table is in coin/kg, not
    // coin/unit. tryLocalTrade scales by the resource's weightKgPerUnit
    // before comparing prices.
    const transportCostPerKg = TRANSPORT_COST_BY_DISTANCE[dist];
    if (transportCostPerKg === undefined) continue;
    const aResources = pricedLocalTradeResourcesForSettlement(a, pricedResourceCache);
    const bResources = pricedLocalTradeResourcesForSettlement(b, pricedResourceCache);
    const smaller =
      aResources.resources.length <= bResources.resources.length ? aResources : bResources;
    const other = smaller === aResources ? bResources.resourcesById : aResources.resourcesById;
    for (const resId of smaller.resources) {
      if (!other.has(resId)) continue;
      if (dist > localTradeMaxHexDistanceForResource(resId)) continue;
      tryLocalTrade(
        world,
        a,
        b,
        resId,
        transportCostPerKg,
        season,
        today,
        ownerKindByActor,
        demandCache,
        scheduleBaseCache,
        laborContextForSettlement,
        subsistenceAccess,
        events,
      );
    }
  }
};

// SettlementAnchorIndex helpers moved to src/sim/world/settlementIndex.ts.

interface PricedLocalTradeResources {
  readonly resources: readonly ResourceId[];
  readonly resourcesById: ReadonlySet<ResourceId>;
}

const pricedLocalTradeResourcesForSettlement = (
  settlement: Settlement,
  cache: Map<Settlement, PricedLocalTradeResources>,
): PricedLocalTradeResources => {
  const cached = cache.get(settlement);
  if (cached !== undefined) return cached;
  const resources: ResourceId[] = [];
  const resourcesById = new Set<ResourceId>();
  for (const resId of LOCAL_TRADE_RESOURCES) {
    const price = settlement.market.lastClearingPrice.get(resId);
    if (price === undefined || price <= 0) continue;
    resources.push(resId);
    resourcesById.add(resId);
  }
  const priced = { resources, resourcesById };
  cache.set(settlement, priced);
  return priced;
};

const tryLocalTrade = (
  world: WorldState,
  a: Settlement,
  b: Settlement,
  resId: ResourceId,
  transportCostPerKg: number,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  demandCache: LocalTradeDemandCache,
  scheduleBaseCache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
  subsistenceAccess: SubsistenceAccessMap,
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
  const buyerIntent = pickLocalTradeBuyer(
    world,
    buyer,
    resId,
    midPrice,
    season,
    today,
    ownerKindByActor,
    demandCache,
    scheduleBaseCache,
    laborContextForSettlement,
  );
  if (buyerIntent === null) return;
  const buyerActor = buyerIntent.actor;
  if (buyerActor.id === sellerActor.id) return;

  const sellerStock = getStockAt(sellerActor, seller.id, resId);
  if (sellerStock <= 0) return;
  const maxByLoad = localTradeLoadKgForResource(resId) / weightKgPerUnit;
  const maxByTreasury = buyerActor.treasury / midPrice;
  let maxByDemand = buyerIntent.quantityDemanded;
  if (buyerIntent.curve === 'subsistence') {
    const access = subsistenceAccess.get(buyer);
    const modiiPerUnit = grainEquivalentModiiPerUnit(resId);
    if (access !== undefined && modiiPerUnit > 0) {
      const remainingModii = Math.max(0, access.needModii - access.fulfilledModii);
      maxByDemand = Math.min(maxByDemand, remainingModii / modiiPerUnit);
    }
  }
  // Tangible goods cross ownership in whole units only (docs/08
  // §"Whole-unit transactions"). Services pass through unrounded.
  // Local trade excludes services upstream, so this is effectively a
  // floor — kept as `wholeUnitsForTransaction` for symmetry with the
  // other transaction sites.
  const qty = wholeUnitsForTransaction(
    resId,
    Math.min(maxByLoad, sellerStock, maxByTreasury, maxByDemand),
  );
  if (qty <= 0) return;

  const coinPaid = qty * midPrice;
  // Apply the transfer. Per docs/15 §C30 the seller's slice is at THEIR
  // settlement and the buyer's slice is at THEIR settlement — local
  // trade physically moves the goods between settlements.
  decreaseStockpile(sellerActor, seller.id, resId, qty);
  if (buyerIntent.disposition === 'stockpile') {
    increaseStockpile(buyerActor, buyer.id, resId, qty);
  }
  sellerActor.treasury = sellerActor.treasury + coinPaid;
  buyerActor.treasury = buyerActor.treasury - coinPaid;
  // Local trade between two settlements: seller exports, buyer imports.
  recordExport(seller, resId, qty);
  recordImport(buyer, resId, qty);
  if (buyerIntent.disposition === 'consume') {
    // Buyer's intent was to consume on arrival — record consumption
    // (the goods went from one stockpile to immediate use).
    recordConsumption(buyer, resId, qty);
    if (buyerIntent.curve === 'subsistence') {
      const access = subsistenceAccess.get(buyer);
      if (access !== undefined) {
        access.fulfilledModii += qty * grainEquivalentModiiPerUnit(resId);
      }
    }
  }

  events.push({
    type: 'local_trade',
    fromSettlement: seller.id,
    toSettlement: buyer.id,
    resource: resId,
    quantity: qty,
    coinPaid,
  });
};

interface LocalTradeBuyerIntent {
  readonly actor: Actor;
  readonly disposition: 'consume' | 'stockpile';
  readonly curve: DemandSource['curve'] | 'fallback';
  readonly quantityDemanded: number;
}

type LocalTradeDemandCache = Map<Settlement, Map<ResourceId, readonly DemandSource[]>>;

const seededPricesForSettlement = (settlement: Settlement): Map<ResourceId, number> => {
  const seededPrices = new Map<ResourceId, number>(DEFAULT_GLOBAL_TRADABLE_PRICE_ENTRIES);
  for (const [resource, observed] of settlement.market.lastClearingPrice) {
    if (observed <= 0) continue;
    if (!TRADABLE_RESOURCE_KEYS.has(String(resource))) continue;
    seededPrices.set(resource, observed);
  }
  return seededPrices;
};

interface LocalTradeScheduleBase {
  readonly owners: readonly Actor[];
  readonly demandBuilder: SettlementDemandSourceBuilder;
  readonly actorTreasuryByActor: Map<ActorId, number>;
}

const localTradeScheduleBaseForSettlement = (
  world: WorldState,
  settlement: Settlement,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  cache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): LocalTradeScheduleBase => {
  const cached = cache.get(settlement);
  if (cached !== undefined) return cached;
  const owners: Actor[] = [];
  const stockpilesByOwner = new Map<ActorId, ReadonlyMap<ResourceId, Quantity>>();
  for (const ownerId of settlement.stockpileOwners) {
    const actor = world.actors.get(ownerId);
    if (actor === undefined) continue;
    owners.push(actor);
    // Per docs/15 §C30: schedule sees only the owner's slice AT this
    // settlement, not their full cross-settlement pool.
    stockpilesByOwner.set(actor.id, actor.stockpile.get(settlement.id) ?? EMPTY_RESOURCE_MAP);
  }
  const base = {
    owners,
    actorTreasuryByActor: new Map<ActorId, number>(),
    demandBuilder: createSettlementDemandSourceBuilder({
      settlement,
      stockpilesByOwner,
      recentLocalPrices: seededPricesForSettlement(settlement),
      today,
      season,
      ownerKindByActor,
      laborClassContext: laborContextForSettlement(settlement),
      grid: world.grid,
    }),
  };
  cache.set(settlement, base);
  return base;
};

const localTradeDemandSourcesFor = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  demandCache: LocalTradeDemandCache,
  scheduleBaseCache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): readonly DemandSource[] => {
  let cacheByResource = demandCache.get(settlement);
  if (cacheByResource === undefined) {
    cacheByResource = new Map<ResourceId, readonly DemandSource[]>();
    demandCache.set(settlement, cacheByResource);
  }
  const cached = cacheByResource.get(resource);
  if (cached !== undefined) return cached;

  const base = localTradeScheduleBaseForSettlement(
    world,
    settlement,
    season,
    today,
    ownerKindByActor,
    scheduleBaseCache,
    laborContextForSettlement,
  );
  if (base.owners.length === 0) {
    cacheByResource.set(resource, []);
    return [];
  }
  const actorTreasuryByActor = base.actorTreasuryByActor;
  actorTreasuryByActor.clear();
  for (const actor of base.owners) actorTreasuryByActor.set(actor.id, actor.treasury);

  const sources = base.demandBuilder.sourcesFor(resource, actorTreasuryByActor);
  cacheByResource.set(resource, sources);
  return sources;
};

const pickDemandBackedLocalBuyer = (
  world: WorldState,
  sources: readonly DemandSource[],
  price: number,
): LocalTradeBuyerIntent | null => {
  let best: {
    readonly source: DemandSource;
    readonly actor: Actor;
    readonly quantityDemanded: number;
  } | null = null;

  for (const source of sources) {
    if (source.buyerActor === undefined || source.buyerDisposition === undefined) continue;
    const quantityDemanded = source.quantityAt(price);
    if (!Number.isFinite(quantityDemanded) || quantityDemanded <= 1e-9) continue;
    const actor = world.actors.get(source.buyerActor);
    if (actor === undefined || actor.treasury <= 0) continue;
    if (
      best === null ||
      source.maxWillingnessToPay > best.source.maxWillingnessToPay ||
      (source.maxWillingnessToPay === best.source.maxWillingnessToPay &&
        quantityDemanded > best.quantityDemanded) ||
      (source.maxWillingnessToPay === best.source.maxWillingnessToPay &&
        quantityDemanded === best.quantityDemanded &&
        String(source.id) < String(best.source.id))
    ) {
      best = { source, actor, quantityDemanded };
    }
  }

  if (best === null) return null;
  // buyerDisposition is guaranteed defined by the `source.buyerDisposition === undefined`
  // continue guard above; the TS narrow is lost across the `best = …` assignment.
  return {
    actor: best.actor,
    disposition: best.source.buyerDisposition!,
    curve: best.source.curve,
    quantityDemanded: best.quantityDemanded,
  };
};

const pickLocalTradeBuyer = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
  price: number,
  season: Season,
  today: Day,
  ownerKindByActor: ReadonlyMap<ActorId, Actor['kind']>,
  demandCache: LocalTradeDemandCache,
  scheduleBaseCache: Map<Settlement, LocalTradeScheduleBase>,
  laborContextForSettlement: (settlement: Settlement) => LaborClassContext,
): LocalTradeBuyerIntent | null => {
  const sources = localTradeDemandSourcesFor(
    world,
    settlement,
    resource,
    season,
    today,
    ownerKindByActor,
    demandCache,
    scheduleBaseCache,
    laborContextForSettlement,
  );
  // Pass 1: prefer a real demand-backed buyer (subsistence/comfort/derived).
  // We still check `sources.length > 0` because some fixtures populate no
  // sources at all and want the legacy fallback below; but per docs/15
  // §C26 the market-making sources only contribute at their threshold
  // price, so when the local-trade price is above that they correctly
  // return 0 — in which case we still fall through to the legacy fallback
  // instead of refusing the trade.
  if (sources.length > 0) {
    const matched = pickDemandBackedLocalBuyer(world, sources, price);
    if (matched !== null) return matched;
  }

  // Legacy fallback for sparse/debug worlds and post-§C26: when no
  // demand source bid at the requested price, a price spread can still
  // move stock to a market factor / city corp with treasury. Without this
  // fallback, market-making sources that don't clear at the local-trade
  // midprice block the trade entirely even when there's a willing buyer
  // in the settlement.
  const fallback = pickBuyerActor(world, settlement);
  if (fallback === null) return null;
  return {
    actor: fallback,
    disposition: 'stockpile',
    curve: 'fallback',
    quantityDemanded: Number.POSITIVE_INFINITY,
  };
};

const pickSellerActor = (
  world: WorldState,
  settlement: Settlement,
  resId: ResourceId,
): Actor | null => {
  for (const id of settlement.stockpileOwners) {
    const actor = world.actors.get(id);
    if (actor === undefined) continue;
    const stock = getStockAt(actor, settlement.id, resId);
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

// LOCAL_TRADE_MAX_HEX_DISTANCE moved to src/sim/world/settlementIndex.ts.
const HOUSEHOLD_LOCAL_TRADE_MAX_HEX_DISTANCE = 3;
const INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE = 6;

/**
 * Per-pair, per-day, per-resource caps. Household goods use a single
 * villager/donkey basket. Strategic workshop goods use a pickup-wagon sized
 * lot, and bulky industrial inputs use local cartage because mine/charcoal/
 * bloomery clusters are deliberately local and need ton-scale material
 * movement before long-haul caravans get involved.
 * docs/06 §"Local trade between nearby settlements".
 */
const MAX_HOUSEHOLD_PETTY_LOAD_KG = 50;
const MAX_WORKSHOP_CARTAGE_LOAD_KG = 500;
const MAX_INDUSTRIAL_CARTAGE_LOAD_KG = 3_000;
/**
 * Per-trade cap on herd capital moved between neighboring settlements
 * by foot. Originally 0.1 herd-unit ("a handful of sheep walking
 * across to the next village") — but under the whole-unit
 * transactions rule (docs/08) every trade is floored to an integer
 * number of units, so a 0.1 cap forced zero-quantity trades and the
 * pathway never activated. Set to 1 herd-unit (~30 sheep / 10 cattle
 * / etc.) which is the smallest whole transaction the unit basis
 * supports. Bigger transfers go via caravan.
 */
const MAX_WALKING_HERD_LOCAL_TRADE_UNITS = 1;

const WORKSHOP_CARTAGE_RESOURCES: ReadonlySet<string> = new Set([
  'goods.tools',
  'goods.weapons',
  'goods.armor',
  'goods.shields',
  'goods.cart',
]);

const INDUSTRIAL_CARTAGE_RESOURCES: ReadonlySet<string> = new Set([
  'material.charcoal',
  'material.wood',
  'material.lumber',
  'material.clay',
  'material.stone',
  'material.cut_stone',
  'material.brick_tile',
]);

const computeLocalTradeLoadKgForResource = (resource: ResourceId): number => {
  const def = getResource(resource);
  if (def.category === 'livestock') {
    return def.weightKgPerUnit * MAX_WALKING_HERD_LOCAL_TRADE_UNITS;
  }
  if (def.category === 'mineral' || def.category === 'metal') {
    return MAX_INDUSTRIAL_CARTAGE_LOAD_KG;
  }
  if (WORKSHOP_CARTAGE_RESOURCES.has(String(resource))) {
    return MAX_WORKSHOP_CARTAGE_LOAD_KG;
  }
  if (INDUSTRIAL_CARTAGE_RESOURCES.has(String(resource))) {
    return MAX_INDUSTRIAL_CARTAGE_LOAD_KG;
  }
  return MAX_HOUSEHOLD_PETTY_LOAD_KG;
};

const computeLocalTradeMaxHexDistanceForResource = (resource: ResourceId): number => {
  const def = getResource(resource);
  if (def.category === 'livestock') {
    return HOUSEHOLD_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  if (def.category === 'mineral' || def.category === 'metal') {
    return INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  if (WORKSHOP_CARTAGE_RESOURCES.has(String(resource))) {
    return INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  if (INDUSTRIAL_CARTAGE_RESOURCES.has(String(resource))) {
    return INDUSTRIAL_LOCAL_TRADE_MAX_HEX_DISTANCE;
  }
  return HOUSEHOLD_LOCAL_TRADE_MAX_HEX_DISTANCE;
};

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
  4: 0.035,
  5: 0.055,
  6: 0.08,
};

/**
 * Resources eligible for the local-trade pass. This is derived from the full
 * tradable set so new physical goods do not silently get prices without local
 * arbitrage. Services are local capacities with coin-only settlement, people
 * move through population/cargo systems, and coin itself is the payment rail.
 */
const LOCAL_TRADE_RESOURCES: readonly ResourceId[] = Object.freeze(
  TRADABLE_RESOURCES.filter((id) => {
    const key = String(id);
    if (key === 'goods.coin') return false;
    const category = getResource(id).category;
    return category !== 'service' && category !== 'people';
  }),
);

const LOCAL_TRADE_WEIGHT_KG_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, getResource(id).weightKgPerUnit] as const),
);
const LOCAL_TRADE_LOAD_KG_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, computeLocalTradeLoadKgForResource(id)] as const),
);
const LOCAL_TRADE_MAX_DISTANCE_BY_RESOURCE: ReadonlyMap<ResourceId, number> = new Map(
  LOCAL_TRADE_RESOURCES.map((id) => [id, computeLocalTradeMaxHexDistanceForResource(id)] as const),
);

const localTradeLoadKgForResource = (resource: ResourceId): number =>
  LOCAL_TRADE_LOAD_KG_BY_RESOURCE.get(resource) ?? computeLocalTradeLoadKgForResource(resource);

const localTradeMaxHexDistanceForResource = (resource: ResourceId): number =>
  LOCAL_TRADE_MAX_DISTANCE_BY_RESOURCE.get(resource) ??
  computeLocalTradeMaxHexDistanceForResource(resource);

// --- Phase 5: Demographics --------------------------------------------------

// demographicsPhase moved to src/sim/phases/demographics.ts.

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
  // Merchant houses and patrician families replace lost trading caravans
  // slowly when the standing fleet falls below the province's settlement
  // count. This keeps trade alive over long burn-ins without injecting
  // discontinuous random fleets.
  merchantCaravanAssemblyPhase(world, rng.derive('merchant-caravan-assembly'), today, events);
  // Per docs/15 §C31: villages with food surplus dispatch a small handcart
  // caravan to the nearest city. Separate fleet target from merchants so
  // long-haul trade and short-haul village→city food runs don't compete
  // for the same caravan slots.
  villagerCaravanAssemblyPhase(world, rng.derive('villager-caravan-assembly'), today, events);
  // Bandit emergence + decisions + raid resolution. Without this loop,
  // the seeded bandit camps are inert decorations — see docs/12
  // §"Bandit emergence in the tick loop".
  banditPhase(world, rng.derive('bandit'), today, events);
  // Per docs/15 §C32: bandit parties (the movable units that handle all
  // camp-originated actions) walk one hex, resolve mission on arrival,
  // and walk back. Runs after camp decisions so the same tick's
  // dispatch can begin moving immediately.
  banditPartyPhase(world, rng.derive('bandit-party'), today, events);
  // Patrols walk routes and engage bandit camps they encounter. The
  // garrison + city-watch units seeded by procgen do this — without it,
  // bandits face no enforcement and grow unchecked.
  patrolPhase(world, rng.derive('patrol'), today, events);
  // Per docs/15 §C32: after both movement phases, any patrol that
  // overlaps a bandit party fights on-hex. The cyclic-route patrol
  // logic in patrolPhase handles patrol-vs-camp; this catches the
  // patrol-vs-party case the route logic doesn't see.
  patrolPartyEngagementPhase(world, rng.derive('patrol-party'), today, events);
  // Process arrived news carriers → apply reputation deltas to local
  // characters. Per docs/13: news doesn't teleport, every reputation
  // update is anchored to a specific carrier walking a specific route.
  newsArrivalPhase(world, today, events);
  // Track per-settlement labor-blocked events for the rolling 30-day
  // reallocation window (docs/04 §"Worker reallocation by demand"). We
  // ingest the events accumulated by THIS tick so the counters stay in
  // sync with the production phase that ran a few microseconds ago.
  ingestLaborBlockedEvents(events);
  // Monthly hook (every 30 days): nudge workers from over-supplied to
  // under-supplied/profitable roles. Picking 30 (not exactly month-length)
  // so the cadence is independent of calendar bookkeeping.
  if ((today + 1) % 30 === 0) {
    workerReallocationPhase(world, today, events);
  }
  // Quarterly hook (every 90 days): each settlement's stockpile-owning
  // actors evaluate observed prices and invest in profitable buildings,
  // and the fiscal-redistribution pass moves cash from cash-generating
  // actor kinds (city corps, off-map houses, tenant villages) to
  // cash-consuming actor kinds (patrician families). Per docs/15 §C4
  // (investment) and §C20 (fiscal redistribution).
  if ((today + 1) % 90 === 0) {
    investmentPhase(world, today, events);
    fiscalRedistributionPhase(world, today, events);
  }
  // Tax shipments: per docs/11 §"Taxes" + the codex review #2.
  // Governor assesses on harvest-tribute day (autumn) + monthly coin
  // assessments. Each non-zero owed becomes a real Caravan walking
  // toward the capital — bandits can ambush it, the road network
  // matters, etc.
  if (
    isHarvestTributeDay(today) ||
    isMonthlyAssessmentDay(today) ||
    hasPendingTaxAssessments(world)
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
const workerReallocationPhase = (world: WorldState, _today: Day, events: TickEvent[]): void => {
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
  dailyCarriedFoodReserveKg(c) * CARAVAN_RATION_RESERVE_DAYS;

const caravanMissingRationReserveKg = (c: Caravan): number =>
  Math.max(0, caravanRationReserveKg(c) - caravanRationCargoKg(c));

const caravanRationDays = (c: Caravan): number => {
  const dailyKg = dailyCarriedFoodReserveKg(c);
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

const MERCHANT_CARAVAN_HOME_OPERATING_RESERVE_COIN = 1_000;
const MERCHANT_CARAVAN_HOME_REMITTANCE_RATE = 0.5;

interface LocalBuyerQuote {
  readonly settlement: Settlement;
  readonly actor: Actor;
  readonly price: number;
  readonly quantity?: number;
  readonly disposition?: 'consume' | 'stockpile';
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
  let sawBook = false;
  for (const settlement of settlements) {
    const ladder = settlement.market.bookLadder.get(resource);
    if (
      ladder !== undefined ||
      settlement.market.lastBookSampleDay.has(resource) ||
      settlement.market.bestAsk.has(resource) ||
      settlement.market.bestBid.has(resource)
    ) {
      sawBook = true;
    }
    if (ladder !== undefined && ladder.asks.length > 0) {
      for (const ask of ladder.asks) {
        const actor = world.actors.get(ask.actorId);
        if (actor === undefined) continue;
        const stock = Math.min(getStockAt(actor, settlement.id, resource), ask.quantity);
        if (stock <= 0) continue;
        quotes.push({ settlement, actor, price: ask.price, stock });
      }
      continue;
    }
  }
  if (sawBook) {
    quotes.sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      if (b.stock !== a.stock) return b.stock - a.stock;
      return String(a.actor.id).localeCompare(String(b.actor.id));
    });
    return quotes;
  }
  for (const settlement of settlements) {
    const price = settlement.market.lastClearingPrice.get(resource);
    if (price === undefined || !Number.isFinite(price) || price <= 0) continue;
    for (const ownerId of settlement.stockpileOwners) {
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const stock = getStockAt(actor, settlement.id, resource);
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

const localRationSellerQuotes = (
  world: WorldState,
  settlements: readonly Settlement[],
  resource: ResourceId,
  buyerOwnerActor: ActorId,
): LocalSellerQuote[] => {
  const quotes: LocalSellerQuote[] = [];
  const seen = new Set<string>();
  for (const settlement of settlements) {
    const price = fallbackRationUnitPrice(settlement, resource);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ownerIds = new Set<ActorId>(settlement.stockpileOwners);
    const buyerOwner = world.actors.get(buyerOwnerActor);
    if (buyerOwner?.homeSettlement === settlement.id) ownerIds.add(buyerOwnerActor);
    for (const ownerId of ownerIds) {
      const key = `${String(settlement.id)}|${String(ownerId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const stock = getStockAt(actor, settlement.id, resource);
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

/**
 * Per docs/15 §C22 + C19: collect each candidate destination's residual
 * bid depth (best-bid quantity) per resource so the caravan planner can
 * cap planned cargo at what the destination market can actually absorb.
 * Returns a Map keyed by `hexKey(candidate.hex)` → resource → quantity.
 * Candidates without quoted bids contribute no entry → the planner treats
 * those resources as effectively unlimited (it has no evidence either
 * way), preserving back-compat with fixtures that don't populate books.
 */
const buildDestinationBidDepthMap = (
  world: WorldState,
  candidates: readonly { readonly id: SettlementId; readonly hex: Hex }[],
): ReadonlyMap<string, ReadonlyMap<ResourceId, Quantity>> => {
  const out = new Map<string, Map<ResourceId, Quantity>>();
  for (const candidate of candidates) {
    const settlement = world.settlements.get(candidate.id);
    if (settlement === undefined) continue;
    const market = settlement.market;
    if (market.bidDepth.size === 0) continue;
    const byResource = new Map<ResourceId, Quantity>();
    for (const [resource, depth] of market.bidDepth) {
      if (Number.isFinite(depth) && depth > 0) byResource.set(resource, depth);
    }
    if (byResource.size > 0) out.set(hexKey(candidate.hex), byResource);
  }
  return out;
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
        total += Math.max(0, getStockAt(actor, settlement.id, resource));
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
  let sawBook = false;
  for (const settlement of settlements) {
    const ladder = settlement.market.bookLadder.get(resource);
    if (
      ladder !== undefined ||
      settlement.market.lastBookSampleDay.has(resource) ||
      settlement.market.bestAsk.has(resource) ||
      settlement.market.bestBid.has(resource)
    ) {
      sawBook = true;
    }
    if (ladder !== undefined && ladder.bids.length > 0) {
      for (const bid of ladder.bids) {
        if (bid.actorId === caravan.ownerActor) continue;
        const actor = world.actors.get(bid.actorId);
        if (actor === undefined || actor.treasury <= 0 || bid.quantity <= 0) continue;
        if (
          best === null ||
          bid.price > best.price ||
          (bid.price === best.price && actor.treasury > best.actor.treasury)
        ) {
          best = {
            settlement,
            actor,
            price: bid.price,
            quantity: bid.quantity,
            ...(bid.buyerDisposition !== undefined ? { disposition: bid.buyerDisposition } : {}),
          };
        }
      }
      continue;
    }
  }
  if (sawBook) return best;
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
    const maxByBook = buyer.quantity ?? Number.POSITIVE_INFINITY;
    // Whole-unit transaction (docs/08): caravans haul tangible goods,
    // not services — floor to integer.
    const qty = wholeUnitsForTransaction(
      resource,
      Math.min(sellableQty, maxByTreasury, maxByBook),
    );
    if (qty <= 0) continue;
    const coin = qty * buyer.price;
    const remaining = currentQty - qty;
    if (remaining > 1e-9) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    caravan.treasury += coin;
    buyer.actor.treasury -= coin;
    if (buyer.disposition === 'consume') recordConsumption(buyer.settlement, resource, qty);
    else increaseStockpile(buyer.actor, buyer.settlement.id, resource, qty);
    // Caravan sold cargo to the settlement: import for the settlement.
    recordImport(buyer.settlement, resource, qty);
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
      // Whole-unit transaction (docs/08): caravans haul tangible goods.
      const qty = wholeUnitsForTransaction(
        resource,
        Math.min(remainingTarget, seller.stock, maxByCapacity, maxByTreasury),
      );
      if (qty <= 0) continue;
      const coin = sameOwner ? 0 : qty * seller.price;
      decreaseStockpile(seller.actor, seller.settlement.id, resource, qty);
      increaseCaravanCargo(caravan, resource, qty);
      if (!sameOwner) {
        caravan.treasury -= coin;
        seller.actor.treasury += coin;
      }
      // Caravan picked up cargo from this settlement: export.
      recordExport(seller.settlement, resource, qty);
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
  const targetKg = dailyCarriedFoodReserveKg(caravan) * CARAVAN_RATION_RESERVE_DAYS;
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
    for (const seller of localRationSellerQuotes(
      world,
      settlements,
      resource,
      caravan.ownerActor,
    )) {
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
    // Whole-unit transaction (docs/08).
    const qty = wholeUnitsForTransaction(
      quote.resource,
      Math.min(maxByNeed, maxByCapacity, maxByTreasury, quote.seller.stock),
    );
    if (qty <= 0) continue;
    const coin = sameOwner ? 0 : qty * quote.seller.price;
    decreaseStockpile(quote.seller.actor, quote.seller.settlement.id, quote.resource, qty);
    increaseCaravanCargo(caravan, quote.resource, qty);
    if (!sameOwner) {
      caravan.treasury -= coin;
      quote.seller.actor.treasury += coin;
    }
    recordClearingPrice(quote.seller.settlement, quote.resource, quote.seller.price);
    // Caravan loaded cargo at this settlement: export.
    recordExport(quote.seller.settlement, quote.resource, qty);
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

const estimateLocalRationPurchaseKg = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  treasuryBudget: number,
): number => {
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
    for (const seller of localRationSellerQuotes(
      world,
      settlements,
      resource,
      caravan.ownerActor,
    )) {
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

  let purchasableKg = 0;
  let remainingCapacityKg = Math.max(0, totalCarryKg(caravan) - totalCargoWeightKg(caravan));
  let remainingTreasury = Math.max(0, treasuryBudget);
  for (const quote of quotes) {
    if (remainingCapacityKg <= 1e-9) break;
    const sameOwner = quote.seller.actor.id === caravan.ownerActor;
    const maxByCapacity = remainingCapacityKg / quote.weightKgPerUnit;
    const maxByTreasury = sameOwner ? quote.seller.stock : remainingTreasury / quote.seller.price;
    const qty = Math.min(quote.seller.stock, maxByCapacity, maxByTreasury);
    if (qty <= 1e-9) continue;
    const kg = qty * quote.weightKgPerUnit;
    purchasableKg += kg;
    remainingCapacityKg -= kg;
    if (!sameOwner) remainingTreasury -= qty * quote.seller.price;
  }
  return purchasableKg;
};

const remitStandingCaravanProfitAtHome = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  events: TickEvent[],
): number => {
  // Both standing merchant caravans (patrician/caravan_owner/off_map) and
  // villager caravans (free_village steward, docs/15 §C31) remit profit at
  // home. Edge-hub + tax caravans are excluded because their balance is
  // closed at the hub/capital, not at an owner's home.
  if (!isStandingMerchantCaravan(caravan) && !isVillagerCaravan(caravan)) return 0;
  const owner = world.actors.get(caravan.ownerActor);
  if (owner === undefined || owner.homeSettlement === undefined) return 0;
  const home = settlements.find((settlement) => settlement.id === owner.homeSettlement);
  if (home === undefined) return 0;

  const reserveCoin = Math.max(
    MERCHANT_CARAVAN_HOME_OPERATING_RESERVE_COIN,
    caravanMissingRationReserveKg(caravan),
  );
  const surplus = caravan.treasury - reserveCoin;
  if (surplus <= 1e-9) return 0;

  const coin = surplus * MERCHANT_CARAVAN_HOME_REMITTANCE_RATE;
  if (coin <= 1e-9) return 0;
  caravan.treasury -= coin;
  owner.treasury += coin;
  events.push({
    type: 'caravan_profit_remitted',
    caravan: caravan.id,
    ownerActor: owner.id,
    settlement: home.id,
    coin,
  });
  return coin;
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
  if (String(caravan.id).startsWith('tax-')) return false;
  if (caravan.destination === null) return false;
  if (!hexEquals(caravan.position, caravan.destination)) return false;
  if (!edgeHexKeys.has(hexKey(caravan.position))) return false;
  let exportedAny = false;
  for (const [resource, rawQty] of Array.from(caravan.cargo.entries())) {
    const price = DEFAULT_GLOBAL_PRICES.get(resource);
    if (price === undefined || price <= 0 || rawQty <= 0) continue;
    // Whole-unit transaction (docs/08): off-map export crosses
    // ownership at the world's edge, so round to integer. Any
    // fractional residual stays in cargo for the next tick (the
    // caravan despawns when cargo.size === 0; a residual < 1 unit
    // is effectively spoilage / spillage).
    const qty = wholeUnitsForTransaction(resource, rawQty);
    if (qty <= 0) {
      caravan.cargo.delete(resource);
      continue;
    }
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

const completeOffMapImportReturnIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  edgeHexKeys: ReadonlySet<string>,
): boolean => {
  if (!isEdgeHubImportCaravan(caravan)) return false;
  if (caravan.destination === null) return false;
  const homeGate = edgeHubHomeGateForCaravan(caravan, edgeHexKeys);
  if (homeGate === null) return false;
  if (!hexEquals(caravan.position, homeGate) || !hexEquals(caravan.destination, homeGate)) {
    return false;
  }
  world.caravans.delete(caravanId);
  return true;
};

const completeTaxShipmentIfArrived = (
  world: WorldState,
  caravanId: CaravanId,
  caravan: Caravan,
  settlements: readonly Settlement[],
): boolean => {
  if (!String(caravan.id).startsWith('tax-')) return false;
  if (caravan.destination === null) return false;
  if (!hexEquals(caravan.position, caravan.destination)) return false;

  const owner = world.actors.get(caravan.ownerActor);
  const destination = settlements[0];
  if (owner !== undefined && destination !== undefined) {
    for (const [resource, qty] of caravan.cargo) {
      receiveResourceOrCoin(owner, destination.id, resource, qty);
      // Tax shipment unloaded its cargo at the capital: an import for
      // the capital from the perspective of the receiving settlement.
      recordImport(destination, resource, qty);
    }
  }
  world.caravans.delete(caravanId);
  return true;
};

const importConsignmentFactor = (
  world: WorldState,
  settlements: readonly Settlement[],
  caravan: Caravan,
): { readonly settlement: Settlement; readonly actor: Actor } | null => {
  let fallback: { settlement: Settlement; actor: Actor } | null = null;
  for (const settlement of settlements) {
    for (const ownerId of settlement.stockpileOwners) {
      if (ownerId === caravan.ownerActor) continue;
      const actor = world.actors.get(ownerId);
      if (actor === undefined) continue;
      const candidate = { settlement, actor };
      if (actor.kind === 'city_corporation') return candidate;
      if (fallback === null || actor.kind === 'patrician_family') fallback = candidate;
    }
  }
  return fallback;
};

const consignOffMapImportCargo = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
): number => {
  const factor = importConsignmentFactor(world, settlements, caravan);
  if (factor === null) return 0;

  let consigned = 0;
  for (const [resource, currentQty] of Array.from(caravan.cargo.entries())) {
    const qty = caravanSellableQuantity(caravan, resource, currentQty);
    if (qty <= 1e-9) continue;
    const remaining = currentQty - qty;
    if (remaining > 1e-9) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    increaseStockpile(factor.actor, factor.settlement.id, resource, qty);
    // Off-map factor consignment lands at this settlement: import.
    recordImport(factor.settlement, resource, qty);
    consigned += qty;
  }
  return consigned;
};

// --- Merchant caravan assembly --------------------------------------------

const MERCHANT_CARAVAN_ASSEMBLY_INTERVAL_DAYS = 7;
const MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL = 2;
const MERCHANT_CARAVAN_TARGET_PER_SETTLEMENT = 0.25;
const MERCHANT_CARAVAN_TARGET_MIN = 4;
const MERCHANT_CARAVAN_TARGET_MAX = 80;
const MERCHANT_CARAVAN_OWNER_CAP = 3;
const MERCHANT_CARAVAN_MIN_OPERATING_TREASURY = 100;
const MERCHANT_CARAVAN_EQUINES_RESOURCE = resourceId('livestock.equines');
const MERCHANT_CARAVAN_CART_RESOURCE = resourceId('goods.cart');
const EQUINE_ANIMALS_PER_HERD_UNIT = 6;
const MERCHANT_CARAVAN_MAX_LIGHT_CARTS = 1;
const MERCHANT_CARAVAN_MIN_STARTER_RATION_DAYS = 7;
const MERCHANT_CARAVAN_MIN_PACK_ANIMALS = 6;
const MERCHANT_CARAVAN_PREFERRED_EQUINE_UNITS = 2;

/**
 * Per docs/15 §C31: villager caravans are short-haul village → city food
 * runs spawned by the village's `free_village` steward. Their ID carries
 * the `villager-` prefix so the viewer renders them with the dedicated
 * peasant-with-handcart glyph and so caravan-bookkeeping doesn't confuse
 * them with patron-owned long-haul merchant trains.
 */
const VILLAGER_CARAVAN_PREFIX = 'villager-';
const VILLAGER_CARAVAN_ASSEMBLY_INTERVAL_DAYS = 14;
const VILLAGER_CARAVAN_MAX_DISPATCHED_PER_INTERVAL = 4;
const VILLAGER_CARAVAN_TARGET_PER_VILLAGE = 0.5;
const VILLAGER_CARAVAN_TARGET_MAX = 120;
const VILLAGER_CARAVAN_OWNER_CAP = 1;
const VILLAGER_CARAVAN_MIN_OPERATING_TREASURY = 30;
const VILLAGER_CARAVAN_MIN_STARTER_RATION_DAYS = 4;
const VILLAGER_CARAVAN_MIN_PACK_ANIMALS = 2;
const VILLAGER_CARAVAN_PREFERRED_EQUINE_UNITS = 0.6; // ≈3-4 mules
const VILLAGER_CARAVAN_SURPLUS_DAYS_THRESHOLD = 14;

const isVillagerCaravan = (caravan: Caravan): boolean =>
  String(caravan.id).startsWith(VILLAGER_CARAVAN_PREFIX);

const isStandingMerchantCaravan = (caravan: Caravan): boolean => {
  const id = String(caravan.id);
  return (
    !id.startsWith(EDGE_HUB_IMPORT_CARAVAN_PREFIX) &&
    !id.startsWith(EDGE_HUB_EXPORT_CARAVAN_PREFIX) &&
    !id.startsWith('tax-') &&
    !id.startsWith(VILLAGER_CARAVAN_PREFIX)
  );
};

const merchantCaravanTarget = (world: WorldState): number => {
  const raw = Math.floor(world.settlements.size * MERCHANT_CARAVAN_TARGET_PER_SETTLEMENT);
  return Math.max(MERCHANT_CARAVAN_TARGET_MIN, Math.min(MERCHANT_CARAVAN_TARGET_MAX, raw));
};

const standingMerchantCaravanCountByOwner = (world: WorldState): Map<ActorId, number> => {
  const out = new Map<ActorId, number>();
  for (const caravan of world.caravans.values()) {
    if (!isStandingMerchantCaravan(caravan)) continue;
    out.set(caravan.ownerActor, (out.get(caravan.ownerActor) ?? 0) + 1);
  }
  return out;
};

const eligibleMerchantCaravanOwners = (
  world: WorldState,
  activeByOwner: ReadonlyMap<ActorId, number>,
): { readonly actor: Actor; readonly settlement: Settlement }[] => {
  const out: { actor: Actor; settlement: Settlement }[] = [];
  for (const actor of world.actors.values()) {
    if (
      actor.kind !== 'patrician_family' &&
      actor.kind !== 'caravan_owner' &&
      actor.kind !== 'off_map_house'
    ) {
      continue;
    }
    if ((activeByOwner.get(actor.id) ?? 0) >= MERCHANT_CARAVAN_OWNER_CAP) continue;
    if (actor.treasury < MERCHANT_CARAVAN_MIN_OPERATING_TREASURY) continue;
    if (actor.homeSettlement === undefined) continue;
    const settlement = world.settlements.get(actor.homeSettlement);
    if (settlement === undefined) continue;
    out.push({ actor, settlement });
  }
  out.sort((a, b) => {
    if (b.actor.treasury !== a.actor.treasury) return b.actor.treasury - a.actor.treasury;
    return String(a.actor.id).localeCompare(String(b.actor.id));
  });
  return out;
};

const buyOwnerAssemblyStockAtLocalMarket = (
  world: WorldState,
  buyer: Actor,
  settlement: Settlement,
  resource: ResourceId,
  targetQty: number,
): number => {
  let remaining = Math.max(0, targetQty - getStockAt(buyer, settlement.id, resource));
  if (remaining <= 1e-9) return 0;
  let bought = 0;
  for (const seller of localSellerQuotes(world, [settlement], resource)) {
    if (remaining <= 1e-9) break;
    if (seller.actor.id === buyer.id) continue;
    const spendable = Math.max(0, buyer.treasury - MERCHANT_CARAVAN_MIN_OPERATING_TREASURY);
    if (spendable <= 1e-9) break;
    const maxByTreasury = spendable / seller.price;
    const qty = Math.min(remaining, seller.stock, maxByTreasury);
    if (qty <= 1e-9) continue;
    const coin = qty * seller.price;
    decreaseStockpile(seller.actor, seller.settlement.id, resource, qty);
    increaseStockpile(buyer, settlement.id, resource, qty);
    buyer.treasury -= coin;
    seller.actor.treasury += coin;
    remaining -= qty;
    bought += qty;
  }
  return bought;
};

const createReplacementMerchantCaravan = (
  world: WorldState,
  today: Day,
  owner: Actor,
  origin: Settlement,
  rng: Rng,
  index: number,
  events: TickEvent[],
): Caravan | null => {
  buyOwnerAssemblyStockAtLocalMarket(
    world,
    owner,
    origin,
    MERCHANT_CARAVAN_EQUINES_RESOURCE,
    MERCHANT_CARAVAN_PREFERRED_EQUINE_UNITS,
  );
  const availablePackAnimals = Math.floor(
    getStockAt(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE) * EQUINE_ANIMALS_PER_HERD_UNIT,
  );
  if (availablePackAnimals < MERCHANT_CARAVAN_MIN_PACK_ANIMALS) return null;
  let muleCount = rng.int(8, 14);
  let donkeyCount = rng.int(0, 3);
  while (muleCount + donkeyCount > availablePackAnimals) {
    if (donkeyCount > 0) donkeyCount -= 1;
    else muleCount -= 1;
  }
  if (muleCount < MERCHANT_CARAVAN_MIN_PACK_ANIMALS) return null;
  const equineUnitsNeeded = (muleCount + donkeyCount) / EQUINE_ANIMALS_PER_HERD_UNIT;
  const lightCartCount = Math.min(
    MERCHANT_CARAVAN_MAX_LIGHT_CARTS,
    Math.floor(getStockAt(owner, origin.id, MERCHANT_CARAVAN_CART_RESOURCE)),
  );
  const operatingTreasury = Math.min(owner.treasury, rng.int(250, 750));
  if (operatingTreasury < MERCHANT_CARAVAN_MIN_OPERATING_TREASURY) return null;
  const tag = Math.floor(rng.next() * 1_000_000_000);
  const caravan = createCaravan({
    id: makeCaravanIdLocal(`merchant-${today}-${index}-${String(owner.id)}-${tag}`),
    ownerActor: owner.id,
    position: { q: origin.anchor.q, r: origin.anchor.r },
    destination: { q: origin.anchor.q, r: origin.anchor.r },
    crew: [
      { kind: 'merchant', count: 1, weapons: 0.1, armor: 0.05 },
      { kind: 'drover', count: rng.int(3, 5), weapons: 0.1, armor: 0.05 },
      { kind: 'caravan_guard', count: rng.int(4, 6), weapons: 0.7, armor: 0.45 },
    ],
    animals: { mule: muleCount, donkey: donkeyCount },
    vehicles:
      lightCartCount > 0 ? { pack_saddle: 1, light_cart: lightCartCount } : { pack_saddle: 1 },
    treasury: operatingTreasury,
  });
  if (!world.grid.has(caravan.position)) return null;
  const minStarterRationKg =
    dailyCarriedFoodReserveKg(caravan) * MERCHANT_CARAVAN_MIN_STARTER_RATION_DAYS;
  if (
    estimateLocalRationPurchaseKg(world, caravan, [origin], operatingTreasury) < minStarterRationKg
  ) {
    return null;
  }
  decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE, equineUnitsNeeded);
  if (lightCartCount > 0) {
    decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_CART_RESOURCE, lightCartCount);
  }
  owner.treasury -= operatingTreasury;
  buyCaravanRationsAtLocalMarkets(world, caravan, [origin], events);
  return caravan;
};

const merchantCaravanAssemblyPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (today % MERCHANT_CARAVAN_ASSEMBLY_INTERVAL_DAYS !== 0) return;
  const worldRoom = remainingWorldCaravanSlots(world);
  if (worldRoom <= 0) return;
  const activeByOwner = standingMerchantCaravanCountByOwner(world);
  const active = Array.from(activeByOwner.values()).reduce((sum, n) => sum + n, 0);
  const target = merchantCaravanTarget(world);
  if (active >= target) return;

  const eligible = rng.shuffle(eligibleMerchantCaravanOwners(world, activeByOwner));
  if (eligible.length === 0) return;
  const toDispatch = Math.min(
    MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL,
    target - active,
    worldRoom,
  );
  let dispatched = 0;
  for (let i = 0; i < eligible.length && dispatched < toDispatch; i++) {
    const slot = eligible[i];
    if (slot === undefined) continue;
    const currentForOwner = activeByOwner.get(slot.actor.id) ?? 0;
    if (currentForOwner >= MERCHANT_CARAVAN_OWNER_CAP) continue;
    const caravan = createReplacementMerchantCaravan(
      world,
      today,
      slot.actor,
      slot.settlement,
      rng.derive(`dispatch-${i}`),
      dispatched,
      events,
    );
    if (caravan === null) continue;
    world.caravans.set(caravan.id, caravan);
    activeByOwner.set(slot.actor.id, currentForOwner + 1);
    dispatched += 1;
    events.push({
      type: 'merchant_caravan_dispatched',
      caravan: caravan.id,
      settlement: slot.settlement.id,
      ownerActor: slot.actor.id,
    });
  }
};

// --- Villager caravans (docs/15 §C31) ------------------------------------

/**
 * Count active villager caravans per owner. Villager caravans use the
 * `villager-` ID prefix so we can distinguish them from standing merchant
 * caravans (which fill a separate fleet target).
 */
const villagerCaravanCountByOwner = (world: WorldState): Map<ActorId, number> => {
  const out = new Map<ActorId, number>();
  for (const caravan of world.caravans.values()) {
    if (!isVillagerCaravan(caravan)) continue;
    out.set(caravan.ownerActor, (out.get(caravan.ownerActor) ?? 0) + 1);
  }
  return out;
};

const villagerCaravanTarget = (world: WorldState): number => {
  // Roughly half the villages can have a villager caravan out at any time.
  let villageCount = 0;
  for (const s of world.settlements.values()) {
    if (s.tier === 'village') villageCount += 1;
  }
  const raw = Math.floor(villageCount * VILLAGER_CARAVAN_TARGET_PER_VILLAGE);
  return Math.max(0, Math.min(VILLAGER_CARAVAN_TARGET_MAX, raw));
};

/**
 * Per docs/15 §C31: things a Roman village routinely had surplus of and
 * carted to a nearby city for sale — basic rural production. Food items,
 * fibre/fleece, lumber, hides, livestock, and the simplest goods the village
 * can make from those (cloth, clothing). NOT included: imports like wine,
 * oil, pottery, tools, salt — those flow IN to a typical village, not out.
 */
const VILLAGER_EXPORTABLE_RESOURCES: ReadonlyArray<ResourceId> = [
  // Food
  resourceId('food.grain'),
  resourceId('food.legumes'),
  resourceId('food.salted_fish'),
  resourceId('food.salted_meat'),
  resourceId('food.cheese'),
  // Fibres + raw materials
  resourceId('material.flax'),
  resourceId('material.linen_fiber'),
  resourceId('material.wool'),
  resourceId('material.wood'),
  resourceId('material.lumber'),
  resourceId('material.hides'),
  resourceId('material.leather'),
  // Livestock + goods made in-village
  resourceId('livestock.sheep'),
  resourceId('livestock.cattle'),
  resourceId('livestock.pigs'),
  resourceId('goods.cloth'),
  resourceId('goods.clothing'),
];

/**
 * Per docs/15 §C31: enough treasury that a village steward could
 * realistically fund an import-only round-trip — fully-paid cart + 4-day
 * starter rations + city-side purchase of pots/oil/tools/salt to bring
 * home. Below this threshold the steward can't really afford an
 * import-driven trip; we still let the caravan launch on a surplus
 * trigger so it can earn coin on the way.
 */
const VILLAGER_CARAVAN_IMPORT_TRIP_MIN_TREASURY = 200;

/**
 * Per docs/15 §C31: is it worth sending a villager caravan out THIS
 * cycle? Three Roman village-to-city motivations:
 *  1. Surplus run — the village has any meaningful exportable inventory
 *     (food, fibre, wood, livestock, cloth) above a small per-capita
 *     threshold. The caravan carries it to the city, returns with coin
 *     and/or city goods.
 *  2. Import trip — the village has accumulated treasury and wants to
 *     buy what it can't make itself (oil, wine, salt, pottery, tools).
 *  3. Hard-times resupply — the village's own subsistence stocks are
 *     critically low AND it has any cash, so the steward drains some
 *     treasury and sends the caravan to buy back food/staples from the
 *     city.
 *
 * Each case is a "yes, dispatch a caravan" — the planner picks the
 * cargo + direction once the caravan exists.
 */
const villageWantsCaravan = (settlement: Settlement, steward: Actor): boolean => {
  const pop = settlement.population.total();
  if (pop <= 0) return false;
  // Case 1: any exportable above a small per-capita day threshold.
  for (const r of VILLAGER_EXPORTABLE_RESOURCES) {
    const stock = getStockAt(steward, settlement.id, r);
    if (stock <= 0) continue;
    // Loose threshold: stock equivalent to ≥ N days of the village's own
    // subsistence-style consumption of that resource. Per-resource rate
    // varies, but 0.02/adult/day is a safe lower bound across the list
    // (grain alone is 0.06; bulky materials less). The planner makes the
    // tight cargo decision; this is just a "do you have meaningful
    // inventory?" filter.
    const daysOfLocalUse = stock / Math.max(1, pop * 0.02);
    if (daysOfLocalUse >= VILLAGER_CARAVAN_SURPLUS_DAYS_THRESHOLD) return true;
  }
  // Case 2: import trip — steward has accumulated coin and wants
  // city-made goods. Even with empty granary, this funds a "go buy us
  // something useful" run.
  if (steward.treasury >= VILLAGER_CARAVAN_IMPORT_TRIP_MIN_TREASURY) return true;
  // Case 3: hard-times resupply — village grain stock under 7 days of
  // subsistence AND steward has any cash to spend. Caravan goes to city
  // and buys staples back.
  const grainStock = getStockAt(steward, settlement.id, resourceId('food.grain'));
  const grainDays = grainStock / Math.max(1, pop * 0.06);
  if (grainDays < 7 && steward.treasury >= VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) return true;
  return false;
};

const eligibleVillagerCaravanOwners = (
  world: WorldState,
  activeByOwner: ReadonlyMap<ActorId, number>,
): { readonly actor: Actor; readonly settlement: Settlement }[] => {
  const out: { actor: Actor; settlement: Settlement }[] = [];
  for (const actor of world.actors.values()) {
    if (actor.kind !== 'free_village') continue;
    if ((activeByOwner.get(actor.id) ?? 0) >= VILLAGER_CARAVAN_OWNER_CAP) continue;
    if (actor.treasury < VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) continue;
    if (actor.homeSettlement === undefined) continue;
    const settlement = world.settlements.get(actor.homeSettlement);
    if (settlement === undefined) continue;
    if (settlement.tier !== 'village') continue;
    if (!villageWantsCaravan(settlement, actor)) continue;
    out.push({ actor, settlement });
  }
  // Stable order: deterministic by id; shuffled later when picking the
  // dispatch slice.
  out.sort((a, b) => String(a.actor.id).localeCompare(String(b.actor.id)));
  return out;
};

const createVillagerCaravan = (
  world: WorldState,
  today: Day,
  owner: Actor,
  origin: Settlement,
  rng: Rng,
  index: number,
  events: TickEvent[],
): Caravan | null => {
  // Allow the village to buy a small herd locally before assembling, just
  // like the merchant flow — but with a much smaller target.
  buyOwnerAssemblyStockAtLocalMarket(
    world,
    owner,
    origin,
    MERCHANT_CARAVAN_EQUINES_RESOURCE,
    VILLAGER_CARAVAN_PREFERRED_EQUINE_UNITS,
  );
  const availablePackAnimals = Math.floor(
    getStockAt(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE) * EQUINE_ANIMALS_PER_HERD_UNIT,
  );
  if (availablePackAnimals < VILLAGER_CARAVAN_MIN_PACK_ANIMALS) return null;
  let muleCount = rng.int(2, 4);
  let donkeyCount = rng.int(0, 1);
  while (muleCount + donkeyCount > availablePackAnimals) {
    if (donkeyCount > 0) donkeyCount -= 1;
    else muleCount -= 1;
  }
  if (muleCount < VILLAGER_CARAVAN_MIN_PACK_ANIMALS) return null;
  const equineUnitsNeeded = (muleCount + donkeyCount) / EQUINE_ANIMALS_PER_HERD_UNIT;
  // Per docs/15 §C31: scale operating treasury with the village's coin
  // reserves so import trips + hard-times resupply can actually fund
  // meaningful purchases at the city. Lower bound keeps the trip funded;
  // upper bound is randomized but capped at what the village can afford
  // while still keeping a small reserve at home.
  const stewardReserveFloor = VILLAGER_CARAVAN_MIN_OPERATING_TREASURY;
  const spendable = Math.max(0, owner.treasury - stewardReserveFloor);
  const operatingTreasury = Math.min(spendable, rng.int(50, 250));
  if (operatingTreasury < VILLAGER_CARAVAN_MIN_OPERATING_TREASURY) return null;
  const tag = Math.floor(rng.next() * 1_000_000_000);
  const caravan = createCaravan({
    id: makeCaravanIdLocal(
      `${VILLAGER_CARAVAN_PREFIX}${today}-${index}-${String(owner.id)}-${tag}`,
    ),
    ownerActor: owner.id,
    position: { q: origin.anchor.q, r: origin.anchor.r },
    destination: { q: origin.anchor.q, r: origin.anchor.r },
    // Minimal crew: a driver and a single guard. No merchant — the village
    // headman / steward is back at the granary.
    crew: [
      { kind: 'drover', count: 1, weapons: 0.1, armor: 0.05 },
      { kind: 'caravan_guard', count: 1, weapons: 0.4, armor: 0.2 },
    ],
    animals: { mule: muleCount, donkey: donkeyCount },
    vehicles: { pack_saddle: 1 },
    treasury: operatingTreasury,
  });
  if (!world.grid.has(caravan.position)) return null;
  const minStarterRationKg =
    dailyCarriedFoodReserveKg(caravan) * VILLAGER_CARAVAN_MIN_STARTER_RATION_DAYS;
  if (
    estimateLocalRationPurchaseKg(world, caravan, [origin], operatingTreasury) < minStarterRationKg
  ) {
    return null;
  }
  decreaseStockpile(owner, origin.id, MERCHANT_CARAVAN_EQUINES_RESOURCE, equineUnitsNeeded);
  owner.treasury -= operatingTreasury;
  buyCaravanRationsAtLocalMarkets(world, caravan, [origin], events);
  return caravan;
};

const villagerCaravanAssemblyPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (today % VILLAGER_CARAVAN_ASSEMBLY_INTERVAL_DAYS !== 0) return;
  const worldRoom = remainingWorldCaravanSlots(world);
  if (worldRoom <= 0) return;
  const activeByOwner = villagerCaravanCountByOwner(world);
  const active = Array.from(activeByOwner.values()).reduce((sum, n) => sum + n, 0);
  const target = villagerCaravanTarget(world);
  if (active >= target) return;

  const eligible = rng.shuffle(eligibleVillagerCaravanOwners(world, activeByOwner));
  if (eligible.length === 0) return;
  const toDispatch = Math.min(
    VILLAGER_CARAVAN_MAX_DISPATCHED_PER_INTERVAL,
    target - active,
    worldRoom,
  );
  let dispatched = 0;
  for (let i = 0; i < eligible.length && dispatched < toDispatch; i++) {
    const slot = eligible[i];
    if (slot === undefined) continue;
    const currentForOwner = activeByOwner.get(slot.actor.id) ?? 0;
    if (currentForOwner >= VILLAGER_CARAVAN_OWNER_CAP) continue;
    const caravan = createVillagerCaravan(
      world,
      today,
      slot.actor,
      slot.settlement,
      rng.derive(`villager-dispatch-${i}`),
      dispatched,
      events,
    );
    if (caravan === null) continue;
    world.caravans.set(caravan.id, caravan);
    activeByOwner.set(slot.actor.id, currentForOwner + 1);
    dispatched += 1;
    events.push({
      type: 'villager_caravan_dispatched',
      caravan: caravan.id,
      settlement: slot.settlement.id,
      ownerActor: slot.actor.id,
    });
  }
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

const LOW_RISK_SCOUT_WINDOW = 0.015;
const LOW_RATION_RISK_PENALTY_HEXES = 24;
const SCOUT_NEAR_DISTANCE_WINDOW_HEXES = 6;

type RouteRiskLookup = (from: Hex, to: Hex) => number;
const ROUTE_RISK_KEY_OFFSET = 32768;
const routeRiskCoordKey = (h: Hex): number =>
  (((h.q + ROUTE_RISK_KEY_OFFSET) << 16) | (h.r + ROUTE_RISK_KEY_OFFSET)) >>> 0;

const fallbackScoutCandidate = (
  from: Hex,
  candidates: readonly {
    readonly id: SettlementId;
    readonly hex: Hex;
    readonly tier: Settlement['tier'];
  }[],
  routeRisk: RouteRiskLookup,
  rationDays: number,
  rng: Rng,
):
  | {
      readonly id: SettlementId;
      readonly hex: Hex;
      readonly tier: Settlement['tier'];
    }
  | undefined => {
  if (rationDays < 7) {
    let best:
      | {
          readonly candidate: (typeof candidates)[number];
          readonly distance: number;
          readonly risk: number;
          readonly score: number;
        }
      | undefined;
    for (const candidate of candidates) {
      if (hexEquals(candidate.hex, from)) continue;
      const distance = hexDistance(from, candidate.hex);
      const risk = routeRisk(from, candidate.hex);
      const score = distance + risk * LOW_RATION_RISK_PENALTY_HEXES;
      if (
        best === undefined ||
        score < best.score ||
        (score === best.score && distance < best.distance) ||
        (score === best.score && distance === best.distance && risk < best.risk) ||
        (score === best.score &&
          distance === best.distance &&
          risk === best.risk &&
          String(candidate.id).localeCompare(String(best.candidate.id)) < 0)
      ) {
        best = { candidate, distance, risk, score };
      }
    }
    return best?.candidate;
  }

  let minRisk = Infinity;
  for (const candidate of candidates) {
    if (hexEquals(candidate.hex, from)) continue;
    minRisk = Math.min(minRisk, routeRisk(from, candidate.hex));
  }
  if (!Number.isFinite(minRisk)) return undefined;

  let nearest = Infinity;
  for (const candidate of candidates) {
    if (hexEquals(candidate.hex, from)) continue;
    const risk = routeRisk(from, candidate.hex);
    if (risk <= minRisk + LOW_RISK_SCOUT_WINDOW) {
      nearest = Math.min(nearest, hexDistance(from, candidate.hex));
    }
  }
  const reasonable: Array<{
    readonly candidate: (typeof candidates)[number];
    readonly distance: number;
    readonly risk: number;
  }> = [];
  for (const candidate of candidates) {
    if (hexEquals(candidate.hex, from)) continue;
    const risk = routeRisk(from, candidate.hex);
    if (risk > minRisk + LOW_RISK_SCOUT_WINDOW) continue;
    const distance = hexDistance(from, candidate.hex);
    if (distance <= nearest + SCOUT_NEAR_DISTANCE_WINDOW_HEXES) {
      reasonable.push({ candidate, distance, risk });
    }
  }
  reasonable.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.risk !== b.risk) return a.risk - b.risk;
    return String(a.candidate.id).localeCompare(String(b.candidate.id));
  });
  return rng.pick(reasonable).candidate;
};

const routeOffMapImportHomeIfDelivered = (
  world: WorldState,
  caravan: Caravan,
  settlements: readonly Settlement[],
  edgeHexKeys: ReadonlySet<string>,
): boolean => {
  if (!isEdgeHubImportCaravan(caravan)) return false;
  const homeGate = edgeHubHomeGateForCaravan(caravan, edgeHexKeys);
  if (homeGate === null) return false;

  // If local buyers could not absorb the cargo with immediate cash, consign
  // the remainder to a local factor. The goods are still physically present
  // in a city stockpile, but the off-map convoy does not become permanent
  // provincial rolling storage.
  consignOffMapImportCargo(world, caravan, settlements);

  if (caravanHasMarketCargo(caravan)) {
    caravan.destination = { q: caravan.position.q, r: caravan.position.r };
    return true;
  }

  caravan.destination = { q: homeGate.q, r: homeGate.r };
  caravan.goalStack = [{ type: 'return_home', home: { q: homeGate.q, r: homeGate.r } }];
  return true;
};

interface MarketObservationAccumulator {
  priceSum: number;
  priceCount: number;
  bidSum: number;
  bidCount: number;
  askSum: number;
  askCount: number;
  bidDepth: number;
  askDepth: number;
}

const observedMarketResources = (settlement: Settlement): Set<ResourceId> => {
  const out = new Set<ResourceId>();
  for (const r of settlement.market.lastClearingPrice.keys()) out.add(r);
  for (const r of settlement.market.midPrice.keys()) out.add(r);
  for (const r of settlement.market.bestBid.keys()) out.add(r);
  for (const r of settlement.market.bestAsk.keys()) out.add(r);
  return out;
};

const representativeObservedPrice = (settlement: Settlement, resource: ResourceId): number => {
  const mid = settlement.market.midPrice.get(resource);
  if (mid !== undefined && Number.isFinite(mid) && mid > 0) return mid;
  const last = settlement.market.lastClearingPrice.get(resource);
  if (last !== undefined && Number.isFinite(last) && last > 0) return last;
  const bid = settlement.market.bestBid.get(resource);
  const ask = settlement.market.bestAsk.get(resource);
  if (
    bid !== undefined &&
    ask !== undefined &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0
  ) {
    return Math.sqrt(bid * ask);
  }
  if (ask !== undefined && Number.isFinite(ask) && ask > 0) return ask;
  if (bid !== undefined && Number.isFinite(bid) && bid > 0) return bid;
  return 0;
};

const addSettlementMarketObservation = (
  acc: Map<ResourceId, MarketObservationAccumulator>,
  settlement: Settlement,
  resource: ResourceId,
): void => {
  const price = representativeObservedPrice(settlement, resource);
  if (!Number.isFinite(price) || price <= 0) return;
  let entry = acc.get(resource);
  if (entry === undefined) {
    entry = {
      priceSum: 0,
      priceCount: 0,
      bidSum: 0,
      bidCount: 0,
      askSum: 0,
      askCount: 0,
      bidDepth: 0,
      askDepth: 0,
    };
    acc.set(resource, entry);
  }
  entry.priceSum += price;
  entry.priceCount += 1;
  const bid = settlement.market.bestBid.get(resource);
  if (bid !== undefined && Number.isFinite(bid) && bid > 0) {
    entry.bidSum += bid;
    entry.bidCount += 1;
    entry.bidDepth += settlement.market.bidDepth.get(resource) ?? 0;
  }
  const ask = settlement.market.bestAsk.get(resource);
  if (ask !== undefined && Number.isFinite(ask) && ask > 0) {
    entry.askSum += ask;
    entry.askCount += 1;
    entry.askDepth += settlement.market.askDepth.get(resource) ?? 0;
  }
};

const averageObservedMarket = (
  entry: MarketObservationAccumulator,
  today: Day,
): PriceObservation => ({
  price: entry.priceSum / entry.priceCount,
  ...(entry.bidCount > 0 ? { bidPrice: entry.bidSum / entry.bidCount } : {}),
  ...(entry.askCount > 0 ? { askPrice: entry.askSum / entry.askCount } : {}),
  ...(entry.bidDepth > 0 ? { bidDepth: entry.bidDepth } : {}),
  ...(entry.askDepth > 0 ? { askDepth: entry.askDepth } : {}),
  observedOnDay: today,
});

/**
 * Per docs/15 §C25 + §C28: caravan profitability gate constants.
 *
 * `CARAVAN_MIN_NET_PROFIT_COIN`: absolute floor on net profit per trip,
 * representing the crew's reservation wages + capital opportunity cost
 * not fully captured by travelCost.
 *
 * `CARAVAN_MIN_NET_PROFIT_FRACTION`: fractional floor — netProfit must be
 * at least N× travelCost for the trip to be worth running. 0.05 means
 * "the trip needs to clear ~5% margin over its travel cost." Loosened
 * from 0.10 in §C28: 10% rejected too many marginal-but-real flows
 * and reduced inter-settlement food movement; 5% still rejects pure
 * noise trades.
 *
 * `CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS`: after this many
 * consecutive ticks the planner returned no profitable route, the
 * caravan disbands. Day-based (not stop-based) because the
 * stop-based variant produced fewer caravans + higher famine in
 * burn-in — long-trip caravans got too many "free" stops and
 * accumulated losses on marginal trades. The day-based count more
 * accurately reflects "this caravan has been bleeding resources
 * for over a month with nothing to show."
 */
const CARAVAN_MIN_NET_PROFIT_COIN = 5;
const CARAVAN_MIN_NET_PROFIT_FRACTION = 0.05;
const CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS = 45;

const caravanReplanPhase = (world: WorldState, rng: Rng, today: Day, events: TickEvent[]): void => {
  const settlementIndex = settlementAnchorIndexForWorld(world);
  const candidates = settlementIndex.candidates;
  const edgeHexKeys = new Set(computeEdgeHexes(world.grid).map(hexKey));
  const knownBanditDensity = knownBanditDensityForCaravans(world);
  const routeRiskCache = new Map<number, Map<number, number>>();
  const routeRisk: RouteRiskLookup =
    knownBanditDensity.size === 0
      ? () => 0
      : (from, to) => {
          const fromKey = routeRiskCoordKey(from);
          const toKey = routeRiskCoordKey(to);
          let byDestination = routeRiskCache.get(fromKey);
          if (byDestination === undefined) {
            byDestination = new Map<number, number>();
            routeRiskCache.set(fromKey, byDestination);
          }
          const cached = byDestination.get(toKey);
          if (cached !== undefined) return cached;
          const risk = expectedRiskOnApproximatePath(knownBanditDensity, from, to);
          byDestination.set(toKey, risk);
          return risk;
        };
  // Market bid-depth books are produced in the trade phase and are not
  // mutated by caravan replan cargo transfers, so one phase-level snapshot is
  // equivalent to rebuilding it for every arrived caravan.
  const destinationBidDepth = buildDestinationBidDepthMap(world, candidates);

  // Build a city-anchor lookup once per phase for goal-completion checks.
  const settlementAnchorByCity = new Map<SettlementId, Hex>();
  for (const s of world.settlements.values()) settlementAnchorByCity.set(s.id, s.anchor);

  for (const [cId, c] of Array.from(world.caravans.entries())) {
    if (completeOffMapImportReturnIfArrived(world, cId, c, edgeHexKeys)) continue;
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

    const localBucket = settlementIndex.byAnchorHex.get(hexKey(c.position));
    if (completeTaxShipmentIfArrived(world, cId, c, localBucket === undefined ? [] : localBucket)) {
      continue;
    }

    // 1. Record observed local prices into caravan's price book. The
    // priceBook key is the hex (the merchant remembers "this is what
    // bread cost in town X"); when multiple settlements share a hex we
    // average their clearing prices for each resource so the order in
    // which settlements were inserted into world.settlements does not
    // change what the caravan remembers.
    if (localBucket !== undefined && localBucket.length > 0) {
      const observedByResource = new Map<ResourceId, MarketObservationAccumulator>();
      for (const local of localBucket) {
        for (const resource of observedMarketResources(local)) {
          addSettlementMarketObservation(observedByResource, local, resource);
        }
      }
      for (const [resource, entry] of observedByResource) {
        if (entry.priceCount === 0) continue;
        let book = c.priceBook.get(resource);
        if (book === undefined) {
          book = new Map<string, PriceObservation>();
          c.priceBook.set(resource, book);
        }
        book.set(`${c.position.q},${c.position.r}`, averageObservedMarket(entry, today));
      }
      sellCaravanCargoAtLocalMarkets(world, c, localBucket, events);
      buyCaravanRationsAtLocalMarkets(world, c, localBucket, events);
      if (routeOffMapImportHomeIfDelivered(world, c, localBucket, edgeHexKeys)) continue;
      remitStandingCaravanProfitAtHome(world, c, localBucket, events);
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
    // Per docs/15 §C22 + C19: pre-build a destination → resource → bid
    // depth map for the candidates so the planner can cap cargo at what
    // each destination market can actually absorb. Without this the
    // planner over-loads goods that won't clear on arrival.
    // 2. Plan next route.
    // Per docs/15 §C25: require a meaningful margin, not just netProfit>0.
    // CARAVAN_MIN_NET_PROFIT_COIN sets an absolute floor representing the
    // crew's reservation wages + opportunity cost; the fractional floor
    // says "the trip has to pay back at least N× its travel cost". A
    // route that nets 0.5 coin over a 200-coin trip isn't worth running.
    const plan = planCaravanRoute({
      caravan: c,
      candidateSettlements: candidates,
      knownPrices: c.priceBook,
      knownBanditDensity,
      expectedRiskForRoute: routeRisk,
      knownToll: () => 0, // v1: no toll signal yet
      cargoConstraints: {
        reserveCapacityKg: missingRationKg,
        // Keep enough cash to buy the missing survival reserve later. This
        // uses the same 1 coin/kg ration-cost approximation as the planner's
        // travel-cost model, so cargo demand is cash-feasible instead of
        // spending the caravan into starvation.
        maxSpendCoin: Math.max(0, c.treasury - missingRationKg),
        reserveTripOperatingCost: true,
        ...(originAvailability !== undefined
          ? { originAvailableQuantity: originAvailability }
          : {}),
        destinationBidDepth,
      },
      minNetProfitCoin: CARAVAN_MIN_NET_PROFIT_COIN,
      minNetProfitFraction: CARAVAN_MIN_NET_PROFIT_FRACTION,
      includeReason: false,
      rng: rng.derive(String(cId)),
    });

    if (plan !== null) {
      // Per docs/15 §C25: a profitable plan resets the no-profit counter.
      c.noProfitableRouteDays = 0;
      const boughtUnits =
        localBucket === undefined
          ? 0
          : buyPlannedCargoAtLocalMarkets(world, c, localBucket, plan.cargoToCarry, events);
      const rationDays = caravanRationDays(c);
      if (boughtUnits <= 1e-9 && !caravanHasMarketCargo(c)) {
        const rngHere = rng.derive(`${String(cId)}-fallback`);
        const fallback = fallbackScoutCandidate(
          c.position,
          candidates,
          routeRisk,
          rationDays,
          rngHere,
        );
        if (fallback === undefined) continue;
        c.destination = { q: fallback.hex.q, r: fallback.hex.r };
        continue;
      }
      if (rationDays + 1e-9 < plan.estimatedDays) {
        const fallback = fallbackScoutCandidate(
          c.position,
          candidates,
          routeRisk,
          0,
          rng.derive(`${String(cId)}-ration-fallback`),
        );
        if (fallback === undefined) continue;
        c.destination = { q: fallback.hex.q, r: fallback.hex.r };
        continue;
      }
      // Set new destination. Cargo isn't restocked here (that's a market
      // operation handled above); the planner's expected profit reflects
      // what it expects to be able to load.
      c.destination = plan.destination;
    } else {
      // Per docs/15 §C25: no profitable plan available. Bump the
      // no-profit counter (day-based); if it crosses the disband
      // threshold, dissolve the caravan instead of pointlessly
      // scouting forever. §C28 experimented with a stop-based
      // counter but it produced fewer caravans + higher famine —
      // the day-based count more reliably catches caravans that
      // bleed resources without finding a route.
      c.noProfitableRouteDays = (c.noProfitableRouteDays ?? 0) + 1;
      if (c.noProfitableRouteDays >= CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS) {
        disbandUnprofitableCaravan(world, cId, c, today, events);
        continue;
      }
      // Below threshold — fall back to "scout to a random different
      // settlement" so the caravan keeps accumulating price observations.
      // This is what unspecialized merchants did historically: travel to
      // gossip and find out where prices are good.
      const rationDays = caravanRationDays(c);
      const fallback = fallbackScoutCandidate(
        c.position,
        candidates,
        routeRisk,
        rationDays,
        rng.derive(`${String(cId)}-fallback`),
      );
      if (fallback === undefined) continue;
      c.destination = { q: fallback.hex.q, r: fallback.hex.r };
    }
  }
};

/**
 * Per docs/15 §C25 + §C28: disband a caravan that hasn't found a
 * profitable route after `CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS`
 * consecutive ticks of failed planning. Emits a `caravan_disbanded`
 * event with reason `'unprofitable'`.
 */
const disbandUnprofitableCaravan = (
  world: WorldState,
  cId: CaravanId,
  c: Caravan,
  today: Day,
  events: TickEvent[],
): void => {
  refundCaravanToOwner(world, c);
  world.caravans.delete(cId);
  events.push({
    type: 'caravan_disbanded',
    caravan: cId,
    at: { q: c.position.q, r: c.position.r },
    reason: 'unprofitable',
  });
  void today;
};

/**
 * Shared helper: return a disbanded caravan's treasury + cargo +
 * livestock + carts to the owner's stockpile/treasury. The crew
 * demographics are intentionally dropped on the floor for now —
 * re-feeding them into the home settlement's population pool is a
 * follow-up (it requires the crew-demographics → population integration
 * described in docs/06).
 */
const refundCaravanToOwner = (world: WorldState, c: Caravan): void => {
  const owner = world.actors.get(c.ownerActor);
  if (owner === undefined) return;
  owner.treasury += Math.max(0, c.treasury);
  c.treasury = 0;
  // Cargo + livestock + carts refund to the owner's slice at their home
  // settlement (per docs/15 §C30 — inventory must land at a specific
  // settlement). Off-map owners with no homeSettlement just lose the
  // physical assets; their treasury is already refunded above.
  const refundSettlement = owner.homeSettlement;
  if (refundSettlement === undefined) {
    c.cargo.clear();
    return;
  }
  for (const [resource, qty] of c.cargo) {
    if (qty > 0) increaseStockpile(owner, refundSettlement, resource, qty);
  }
  c.cargo.clear();
  const equineResource = resourceId('livestock.equines');
  const cartResource = resourceId('goods.cart');
  let equineUnits = 0;
  for (const k of Object.keys(c.animals) as (keyof typeof c.animals)[]) {
    const n = c.animals[k] ?? 0;
    if (n > 0) equineUnits += n;
  }
  if (equineUnits > 0) {
    // ~6 pack animals per herd unit (matches procgen's
    // transport-capital convention).
    const herdUnits = equineUnits / 6;
    if (herdUnits > 0) increaseStockpile(owner, refundSettlement, equineResource, herdUnits);
  }
  let cartUnits = 0;
  for (const k of Object.keys(c.vehicles) as (keyof typeof c.vehicles)[]) {
    const n = c.vehicles[k] ?? 0;
    if (n > 0) cartUnits += n;
  }
  if (cartUnits > 0) increaseStockpile(owner, refundSettlement, cartResource, cartUnits);
};


// banditPhase + banditPartyPhase + supporting helpers moved to
// src/sim/phases/bandit.ts.

// newsArrivalPhase + buildActorToFactionIndex moved to
// src/sim/phases/newsArrival.ts.

// patrolPartyEngagementPhase moved to src/sim/phases/patrolPartyEngagement.ts.

// patrolPhase moved to src/sim/phases/patrol.ts.

// constructionPhase moved to src/sim/phases/construction.ts.


// --- Annual hook ------------------------------------------------------------

// abandonmentPhase moved to src/sim/phases/abandonment.ts.

// annualPhase + pickCatchmentOwnerForSettlement moved to
// src/sim/phases/annual.ts.
