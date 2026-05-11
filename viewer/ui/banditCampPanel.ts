/**
 * Selected bandit-camp detail panel.
 *
 * The camp's "leader" is its named owner Actor (a bandit_camp Actor). Loot
 * value is approximated as the count of distinct loot resources × their
 * quantity sum — exact pricing would need a market lookup we don't yet
 * surface here.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { BanditCampId } from '../../src/sim/types.js';
import type { ViewerState } from '../state/viewerState.js';
import type { ViewerHistory } from '../state/history.js';
import { createSparkline, fmtCompact } from './sparkline.js';

export interface BanditCampPanel {
  update(world: WorldState): void;
}

export interface BanditCampPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
  readonly onClear: () => void;
}

export const createBanditCampPanel = (opts: BanditCampPanelOpts): BanditCampPanel => {
  const { host, state, history } = opts;
  const root = document.createElement('div');
  host.appendChild(root);

  const update = (world: WorldState): void => {
    if (state.selection.kind !== 'bandit_camp') {
      root.style.display = 'none';
      return;
    }
    const camps = world.banditCamps;
    const camp = camps?.get(state.selection.id);
    if (camp === undefined) {
      root.innerHTML = '<div class="selected-empty">camp no longer exists</div>';
      root.style.display = '';
      return;
    }
    root.style.display = '';
    root.innerHTML = '';

    const owner = world.actors.get(camp.ownerActor);
    const name = document.createElement('h4');
    name.className = 'entity-name';
    name.textContent = camp.name;
    root.appendChild(name);

    const meta = document.createElement('div');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    meta.style.marginBottom = '6px';
    let lootUnits = 0;
    for (const v of camp.loot.values()) lootUnits += v;
    meta.innerHTML =
      `leader actor: ${owner?.name ?? String(camp.ownerActor)}<br>` +
      `hex: (${camp.hex.q}, ${camp.hex.r})<br>` +
      `bandits ${camp.banditCount} · hangers-on ${camp.hangersOnCount}<br>` +
      `weapons ${(camp.weaponsPerBandit * 100).toFixed(0)}% · armor ${(camp.armorPerBandit * 100).toFixed(0)}% · health ${(camp.averageHealth * 100).toFixed(0)}%<br>` +
      `treasury ${Math.round(camp.treasury)} coin · loot ${lootUnits} units`;
    root.appendChild(meta);

    if (camp.loot.size > 0) {
      const lootHeader = document.createElement('div');
      lootHeader.style.color = 'var(--muted)';
      lootHeader.style.marginTop = '4px';
      lootHeader.textContent = 'Loot:';
      root.appendChild(lootHeader);
      const list = document.createElement('div');
      list.className = 'stocklist';
      for (const [r, qty] of camp.loot) {
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

    // Historical trajectories (banditCount, treasury, health) + raid history.
    renderCampHistory(root, history, camp.id);

    const copy = document.createElement('button');
    copy.className = 'copy-btn';
    copy.textContent = 'Copy state JSON';
    copy.style.marginTop = '6px';
    copy.addEventListener('click', () => {
      const payload = {
        id: String(camp.id),
        name: camp.name,
        hex: camp.hex,
        owner: String(camp.ownerActor),
        banditCount: camp.banditCount,
        hangersOnCount: camp.hangersOnCount,
        treasury: camp.treasury,
        loot: Object.fromEntries(Array.from(camp.loot.entries()).map(([k, v]) => [String(k), v])),
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

const renderCampHistory = (
  root: HTMLElement,
  history: ViewerHistory,
  id: BanditCampId,
): void => {
  const buf = history.banditCamps.get(id);
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
  appendCampSparkRow(
    root,
    'Bandits',
    recent.map((b) => b.banditCount),
    String(lastSnap.banditCount),
  );
  appendCampSparkRow(
    root,
    'Hangers-on',
    recent.map((b) => b.hangersOnCount),
    String(lastSnap.hangersOnCount),
  );
  appendCampSparkRow(
    root,
    'Treasury',
    recent.map((b) => b.treasury),
    fmtCompact(lastSnap.treasury),
  );
  appendCampSparkRow(
    root,
    'Health',
    recent.map((b) => b.averageHealth),
    `${(lastSnap.averageHealth * 100).toFixed(0)}%`,
  );

  const events = history.banditCampEvents.get(id);
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
    list.style.maxHeight = '120px';
    list.style.overflowY = 'auto';
    for (const e of events.slice(-8)) {
      const row = document.createElement('div');
      row.style.color = 'var(--muted)';
      row.style.padding = '1px 0';
      row.textContent = `d${e.day} · ${e.summary}`;
      list.appendChild(row);
    }
    root.appendChild(list);
  }
};

const appendCampSparkRow = (
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
