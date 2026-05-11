/**
 * Settlement: an anchor + multi-hex urban extent + catchment +
 * population pool + per-owner stockpile + market state.
 *
 * docs/05 §"Multi-hex entry UX (locked)": the player entering ANY
 * urban or catchment hex opens the settlement screen — there's
 * no single "settlement hex." docs/05 §"Ownership of catchment
 * hexes": each catchment hex is owned by a specific actor, and
 * recipe outputs flow to the owner's stockpile, not a generic
 * settlement pool. Stockpile *holders* are tracked here so the
 * UI can enumerate them; actual quantities live on each Actor
 * (T6 — see src/sim/politics/actor.ts).
 *
 * Design references:
 *   docs/05-settlements.md
 *   docs/11-politics-and-ownership.md
 */

import { getBuilding } from '../buildings/catalog.js';
import { emptyPool, type PopulationPool } from '../population/index.js';
import type { Quantity } from '../types.js';
import type {
  ActorId,
  BuildingId,
  Day,
  FactionId,
  JobId,
  ResourceId,
  SettlementId,
} from '../types.js';
import { hex as makeHex, hexEquals, hexesWithinRange, hexKey, type Hex } from './hex.js';
import type { HexGrid } from './grid.js';

export type SettlementTier = 'hamlet' | 'village' | 'town' | 'small_city' | 'large_city';

export const SETTLEMENT_TIERS = [
  'hamlet',
  'village',
  'town',
  'small_city',
  'large_city',
] as const satisfies readonly SettlementTier[];

export interface SettlementBuilding {
  /** Type of building (lookup against src/sim/buildings/catalog.ts). */
  buildingId: BuildingId;
  /** Specific hex within the settlement (urban or catchment). */
  hex: Hex;
  /** The actor that owns this physical building. */
  ownerActor: ActorId;
  /** Current remaining capacity for the active day. */
  capacity: number;
  /**
   * Installed daily capacity for this physical building. Starter buildings
   * may be scaled above the catalog default; daily production resets
   * `capacity` back to this value.
   */
  maxCapacity?: number;
  daysSinceMaintained: number;
}

export interface MarketSnapshot {
  /**
   * Four exponentially-decayed flow counters per resource. All four are
   * multiplied by `exp(-1/30) ≈ 0.967` once per day by the tick layer's
   * `ageRecentFlowsPhase` BEFORE the day's new flows are recorded, so
   * each value approximates the last ~30 days of activity (steady-state
   * ≈ 30 × daily-rate). Categories:
   *
   *  - `recentImports`: goods arriving from elsewhere (caravan delivery,
   *    off-map factor consignment, local-trade buyer side).
   *  - `recentExports`: goods leaving the settlement to elsewhere
   *    (caravan picking up cargo, local-trade seller side).
   *  - `recentProduction`: goods made HERE by a recipe firing
   *    (mill grinding flour, smithy making tools, farm yielding grain).
   *  - `recentConsumption`: goods used UP HERE (recipe inputs drained,
   *    population eating bread, subsistence-curve trades).
   *
   * `recentInflows` and `recentOutflows` are aggregates:
   *   recentInflows  = recentImports  + recentProduction
   *   recentOutflows = recentExports  + recentConsumption
   * Kept on the schema as cached sums so existing consumers (tax
   * assessor, viewer fallbacks, snapshot replay) keep working unchanged.
   */
  recentImports: Map<ResourceId, number>;
  recentExports: Map<ResourceId, number>;
  recentProduction: Map<ResourceId, number>;
  recentConsumption: Map<ResourceId, number>;
  recentInflows: Map<ResourceId, number>;
  recentOutflows: Map<ResourceId, number>;
  /** Last clearing price per resource (set by the market clearing tick). */
  lastClearingPrice: Map<ResourceId, number>;
}

