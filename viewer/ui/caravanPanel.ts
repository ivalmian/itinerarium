/**
 * Selected-caravan detail panel.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ViewerState } from '../state/viewerState.js';

export interface CaravanPanel {
  update(world: WorldState): void;
}

export interface CaravanPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly onClear: () => void;
}

export const createCaravanPanel = (opts: CaravanPanelOpts): CaravanPanel => {
  const { host, state } = opts;
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

    const name = document.createElement('h4');
    name.className = 'entity-name';
    name.textContent = `Caravan ${String(c.id).slice(-12)}`;
    root.appendChild(name);

    const meta = document.createElement('div');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    meta.style.marginBottom = '6px';
    const totalCrew = c.crew.reduce((acc, m) => acc + m.count, 0);
    const totalAnimals = Object.values(c.animals).reduce<number>((a, b) => a + (b ?? 0), 0);
    meta.innerHTML =
      `owner: ${escapeHtml(ownerName)}<br>` +
      `position: (${c.position.q}, ${c.position.r}) → ${
        c.destination ? `(${c.destination.q}, ${c.destination.r})` : '—'
      }<br>` +
      `crew ${totalCrew} · animals ${totalAnimals} · treasury ${Math.round(c.treasury)} coin<br>` +
      `health ${(c.health * 100).toFixed(0)}% · MP today ${Math.round(c.mpRemainingToday)}`;
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

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
