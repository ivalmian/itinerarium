/**
 * Per-entity history ring buffers for the viewer's inspection panels.
 *
 * The sim is the source of truth and intentionally does not retain
 * historical snapshots — every read is "what is this thing now?". For UX,
 * however, the player wants to see trajectories: did this settlement grow
 * or shrink? Did this caravan's treasury swing on its last leg? Did this
 * bandit camp lose half its strength to a recent patrol fight?
 *
 * We solve that purely on the viewer side by snapshotting visible entities
 * each tick into bounded ring buffers (~100 entries / entity, ~one per day
 * of sim wall-time). 100 entries × 3 kinds × ~50 visible-at-a-time entities
 * is a few KB of memory, well under the budget for a debug/burn-in viewer.
 *
 * Design choices:
 *   - We snapshot ALL entities every tick (not just selected) so when the
 *     user clicks a caravan that's been wandering for 30 days they see real
 *     prior state, not a single point. The settlement count is small enough
 *     (~65 in the default viewer boot) that this is cheap.
 *   - Events are routed through a per-entity event log, not stored in the
 *     entity snapshot, so we can show "last raid", "last epidemic", etc.
 *     We only retain the last 20 events per entity.
 *   - Settlement snapshots include population and a small set of clearing
 *     prices for the settlement's most-traded resources. We don't snapshot
 *     every tracked resource — the lastClearingPrice map already gives us
 *     a slice of what the settlement actually cleared.
 *   - All timestamps are sim days (world.day), not wall time. The panels
 *     render relative ("d-3", "d-30") so the user reads them as elapsed.
 *
 * Memory bound: per the cap of MAX_TICKS_PER_ENTITY * (~6 numbers + 1 Map)
 * we keep history at <~10 KB / entity / kind, and the prune step in
 * recordTick() bounds the total set of tracked ids per kind.
 */

import type {
  BanditCampId,
  CaravanId,
  Day,
  Position,
  ResourceId,
  SettlementId,
} from '../../src/sim/types.js';
import type { TickEvent } from '../../src/sim/tick.js';
import type { WorldState } from '../../src/procgen/seed.js';

/** Max number of per-tick snapshots retained for any single entity. */
export const MAX_TICKS_PER_ENTITY = 100;
/** Max number of recent events retained per entity. */
export const MAX_EVENTS_PER_ENTITY = 20;

/**
 * Global history is sampled (not every tick) so we can carry 10+
 * in-game years of trajectory without ballooning memory. With a 10-day
 * sample interval and 500 retained samples we get ~13.7y of coverage.
 */
export const GLOBAL_HISTORY_SAMPLE_DAYS = 10;
export const GLOBAL_HISTORY_MAX_SAMPLES = 500;

export interface SettlementSnapshot {
  readonly day: Day;
  readonly population: number;
  readonly buildings: number;
  /** ResourceId → last clearing price observed at this tick. Sparse. */
  readonly clearingPrices: ReadonlyMap<ResourceId, number>;
  /** Total stockpile per resource summed across all owners at this settlement. Sparse. */
  readonly stockpiles: ReadonlyMap<ResourceId, number>;
  /** Aggregate treasury of all stockpile-owner actors at this settlement. */
  readonly settlementTreasury: number;
}

/**
 * Per-tier population aggregate. The viewer's tally panel renders
 * this as a stacked line over time so the user can see e.g. "cities
 * grow, villages collapse" patterns at a glance.
 */
export interface TierPopulation {
  readonly hamlet: number;
  readonly village: number;
  readonly town: number;
  readonly small_city: number;
  readonly large_city: number;
  readonly total: number;
}

/**
 * Aggregate coin holdings by actor kind. Mirrors the burn-in report's
 * "Treasury by actor kind" table but live and updated as the sim
 * advances. Sparse — only kinds that have at least one alive actor.
 */
export type TreasuryByKind = ReadonlyMap<string, number>;

/** Caravan counts by ID-prefix category. */
export interface CaravanCounts {
  readonly villager: number;
  readonly merchant: number;
  readonly export_: number;
  readonly import_: number;
  readonly tax: number;
  readonly other: number;
  readonly total: number;
}

/**
 * Per-tick global aggregate snapshot. Sampled every
 * `GLOBAL_HISTORY_SAMPLE_DAYS` days to cap memory.
 */
