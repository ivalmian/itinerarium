/**
 * Right-hand sidebar — composition of all the inspection panels.
 *
 * The sidebar wires its sub-panels into a single column inside the #sidebar
 * element. Each panel manages its own DOM children; the sidebar just lays them
 * out. Per-tick refresh is driven by `update(world)`.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { TickEvent } from '../../src/sim/tick.js';
import type { ViewerState } from '../state/viewerState.js';
import { setSelection } from '../state/viewerState.js';
import { createTimeControls, type TimeControls } from './timeControls.js';
import { createSettlementPanel, type SettlementPanel } from './settlementPanel.js';
import { createCaravanPanel, type CaravanPanel } from './caravanPanel.js';
import { createBanditCampPanel, type BanditCampPanel } from './banditCampPanel.js';
import { createHexPanel, type HexPanel } from './hexPanel.js';
import { createResourcePanel, type ResourcePanel } from './resourcePanel.js';
import { createEventLog, type EventLog } from './eventLog.js';
import { createWorldHistoryPanel, type WorldHistoryPanel } from './worldHistoryPanel.js';
import type { ViewerHistory } from '../state/history.js';

interface RollingCounts {
  caravan_robbed: number;
  settlement_raided: number;
  patrol_engaged: number;
  news_carrier_arrived: number;
  reputation_updated: number;
  epidemic_started: number;
}

const ROLLING_WINDOW_DAYS = 365;

export interface Sidebar {
  update(world: WorldState, events: readonly TickEvent[]): void;
  /** Append events to the event log even outside the per-tick update. */
  pushEvents(world: WorldState, events: readonly TickEvent[]): void;
  readonly timeControls: TimeControls;
  readonly settlementPanel: SettlementPanel;
  readonly caravanPanel: CaravanPanel;
  readonly banditCampPanel: BanditCampPanel;
  readonly hexPanel: HexPanel;
  readonly resourcePanel: ResourcePanel;
  readonly eventLog: EventLog;
  readonly worldHistoryPanel: WorldHistoryPanel;
}

const fmt = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n >= 1000) return n.toLocaleString();
  return String(Math.round(n));
};

export interface SidebarOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
  readonly onPlayPause: () => void;
  readonly onSpeedCycle: () => void;
  readonly onReset: () => void;
}

