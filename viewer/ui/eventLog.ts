/**
 * Scrolling event log — last 50 high-magnitude TickEvents, rendered with
 * clickable named entities (settlements, caravans, bandit camps) so the
 * player can drill into the parties involved in an incident instead of
 * staring at branded ids.
 *
 * "High magnitude" = the events the rolling counters track plus
 * settlement_raided / fence_traded / caravan trading activity.
 * Recipe runs, raw per-tick market clears, and the dozens of per-step
 * `patrol_dispatched` events one patrol emits walking its route are
 * filtered / deduplicated below so the log stays readable.
 */

import type { TickEvent } from '../../src/sim/tick.js';
import type { WorldState } from '../../src/procgen/seed.js';
import type { ViewerState } from '../state/viewerState.js';
import {
  banditCampLink,
  caravanLink,
  settlementLink,
} from './entityLinks.js';

const MAX_LINES = 50;

export interface EventLog {
  append(world: WorldState, events: readonly TickEvent[]): void;
  clear(): void;
}

export interface EventLogOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
}

export const createEventLog = (opts: EventLogOpts): EventLog => {
  const root = document.createElement('div');
  root.className = 'event-log';
  opts.host.appendChild(root);

  const append = (world: WorldState, events: readonly TickEvent[]): void => {
    const day = world.day;
    const year = Math.floor(day / 365) + 1;
    const filtered = filterNoisyEvents(events);
    for (const e of filtered) {
      const line = formatEvent(world, opts.state, e, day, year);
      if (line === null) continue;
      const div = document.createElement('div');
      div.className = `event ${line.cls}`;
      for (const node of line.parts) div.appendChild(node);
      root.appendChild(div);
    }
    while (root.childElementCount > MAX_LINES) {
      root.removeChild(root.firstChild as ChildNode);
    }
    root.scrollTop = root.scrollHeight;
  };

  const clear = (): void => {
    root.innerHTML = '';
  };

  return { append, clear };
};

/**
 * Per-tick noise reduction.
 *
 * `patrol_dispatched` is emitted by the sim for every patrol step that
 * passes within sight of a known bandit camp (tactical retreat / bribery
 * / engagement). One patrol walking its 5–10-hex daily route past two
 * neighbouring camps can therefore emit a dozen events in a single tick.
 * The log drowns in them. Collapse to one line per patrol per tick.
 *
 * `caravan_traded` is similarly emitted per resource per visit — a
 * single caravan stopping at a forum-market may emit 5+ trades in one
 * tick. Collapse to one line per caravan per tick (sum the coin so the
 * surfaced value is meaningful).
 */
const filterNoisyEvents = (events: readonly TickEvent[]): readonly TickEvent[] => {
  const out: TickEvent[] = [];
  const seenPatrols = new Set<string>();
  const tradesByCaravan = new Map<string, {
    caravan: string;
    settlement: string;
    coinBought: number;
    coinSold: number;
    countBought: number;
    countSold: number;
    firstIndex: number;
  }>();

  for (const e of events) {
    if (e.type === 'patrol_dispatched') {
      const k = String(e.patrolId);
      if (seenPatrols.has(k)) continue;
      seenPatrols.add(k);
      out.push(e);
      continue;
    }
    if (e.type === 'caravan_traded') {
      const k = String(e.caravan);
      let agg = tradesByCaravan.get(k);
      if (agg === undefined) {
        agg = {
          caravan: String(e.caravan),
          settlement: String(e.settlement),
          coinBought: 0,
          coinSold: 0,
          countBought: 0,
          countSold: 0,
          firstIndex: out.length,
        };
        tradesByCaravan.set(k, agg);
        // Reserve a slot in `out` to swap in the aggregated event later.
        out.push(e);
      }
      if (e.side === 'bought') {
        agg.coinBought += e.coin;
        agg.countBought += 1;
      } else {
        agg.coinSold += e.coin;
        agg.countSold += 1;
      }
      continue;
    }
    out.push(e);
  }

  // Replace each placeholder with a synthetic aggregated event.
  for (const agg of tradesByCaravan.values()) {
    out[agg.firstIndex] = {
      type: 'caravan_traded_summary',
      caravan: agg.caravan,
      settlement: agg.settlement,
      coinBought: Math.round(agg.coinBought),
      coinSold: Math.round(agg.coinSold),
      countBought: agg.countBought,
      countSold: agg.countSold,
    } as unknown as TickEvent;
  }

  return out;
};