export interface GlobalSnapshot {
  readonly day: Day;
  readonly population: TierPopulation;
  readonly caravans: CaravanCounts;
  readonly banditCampCount: number;
  readonly banditTotalCount: number;
  readonly treasuryByKind: TreasuryByKind;
  /** Median clearing price across all settlements that cleared this resource recently. */
  readonly medianPrices: ReadonlyMap<ResourceId, number>;
  /** Cumulative famine deaths since the run started. */
  readonly cumulativeFamineDeaths: number;
  /** Cumulative disease deaths since the run started. */
  readonly cumulativeDiseaseDeaths: number;
  /** Cumulative recipe runs since the run started. */
  readonly cumulativeRecipeRuns: number;
  /** Cumulative market clearings since the run started. */
  readonly cumulativeMarketClearings: number;
  /** Settlement count at this tick. */
  readonly settlementCount: number;
}

export interface CaravanSnapshot {
  readonly day: Day;
  readonly position: Position;
  readonly cargoUnits: number;
  readonly treasury: number;
  readonly health: number;
  readonly crewCount: number;
}

export interface BanditCampSnapshot {
  readonly day: Day;
  readonly banditCount: number;
  readonly hangersOnCount: number;
  readonly treasury: number;
  readonly averageHealth: number;
}

/**
 * Lightweight per-entity event record. We keep only the fields panels
 * actually render to keep the buffer small and so the type doesn't drift
 * with TickEvent's many subtypes.
 */
export interface EntityEvent {
  readonly day: Day;
  readonly kind: TickEvent['type'];
  readonly summary: string;
}

export interface ViewerHistory {
  readonly settlements: Map<SettlementId, SettlementSnapshot[]>;
  readonly caravans: Map<CaravanId, CaravanSnapshot[]>;
  readonly banditCamps: Map<BanditCampId, BanditCampSnapshot[]>;
  /** Keyed by the same id types as above; we union them as plain string keys. */
  readonly settlementEvents: Map<SettlementId, EntityEvent[]>;
  readonly caravanEvents: Map<CaravanId, EntityEvent[]>;
  readonly banditCampEvents: Map<BanditCampId, EntityEvent[]>;
  /** Sampled global aggregates over time. */
  readonly global: GlobalSnapshot[];
  /** Per-tick stats accumulator. Carried across ticks so cumulative counters survive. */
  cumulativeStats: {
    famineDeaths: number;
    diseaseDeaths: number;
    recipeRuns: number;
    marketClearings: number;
  };
}

export const createViewerHistory = (): ViewerHistory => ({
  settlements: new Map(),
  caravans: new Map(),
  banditCamps: new Map(),
  settlementEvents: new Map(),
  caravanEvents: new Map(),
  banditCampEvents: new Map(),
  global: [],
  cumulativeStats: {
    famineDeaths: 0,
    diseaseDeaths: 0,
    recipeRuns: 0,
    marketClearings: 0,
  },
});

/** Wipe all per-entity history. Called on world reset. */
export const clearHistory = (h: ViewerHistory): void => {
  h.settlements.clear();
  h.caravans.clear();
  h.banditCamps.clear();
  h.settlementEvents.clear();
  h.caravanEvents.clear();
  h.banditCampEvents.clear();
  h.global.length = 0;
  h.cumulativeStats.famineDeaths = 0;
  h.cumulativeStats.diseaseDeaths = 0;
  h.cumulativeStats.recipeRuns = 0;
  h.cumulativeStats.marketClearings = 0;
};

const pushBounded = <T>(buf: T[], snap: T): void => {
  buf.push(snap);
  if (buf.length > MAX_TICKS_PER_ENTITY) buf.shift();
};

const pushBoundedEvents = (buf: EntityEvent[], evt: EntityEvent): void => {
  buf.push(evt);
  if (buf.length > MAX_EVENTS_PER_ENTITY) buf.shift();
};

/**
 * Snapshot every currently-live entity, then prune buffers for entities that
 * have ceased to exist. Called once per advanced sim tick.
 */