export const createSidebar = (opts: SidebarOpts): Sidebar => {
  const { host, state } = opts;
  host.innerHTML = '';

  const dateSection = section('Time');
  const dayValue = stat(dateSection, 'Day', '0');
  const yearValue = stat(dateSection, 'Year', '0');
  host.appendChild(dateSection.root);

  const totalsSection = section('Totals');
  const popValue = stat(totalsSection, 'Population', '0');
  const settlementsValue = stat(totalsSection, 'Settlements', '0');
  const caravansValue = stat(totalsSection, 'Caravans', '0');
  const banditsValue = stat(totalsSection, 'Bandits', '0');
  const patrolsValue = stat(totalsSection, 'Patrols', '0');
  host.appendChild(totalsSection.root);

  const recentSection = section('Recent (last 365 days)');
  const recRobbed = stat(recentSection, 'Caravans robbed', '0');
  const recRaided = stat(recentSection, 'Settlements raided', '0');
  const recEngaged = stat(recentSection, 'Patrol engagements', '0');
  const recNews = stat(recentSection, 'News carriers arrived', '0');
  const recRep = stat(recentSection, 'Reputation updates', '0');
  const recEpi = stat(recentSection, 'Epidemics', '0');
  host.appendChild(recentSection.root);

  const timeSection = section('Time controls');
  const timeControls = createTimeControls({
    host: timeSection.root,
    state,
    onPlayPause: opts.onPlayPause,
    onSpeedCycle: opts.onSpeedCycle,
    onReset: opts.onReset,
  });
  host.appendChild(timeSection.root);

  const resourceSection = section('Resources');
  const resourcePanel = createResourcePanel({ host: resourceSection.root });
  host.appendChild(resourceSection.root);

  // Collapsible world-history section. Default closed because it grows
  // tall as the run progresses.
  const worldHistorySection = collapsibleSection('World history', false);
  const worldHistoryPanel = createWorldHistoryPanel({ history: opts.history });
  worldHistorySection.body.appendChild(worldHistoryPanel.root);
  host.appendChild(worldHistorySection.root);

  const selectedSection = section('Selected');
  const selectedHost = document.createElement('div');
  selectedSection.root.appendChild(selectedHost);
  const settlementPanel = createSettlementPanel({
    host: selectedHost,
    state,
    history: opts.history,
    onClear: () => setSelection(state, { kind: 'none' }),
  });
  const caravanPanel = createCaravanPanel({
    host: selectedHost,
    state,
    history: opts.history,
    onClear: () => setSelection(state, { kind: 'none' }),
  });
  const banditCampPanel = createBanditCampPanel({
    host: selectedHost,
    state,
    history: opts.history,
    onClear: () => setSelection(state, { kind: 'none' }),
  });
  const hexPanel = createHexPanel({
    host: selectedHost,
    state,
    onClear: () => setSelection(state, { kind: 'none' }),
  });
  host.appendChild(selectedSection.root);

  const logSection = section('Event log');
  const eventLog = createEventLog({ host: logSection.root, state });
  host.appendChild(logSection.root);

  // Rolling event window stored as per-day buckets.
  const rolling: RollingCounts[] = [];

  const update = (world: WorldState, events: readonly TickEvent[]): void => {
    // Time
    dayValue.textContent = String(world.day);
    yearValue.textContent = String(Math.floor(world.day / 365) + 1);

    // Totals
    let pop = 0;
    for (const s of world.settlements.values()) pop += s.population.total();
    popValue.textContent = fmt(pop);
    settlementsValue.textContent = String(world.settlements.size);
    caravansValue.textContent = String(world.caravans.size);
    let bandits = 0;
    if (world.banditCamps !== undefined) {
      for (const c of world.banditCamps.values()) bandits += c.banditCount;
    }
    banditsValue.textContent = fmt(bandits);
    patrolsValue.textContent = String(world.patrols?.size ?? 0);

    // Update rolling counts.
    const todayBucket: RollingCounts = {
      caravan_robbed: 0,
      settlement_raided: 0,
      patrol_engaged: 0,
      news_carrier_arrived: 0,
      reputation_updated: 0,
      epidemic_started: 0,
    };
    for (const e of events) {
      switch (e.type) {
        case 'caravan_robbed':
          todayBucket.caravan_robbed += 1;
          break;
        case 'settlement_raided':
          todayBucket.settlement_raided += 1;
          break;
        case 'patrol_engaged':
          todayBucket.patrol_engaged += 1;
          break;
        case 'news_carrier_arrived':
          todayBucket.news_carrier_arrived += 1;
          break;
        case 'reputation_updated':
          todayBucket.reputation_updated += 1;
          break;
        case 'epidemic_started':
          todayBucket.epidemic_started += 1;
          break;
        default:
          break;
      }
    }
    rolling.push(todayBucket);
    while (rolling.length > ROLLING_WINDOW_DAYS) {
      rolling.shift();
    }
    const sums: RollingCounts = {
      caravan_robbed: 0,
      settlement_raided: 0,
      patrol_engaged: 0,
      news_carrier_arrived: 0,
      reputation_updated: 0,
      epidemic_started: 0,
    };
    for (const b of rolling) {
      sums.caravan_robbed += b.caravan_robbed;
      sums.settlement_raided += b.settlement_raided;
      sums.patrol_engaged += b.patrol_engaged;
      sums.news_carrier_arrived += b.news_carrier_arrived;
      sums.reputation_updated += b.reputation_updated;
      sums.epidemic_started += b.epidemic_started;
    }
    recRobbed.textContent = String(sums.caravan_robbed);
    recRaided.textContent = String(sums.settlement_raided);
    recEngaged.textContent = String(sums.patrol_engaged);
    recNews.textContent = String(sums.news_carrier_arrived);
    recRep.textContent = String(sums.reputation_updated);
    recEpi.textContent = String(sums.epidemic_started);

    // Time controls speed display.
    timeControls.refresh();

    // Resource panel and selected entity panels.
    resourcePanel.update(world);
    settlementPanel.update(world);
    caravanPanel.update(world);
    banditCampPanel.update(world);
    hexPanel.update(world);
    eventLog.append(world, events);
    worldHistoryPanel.update();
  };

  const pushEvents = (world: WorldState, events: readonly TickEvent[]): void => {
    eventLog.append(world, events);
  };

  return {
    update,
    pushEvents,
    timeControls,
    settlementPanel,
    caravanPanel,
    banditCampPanel,
    hexPanel,
    resourcePanel,
    eventLog,
    worldHistoryPanel,
  };
};

interface Section {
  readonly root: HTMLElement;
}

const section = (title: string): Section => {
  const root = document.createElement('div');
  root.className = 'section';
  const h = document.createElement('h3');
  h.textContent = title;
  root.appendChild(h);
  return { root };
};

interface CollapsibleSection {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
}

const collapsibleSection = (title: string, openByDefault: boolean): CollapsibleSection => {
  const root = document.createElement('details');
  root.className = 'section';
  if (openByDefault) root.open = true;
  const summary = document.createElement('summary');
  summary.style.cursor = 'pointer';
  summary.style.fontSize = '13px';
  summary.style.fontWeight = '600';
  summary.style.opacity = '0.9';
  summary.textContent = title;
  root.appendChild(summary);
  const body = document.createElement('div');
  body.style.marginTop = '6px';
  root.appendChild(body);
  return { root, body };
};

const stat = (s: Section, label: string, value: string): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'value';
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  s.root.appendChild(row);
  return v;
};
