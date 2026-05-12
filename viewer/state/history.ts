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

export interface SettlementSnapshot {
  readonly day: Day;
  readonly population: number;
  readonly buildings: number;
  /** ResourceId → last clearing price observed at this tick. Sparse. */
  readonly clearingPrices: ReadonlyMap<ResourceId, number>;
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
}

export const createViewerHistory = (): ViewerHistory => ({
  settlements: new Map(),
  caravans: new Map(),
  banditCamps: new Map(),
  settlementEvents: new Map(),
  caravanEvents: new Map(),
  banditCampEvents: new Map(),
});

/** Wipe all per-entity history. Called on world reset. */
export const clearHistory = (h: ViewerHistory): void => {
  h.settlements.clear();
  h.caravans.clear();
  h.banditCamps.clear();
  h.settlementEvents.clear();
  h.caravanEvents.clear();
  h.banditCampEvents.clear();
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
    pushBounded(buf, {
      day: world.day,
      population: s.population.total(),
      buildings: s.buildings.length,
      clearingPrices: prices,
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
