/**
 * Selected-caravan detail panel.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { CaravanId } from '../../src/sim/types.js';
import type { ViewerState } from '../state/viewerState.js';
import type { ViewerHistory } from '../state/history.js';
import { createSparkline, fmtCompact } from './sparkline.js';
import { createFactionLink } from './factionLink.js';
import { findFactionByActor } from './factionScreen.js';
import { appendEventSummary, hexDestinationNode } from './entityLinks.js';

export interface CaravanPanel {
  update(world: WorldState): void;
}

export interface CaravanPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
  readonly onClear: () => void;
}

export const createCaravanPanel = (opts: CaravanPanelOpts): CaravanPanel => {
  const { host, state, history } = opts;
  const root = document.createElement('div');
  host.appendChild(root);

  const update = (world: WorldState): void => {
    if (state.selection.kind !== 'caravan') {
      root.style.display = 'none';
      return;
    }
    const c = world.caravans.get(state.selection.id);
    if (c === undefined) {
      root.innerHTML = '<div class="selected-empty">caravan no longer exists</div>';
      root.style.display = '';
      return;
    }
    root.style.display = '';
    root.innerHTML = '';

    const owner = world.actors.get(c.ownerActor);
    const ownerName = owner?.name ?? String(c.ownerActor);
    const ownerKind = owner?.kind ?? 'unknown';
    let homeName = '';
    if (owner?.homeSettlement !== undefined) {
      const home = world.settlements.get(owner.homeSettlement);
      if (home !== undefined) homeName = home.name;
    }

    const name = document.createElement('h4');
    name.className = 'entity-name';
    name.textContent = `${ownerName}'s caravan`;
    root.appendChild(name);

    const meta = document.createElement('div');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    meta.style.marginBottom = '6px';
    const totalCrew = c.crew.reduce((acc, m) => acc + m.count, 0);
    const totalAnimals = Object.values(c.animals).reduce<number>((a, b) => a + (b ?? 0), 0);

    // Owner line: if the owner-actor backs a faction, render the faction
    // name as a clickable link; otherwise just print the actor name.
    const ownerRow = document.createElement('div');
    const ownerLabel = document.createElement('span');
    ownerLabel.textContent = 'owner: ';
    ownerRow.appendChild(ownerLabel);
    const ownerFaction = findFactionByActor(world, c.ownerActor);
    if (ownerFaction !== undefined) {
      ownerRow.appendChild(createFactionLink(state, ownerFaction.id, ownerFaction.name));
      const tail = document.createElement('span');
      const tailText =
        homeName.length > 0 ? ` (${ownerKind} · ${homeName})` : ` (${ownerKind})`;
      tail.textContent = tailText;
      ownerRow.appendChild(tail);
    } else {
      const tail = document.createElement('span');
      const tailText =
        homeName.length > 0
          ? `${ownerName} (${ownerKind} · ${homeName})`
          : `${ownerName} (${ownerKind})`;
      tail.textContent = tailText;
      ownerRow.appendChild(tail);
    }
    meta.appendChild(ownerRow);

    // Position → destination line, with destination shown as a clickable
    // settlement / camp link where possible.
    const posLine = document.createElement('div');
    posLine.appendChild(
      document.createTextNode(`position: (${c.position.q}, ${c.position.r}) → `),
    );
    if (c.destination !== null) {
      posLine.appendChild(hexDestinationNode(world, state, c.destination));
    } else {
      posLine.appendChild(document.createTextNode('—'));
    }
    meta.appendChild(posLine);

    const stats = document.createElement('div');
    stats.innerHTML =
      `crew ${totalCrew} · animals ${totalAnimals} · treasury ${Math.round(c.treasury)} coin<br>` +
      `health ${(c.health * 100).toFixed(0)}% · MP today ${Math.round(c.mpRemainingToday)}`;
    meta.appendChild(stats);
    root.appendChild(meta);

    const cargoHeader = document.createElement('div');
    cargoHeader.style.color = 'var(--muted)';
    cargoHeader.style.marginTop = '4px';
    cargoHeader.textContent = 'Cargo:';
    root.appendChild(cargoHeader);
    if (c.cargo.size === 0) {
      const emp = document.createElement('div');
      emp.className = 'selected-empty';
      emp.textContent = '(empty)';
      root.appendChild(emp);
    } else {
      const list = document.createElement('div');
      list.className = 'stocklist';
      const sorted = Array.from(c.cargo.entries()).sort((a, b) => b[1] - a[1]);
      for (const [r, qty] of sorted) {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const l = document.createElement('span');
        l.className = 'label';
        l.textContent = String(r);
        const v = document.createElement('span');
        v.className = 'value';
        v.textContent = Math.round(qty).toString();
        row.appendChild(l);
        row.appendChild(v);
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    // Historical trajectories (cargo, treasury, health, route) over the last
    // ~30 days from the per-entity history buffer.
    renderCaravanHistory(root, history, c.id, world, state);

    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.textContent = 'Copy state JSON';
    copy.style.marginTop = '6px';
    copy.addEventListener('click', () => {
      const payload = {
        id: String(c.id),
        owner: String(c.ownerActor),
        position: c.position,
        destination: c.destination,
        crew: c.crew,
        animals: c.animals,
        vehicles: c.vehicles,
        cargo: Object.fromEntries(Array.from(c.cargo.entries()).map(([k, v]) => [String(k), v])),
        treasury: c.treasury,
        health: c.health,
      };
      void navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => {});
    });
    root.appendChild(copy);

    const clear = document.createElement('button');
    clear.className = 'copy-btn';
    clear.textContent = 'Deselect';
    clear.style.marginLeft = '6px';
    clear.addEventListener('click', opts.onClear);
    root.appendChild(clear);
  };

  return { update };
};

/**
 * Caravan history: cargo / treasury / health sparklines + condensed route
 * (deduped consecutive hexes from the last ~30 ticks).
 */
