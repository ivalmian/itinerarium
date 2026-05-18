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
// wholeUnitsForTransaction moved out with the trade + caravan clusters.
import { abandonmentPhase } from './phases/abandonment.js';
import { ageRecentFlowsPhase } from './phases/ageRecentFlows.js';
import { annualPhase } from './phases/annual.js';
import { civilUnrestPhase } from './phases/civilUnrest.js';
import { constructionPhase } from './phases/construction.js';
import { consumptionPhase } from './phases/consumption.js';
import { demographicsPhase } from './phases/demographics.js';
import { demolitionPhase } from './phases/demolition.js';
import { fiscalRedistributionPhase } from './phases/fiscalRedistribution.js';
import { homePresenceSyncPhase } from './phases/homePresenceSync.js';
import {
  caravanArrivalSyncPhase,
  caravanMeetingSyncPhase,
  guildLedgerSyncPhase,
} from './phases/priceSync.js';
import { investmentPhase } from './phases/investment.js';
import { movementPhase } from './phases/movement.js';
import { edgeHubPhase } from './phases/edgeHub.js';
import { newsArrivalPhase } from './phases/newsArrival.js';
import { patrolPartyEngagementPhase } from './phases/patrolPartyEngagement.js';
import { hasPendingTaxAssessments, taxShipmentPhase } from './phases/taxShipment.js';
import {
  isHarvestTributeDay,
  isMonthlyAssessmentDay,
} from './politics/taxShipment.js';
import { roadMaintenancePhase } from './phases/roadMaintenance.js';
import { storageSpoilagePhase } from './phases/spoilage.js';
import { trailWearTickPhase } from './phases/trailWearTick.js';
import { tributePhase } from './phases/tribute.js';
import { banditPhase, banditPartyPhase } from './phases/bandit.js';
import {
  caravanReplanPhase,
  merchantCaravanAssemblyPhase,
  villagerCaravanAssemblyPhase,
} from './phases/caravan.js';
import { patrolPhase } from './phases/patrol.js';
import { productionPhase } from './phases/production.js';
import { localTradePhase, tradePhase } from './phases/trade.js';
import {
  ingestLaborBlockedEvents,
  workerReallocationPhase,
} from './phases/workerReallocation.js';
// settlementAnchorIndexForWorld + stockpile mutation helpers moved
// out with the trade + caravan + bandit clusters.
// production-wage helpers moved with the production phase.
import { initializeSubsistenceAccess } from './world/subsistence.js';
import { crossGuildRumorPhase } from './politics/guildLedger.js';
// tickCaravanMovement moved out with the movement phase.
// MAX_ACTIVE_WORLD_CARAVANS + caravan/ai + caravan/goal moved with caravan cluster.
// Bandit camp + party types/helpers moved out with the bandit phase.
// politics/actor primitives (getStockAt, addStockAt etc) moved out
// with the phase clusters that use them.
// createCharacter, generateFullName, createFaction, createActor moved out with the bandit phase.
// Guild helpers (buildGuildByMember, mergeLedgerInto, Guild, GuildPriceObs)
// now live behind ./politics/guildLedger.ts.
// actorId + banditCampId + characterId + factionId moved out with
// the bandit phase. resolveAmbush + AmbushResult also moved.
// DEFAULT_GLOBAL_PRICES moved out with the trade + caravan clusters.
// makeCaravanIdLocal moved with caravan cluster.
// Patrol, resolveRaid, WallLevel moved out with the bandit + patrol phases.
// Caravan type moved with caravan cluster.
// createNewsItem, createNewsCarrier, NEWS_CARRIER_SPEED moved out
// with the bandit + patrol phases.
// tickCarrierWithGrid moved out with the movement phase.
// processNewsArrival + NamedCharacter moved out with newsArrivalPhase.
import type { ReputationMagnitude } from './reputation/table.js';
// clearMarket + market/scheduleBuilder helpers moved out with the
// trade phase. allRecipes ditto.
// News-carrier ticking is handled by docs/13's tickCarrier; the world doesn't
// yet hold a Map for them so the orchestration call sits with the news
// subsystem until that storage lands.
import type { Rng } from './rng.js';
import { dayOfYearToSeason, type Season } from './world/terrain.js';
import { type Hex } from './world/hex.js';
import type {
  ActorId,
  BanditCampId,
  BanditPartyId,
  BuildingId,
  CaravanId,
  Day,
  JobId,
  RecipeId,
  ResourceId,
  SettlementId,
} from './types.js';
import {
  buildLaborClassContext,
  type LaborClassContext,
} from './jobs/laborEconomics.js';
import type { Settlement } from './world/settlement.js';
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
      /**
       * Per docs/08 §"Marginal-product wages" + docs/14 §"Per-recipe
       * economics CSV": emitted alongside recipe_ran so burn-in can
       * attribute the surplus split per (settlement, recipe, owner).
       * All money fields are coin at local prices on the day; output
       * - input - wage = owner take (can be negative for loss-running
       * recipes when prices momentarily invert).
       */
      readonly type: 'recipe_economics';
      readonly settlement: SettlementId;
      readonly recipe: RecipeId;
      readonly owner: ActorId;
      readonly outputValue: number;
      readonly inputValue: number;
      readonly wagePaidCoin: number;
      readonly wagePaidInKindValue: number;
      readonly wagePaidTotal: number;
      readonly ownerTake: number;
      readonly paidWorkerDays: number;
      readonly subsistenceWagePerDay: number;
      readonly marginalProductPerWorkerDay: number;
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
      /**
       * Per docs/04 §"Person registry for moving units": the annual
       * aging pass aged every alive Person by one year and applied
       * baseline mortality. `deaths` is the count of Persons that
       * transitioned to `dead` during the pass.
       */
      readonly type: 'persons_aged';
      readonly deaths: number;
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
       * Per docs/15 §C31: a `free_village` or `hamlet_household` actor
       * dispatched a low-capacity villager caravan for a market run.
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
  // After every settlement clears its market, run the residual same-hex
  // local-trade pass for pagus / dependent-hamlet coexistence. Distance >= 1
  // inter-settlement trade uses real caravan units (docs/06 §"Local trade
  // between nearby settlements", docs/08 §"Per-settlement markets, regional
  // smoothing").
  localTradePhase(world, season, today, events, subsistenceAccess, laborContextForSettlement);

  // --- Phase 4c: Resident-presence price sync -----------------------------
  // After all markets clear, every actor that physically lives at a
  // settlement records a fresh MarketObservation into its knownPrices map
  // for that settlement (docs/06 §"All knowledge comes from syncs",
  // docs/10 decision 38). Not magic — literally "I live here, I see the
  // forum prices today."
  homePresenceSyncPhase(world, today);

  // --- Phase 4d: Mobile-unit price syncs ----------------------------------
  // Caravan arrival: every caravan currently parked at a settlement anchor
  // writes a fresh MarketObservation into its owner's knownPrices map.
  // Caravan meeting: pairs of caravans co-located on the same hex merge
  // their owners' maps (hostile actors refuse to share).
  // Guild ledger: every guild member co-present at the guild's home —
  // resident members or those with a caravan parked at home — mutual-
  // merges with the guild's map (docs/13 §"News-carrier price piggyback").
  caravanArrivalSyncPhase(world, today);
  caravanMeetingSyncPhase(world);
  guildLedgerSyncPhase(world);

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

