/**
 * Selected-settlement detail panel.
 *
 * Pop, top stockpiles (summed across the settlement's stockpile owners),
 * building count, and last few clearing prices. Re-renders on every tick when
 * the selection is a settlement.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ResourceId, SettlementId } from '../../src/sim/types.js';
import { hexEquals } from '../../src/sim/world/hex.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';
import type { ViewerHistory } from '../state/history.js';
import { createSparkline, fmtCompact } from './sparkline.js';
import { createFactionLink } from './factionLink.js';

export interface SettlementPanel {
  update(world: WorldState): void;
}

export interface SettlementPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
  readonly onClear: () => void;
}

export const createSettlementPanel = (opts: SettlementPanelOpts): SettlementPanel => {
  const { host, state, history } = opts;
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
    const siblings: { readonly id: SettlementId; readonly name: string; readonly tier: string }[] =
      [];
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

    // Factions present in this settlement (docs/11). Every entry is a click
    // target that opens the faction screen.
    if (s.factions.length > 0) {
      const facHeader = document.createElement('div');
      facHeader.style.color = 'var(--muted)';
      facHeader.style.fontSize = '11px';
      facHeader.style.marginBottom = '2px';
      facHeader.textContent = `Factions (${s.factions.length}):`;
      root.appendChild(facHeader);
      const facList = document.createElement('div');
      facList.style.marginBottom = '6px';
      for (const fId of s.factions) {
        const f = world.factions.get(fId);
        const label = f?.name ?? `(unknown ${String(fId).slice(-6)})`;
        facList.appendChild(createFactionLink(state, fId, label));
      }
      root.appendChild(facList);
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
    const sorted = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
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

    // Market snapshot: last clearing price + residual bid-ask book per
    // docs/08 §"Bid-ask book". Shows "bid · last · ask" so the player can
    // see at a glance whether each market is crossing or sitting frozen.
    if (s.market.lastClearingPrice.size > 0) {
      const priceHeader = document.createElement('div');
      priceHeader.style.color = 'var(--muted)';
      priceHeader.style.marginTop = '6px';
      priceHeader.textContent = 'Market (bid · last · ask):';
      root.appendChild(priceHeader);
      const sortedPrices = Array.from(s.market.lastClearingPrice.entries()).slice(0, 8);
      const list = document.createElement('div');
      for (const [r, p] of sortedPrices) {
        const row = document.createElement('div');
        row.className = 'stat-row';
        const l = document.createElement('span');
        l.className = 'label';
        l.textContent = String(r);
        const v = document.createElement('span');
        v.className = 'value';
        const bid = s.market.bestBid.get(r);
        const ask = s.market.bestAsk.get(r);
        const bidStr = bid !== undefined ? bid.toFixed(2) : '—';
        const askStr = ask !== undefined ? ask.toFixed(2) : '—';
        v.textContent = `${bidStr} · ${p.toFixed(2)} · ${askStr}`;
        row.appendChild(l);
        row.appendChild(v);
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    // Historical trajectories from the per-entity history buffer.
    renderHistory(root, history, s.id);

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

/**
 * Pull the per-entity ring buffer for this settlement and render:
 *   1. Population sparkline (downsampled to last ~10 points).
 *   2. Per-resource clearing-price sparklines for the most-active resources.
 *   3. Recent (last 20) routed events.
 *
 * Downsampling keeps the inline sparkline readable: 100 raw daily points
 * compressed into ~10 buckets averaged so a city's slow population drift
 * shows as a smooth line, not a 100-pixel jitter.
 */
const renderHistory = (root: HTMLElement, history: ViewerHistory, id: SettlementId): void => {
  const buf = history.settlements.get(id);
  if (buf === undefined || buf.length < 2) return;

  const histHeader = document.createElement('div');
  histHeader.style.color = 'var(--muted)';
  histHeader.style.marginTop = '8px';
  histHeader.style.borderTop = '1px solid var(--border)';
  histHeader.style.paddingTop = '6px';
  histHeader.textContent = `History (${buf.length} ticks):`;
  root.appendChild(histHeader);

  // Population sparkline at coarse grain.
  const popSeries = downsample(
    buf.map((b) => b.population),
    10,
  );
  appendSparklineRow(root, 'Population', popSeries, fmtCompact(buf[buf.length - 1]!.population));

  // Top-3 most-volatile clearing-price series. We aggregate prices per
  // resource across ALL recorded ticks so the panel includes prices that
  // weren't present in the latest snapshot's slice.
  const series = aggregatePriceSeries(buf);
  const ranked = Array.from(series.entries())
    .filter(([, vals]) => vals.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4);
  if (ranked.length > 0) {
    const ph = document.createElement('div');
    ph.style.color = 'var(--muted)';
    ph.style.fontSize = '11px';
    ph.style.marginTop = '4px';
    ph.textContent = 'Recent clearing prices:';
    root.appendChild(ph);
    for (const [res, vals] of ranked) {
      const trimmed = vals.slice(-10);
      appendSparklineRow(root, String(res), trimmed, fmtCompact(trimmed[trimmed.length - 1] ?? 0));
    }
  }

  // Recent events (chronological, oldest first; cap visible at 8).
  const events = history.settlementEvents.get(id);
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
    const visible = events.slice(-8);
    for (const e of visible) {
      const row = document.createElement('div');
      row.style.color = 'var(--muted)';
      row.style.padding = '1px 0';
      row.textContent = `d${e.day} · ${e.summary}`;
      list.appendChild(row);
    }
    root.appendChild(list);
  }
};

/** Aggregate every snapshot's clearing-price map into one series per resource. */
const aggregatePriceSeries = (
  buf: readonly { readonly clearingPrices: ReadonlyMap<ResourceId, number> }[],
): Map<ResourceId, number[]> => {
  const series = new Map<ResourceId, number[]>();
  for (const snap of buf) {
    for (const [res, price] of snap.clearingPrices) {
      let arr = series.get(res);
      if (arr === undefined) {
        arr = [];
        series.set(res, arr);
      }
      arr.push(price);
    }
  }
  return series;
};

/** Mean-bucket downsample of a numeric series down to at most `bins` points. */
const downsample = (vals: readonly number[], bins: number): number[] => {
  if (vals.length <= bins) return vals.slice();
  const step = vals.length / bins;
  const out: number[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = Math.floor(i * step);
    const hi = Math.min(vals.length, Math.floor((i + 1) * step));
    let sum = 0;
    let count = 0;
    for (let j = lo; j < hi; j++) {
      sum += vals[j] as number;
      count += 1;
    }
    out.push(count > 0 ? sum / count : 0);
  }
  return out;
};

const appendSparklineRow = (
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
  l.style.flex = '0 0 auto';
  l.textContent = label;
  row.appendChild(l);

  const right = document.createElement('span');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '4px';
  const spark = createSparkline(values);
  right.appendChild(spark);
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

const serializeSettlement = (
  world: WorldState,
  id: import('../../src/sim/types.js').SettlementId,
) => {
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