const renderCaravanHistory = (
  root: HTMLElement,
  history: ViewerHistory,
  id: CaravanId,
  world: WorldState,
  state: ViewerState,
): void => {
  const buf = history.caravans.get(id);
  if (buf === undefined || buf.length < 2) return;

  const hh = document.createElement('div');
  hh.style.color = 'var(--muted)';
  hh.style.marginTop = '8px';
  hh.style.borderTop = '1px solid var(--border)';
  hh.style.paddingTop = '6px';
  hh.textContent = `History (${buf.length} ticks):`;
  root.appendChild(hh);

  const recent = buf.slice(-30);
  const lastSnap = recent[recent.length - 1];
  if (lastSnap === undefined) return;

  appendCaravanSparkRow(
    root,
    'Cargo',
    recent.map((b) => b.cargoUnits),
    fmtCompact(lastSnap.cargoUnits),
  );
  appendCaravanSparkRow(
    root,
    'Treasury',
    recent.map((b) => b.treasury),
    fmtCompact(lastSnap.treasury),
  );
  appendCaravanSparkRow(
    root,
    'Health',
    recent.map((b) => b.health),
    `${(lastSnap.health * 100).toFixed(0)}%`,
  );
  appendCaravanSparkRow(
    root,
    'Crew',
    recent.map((b) => b.crewCount),
    String(lastSnap.crewCount),
  );

  // Route trace — collapse runs of identical hexes (caravan stationary)
  // so 30 days at the same hex shows as one entry, not 30.
  const route: { day: number; q: number; r: number }[] = [];
  for (const snap of recent) {
    const last = route[route.length - 1];
    if (last !== undefined && last.q === snap.position.q && last.r === snap.position.r) {
      continue;
    }
    route.push({ day: snap.day, q: snap.position.q, r: snap.position.r });
  }
  if (route.length > 0) {
    const rh = document.createElement('div');
    rh.style.color = 'var(--muted)';
    rh.style.fontSize = '11px';
    rh.style.marginTop = '6px';
    rh.textContent = `Recent route (${route.length} stops):`;
    root.appendChild(rh);
    const list = document.createElement('div');
    list.style.fontSize = '11px';
    list.style.fontFamily = 'ui-monospace, SF Mono, monospace';
    list.style.maxHeight = '90px';
    list.style.overflowY = 'auto';
    // Show most recent 8 stops, oldest first.
    for (const r of route.slice(-8)) {
      const row = document.createElement('div');
      row.style.color = 'var(--muted)';
      row.style.padding = '1px 0';
      row.textContent = `d${r.day} · (${r.q}, ${r.r})`;
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  // Recent events.
  const events = history.caravanEvents.get(id);
  if (events !== undefined && events.length > 0) {
    const eh = document.createElement('div');
    eh.style.color = 'var(--muted)';
    eh.style.fontSize = '11px';
    eh.style.marginTop = '6px';
    eh.textContent = `Recent events (${events.length}):`;
    root.appendChild(eh);
    const list = document.createElement('div');
    list.style.fontSize = '11px';
    list.style.fontFamily = 'ui-monospace, SF Mono, monospace';
    list.style.maxHeight = '90px';
    list.style.overflowY = 'auto';
    for (const e of events.slice(-6)) {
      const row = document.createElement('div');
      row.style.color = 'var(--muted)';
      row.style.padding = '1px 0';
      row.appendChild(document.createTextNode(`d${e.day} · `));
      appendEventSummary(row, world, state, e.summary);
      list.appendChild(row);
    }
    root.appendChild(list);
  }
};

const appendCaravanSparkRow = (
  host: HTMLElement,
  label: string,
  values: readonly number[],
  current: string,
): void => {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.justifyContent = 'space-between';
  row.style.padding = '1px 0';
  row.style.gap = '6px';
  const l = document.createElement('span');
  l.className = 'label';
  l.style.color = 'var(--muted)';
  l.style.fontSize = '11px';
  l.textContent = label;
  row.appendChild(l);
  const right = document.createElement('span');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '4px';
  right.appendChild(createSparkline(values));
  const cur = document.createElement('span');
  cur.className = 'value';
  cur.style.fontSize = '11px';
  cur.style.fontVariantNumeric = 'tabular-nums';
  cur.style.minWidth = '36px';
  cur.style.textAlign = 'right';
  cur.textContent = current;
  right.appendChild(cur);
  row.appendChild(right);
  host.appendChild(row);
};