export interface Settlement {
  readonly id: SettlementId;
  tier: SettlementTier;
  readonly name: string;
  readonly anchor: Hex;
  readonly urbanHexes: readonly Hex[];
  /**
   * Mutable catchment list. Per docs/05 §"Dynamic catchment recompute" the
   * settlement claims/releases catchment hexes when its population crosses a
   * ±25% threshold from `catchmentBaselinePop`. Production layer reads this
   * each tick — so we replace the array contents in-place via splice() rather
   * than re-assigning the field.
   */
  catchmentHexes: Hex[];
  readonly population: PopulationPool;
  readonly buildings: SettlementBuilding[];
  readonly factions: FactionId[];
  readonly stockpileOwners: ActorId[];
  readonly market: MarketSnapshot;
  /**
   * Population at the most recent catchment recompute. Initialized at procgen
   * to the day-0 population. The annual phase compares current pop to this
   * baseline to decide whether to resize the catchment.
   */
  catchmentBaselinePop: number;
  /**
   * Day on which the catchment was last resized. Initialized to 0 at procgen.
   * A 365-day cooldown prevents thrashing across rapid pop swings (e.g. a
   * plague year + bounce-back).
   */
  catchmentDayLastChanged: Day;
  /**
   * Per-job worker assignments (docs/04 §"Worker reallocation by demand").
   * The production engine treats each adult as available only for the job
   * they are currently assigned to (rather than the v1 "all adults available
   * for all roles" generosity). Allocations shift slowly each month based on
   * recipe_blocked-labor events and clearing prices.
   */
  readonly jobAllocations: Map<JobId, number>;
  /**
   * In-progress construction projects (docs/08 §"Construction is heavy"
   * + docs/15 §C8). Buildings spend mason+carpenter worker-days here
   * before becoming productive. The investmentPhase pushes new pending
   * builds; the construction phase drains worker-days from settlement
   * allocations toward them; when workerDaysRemaining hits 0 the
   * building is materialized via addBuilding and the entry is removed.
   */
  readonly pendingBuildings: PendingBuilding[];
  /**
   * Buildings being torn down (per docs/15 §C8 demolition). Drained by
   * the demolition phase from the same mason+carpenter pools as
   * construction. ~15% of construction time. On completion: half the
   * materials credit back to the owner's stockpile; the building is
   * removed from `buildings`.
   */
  readonly pendingDemolitions: PendingDemolition[];
}

export interface PendingBuilding {
  readonly buildingId: BuildingId;
  readonly hex: Hex;
  readonly ownerActor: ActorId;
  readonly beganOnDay: Day;
  workerDaysRemaining: number;
  /** Total at start, kept for telemetry / progress display. */
  readonly workerDaysTotal: number;
  /**
   * Per docs/15 §C14: construction labor is split between masons (stone
   * + brick work) and carpenters (lumber work). When 0, treated as legacy
   * "any worker-day counts" projects (ignored for the labor-split rule).
   * Mason and carpenter pools drain independently.
   */
  masonDaysRemaining?: number;
  carpenterDaysRemaining?: number;
}

export interface PendingDemolition {
  readonly buildingId: BuildingId;
  readonly hex: Hex;
  readonly ownerActor: ActorId;
  readonly beganOnDay: Day;
  workerDaysRemaining: number;
}

export interface CreateSettlementInput {
  readonly id: SettlementId;
  readonly tier: SettlementTier;
  readonly name: string;
  readonly anchor: Hex;
  readonly urbanHexes: readonly Hex[];
  readonly catchmentHexes: readonly Hex[];
  readonly factions?: readonly FactionId[];
  readonly stockpileOwners?: readonly ActorId[];
  /**
   * Initial baseline pop for catchment recompute. Defaults to 0 so newly
   * created (test-stub) settlements behave the same as before; procgen
   * overwrites with the seeded total population so the first ±25% trigger
   * fires sensibly.
   */
  readonly catchmentBaselinePop?: number;
  /**
   * Initial day for catchment cooldown. Defaults to 0.
   */
  readonly catchmentDayLastChanged?: Day;
}

const cloneHex = (h: Hex): Hex => makeHex(h.q, h.r);