interface CaravanTradedSummary {
  readonly type: 'caravan_traded_summary';
  readonly caravan: string;
  readonly settlement: string;
  readonly coinBought: number;
  readonly coinSold: number;
  readonly countBought: number;
  readonly countSold: number;
}

interface FormattedEvent {
  readonly parts: readonly Node[];
  readonly cls: string;
}

const stamp = (day: number, year: number): string => `Y${year} d${day % 365} `;

const txt = (s: string): Text => document.createTextNode(s);

const formatEvent = (
  world: WorldState,
  state: ViewerState,
  e: TickEvent,
  day: number,
  year: number,
): FormattedEvent | null => {
  const head = txt(stamp(day, year));
  switch (e.type) {
    case 'caravan_robbed':
      return {
        cls: 'bad',
        parts: [
          head,
          caravanLink(world, state, e.caravan),
          txt(` robbed (${e.cargoLost} cargo lost)`),
        ],
      };
    case 'settlement_raided':
      return {
        cls: 'bad',
        parts: [
          head,
          settlementLink(world, state, e.settlement),
          txt(` raided by `),
          banditCampLink(world, state, e.by),
          txt(`: ${e.cargoLost} taken, ${e.defendersKilled} dead`),
        ],
      };
    case 'patrol_engaged':
      return {
        cls: 'high',
        parts: [
          head,
          txt(`patrol engaged `),
          banditCampLink(world, state, e.camp),
          txt(`: ${e.outcome}`),
        ],
      };
    case 'news_carrier_arrived':
      return {
        cls: '',
        parts: [
          head,
          txt(`news arrived at `),
          settlementLink(world, state, e.settlement),
          txt(` (${e.deltasApplied} deltas)`),
        ],
      };
    case 'reputation_updated': {
      // Holder/subject are reputation keys (CharacterId | ActorId).
      // Look them up in `world.actors`; characters aren't a top-level
      // selectable yet, so fall through to id text.
      const holderName =
        world.actors.get(e.holder as unknown as Parameters<typeof world.actors.get>[0])?.name ??
        String(e.holder);
      const subjectName =
        world.actors.get(e.subject as unknown as Parameters<typeof world.actors.get>[0])?.name ??
        String(e.subject);
      return {
        cls: '',
        parts: [
          head,
          txt(`rep Δ ${e.delta.toFixed(1)} ${holderName} → ${subjectName}`),
        ],
      };
    }
    case 'epidemic_started':
      return {
        cls: 'bad',
        parts: [
          head,
          txt(`epidemic in `),
          settlementLink(world, state, e.settlement),
          txt(`: ${e.disease}`),
        ],
      };
    case 'cohort_deaths':
      if (e.cause === 'famine' || e.cause === 'disease') {
        return {
          cls: 'bad',
          parts: [
            head,
            txt(`${e.deaths} died (${e.cause}) at `),
            settlementLink(world, state, e.settlement),
          ],
        };
      }
      return null;
    case 'fence_traded':
      return {
        cls: 'high',
        parts: [
          head,
          banditCampLink(world, state, e.camp),
          txt(` fenced loot through `),
          settlementLink(world, state, e.through),
          txt(` for ${e.coinPaid}`),
        ],
      };
    case 'bandit_recruited':
      return {
        cls: 'high',
        parts: [
          head,
          banditCampLink(world, state, e.camp),
          txt(` recruited ${e.count} from `),
          settlementLink(world, state, e.fromSettlement),
        ],
      };
    case 'patrol_dispatched': {
      // The sim emits patrol_dispatched whenever a patrol spots a known
      // bandit camp on its route — not when the patrol literally leaves
      // its base. Phrase accordingly so the log reads as observation,
      // not deployment. Target hex: resolve to a settlement / camp link
      // where possible, fall back to coordinates.
      let targetNode: Node = txt(`(${e.target.q},${e.target.r})`);
      for (const s of world.settlements.values()) {
        if (s.anchor.q === e.target.q && s.anchor.r === e.target.r) {
          targetNode = settlementLink(world, state, s.id);
          break;
        }
      }
      if (world.banditCamps !== undefined) {
        for (const camp of world.banditCamps.values()) {
          if (camp.hex.q === e.target.q && camp.hex.r === e.target.r) {
            targetNode = banditCampLink(world, state, camp.id);
            break;
          }
        }
      }
      return {
        cls: '',
        parts: [
          head,
          txt(`patrol from `),
          settlementLink(world, state, e.from),
          txt(` spotted activity at `),
          targetNode,
        ],
      };
    }
    case 'caravan_arrived': {
      let where: Node = txt(`(${e.at.q},${e.at.r})`);
      for (const s of world.settlements.values()) {
        if (s.anchor.q === e.at.q && s.anchor.r === e.at.r) {
          where = settlementLink(world, state, s.id);
          break;
        }
      }
      return {
        cls: '',
        parts: [head, caravanLink(world, state, e.caravan), txt(` arrived at `), where],
      };
    }
    case 'caravan_profit_remitted':
      return {
        cls: 'good',
        parts: [
          head,
          caravanLink(world, state, e.caravan),
          txt(` remitted ${Math.round(e.coin)}c profit at `),
          settlementLink(world, state, e.settlement),
        ],
      };
    case 'caravan_exported_off_map':
      return {
        cls: 'good',
        parts: [
          head,
          caravanLink(world, state, e.caravan),
          txt(
            ` exported ${formatQty(e.quantity)} ${String(e.resource)} off-map for ${Math.round(e.coin)}c`,
          ),
        ],
      };
    case 'building_completed':
      return {
        cls: '',
        parts: [
          head,
          settlementLink(world, state, e.settlement),
          txt(` finished a ${String(e.building)}`),
        ],
      };
    case 'building_invested':
      return {
        cls: '',
        parts: [
          head,
          settlementLink(world, state, e.settlement),
          txt(` began a ${String(e.building)} (${e.costCoin}c)`),
        ],
      };
    case 'tax_shipment_dispatched':
      return {
        cls: '',
        parts: [
          head,
          settlementLink(world, state, e.fromSettlement),
          txt(` shipped tax (${e.grainModii}m grain, ${e.coin}c) → `),
          settlementLink(world, state, e.toSettlement),
        ],
      };
    case 'tribute_paid': {
      const fromActor = world.actors.get(e.fromActor);
      const toActor = world.actors.get(e.toActor);
      return {
        cls: '',
        parts: [
          head,
          txt(`${fromActor?.name ?? '?'} paid ${e.coin}c tribute to ${toActor?.name ?? '?'} from `),
          settlementLink(world, state, e.fromSettlement),
        ],
      };
    }
    case 'local_trade':
      return {
        cls: '',
        parts: [
          head,
          settlementLink(world, state, e.fromSettlement),
          txt(` → ${e.quantity} ${String(e.resource)} → `),
          settlementLink(world, state, e.toSettlement),
        ],
      };
    case 'merchant_caravan_dispatched':
      return {
        cls: '',
        parts: [
          head,
          caravanLink(world, state, e.caravan),
          txt(` set out from `),
          settlementLink(world, state, e.settlement),
        ],
      };
    case 'villager_caravan_dispatched':
      return {
        cls: '',
        parts: [
          head,
          txt(`villager caravan `),
          caravanLink(world, state, e.caravan),
          txt(` left `),
          settlementLink(world, state, e.settlement),
          txt(` with surplus`),
        ],
      };
    case 'caravan_disbanded':
      return {
        cls: '',
        parts: [head, caravanLink(world, state, e.caravan), txt(` disbanded`)],
      };
    case 'edge_hub_spawned':
      return {
        cls: '',
        parts: [head, txt(`edge-hub spawned ${e.newCaravans} new caravan(s)`)],
      };
    case 'news_carrier_spawned': {
      const perp = world.actors.get(
        e.perpetrator as unknown as Parameters<typeof world.actors.get>[0],
      );
      const victim =
        e.victim !== null
          ? world.actors.get(e.victim as unknown as Parameters<typeof world.actors.get>[0])
          : undefined;
      return {
        cls: '',
        parts: [
          head,
          txt(
            `news carrier left toward (${e.destination.q},${e.destination.r}) about ${perp?.name ?? String(e.perpetrator)}${
              victim !== undefined ? ` vs ${victim.name}` : ''
            }`,
          ),
        ],
      };
    }
    case 'bandit_party_dispatched':
      return {
        cls: 'high',
        parts: [
          head,
          banditCampLink(world, state, e.fromCamp),
          txt(` sent a ${e.missionType.replace(/_/g, ' ')} party toward (${e.at.q},${e.at.r})`),
        ],
      };
    case 'bandit_party_returned':
      return {
        cls: '',
        parts: [head, txt(`bandit party ${e.outcome.replace(/_/g, ' ')} at (${e.at.q},${e.at.r})`)],
      };
    case 'mob_looting': {
      const fromActor = world.actors.get(e.fromActor);
      return {
        cls: 'bad',
        parts: [
          head,
          txt(`mob looted ${formatQty(e.looted)} ${String(e.resource)} from ${fromActor?.name ?? '?'} at `),
          settlementLink(world, state, e.settlement),
        ],
      };
    }
    case 'riot':
      return {
        cls: 'bad',
        parts: [
          head,
          txt(`riot in `),
          settlementLink(world, state, e.settlement),
          txt(` over ${String(e.trigger)} (×${e.priceMultipleOfBaseline.toFixed(1)} baseline)`),
        ],
      };
    case 'edict_issued':
      return {
        cls: '',
        parts: [
          head,
          settlementLink(world, state, e.settlement),
          txt(` capped ${String(e.resource)} at ${e.priceCap.toFixed(2)}`),
        ],
      };
    case 'settlement_abandoned':
      return {
        cls: 'bad',
        parts: [
          head,
          settlementLink(world, state, e.settlement),
          txt(` abandoned (depopulated)`),
        ],
      };
    case 'catchment_resized':
      // Only surface significant resizes so the log isn't dominated by
      // ±1-hex routine adjustments.
      if (Math.abs(e.newRadius - e.oldRadius) < 2) return null;
      return {
        cls: '',
        parts: [
          head,
          settlementLink(world, state, e.settlement),
          txt(` catchment ${e.oldRadius}→${e.newRadius} hex`),
        ],
      };
    default: {
      // Synthetic aggregated trade event produced by `filterNoisyEvents`.
      const aggregated = e as unknown as CaravanTradedSummary;
      if (aggregated.type === 'caravan_traded_summary') {
        const net = aggregated.coinSold - aggregated.coinBought;
        const sign = net >= 0 ? '+' : '−';
        const fragments: Node[] = [head];
        fragments.push(
          caravanLink(
            world,
            state,
            aggregated.caravan as unknown as Parameters<typeof caravanLink>[2],
          ),
        );
        fragments.push(txt(` traded at `));
        fragments.push(
          settlementLink(
            world,
            state,
            aggregated.settlement as unknown as Parameters<typeof settlementLink>[2],
          ),
        );
        const ops: string[] = [];
        if (aggregated.countBought > 0) ops.push(`bought ${aggregated.countBought}`);
        if (aggregated.countSold > 0) ops.push(`sold ${aggregated.countSold}`);
        fragments.push(
          txt(` (${ops.join(', ')}; net ${sign}${Math.abs(Math.round(net))}c)`),
        );
        return { cls: net >= 0 ? 'good' : '', parts: fragments };
      }
      return null;
    }
  }
};

const formatQty = (q: number): string =>
  Number.isInteger(q) ? String(q) : q.toFixed(1);