export const recordTick = (history: ViewerHistory, world: WorldState): void => {
  // Settlements.
  // Precompute per-settlement stockpile totals + actor-treasury sums by
  // iterating actors once (used by both per-settlement snapshots and
  // global aggregates below).
  const stockpileBySettlement = new Map<SettlementId, Map<ResourceId, number>>();
  const treasuryBySettlement = new Map<SettlementId, number>();
  const treasuryByKind = new Map<string, number>();
  let banditTotalCount = 0;
  for (const [, a] of world.actors) {
    treasuryByKind.set(a.kind, (treasuryByKind.get(a.kind) ?? 0) + (a.treasury ?? 0));
    if (a.kind === 'bandit_camp') {
      // Skip: bandit_count is on banditCamps, not treasury sum.
    }
    for (const [sId, byRes] of a.stockpile) {
      let agg = stockpileBySettlement.get(sId);
      if (agg === undefined) {
        agg = new Map<ResourceId, number>();
        stockpileBySettlement.set(sId, agg);
      }
      for (const [r, q] of byRes) {
        agg.set(r, (agg.get(r) ?? 0) + q);
      }
    }
  }
  if (world.banditCamps !== undefined) {
    for (const [, camp] of world.banditCamps) {
      banditTotalCount += camp.banditCount;
    }
  }
  for (const [sId, s] of world.settlements) {
    let tSum = 0;
    for (const ownerId of s.stockpileOwners) {
      const a = world.actors.get(ownerId);
      if (a !== undefined) tSum += a.treasury ?? 0;
    }
    treasuryBySettlement.set(sId, tSum);
  }

  const settlementSeen = new Set<SettlementId>();
  for (const [id, s] of world.settlements) {
    settlementSeen.add(id);
    let buf = history.settlements.get(id);
    if (buf === undefined) {
      buf = [];
      history.settlements.set(id, buf);
    }
    // Copy the prices (small Map: ~6 entries in practice).
    const prices = new Map<ResourceId, number>(s.market.lastClearingPrice);
    const stockpiles = stockpileBySettlement.get(id) ?? new Map<ResourceId, number>();
    pushBounded(buf, {
      day: world.day,
      population: s.population.total(),
      buildings: s.buildings.length,
      clearingPrices: prices,
      stockpiles,
      settlementTreasury: treasuryBySettlement.get(id) ?? 0,
    });
  }
  for (const id of history.settlements.keys()) {
    if (!settlementSeen.has(id)) {
      history.settlements.delete(id);
      history.settlementEvents.delete(id);
    }
  }

  // Caravans.
  const caravanSeen = new Set<CaravanId>();
  for (const [id, c] of world.caravans) {
    caravanSeen.add(id);
    let buf = history.caravans.get(id);
    if (buf === undefined) {
      buf = [];
      history.caravans.set(id, buf);
    }
    let cargoUnits = 0;
    for (const v of c.cargo.values()) cargoUnits += v;
    let crewCount = 0;
    for (const m of c.crew) crewCount += m.count;
    pushBounded(buf, {
      day: world.day,
      position: { q: c.position.q, r: c.position.r },
      cargoUnits,
      treasury: c.treasury,
      health: c.health,
      crewCount,
    });
  }
  for (const id of history.caravans.keys()) {
    if (!caravanSeen.has(id)) {
      history.caravans.delete(id);
      history.caravanEvents.delete(id);
    }
  }

  // Bandit camps.
  const campSeen = new Set<BanditCampId>();
  if (world.banditCamps !== undefined) {
    for (const [id, camp] of world.banditCamps) {
      campSeen.add(id);
      let buf = history.banditCamps.get(id);
      if (buf === undefined) {
        buf = [];
        history.banditCamps.set(id, buf);
      }
      pushBounded(buf, {
        day: world.day,
        banditCount: camp.banditCount,
        hangersOnCount: camp.hangersOnCount,
        treasury: camp.treasury,
        averageHealth: camp.averageHealth,
      });
    }
  }
  for (const id of history.banditCamps.keys()) {
    if (!campSeen.has(id)) {
      history.banditCamps.delete(id);
      history.banditCampEvents.delete(id);
    }
  }

  // Global aggregates — sampled every GLOBAL_HISTORY_SAMPLE_DAYS days.
  if (world.day % GLOBAL_HISTORY_SAMPLE_DAYS === 0) {
    pushGlobalSnapshot(history, world, treasuryByKind, banditTotalCount);
  }
};