const containsHex = (hexes: readonly Hex[], h: Hex): boolean => {
  for (const x of hexes) {
    if (hexEquals(x, h)) return true;
  }
  return false;
};

export const createSettlement = (input: CreateSettlementInput): Settlement => {
  if (input.name.length === 0) {
    throw new Error(`Settlement ${String(input.id)} must have a non-empty name`);
  }
  if (input.urbanHexes.length === 0) {
    throw new Error(`Settlement ${String(input.id)} must have at least one urban hex`);
  }
  if (!containsHex(input.urbanHexes, input.anchor)) {
    throw new Error(`Settlement ${String(input.id)} anchor must be one of its urban hexes`);
  }
  // Defensively reject overlap so addBuilding/settlementContainsHex stay
  // unambiguous about whether a hex is urban or catchment.
  const urbanKeys = new Set(input.urbanHexes.map(hexKey));
  for (const c of input.catchmentHexes) {
    if (urbanKeys.has(hexKey(c))) {
      throw new Error(
        `Settlement ${String(input.id)} hex ${hexKey(c)} is both urban and catchment`,
      );
    }
  }

  return {
    id: input.id,
    tier: input.tier,
    name: input.name,
    anchor: cloneHex(input.anchor),
    urbanHexes: input.urbanHexes.map(cloneHex),
    catchmentHexes: input.catchmentHexes.map(cloneHex),
    population: emptyPool(),
    buildings: [],
    pendingBuildings: [],
    pendingDemolitions: [],
    factions: input.factions ? [...input.factions] : [],
    stockpileOwners: input.stockpileOwners ? [...input.stockpileOwners] : [],
    market: {
      recentImports: new Map(),
      recentExports: new Map(),
      recentProduction: new Map(),
      recentConsumption: new Map(),
      recentInflows: new Map(),
      recentOutflows: new Map(),
      lastClearingPrice: new Map(),
    },
    catchmentBaselinePop: input.catchmentBaselinePop ?? 0,
    catchmentDayLastChanged: input.catchmentDayLastChanged ?? 0,
    jobAllocations: new Map(),
  };
};

export const settlementContainsHex = (s: Settlement, h: Hex): boolean => {
  return containsHex(s.urbanHexes, h) || containsHex(s.catchmentHexes, h);
};

/**
 * Population → tier classification per docs/05 table:
 *   Hamlet: 30–150 (we treat <150 as hamlet, including 0).
 *   Village: 150–800
 *   Town: 1k–5k (we use ≥1000 as the bottom of town to leave a
 *     small "transitional" gap 800–1000 inside village)
 *   Small city: 5k–15k
 *   Large city: 15k–50k+
 */
export const tierOfPopulation = (totalPop: number): SettlementTier => {
  if (!Number.isFinite(totalPop) || totalPop < 0) {
    throw new Error(`tierOfPopulation: population must be non-negative, got ${totalPop}`);
  }
  if (totalPop < 150) return 'hamlet';
  if (totalPop < 1000) return 'village';
  if (totalPop < 5000) return 'town';
  if (totalPop < 15000) return 'small_city';
  return 'large_city';
};

/** Catchment radius in hexes (1 km/hex). docs/05 §"Catchment". */
export const expectedCatchmentRadius = (tier: SettlementTier): number => {
  switch (tier) {
    case 'hamlet':
      return 1;
    case 'village':
      return 2;
    case 'town':
      return 3;
    case 'small_city':
      return 5;
    case 'large_city':
      return 5;
  }
};

/**
 * The "typical" population for a tier — the midpoint of each tier's docs/05
 * range used as a normalizer when scaling the catchment radius. Used by the
 * dynamic-catchment recompute (docs/05 §"Dynamic catchment recompute").
 *
 *   r' = expectedCatchmentRadius(tier) × sqrt(currentPop / typicalPop)
 *
 * Radius scales with sqrt(pop) because catchment AREA scales linearly with
 * the people working it.
 */
