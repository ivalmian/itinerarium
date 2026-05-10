/**
 * Selected bandit-camp detail panel.
 *
 * The camp's "leader" is its named owner Actor (a bandit_camp Actor). Loot
 * value is approximated as the count of distinct loot resources × their
 * quantity sum — exact pricing would need a market lookup we don't yet
 * surface here.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ViewerState } from '../state/viewerState.js';

export interface BanditCampPanel {
  update(world: WorldState): void;
}

export interface BanditCampPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly onClear: () => void;
}

export const createBanditCampPanel = (opts: BanditCampPanelOpts): BanditCampPanel => {
  const { host, state } = opts;
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