const pushGlobalSnapshot = (
  history: ViewerHistory,
  world: WorldState,
  treasuryByKind: Map<string, number>,
  banditTotalCount: number,
): void => {
  // Aggregate population by tier.
  let hamletPop = 0;
  let villagePop = 0;
  let townPop = 0;
  let smallCityPop = 0;
  let largeCityPop = 0;
  for (const [, s] of world.settlements) {
    const pop = s.population.total();
    switch (s.tier) {
      case 'hamlet':
        hamletPop += pop;
        break;
      case 'village':
        villagePop += pop;
        break;
      case 'town':
        townPop += pop;
        break;
      case 'small_city':
        smallCityPop += pop;
        break;
      case 'large_city':
        largeCityPop += pop;
        break;
    }
  }
  const tierPop: TierPopulation = {
    hamlet: hamletPop,
    village: villagePop,
    town: townPop,
    small_city: smallCityPop,
    large_city: largeCityPop,
    total: hamletPop + villagePop + townPop + smallCityPop + largeCityPop,
  };

  // Caravan counts by ID prefix.
  let villager = 0;
  let merchant = 0;
  let exportC = 0;
  let importC = 0;
  let tax = 0;
  let other = 0;
  for (const [id] of world.caravans) {
    const s = String(id);
    if (s.startsWith('villager-')) villager += 1;
    else if (s.startsWith('export-')) exportC += 1;
    else if (s.startsWith('import-')) importC += 1;
    else if (s.startsWith('tax-')) tax += 1;
    else if (s.startsWith('merchant-')) merchant += 1;
    else other += 1;
  }
  const caravans: CaravanCounts = {
    villager,
    merchant,
    export_: exportC,
    import_: importC,
    tax,
    other,
    total: villager + merchant + exportC + importC + tax + other,
  };

  // Median clearing prices across settlements that have a recent price.
  const priceLists = new Map<ResourceId, number[]>();
  for (const [, s] of world.settlements) {
    for (const [r, p] of s.market.lastClearingPrice) {
      if (!Number.isFinite(p) || p <= 0) continue;
      let arr = priceLists.get(r);
      if (arr === undefined) {
        arr = [];
        priceLists.set(r, arr);
      }
      arr.push(p);
    }
  }
  const medianPrices = new Map<ResourceId, number>();
  for (const [r, arr] of priceLists) {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    const med =
      arr.length % 2 === 0 && arr.length > 0
        ? ((arr[mid - 1] ?? 0) + (arr[mid] ?? 0)) / 2
        : (arr[mid] ?? 0);
    medianPrices.set(r, med);
  }

  const banditCampCount = world.banditCamps?.size ?? 0;

  const snap: GlobalSnapshot = {
    day: world.day,
    population: tierPop,
    caravans,
    banditCampCount,
    banditTotalCount,
    treasuryByKind: new Map(treasuryByKind),
    medianPrices,
    cumulativeFamineDeaths: history.cumulativeStats.famineDeaths,
    cumulativeDiseaseDeaths: history.cumulativeStats.diseaseDeaths,
    cumulativeRecipeRuns: history.cumulativeStats.recipeRuns,
    cumulativeMarketClearings: history.cumulativeStats.marketClearings,
    settlementCount: world.settlements.size,
  };
  history.global.push(snap);
  if (history.global.length > GLOBAL_HISTORY_MAX_SAMPLES) {
    history.global.shift();
  }
};

/**
 * Route this tick's events into per-entity event buffers. Many TickEvent
 * variants reference more than one entity (e.g. settlement_raided has both
 * a settlement AND a bandit camp); we record the event under each.
 *
 * Summaries written here use bracketed `[<kind>:<id>]` placeholders for
 * references to other entities. Renderers that have access to `WorldState`
 * (e.g. `viewer/ui/caravanPopup.ts`) replace these placeholders with
 * clickable entity links. Renderers without `WorldState` access can fall
 * back to plain text.
 */
export const recordEvents = (
  history: ViewerHistory,
  day: Day,
  events: readonly TickEvent[],
  world: WorldState,
): void => {
  for (const e of events) {
    routeEvent(history, day, e, world);
    accumulateGlobalStats(history, e);
  }
};