export const typicalPopForTier = (tier: SettlementTier): number => {
  switch (tier) {
    case 'hamlet':
      return 100;
    case 'village':
      return 500;
    case 'town':
      return 2000;
    case 'small_city':
      return 10000;
    case 'large_city':
      return 30000;
  }
};

/** Min/max catchment radius clamps used by the dynamic recompute. */
export const MIN_CATCHMENT_RADIUS = 1;
export const MAX_CATCHMENT_RADIUS = 15;

/**
 * Compute the *target* catchment radius for a settlement at `currentPop` in
 * tier `tier`. Per docs/05 §"Dynamic catchment recompute":
 *   r' = expectedCatchmentRadius(tier) × sqrt(currentPop / typicalPop)
 * clamped to [MIN_CATCHMENT_RADIUS, MAX_CATCHMENT_RADIUS]. A settlement that
 * collapses to 0 still gets MIN_CATCHMENT_RADIUS so it has somewhere for any
 * remaining buildings to sit.
 */
export const targetCatchmentRadius = (tier: SettlementTier, currentPop: number): number => {
  const base = expectedCatchmentRadius(tier);
  const typical = typicalPopForTier(tier);
  const safePop = Number.isFinite(currentPop) && currentPop > 0 ? currentPop : 0;
  const scaled = base * Math.sqrt(safePop / typical);
  const rounded = Math.max(MIN_CATCHMENT_RADIUS, Math.round(scaled));
  return Math.min(MAX_CATCHMENT_RADIUS, rounded);
};

/** Urban hex count band per docs/05 §"Physical extent". */
export const expectedUrbanHexCount = (tier: SettlementTier): { min: number; max: number } => {
  switch (tier) {
    case 'hamlet':
      return { min: 1, max: 1 };
    case 'village':
      return { min: 1, max: 1 };
    case 'town':
      return { min: 1, max: 2 };
    case 'small_city':
      return { min: 2, max: 3 };
    case 'large_city':
      return { min: 3, max: 10 };
  }
};

const buildingMatches = (b: SettlementBuilding, hex: Hex, buildingId: BuildingId): boolean =>
  hexEquals(b.hex, hex) && b.buildingId === buildingId;

export const addBuilding = (s: Settlement, b: SettlementBuilding): void => {
  if (!settlementContainsHex(s, b.hex)) {
    throw new Error(`addBuilding: hex ${hexKey(b.hex)} is not part of settlement ${String(s.id)}`);
  }
  for (const existing of s.buildings) {
    if (buildingMatches(existing, b.hex, b.buildingId) && existing.ownerActor === b.ownerActor) {
      throw new Error(
        `addBuilding: duplicate ${String(b.buildingId)} at ${hexKey(b.hex)} owned by ${String(b.ownerActor)}`,
      );
    }
  }
  s.buildings.push({
    ...b,
    hex: cloneHex(b.hex),
  });
};

export const removeBuilding = (s: Settlement, hex: Hex, buildingId: BuildingId): void => {
  const i = s.buildings.findIndex((b) => buildingMatches(b, hex, buildingId));
  if (i < 0) {
    throw new Error(
      `removeBuilding: no ${String(buildingId)} at ${hexKey(hex)} in settlement ${String(s.id)}`,
    );
  }
  s.buildings.splice(i, 1);
};