// goalDestination + GoalStack helpers moved out with the caravan cluster
// (src/sim/phases/caravan.ts).

// --- Merchant guilds (docs/15 §C17) --------------------------------------
//
// `getGuildByMember`, `syncCaravanWithLocalGuild`, and
// `crossGuildRumorPhase` moved to src/sim/politics/guildLedger.ts.

// civilUnrestPhase moved to src/sim/phases/civilUnrest.ts.

// roadMaintenancePhase moved to src/sim/phases/roadMaintenance.ts.

// tributePhase moved to src/sim/phases/tribute.ts.

// storageSpoilagePhase + helpers moved to src/sim/phases/spoilage.ts.

// caravan spawn pressure helpers moved out with the caravan cluster
// (src/sim/phases/caravan.ts).

// taxShipmentPhase + helpers moved to src/sim/phases/taxShipment.ts.

// edgeHubPhase + helpers moved to src/sim/phases/edgeHub.ts.

// ageRecentFlowsPhase + trailWearTickPhase moved to src/sim/phases/
// (with their shared road-wear helpers in src/sim/world/roadWear.ts).
// Imported at the top of this file.

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
  // Eligible patrician families / caravan-owner firms replace lost trading
  // caravans slowly when the standing fleet falls below the province's
  // settlement-count target. This keeps trade alive over long burn-ins
  // without injecting discontinuous random fleets.
  merchantCaravanAssemblyPhase(world, rng.derive('merchant-caravan-assembly'), today, events);
  // Per docs/15 §C31: villages / hamlets with surplus, import cash, or
  // hard-times staple needs dispatch low-capacity villager caravans. Separate
  // fleet target from merchants so local runs and long-haul trade don't
  // compete for the same caravan slots.
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
  ingestLaborBlockedEvents(world, events);
  // Monthly hook (every 30 days): nudge workers from over-supplied to
  // under-supplied/profitable roles. Picking 30 (not exactly month-length)
  // so the cadence is independent of calendar bookkeeping.
  if ((today + 1) % 30 === 0) {
    workerReallocationPhase(world, today, events);
  }
  // Quarterly hook (every 90 days): each settlement's stockpile-owning
  // actors evaluate observed prices and invest in profitable buildings,
  // and the fiscal-redistribution pass moves cash from cash-generating
  // actor kinds (city corporations and tenant villages/hamlets) to
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


// caravan-trade helpers + caravanReplanPhase + merchantCaravanAssemblyPhase
// + villagerCaravanAssemblyPhase moved to src/sim/phases/caravan.ts.

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