const accumulateGlobalStats = (history: ViewerHistory, e: TickEvent): void => {
  switch (e.type) {
    case 'cohort_deaths':
      if (e.cause === 'famine') history.cumulativeStats.famineDeaths += e.deaths;
      else if (e.cause === 'disease') history.cumulativeStats.diseaseDeaths += e.deaths;
      return;
    case 'recipe_ran':
      history.cumulativeStats.recipeRuns += 1;
      return;
    case 'market_cleared':
      history.cumulativeStats.marketClearings += 1;
      return;
    default:
      return;
  }
};

/**
 * Placeholder helpers — emit `[<kind>:<id>]` substrings that the popup
 * renderers substitute for clickable entity links. The renderer (or a
 * fallback stripper) does the name lookup so we don't capture a stale
 * snapshot of the entity name in the event buffer.
 */
const settlementRef = (id: SettlementId): string => `[settlement:${String(id)}]`;
const banditCampRef = (id: BanditCampId): string => `[bandit_camp:${String(id)}]`;

const addSettlementEvent = (
  history: ViewerHistory,
  id: SettlementId,
  evt: EntityEvent,
): void => {
  let buf = history.settlementEvents.get(id);
  if (buf === undefined) {
    buf = [];
    history.settlementEvents.set(id, buf);
  }
  pushBoundedEvents(buf, evt);
};

const addCaravanEvent = (
  history: ViewerHistory,
  id: CaravanId,
  evt: EntityEvent,
): void => {
  let buf = history.caravanEvents.get(id);
  if (buf === undefined) {
    buf = [];
    history.caravanEvents.set(id, buf);
  }
  pushBoundedEvents(buf, evt);
};

const addCampEvent = (
  history: ViewerHistory,
  id: BanditCampId,
  evt: EntityEvent,
): void => {
  let buf = history.banditCampEvents.get(id);
  if (buf === undefined) {
    buf = [];
    history.banditCampEvents.set(id, buf);
  }
  pushBoundedEvents(buf, evt);
};