const requirePositiveQty = (qty: number, label: string): void => {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${label} must be positive, got ${qty}`);
  }
};

const bumpMap = (m: Map<ResourceId, number>, resource: ResourceId, qty: number): void => {
  m.set(resource, (m.get(resource) ?? 0) + qty);
};

/** A trade delivery from outside arrived at this settlement (caravan
 *  selling its cargo to the local market, off-map factor consignment,
 *  buyer side of a local-trade pair). Aggregated into `recentInflows`. */
export const recordImport = (s: Settlement, resource: ResourceId, qty: number): void => {
  requirePositiveQty(qty, 'recordImport qty');
  bumpMap(s.market.recentImports, resource, qty);
  bumpMap(s.market.recentInflows, resource, qty);
};

/** A trade pickup left this settlement (caravan buying cargo, seller side
 *  of a local-trade pair, fence outlet sale). Aggregated into
 *  `recentOutflows`. */
export const recordExport = (s: Settlement, resource: ResourceId, qty: number): void => {
  requirePositiveQty(qty, 'recordExport qty');
  bumpMap(s.market.recentExports, resource, qty);
  bumpMap(s.market.recentOutflows, resource, qty);
};

/** A recipe firing in this settlement produced output (mill grinding,
 *  smithy hammering, farm harvest). Aggregated into `recentInflows`. */
export const recordProduction = (s: Settlement, resource: ResourceId, qty: number): void => {
  requirePositiveQty(qty, 'recordProduction qty');
  bumpMap(s.market.recentProduction, resource, qty);
  bumpMap(s.market.recentInflows, resource, qty);
};

/** Goods were used up in this settlement (recipe inputs drained,
 *  population eating, subsistence-curve trade where the buyer immediately
 *  consumes). Aggregated into `recentOutflows`. */
export const recordConsumption = (s: Settlement, resource: ResourceId, qty: number): void => {
  requirePositiveQty(qty, 'recordConsumption qty');
  bumpMap(s.market.recentConsumption, resource, qty);
  bumpMap(s.market.recentOutflows, resource, qty);
};

/**
 * Back-compat shim. Old callers used `recordInflow` for both imports and
 * production without distinguishing; everything that came through here is
 * routed to `recordImport`. New code should call `recordImport` /
 * `recordProduction` directly.
 * @deprecated prefer `recordImport` or `recordProduction`.
 */
export const recordInflow = (s: Settlement, resource: ResourceId, qty: number): void => {
  recordImport(s, resource, qty);
};

/**
 * Back-compat shim. Old callers used `recordOutflow` for both exports and
 * local consumption. Everything that came through here is routed to
 * `recordExport`. New code should call `recordExport` or
 * `recordConsumption` directly.
 * @deprecated prefer `recordExport` or `recordConsumption`.
 */
export const recordOutflow = (s: Settlement, resource: ResourceId, qty: number): void => {
  recordExport(s, resource, qty);
};

export const recordClearingPrice = (s: Settlement, resource: ResourceId, price: number): void => {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`recordClearingPrice: price must be non-negative, got ${price}`);
  }
  s.market.lastClearingPrice.set(resource, price);
};

// --- Dynamic catchment recompute (docs/05 §"Dynamic catchment recompute") ---

/**
 * Set or clear the `ownerActor` on a hex tile in the grid. A no-op if the hex
 * doesn't exist (defensive). This mirrors the private `setOwner` in
 * src/procgen/seed.ts but lives here so the tick layer can invoke it during
 * dynamic recompute without taking a procgen dependency.
 */
export const setHexOwner = (grid: HexGrid, hex: Hex, owner: ActorId | null): void => {
  const tile = grid.get(hex);
  if (tile === undefined) return;
  tile.ownerActor = owner;
};

export interface SettlementStorage {
  /** Per-resource cap (in resource units). */
  readonly perResource: ReadonlyMap<ResourceId, Quantity>;
  /** Generic in-process cap in kilograms (any tradable). */
  readonly wildcardKg: number;
}

/**
 * Aggregate storage capacity from this settlement's buildings, plus a
 * per-capita household baseline so buildingless hamlets aren't capped
 * at zero. Per docs/15 §C10 + docs/05 §"Storage capacity".
 */
export const computeStorageCapacity = (s: Settlement): SettlementStorage => {
  const perResource = new Map<ResourceId, Quantity>();
  let wildcardKg = 0;

  // Households: ~50 kg of mixed storage per adult (the family attic +
  // a couple of grain pots). Without this floor, a hamlet of 100 with
  // no granary can't hold any reserves at all — unrealistic.
  const adults = adultPopulationCount(s);
  wildcardKg += adults * 50;

  for (const b of s.buildings) {
    const def = getBuilding(b.buildingId);
    const sc = def.storageCapacity;
    if (sc !== undefined) {
      for (const [r, qty] of sc) {
        perResource.set(r, (perResource.get(r) ?? 0) + qty);
      }
    }
    wildcardKg += def.wildcardCapacityKg ?? 0;
  }
  return { perResource, wildcardKg };
};

/** Sum of working-age cohorts (15-59). Local helper. */
const adultPopulationCount = (s: Settlement): number => {
  let n = 0;
  for (const [key, count] of s.population.cohorts()) {
    const age = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (age >= 15 && age < 60) n += count;
  }
  return n;
};

export interface CatchmentRecomputeResult {
  readonly resized: boolean;
  readonly oldRadius: number;
  readonly newRadius: number;
  readonly claimed: readonly Hex[];
  readonly released: readonly Hex[];
}

const POP_TRIGGER_FRACTION = 0.25;
const COOLDOWN_DAYS = 365;

/**
 * Decide whether `settlement` should resize its catchment now. Returns true
 * iff:
 *   - the population has moved by more than ±25% from `catchmentBaselinePop`
 *   - and at least 365 days have passed since the last recompute.
 *
 * Settlements with a baseline of 0 (e.g. just-seeded test stubs that weren't
 * given a baseline by procgen) are not eligible — without a baseline the
 * relative threshold is undefined.
 */
export const shouldRecomputeCatchment = (
  settlement: Settlement,
  currentPop: number,
  today: Day,
): boolean => {
  if (settlement.catchmentBaselinePop <= 0) return false;
  if (today - settlement.catchmentDayLastChanged < COOLDOWN_DAYS) return false;
  const delta = Math.abs(currentPop - settlement.catchmentBaselinePop);
  return delta / settlement.catchmentBaselinePop > POP_TRIGGER_FRACTION;
};

/**
 * Recompute `settlement`'s catchment to match `currentPop`. Per docs/05
 * §"Dynamic catchment recompute":
 *
 *   1. Compute `r' = expectedCatchmentRadius(tier) × sqrt(pop / typicalPop)`,
 *      clamped to [MIN_CATCHMENT_RADIUS, MAX_CATCHMENT_RADIUS].
 *   2. Released hexes (in old catchment, not in new): clear ownership via
 *      setHexOwner(grid, hex, null). Buildings on those hexes stay (their
 *      owner still has them on their books) but no longer count toward this
 *      settlement's productive land.
 *   3. Claimed hexes (in new catchment, not in old): only those not currently
 *      owned by ANY other settlement (urban OR catchment). Contested hexes
 *      are deferred (the existing claimant keeps them).
 *
 * Mutates `settlement.catchmentHexes`, `settlement.catchmentBaselinePop`, and
 * `settlement.catchmentDayLastChanged`. Updates the grid's hex ownership.
 *
 * @param ownerActorForClaimed The actor that should own newly-claimed hexes.
 *   Caller is responsible for picking a sensible owner — typically the same
 *   actor that owned the settlement's catchment to begin with (e.g. the city
 *   corporation, the free village, or the patron family).
 * @param otherSettlements All other settlements in the world; used to detect
 *   which hexes are already claimed by a neighbor so we don't steal them.
 */
