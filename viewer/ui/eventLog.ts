/**
 * Scrolling event log — last 50 high-magnitude TickEvents.
 *
 * "High magnitude" = the events the rolling counters track plus
 * settlement_raided / fence_traded etc. Recipe runs and per-tick market
 * clears are noisy and skipped to keep the log readable.
 */

import type { TickEvent } from '../../src/sim/tick.js';
import type { WorldState } from '../../src/procgen/seed.js';

const MAX_LINES = 50;

export interface EventLog {
  append(world: WorldState, events: readonly TickEvent[]): void;
  clear(): void;
}

export interface EventLogOpts {
  readonly host: HTMLElement;
}

export const createEventLog = (opts: EventLogOpts): EventLog => {
  const root = document.createElement('div');
  root.className = 'event-log';
  opts.host.appendChild(root);

  const append = (world: WorldState, events: readonly TickEvent[]): void => {
    const day = world.day;
    const year = Math.floor(day / 365) + 1;
    for (const e of events) {
      const line = formatEvent(e, day, year);
      if (line === null) continue;
      const div = document.createElement('div');
      div.className = `event ${line.cls}`;
      div.textContent = line.text;
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

const formatEvent = (
  e: TickEvent,
  day: number,
  year: number,
): { text: string; cls: string } | null => {
  const stamp = `Y${year} d${day % 365}`;
  switch (e.type) {
    case 'caravan_robbed':
      return { text: `${stamp} caravan ${shortId(String(e.caravan))} robbed (${e.cargoLost} cargo lost)`, cls: 'bad' };
    case 'settlement_raided':
      return { text: `${stamp} settlement raided by ${shortId(String(e.by))}: ${e.cargoLost} taken, ${e.defendersKilled} dead`, cls: 'bad' };
    case 'patrol_engaged':
      return { text: `${stamp} patrol engaged ${shortId(String(e.camp))}: ${e.outcome}`, cls: 'high' };
    case 'news_carrier_arrived':
      return { text: `${stamp} news arrived at ${shortId(String(e.settlement))} (${e.deltasApplied} deltas)`, cls: '' };
    case 'reputation_updated':
      return { text: `${stamp} rep Δ ${e.delta.toFixed(1)} ${shortId(String(e.holder))} → ${shortId(String(e.subject))}`, cls: '' };
    case 'epidemic_started':
      return { text: `${stamp} epidemic in ${shortId(String(e.settlement))}: ${e.disease}`, cls: 'bad' };
    case 'cohort_deaths':
      if (e.cause === 'famine' || e.cause === 'disease') {
        return { text: `${stamp} ${e.deaths} died (${e.cause}) at ${shortId(String(e.settlement))}`, cls: 'bad' };
      }
      return null;
    case 'fence_traded':
      return { text: `${stamp} ${shortId(String(e.camp))} fenced loot through ${shortId(String(e.through))} for ${e.coinPaid}`, cls: 'high' };
    case 'bandit_recruited':
      return { text: `${stamp} ${shortId(String(e.camp))} recruited ${e.count} from ${shortId(String(e.fromSettlement))}`, cls: 'high' };
    case 'patrol_dispatched':
      return { text: `${stamp} patrol dispatched from ${shortId(String(e.from))} to (${e.target.q},${e.target.r})`, cls: '' };
    default:
      return null;
  }
};

const shortId = (id: string): string => {
  const parts = id.split(':');
  if (parts.length <= 1) return id.slice(-10);
  return parts[parts.length - 1] ?? id;
};