const routeEvent = (
  history: ViewerHistory,
  day: Day,
  e: TickEvent,
  world: WorldState,
): void => {
  // `world` is used by the placeholder helpers below to ensure the id
  // we capture into the buffer is canonical (matches whatever the
  // renderer will look up). Keeping the param even when individual
  // event arms don't need a name today makes the renderer-future-proof.
  void world;
  switch (e.type) {
    case 'cohort_deaths':
      if (e.cause === 'famine' || e.cause === 'disease' || e.cause === 'war') {
        addSettlementEvent(history, e.settlement, {
          day,
          kind: e.type,
          summary: `${e.deaths} died (${e.cause})`,
        });
      }
      return;
    case 'epidemic_started':
      addSettlementEvent(history, e.settlement, {
        day,
        kind: e.type,
        summary: `epidemic: ${e.disease}`,
      });
      return;
    case 'settlement_raided':
      addSettlementEvent(history, e.settlement, {
        day,
        kind: e.type,
        summary: `raided by ${banditCampRef(e.by)} (${e.cargoLost} taken, ${e.defendersKilled} dead)`,
      });
      addCampEvent(history, e.by, {
        day,
        kind: e.type,
        summary: `raided ${settlementRef(e.settlement)} (+${e.cargoLost} loot)`,
      });
      return;
    case 'caravan_robbed':
      addCaravanEvent(history, e.caravan, {
        day,
        kind: e.type,
        summary:
          e.by !== null
            ? `robbed by ${banditCampRef(e.by)} (${e.cargoLost} cargo lost)`
            : `robbed (${e.cargoLost} cargo lost)`,
      });
      if (e.by !== null) {
        addCampEvent(history, e.by, {
          day,
          kind: e.type,
          summary: `robbed caravan (+${e.cargoLost})`,
        });
      }
      return;
    case 'caravan_arrived': {
      // Render the destination as a settlement name when we can resolve
      // it; otherwise fall through to hex coords. We don't have a way to
      // call into entityLinks here (renderer scope), so we just include
      // the settlement placeholder when the hex contains a settlement.
      let where = `(${e.at.q},${e.at.r})`;
      for (const s of world.settlements.values()) {
        if (s.anchor.q === e.at.q && s.anchor.r === e.at.r) {
          where = settlementRef(s.id);
          break;
        }
      }
      addCaravanEvent(history, e.caravan, {
        day,
        kind: e.type,
        summary: `arrived at ${where}`,
      });
      return;
    }
    case 'building_completed':
      addSettlementEvent(history, e.settlement, {
        day,
        kind: e.type,
        summary: `built ${String(e.building)} (${e.daysToBuild}d)`,
      });
      return;
    case 'building_invested':
      addSettlementEvent(history, e.settlement, {
        day,
        kind: e.type,
        summary: `invested in ${String(e.building)} (${e.costCoin} coin)`,
      });
      return;
    case 'patrol_engaged':
      addCampEvent(history, e.camp, {
        day,
        kind: e.type,
        summary: `patrol engaged: ${e.outcome}`,
      });
      return;
    case 'fence_traded':
      addSettlementEvent(history, e.through, {
        day,
        kind: e.type,
        summary: `fenced loot for ${banditCampRef(e.camp)} (+${e.coinPaid} coin)`,
      });
      addCampEvent(history, e.camp, {
        day,
        kind: e.type,
        summary: `fenced loot through ${settlementRef(e.through)} for ${e.coinPaid}`,
      });
      return;
    case 'bandit_recruited':
      addSettlementEvent(history, e.fromSettlement, {
        day,
        kind: e.type,
        summary: `${e.count} joined ${banditCampRef(e.camp)}`,
      });
      addCampEvent(history, e.camp, {
        day,
        kind: e.type,
        summary: `recruited ${e.count} from ${settlementRef(e.fromSettlement)}`,
      });
      return;
    case 'catchment_resized':
      addSettlementEvent(history, e.settlement, {
        day,
        kind: e.type,
        summary: `catchment ${e.oldRadius}→${e.newRadius} (+${e.claimed}/-${e.released})`,
      });
      return;
    case 'tax_shipment_dispatched':
      addSettlementEvent(history, e.fromSettlement, {
        day,
        kind: e.type,
        summary: `tax → ${settlementRef(e.toSettlement)} (${e.grainModii}m, ${e.coin}c)`,
      });
      addSettlementEvent(history, e.toSettlement, {
        day,
        kind: e.type,
        summary: `tax ← ${settlementRef(e.fromSettlement)} (${e.grainModii}m, ${e.coin}c)`,
      });
      return;
    case 'local_trade':
      addSettlementEvent(history, e.fromSettlement, {
        day,
        kind: e.type,
        summary: `sold ${e.quantity} ${String(e.resource)} → ${settlementRef(e.toSettlement)}`,
      });
      addSettlementEvent(history, e.toSettlement, {
        day,
        kind: e.type,
        summary: `bought ${e.quantity} ${String(e.resource)} ← ${settlementRef(e.fromSettlement)}`,
      });
      return;
    case 'caravan_traded': {
      const unitPrice = e.quantity > 0 ? e.coin / e.quantity : 0;
      const sign = e.side === 'sold' ? '+' : '−';
      const qtyStr = Number.isInteger(e.quantity)
        ? String(e.quantity)
        : e.quantity.toFixed(1);
      addCaravanEvent(history, e.caravan, {
        day,
        kind: e.type,
        summary: `${e.side} ${qtyStr} ${String(e.resource)} @ ${unitPrice.toFixed(2)} ${sign}${Math.round(e.coin)}c · ${settlementRef(e.settlement)}`,
      });
      // Mirror the trade on the settlement so the settlement's own log
      // shows "Caelius's caravan bought 12 grain @ 1.10 …" with a link
      // to the caravan.
      addSettlementEvent(history, e.settlement, {
        day,
        kind: e.type,
        summary: `[caravan:${String(e.caravan)}] ${e.side} ${qtyStr} ${String(e.resource)} @ ${unitPrice.toFixed(2)} ${sign}${Math.round(e.coin)}c`,
      });
      return;
    }
    case 'caravan_profit_remitted':
      addCaravanEvent(history, e.caravan, {
        day,
        kind: e.type,
        summary: `remitted ${Math.round(e.coin)}c to owner · ${settlementRef(e.settlement)}`,
      });
      return;
    case 'caravan_exported_off_map':
      addCaravanEvent(history, e.caravan, {
        day,
        kind: e.type,
        summary: `exported ${Number.isInteger(e.quantity) ? e.quantity : e.quantity.toFixed(1)} ${String(e.resource)} off-map +${Math.round(e.coin)}c`,
      });
      return;
    default:
      return;
  }
};