export const recomputeCatchment = (input: {
  readonly settlement: Settlement;
  readonly currentPop: number;
  readonly today: Day;
  readonly grid: HexGrid;
  readonly ownerActorForClaimed: ActorId | null;
  readonly otherSettlements: Iterable<Settlement>;
}): CatchmentRecomputeResult => {
  const { settlement, currentPop, today, grid, ownerActorForClaimed, otherSettlements } = input;

  const oldRadius = computeCurrentRadius(settlement);
  const newRadius = targetCatchmentRadius(settlement.tier, currentPop);

  // Build the candidate set for the new catchment: every hex within newRadius
  // of any urban hex, minus the urban hexes themselves, that exists in grid.
  const urbanKeys = new Set(settlement.urbanHexes.map(hexKey));
  const desired = new Map<string, Hex>();
  for (const u of settlement.urbanHexes) {
    for (const h of hexesWithinRange(u, newRadius)) {
      const k = hexKey(h);
      if (urbanKeys.has(k)) continue;
      if (!grid.has(h)) continue;
      if (!desired.has(k)) desired.set(k, h);
    }
  }

  // Collect every hex (urban + catchment) owned by any other settlement so we
  // can defer contested claims.
  const claimedByOthers = new Set<string>();
  for (const other of otherSettlements) {
    if (other.id === settlement.id) continue;
    for (const u of other.urbanHexes) claimedByOthers.add(hexKey(u));
    for (const c of other.catchmentHexes) claimedByOthers.add(hexKey(c));
  }

  const oldKeys = new Set(settlement.catchmentHexes.map(hexKey));

  // Released = in old, not in desired.
  const released: Hex[] = [];
  for (const h of settlement.catchmentHexes) {
    if (!desired.has(hexKey(h))) released.push(h);
  }

  // Claimed = in desired, not in old, not contested.
  const claimed: Hex[] = [];
  for (const [k, h] of desired) {
    if (oldKeys.has(k)) continue;
    if (claimedByOthers.has(k)) continue;
    claimed.push(h);
  }

  // Apply: rebuild catchmentHexes = (old - released) + claimed.
  const releasedKeys = new Set(released.map(hexKey));
  const newCatchment: Hex[] = [];
  for (const h of settlement.catchmentHexes) {
    if (!releasedKeys.has(hexKey(h))) newCatchment.push(h);
  }
  for (const h of claimed) newCatchment.push(cloneHex(h));

  // Mutate the catchmentHexes list in place so any stable reference holders
  // still see the new contents.
  settlement.catchmentHexes.splice(0, settlement.catchmentHexes.length, ...newCatchment);

  // Apply hex-ownership changes.
  for (const h of released) setHexOwner(grid, h, null);
  for (const h of claimed) setHexOwner(grid, h, ownerActorForClaimed);

  // Per docs/15 §C8 demolition: any building physically located on a
  // released hex starts being torn down. The buildings stay in
  // settlement.buildings until pendingDemolitions completes.
  if (releasedKeys.size > 0) {
    for (const b of settlement.buildings) {
      const k = hexKey(b.hex);
      if (!releasedKeys.has(k)) continue;
      // Skip if already queued.
      const already = settlement.pendingDemolitions.some(
        (d) => d.buildingId === b.buildingId && hexEquals(d.hex, b.hex),
      );
      if (already) continue;
      settlement.pendingDemolitions.push({
        buildingId: b.buildingId,
        hex: cloneHex(b.hex),
        ownerActor: b.ownerActor,
        beganOnDay: today,
        // Demolition takes ~15% of construction time. Use a fixed
        // small-but-nonzero value here; the tick layer's
        // constructionWorkerDays helper isn't reachable from this
        // module (would create a buildings → settlement cycle).
        // The tick layer can adjust via the field.
        workerDaysRemaining: 15,
      });
    }
  }

  settlement.catchmentBaselinePop = currentPop;
  settlement.catchmentDayLastChanged = today;

  return {
    resized: claimed.length > 0 || released.length > 0,
    oldRadius,
    newRadius,
    claimed,
    released,
  };
};

/**
 * Best-effort estimate of the settlement's *current* catchment radius — the
 * max hex-distance from any urban hex to any catchment hex. Used for
 * diagnostic/tick-event reporting only; the recompute itself uses the
 * tier+pop-derived target radius.
 */
const computeCurrentRadius = (settlement: Settlement): number => {
  if (settlement.catchmentHexes.length === 0) return 0;
  let maxDist = 0;
  for (const c of settlement.catchmentHexes) {
    let bestForC = Infinity;
    for (const u of settlement.urbanHexes) {
      const d = Math.abs(u.q - c.q) + Math.abs(u.r - c.r) + Math.abs(u.q + u.r - c.q - c.r);
      const dist = d / 2;
      if (dist < bestForC) bestForC = dist;
    }
    if (bestForC > maxDist) maxDist = bestForC;
  }
  return maxDist;
};
