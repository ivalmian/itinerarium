/**
 * Rich modal-popup content for a selected bandit camp.
 *
 * Sections:
 *   - Header: name, hex, owner actor.
 *   - Combat profile: bandit count, hangers-on, weapons/armor %, health %.
 *   - Loot stockpile (mirrors the settlement market view minus the
 *     market layer, since camps don't run a market).
 *   - Treasury.
 *   - Recent events: per-entity event log from viewer history.
 *   - Bandit demographics pyramid (when available).
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { BanditCampId } from '../../src/sim/types.js';
import type { BanditCamp } from '../../src/sim/bandit/camp.js';
import { campSize } from '../../src/sim/bandit/camp.js';
import { AGE_BANDS, type AgeBand } from '../../src/sim/population/cohort.js';
import { parseDemoKey } from '../../src/sim/population/demographics.js';
import type { ViewerHistory } from '../state/history.js';
import type { ViewerState } from '../state/viewerState.js';
import { createSparkline, fmtCompact } from './sparkline.js';
import { createFactionLink } from './factionLink.js';
import { findFactionByActor } from './factionScreen.js';
import { popupEmpty, popupKv, popupSection } from './popup.js';

export interface BanditCampPopupContent {
  readonly element: HTMLElement;
  readonly title: string;
}

export interface BanditCampPopupOpts {
  readonly world: WorldState;
  readonly id: BanditCampId;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
}

export const renderBanditCampPopup = (opts: BanditCampPopupOpts): BanditCampPopupContent | null => {
  const { world, id, state, history } = opts;
  const camp = world.banditCamps?.get(id);
  if (camp === undefined) return null;

  const root = document.createElement('div');
  root.appendChild(renderHeader(world, camp, state));
  root.appendChild(renderCombatSection(camp));
  root.appendChild(renderLootSection(camp));
  root.appendChild(renderDemographicsSection(camp));
  root.appendChild(renderHistorySection(camp, history));
  const events = renderEventsSection(history, camp.id);
  if (events !== null) root.appendChild(events);

  return {
    element: root,
    title: `${camp.name} — bandit camp at (${camp.hex.q}, ${camp.hex.r})`,
  };
};

const renderHeader = (world: WorldState, camp: BanditCamp, state: ViewerState): HTMLElement => {
  const section = popupSection('Overview');
  const owner = world.actors.get(camp.ownerActor);
  section.appendChild(
    popupKv([
      ['Name', camp.name],
      ['Hex', `(${camp.hex.q}, ${camp.hex.r})`],
      ['Leader actor', owner?.name ?? String(camp.ownerActor)],
      ['Owner kind', owner?.kind ?? 'unknown'],
      ['Camp size', campSize(camp)],
      ['Treasury', `${Math.round(camp.treasury).toLocaleString()} coin`],
    ]),
  );

  // Owner faction link if available (some bandit-camp owner actors back a
  // faction; render a clickable chip so the player can pivot to it).
  const faction = findFactionByActor(world, camp.ownerActor);
  if (faction !== undefined) {
    const row = document.createElement('div');
    row.style.marginTop = '6px';
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Faction:';
    row.appendChild(lbl);
    row.appendChild(createFactionLink(state, faction.id, faction.name));
    section.appendChild(row);
  }

  return section;
};

const renderCombatSection = (camp: BanditCamp): HTMLElement => {
  const section = popupSection('Combat profile');
  section.appendChild(
    popupKv([
      ['Bandits', camp.banditCount.toLocaleString()],
      ['Hangers-on', camp.hangersOnCount.toLocaleString()],
      ['Weapons per bandit', `${(camp.weaponsPerBandit * 100).toFixed(0)}%`],
      ['Armor per bandit', `${(camp.armorPerBandit * 100).toFixed(0)}%`],
      ['Average health', `${(camp.averageHealth * 100).toFixed(0)}%`],
    ]),
  );
  return section;
};

const renderLootSection = (camp: BanditCamp): HTMLElement => {
  const section = popupSection('Loot stockpile');
  if (camp.loot.size === 0) {
    section.appendChild(popupEmpty('(no loot stored)'));
    return section;
  }

  const table = document.createElement('table');
  table.className = 'popup-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Resource</th><th class="num">Quantity</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const sorted = Array.from(camp.loot.entries()).sort((a, b) => b[1] - a[1]);
  let totalUnits = 0;
  for (const [r, qty] of sorted) {
    totalUnits += qty;
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = String(r);
    const c2 = document.createElement('td');
    c2.className = 'num';
    c2.textContent = Math.round(qty).toLocaleString();
    tr.appendChild(c1);
    tr.appendChild(c2);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const tfoot = document.createElement('tfoot');
  const trf = document.createElement('tr');
  trf.style.fontWeight = 'bold';
  const f1 = document.createElement('td');
  f1.textContent = 'Total units';
  const f2 = document.createElement('td');
  f2.className = 'num';
  f2.textContent = Math.round(totalUnits).toLocaleString();
  trf.appendChild(f1);
  trf.appendChild(f2);
  tfoot.appendChild(trf);
  table.appendChild(tfoot);
  section.appendChild(table);
  return section;
};

// --- Bandit demographics pyramid (where available) ------------------------

const renderDemographicsSection = (camp: BanditCamp): HTMLElement => {
  const section = popupSection('Bandit demographics');

  const demo = camp.banditDemographics;
  if (demo === undefined || demo.size === 0) {
    section.appendChild(popupEmpty('(demographics not seeded for this camp)'));
    return section;
  }

  const counts = new Map<AgeBand, { male: number; female: number }>();
  for (const a of AGE_BANDS) counts.set(a, { male: 0, female: 0 });
  for (const [rawKey, n] of demo) {
    const parsed = parseDemoKey(rawKey);
    const bucket = counts.get(parsed.age);
    if (bucket === undefined) continue;
    if (parsed.sex === 'male') bucket.male += n;
    else bucket.female += n;
  }
  let maxBand = 1;
  for (const v of counts.values()) {
    const m = Math.max(v.male, v.female);
    if (m > maxBand) maxBand = m;
  }

  const pyramid = document.createElement('div');
  pyramid.className = 'popup-pyramid';
  for (const age of [...AGE_BANDS].reverse()) {
    const c = counts.get(age);
    if (c === undefined) continue;
    if (c.male === 0 && c.female === 0) continue;
    const row = document.createElement('div');
    row.className = 'popup-pyramid-row';

    const maleBar = document.createElement('div');
    maleBar.className = 'popup-pyramid-bar male';
    if (c.male > 0) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.width = `${Math.max(1, (c.male / maxBand) * 100)}%`;
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = c.male.toLocaleString();
      maleBar.appendChild(lbl);
      maleBar.appendChild(seg);
    }

    const ageCell = document.createElement('div');
    ageCell.className = 'age';
    ageCell.textContent = age;

    const femaleBar = document.createElement('div');
    femaleBar.className = 'popup-pyramid-bar';
    if (c.female > 0) {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.style.width = `${Math.max(1, (c.female / maxBand) * 100)}%`;
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = c.female.toLocaleString();
      femaleBar.appendChild(seg);
      femaleBar.appendChild(lbl);
    }

    row.appendChild(maleBar);
    row.appendChild(ageCell);
    row.appendChild(femaleBar);
    pyramid.appendChild(row);
  }
  section.appendChild(pyramid);
  return section;
};

// --- History trio ----------------------------------------------------------

const renderHistorySection = (camp: BanditCamp, history: ViewerHistory): HTMLElement => {
  const section = popupSection('Trajectory (recent ticks)');
  const buf = history.banditCamps.get(camp.id);
  if (buf === undefined || buf.length < 2) {
    section.appendChild(popupEmpty('(not enough history yet)'));
    return section;
  }

  const recent = buf.slice(-60);
  const lastSnap = recent[recent.length - 1]!;
  const tri = document.createElement('div');
  tri.style.display = 'grid';
  tri.style.gridTemplateColumns = 'repeat(auto-fit, minmax(160px, 1fr))';
  tri.style.gap = '8px';
  tri.appendChild(
    sparkCell(
      'Bandits',
      recent.map((b) => b.banditCount),
      String(lastSnap.banditCount),
    ),
  );
  tri.appendChild(
    sparkCell(
      'Hangers-on',
      recent.map((b) => b.hangersOnCount),
      String(lastSnap.hangersOnCount),
    ),
  );
  tri.appendChild(
    sparkCell(
      'Treasury',
      recent.map((b) => b.treasury),
      fmtCompact(lastSnap.treasury),
    ),
  );
  tri.appendChild(
    sparkCell(
      'Health',
      recent.map((b) => b.averageHealth),
      `${(lastSnap.averageHealth * 100).toFixed(0)}%`,
    ),
  );
  section.appendChild(tri);
  return section;
};

const renderEventsSection = (history: ViewerHistory, id: BanditCampId): HTMLElement | null => {
  const events = history.banditCampEvents.get(id);
  if (events === undefined || events.length === 0) return null;
  const section = popupSection('Recent actions & events');
  const list = document.createElement('div');
  list.className = 'popup-event-list';
  for (const e of events.slice(-25)) {
    const row = document.createElement('div');
    row.className = 'row';
    const day = document.createElement('span');
    day.className = 'day';
    day.textContent = `d${e.day}`;
    row.appendChild(day);
    row.appendChild(document.createTextNode(e.summary));
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
};

const sparkCell = (label: string, values: readonly number[], current: string): HTMLElement => {
  const cell = document.createElement('div');
  cell.style.background = 'var(--panel-2)';
  cell.style.border = '1px solid var(--border)';
  cell.style.padding = '6px 10px';
  const lbl = document.createElement('div');
  lbl.style.color = 'var(--muted)';
  lbl.style.fontSize = '10px';
  lbl.style.textTransform = 'uppercase';
  lbl.style.letterSpacing = '0.05em';
  lbl.textContent = label;
  cell.appendChild(lbl);
  const val = document.createElement('div');
  val.style.color = 'var(--text)';
  val.style.fontVariantNumeric = 'tabular-nums';
  val.style.fontSize = '14px';
  val.textContent = current;
  cell.appendChild(val);
  cell.appendChild(createSparkline(values, { width: 140, height: 22 }));
  return cell;
};
