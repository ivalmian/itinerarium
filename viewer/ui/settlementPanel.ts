/**
 * Selected-settlement detail panel.
 *
 * Pop, top stockpiles (summed across the settlement's stockpile owners),
 * building count, and last few clearing prices. Re-renders on every tick when
 * the selection is a settlement.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { SettlementId } from '../../src/sim/types.js';
import { hexEquals } from '../../src/sim/world/hex.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';

export interface SettlementPanel {
  update(world: WorldState): void;
}

export interface SettlementPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly onClear: () => void;
}

export const createSettlementPanel = (opts: SettlementPanelOpts): SettlementPanel => {
  const { host, state } = opts;
  const root = document.createElement('div');
  host.appendChild(root);

  const update = (world: WorldState): void => {
    if (state.selection.kind !== 'settlement') {
      root.style.display = 'none';
      return;
    }
    const s = world.settlements.get(state.selection.id);
    if (s === undefined) {
      root.innerHTML = '<div class="selected-empty">settlement no longer exists</div>';
      root.style.display = '';
      return;
    }
    root.style.display = '';
    root.innerHTML = '';

    const name = document.createElement('h4');
    name.className = 'entity-name';
    name.textContent = `${s.name} (${s.tier})`;
    root.appendChild(name);

    const meta = document.createElement('div');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    meta.style.marginBottom = '6px';
    meta.textContent = `pop ${s.population.total().toLocaleString()} · ${s.buildings.length} buildings · anchor (${s.anchor.q},${s.anchor.r})`;
    root.appendChild(meta);

    // Stacked-with affordance — list other settlements that share this anchor
    // hex (docs/05 §"Same-hex coexistence"). Each is a click-target that
    // switches the selection to the sibling.
    const siblings: { readonly id: SettlementId; readonly name: string; readonly tier: string }[] = [];
    for (const other of world.settlements.values()) {
      if (other.id === s.id) continue;
      if (!hexEquals(other.anchor, s.anchor)) continue;
      siblings.push({ id: other.id, name: other.name, tier: other.tier });
    }
    if (siblings.length > 0) {
      const stackHeader = document.createElement('div');
      stackHeader.style.color = 'var(--muted)';
      stackHeader.style.fontSize = '11px';
      stackHeader.style.marginBottom = '4px';
      stackHeader.textContent = `Stacked with (same hex): ${siblings.length}`;
      root.appendChild(stackHeader);
      const stackList = document.createElement('div');
      stackList.style.marginBottom = '6px';
      for (const sib of siblings) {
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = `${sib.name} (${sib.tier})`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'settlement', id: sib.id });
        });
        stackList.appendChild(link);
      }
      root.appendChild(stackList);
    }

    // Aggregate stockpiles across all stockpile owners.
    const totals = new Map<string, number>();
    for (const ownerId of s.stockpileOwners) {
      const a = world.actors.get(ownerId);
      if (a === undefined) continue;
      for (const [res, qty] of a.stockpile) {
        totals.set(String(res), (totals.get(String(res)) ?? 0) + qty);
      }
    }
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const stockHeader = document.createElement('div');
    stockHeader.style.color = 'var(--muted)';
    stockHeader.style.marginTop = '4px';
    stockHeader.textContent = 'Top stockpiles:';
    root.appendChild(stockHeader);
    if (sorted.length === 0) {
      const emp = document.createElement('div');
      emp.className = 'selected-empty';
      emp.textContent = '(empty)';
      root.appendChild(emp);
    } else {
      const list = document.createElement('div');
      list.className = 'stocklist';
      for (const [r, qty] of sorted) {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const l = document.createElement('span');
        l.className = 'label';
        l.textContent = r;
        const v = document.createElement('span');
        v.className = 'value';
        v.textContent = qty >= 1000 ? `${Math.round(qty / 100) / 10}k` : Math.round(qty).toString();
        row.appendChild(l);
        row.appendChild(v);
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    // Last clearing prices.
    if (s.market.lastClearingPrice.size > 0) {
      const priceHeader = document.createElement('div');
      priceHeader.style.color = 'var(--muted)';
      priceHeader.style.marginTop = '6px';
      priceHeader.textContent = 'Last clearing prices:';
      root.appendChild(priceHeader);
      const sortedPrices = Array.from(s.market.lastClearingPrice.entries()).slice(0, 6);
      const list = document.createElement('div');
      for (const [r, p] of sortedPrices) {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const l = document.createElement('span');
        l.className = 'label';
        l.textContent = String(r);
        const v = document.createElement('span');
        v.className = 'value';
        v.textContent = p.toFixed(2);
        row.appendChild(l);
        row.appendChild(v);
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    addCopyButton(root, () => JSON.stringify(serializeSettlement(world, s.id), null, 2));

    const clearBtn = document.createElement('button');
    clearBtn.className = 'copy-btn';
    clearBtn.textContent = 'Deselect';
    clearBtn.style.marginLeft = '6px';
    clearBtn.addEventListener('click', opts.onClear);
    root.appendChild(clearBtn);
  };

  return { update };
};

const serializeSettlement = (world: WorldState, id: import('../../src/sim/types.js').SettlementId) => {
  const s = world.settlements.get(id);
  if (s === undefined) return null;
  return {
    id: String(s.id),
    name: s.name,
    tier: s.tier,
    anchor: s.anchor,
    population: s.population.total(),
    buildings: s.buildings.length,
    urbanHexes: s.urbanHexes.length,
    catchmentHexes: s.catchmentHexes.length,
    factions: s.factions.map(String),
    stockpileOwners: s.stockpileOwners.map(String),
    lastClearingPrices: Object.fromEntries(
      Array.from(s.market.lastClearingPrice.entries()).map(([k, v]) => [String(k), v]),
    ),
  };
};

const addCopyButton = (host: HTMLElement, getter: () => string): void => {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'Copy state JSON';
  btn.style.marginTop = '6px';
  btn.addEventListener('click', () => {
    void navigator.clipboard.writeText(getter()).catch(() => {
      // Clipboard write can fail in insecure contexts; ignore.
    });
  });
  host.appendChild(btn);
};
