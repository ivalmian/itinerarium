/**
 * Global resources table.
 *
 * Aggregates stockpiles across every Actor for every resource, combines with
 * the average last-clearing-price across settlements for that resource, and
 * shows the top 20 by total value (stock × price). Also tracks 30-day moving
 * average production via a per-resource ring buffer of `recordRecipeRun` calls
 * the app pushes in from each tick's events.
 */

import { allResources } from '../../src/sim/resources/catalog.js';
import type { ResourceId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';

const PRODUCTION_WINDOW_DAYS = 30;

export interface ResourcePanel {
  update(world: WorldState): void;
  /** Append today's recipe-output additions to the production window. */
  recordOutputs(deltaByResource: ReadonlyMap<ResourceId, number>): void;
}

export interface ResourcePanelOpts {
  readonly host: HTMLElement;
}

export const createResourcePanel = (opts: ResourcePanelOpts): ResourcePanel => {
  const { host } = opts;

  const toggle = document.createElement('button');
  toggle.className = 'resource-toggle';
  toggle.textContent = 'Resources ▶';
  host.appendChild(toggle);

  const table = document.createElement('table');
  table.className = 'resource-table';
  table.style.display = 'none';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Resource</th>
        <th class="num">Stock</th>
        <th class="num">/day (30d)</th>
        <th class="num">Last px</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  host.appendChild(table);
  const tbody = table.querySelector('tbody') as HTMLTableSectionElement;

  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    table.style.display = expanded ? '' : 'none';
    toggle.textContent = expanded ? 'Resources ▼' : 'Resources ▶';
  });

  const allDefs = allResources();

  // Production ring: for each resource, an array of last-N daily totals.
  const ring = new Map<string, number[]>();

  const recordOutputs = (deltaByResource: ReadonlyMap<ResourceId, number>): void => {
    const seen = new Set<string>();
    for (const [r, v] of deltaByResource) {
      const key = String(r);
      seen.add(key);
      let buf = ring.get(key);
      if (buf === undefined) {
        buf = [];
        ring.set(key, buf);
      }
      buf.push(v);
      while (buf.length > PRODUCTION_WINDOW_DAYS) buf.shift();
    }
    // Resources with no production today still get a 0 entry so the moving
    // average doesn't keep stale data permanently.
    for (const [key, buf] of ring) {
      if (seen.has(key)) continue;
      buf.push(0);
      while (buf.length > PRODUCTION_WINDOW_DAYS) buf.shift();
    }
  };

  const movingAvg = (key: string): number => {
    const buf = ring.get(key);
    if (buf === undefined || buf.length === 0) return 0;
    let s = 0;
    for (const v of buf) s += v;
    return s / buf.length;
  };

  const update = (world: WorldState): void => {
    if (!expanded) return;

    // Aggregate stockpiles across every actor across every settlement
    // (each modius is counted exactly once because actor.stockpile is now
    // keyed by SettlementId per docs/15 §C30).
    const stocks = new Map<string, number>();
    for (const a of world.actors.values()) {
      for (const slice of a.stockpile.values()) {
        for (const [r, q] of slice) {
          stocks.set(String(r), (stocks.get(String(r)) ?? 0) + q);
        }
      }
    }
    // Camp loot also counts toward global stock.
    if (world.banditCamps !== undefined) {
      for (const c of world.banditCamps.values()) {
        for (const [r, q] of c.loot) {
          stocks.set(String(r), (stocks.get(String(r)) ?? 0) + q);
        }
      }
    }

    // Average last-clearing-price across settlements.
    const priceSum = new Map<string, { sum: number; n: number }>();
    for (const s of world.settlements.values()) {
      for (const [r, p] of s.market.lastClearingPrice) {
        const k = String(r);
        const entry = priceSum.get(k) ?? { sum: 0, n: 0 };
        entry.sum += p;
        entry.n += 1;
        priceSum.set(k, entry);
      }
    }
    const avgPrice = (k: string): number => {
      const e = priceSum.get(k);
      return e === undefined || e.n === 0 ? 1 : e.sum / e.n;
    };

    interface Row {
      key: string;
      stock: number;
      price: number;
      production: number;
      value: number;
    }
    const rows: Row[] = [];
    for (const def of allDefs) {
      const key = String(def.id);
      const stock = stocks.get(key) ?? 0;
      const price = avgPrice(key);
      const value = stock * price;
      rows.push({ key, stock, price, production: movingAvg(key), value });
    }
    rows.sort((a, b) => b.value - a.value);
    const top = rows.slice(0, 20);

    // Cheap diff-free re-render (small N).
    tbody.innerHTML = '';
    for (const row of top) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${escapeHtml(row.key)}</td>` +
        `<td class="num">${formatQty(row.stock)}</td>` +
        `<td class="num">${row.production > 0 ? formatQty(row.production) : '—'}</td>` +
        `<td class="num">${row.price.toFixed(2)}</td>`;
      tbody.appendChild(tr);
    }
  };

  return { update, recordOutputs };
};

const formatQty = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n >= 1000) return n.toLocaleString();
  if (n >= 10) return Math.round(n).toString();
  return n.toFixed(2);
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
