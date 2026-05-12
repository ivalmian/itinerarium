/**
 * Scrolling event log — last 50 high-magnitude TickEvents, rendered with
 * clickable named entities (settlements, caravans, bandit camps) so the
 * player can drill into the parties involved in an incident instead of
 * staring at branded ids.
 *
 * "High magnitude" = the events the rolling counters track plus
 * settlement_raided / fence_traded etc. Recipe runs and per-tick market
 * clears are noisy and skipped to keep the log readable.
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
    for (const e of events) {
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
      // Render the target as a settlement / camp link where possible.
      let targetNode: Node = txt(`(${e.target.q},${e.target.r})`);
      for (const s of world.settlements.values()) {
        if (s.anchor.q === e.target.q && s.anchor.r === e.target.r) {
          targetNode = settlementLink(world, state, s.id);
          break;
        }
      }
      return {
        cls: '',
        parts: [
          head,
          txt(`patrol dispatched from `),
          settlementLink(world, state, e.from),
          txt(` to `),
          targetNode,
        ],
      };
    }
    default:
      return null;
  }
};
