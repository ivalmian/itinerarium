/**
 * Rich modal-popup content for a selected settlement.
 *
 * Renders everything we currently have visibility into for a settlement:
 * header (name, tier, anchor, factions), demographics (age × sex × class
 * pyramid + class totals), treasury per owning actor, buildings grouped by
 * kind, and the per-resource stockpile / market view with last-clearing
 * price, bid-ask spread (—; we don't yet persist max-bid/min-ask), 30-day
 * traded volume from the market's recentInflows/Outflows, and a small
 * sparkline of clearing prices over the per-entity history buffer.
 *
 * The rebuild() function constructs a fresh DOM tree each call. Settlement
 * counts at viewer scale (~60–200) make this cheap enough for a 1 Hz tick.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ActorId, ResourceId, SettlementId } from '../../src/sim/types.js';
import type { Settlement, SettlementBuilding } from '../../src/sim/world/settlement.js';
import { getBuilding } from '../../src/sim/buildings/catalog.js';
import { AGE_BANDS, type AgeBand } from '../../src/sim/population/cohort.js';
import { CHARACTER_CLASSES } from '../../src/sim/population/types.js';
import type { ViewerHistory } from '../state/history.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';
import { createSparkline, fmtCompact } from './sparkline.js';
import { popupEmpty, popupKv, popupSection } from './popup.js';
import { createFactionLink } from './factionLink.js';

export interface SettlementPopupContent {
  readonly element: HTMLElement;
  readonly title: string;
}

export interface SettlementPopupOpts {
  readonly world: WorldState;
  readonly id: SettlementId;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
}

export const renderSettlementPopup = (opts: SettlementPopupOpts): SettlementPopupContent | null => {
  const { world, id, state, history } = opts;
  const s = world.settlements.get(id);
  if (s === undefined) return null;

  const root = document.createElement('div');

  root.appendChild(renderHeader(world, s, state));
  root.appendChild(renderPopulationSection(s));
  root.appendChild(renderTreasurySection(world, s));
  root.appendChild(renderBuildingsSection(s));
  root.appendChild(renderStockpileSection(world, s, history));
  const events = renderEventsSection(history, s.id);
  if (events !== null) root.appendChild(events);

  return {
    element: root,
    title: `${s.name} — ${tierLabel(s.tier)} at (${s.anchor.q}, ${s.anchor.r})`,
  };
};

const tierLabel = (t: Settlement['tier']): string => {
  switch (t) {
    case 'large_city':
      return 'large city';
    case 'small_city':
      return 'small city';
    default:
      return t;
  }
};

// --- Header -----------------------------------------------------------------

const renderHeader = (world: WorldState, s: Settlement, state: ViewerState): HTMLElement => {
  const section = popupSection('Overview');

  const overview = popupKv([
    ['Population', s.population.total().toLocaleString()],
    ['Tier', tierLabel(s.tier)],
    ['Anchor', `(${s.anchor.q}, ${s.anchor.r})`],
    ['Urban hexes', String(s.urbanHexes.length)],
    ['Catchment hexes', String(s.catchmentHexes.length)],
    ['Buildings', String(s.buildings.length)],
    ['Stockpile owners', String(s.stockpileOwners.length)],
  ]);
  section.appendChild(overview);

  // Factions: clickable chips that open the faction screen.
  if (s.factions.length > 0) {
    const f = document.createElement('div');
    f.style.marginTop = '8px';
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Factions:';
    f.appendChild(lbl);
    for (const fid of s.factions) {
      const faction = world.factions.get(fid);
      const label = faction?.name ?? String(fid);
      const link = createFactionLink(state, fid, label);
      link.style.marginRight = '6px';
      f.appendChild(link);
    }
    section.appendChild(f);
  }

  // Same-hex siblings (stacked settlements) — clickable to switch.
  const siblings = [];
  for (const other of world.settlements.values()) {
    if (other.id === s.id) continue;
    if (other.anchor.q !== s.anchor.q || other.anchor.r !== s.anchor.r) continue;
    siblings.push(other);
  }
  if (siblings.length > 0) {
    const sib = document.createElement('div');
    sib.style.marginTop = '6px';
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Stacked with:';
    sib.appendChild(lbl);
    for (const other of siblings) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'popup-link';
      btn.style.marginRight = '8px';
      btn.textContent = `${other.name} (${tierLabel(other.tier)})`;
      btn.addEventListener('click', () => {
        setSelection(state, { kind: 'settlement', id: other.id });
      });
      sib.appendChild(btn);
    }
    section.appendChild(sib);
  }

  return section;
};

// --- Population: class totals + age × sex pyramid --------------------------

const renderPopulationSection = (s: Settlement): HTMLElement => {
  const section = popupSection('Population');

  // Class totals row.
  const classRow = document.createElement('div');
  classRow.style.display = 'grid';
  classRow.style.gridTemplateColumns = 'repeat(auto-fit, minmax(140px, 1fr))';
  classRow.style.gap = '8px';
  classRow.style.marginBottom = '12px';
  for (const c of CHARACTER_CLASSES) {
    const n = s.population.totalByClass(c);
    if (n === 0) continue;
    const cell = document.createElement('div');
    cell.style.background = 'var(--panel-2)';
    cell.style.border = '1px solid var(--border)';
    cell.style.padding = '4px 8px';
    cell.style.borderRadius = '3px';
    const lbl = document.createElement('div');
    lbl.style.color = 'var(--muted)';
    lbl.style.fontSize = '10px';
    lbl.style.textTransform = 'uppercase';
    lbl.style.letterSpacing = '0.05em';
    lbl.textContent = c;
    cell.appendChild(lbl);
    const val = document.createElement('div');
    val.style.color = 'var(--text)';
    val.style.fontVariantNumeric = 'tabular-nums';
    val.textContent = n.toLocaleString();
    cell.appendChild(val);
    classRow.appendChild(cell);
  }
  if (classRow.children.length === 0) {
    section.appendChild(popupEmpty('(no population)'));
    return section;
  }
  section.appendChild(classRow);

  // Demographic pyramid: per age band, two horizontal bars (male left,
  // female right) sized by count. Skip empty age bands.
  const counts = new Map<AgeBand, { male: number; female: number }>();
  for (const a of AGE_BANDS) counts.set(a, { male: 0, female: 0 });
  for (const [key, n] of s.population.cohorts()) {
    if (n === 0) continue;
    const bucket = counts.get(key.age);
    if (bucket === undefined) continue;
    if (key.sex === 'male') bucket.male += n;
    else bucket.female += n;
  }
  let maxBand = 1;
  for (const v of counts.values()) {
    const m = Math.max(v.male, v.female);
    if (m > maxBand) maxBand = m;
  }

  const pyramid = document.createElement('div');
  pyramid.className = 'popup-pyramid';

  const headerRow = document.createElement('div');
  headerRow.className = 'popup-pyramid-row';
  const headerMale = document.createElement('div');
  headerMale.style.textAlign = 'right';
  headerMale.style.color = 'var(--muted)';
  headerMale.style.fontSize = '10px';
  headerMale.textContent = 'male';
  const headerAge = document.createElement('div');
  headerAge.className = 'age';
  headerAge.style.fontSize = '10px';
  headerAge.textContent = 'age';
  const headerFemale = document.createElement('div');
  headerFemale.style.color = 'var(--muted)';
  headerFemale.style.fontSize = '10px';
  headerFemale.textContent = 'female';
  headerRow.appendChild(headerMale);
  headerRow.appendChild(headerAge);
  headerRow.appendChild(headerFemale);
  pyramid.appendChild(headerRow);

  // Render oldest at top, youngest at bottom (population-pyramid convention).
  const rendered = [...AGE_BANDS].reverse();
  for (const age of rendered) {
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

// --- Treasury per owning actor ---------------------------------------------

const renderTreasurySection = (world: WorldState, s: Settlement): HTMLElement => {
  const section = popupSection('Treasury (by owning actor)');

  if (s.stockpileOwners.length === 0) {
    section.appendChild(popupEmpty('(no stockpile owners)'));
    return section;
  }

  const table = document.createElement('table');
  table.className = 'popup-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Actor</th><th>Kind</th><th class="num">Treasury (coin)</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  // Sort by treasury desc.
  const rows: { id: ActorId; name: string; kind: string; treasury: number }[] = [];
  for (const ownerId of s.stockpileOwners) {
    const a = world.actors.get(ownerId);
    if (a === undefined) continue;
    rows.push({
      id: ownerId,
      name: a.name,
      kind: a.kind,
      treasury: a.treasury,
    });
  }
  rows.sort((a, b) => b.treasury - a.treasury);

  let total = 0;
  for (const r of rows) {
    total += r.treasury;
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = r.name;
    const c2 = document.createElement('td');
    c2.textContent = r.kind;
    c2.style.color = 'var(--muted)';
    const c3 = document.createElement('td');
    c3.className = 'num';
    c3.textContent = Math.round(r.treasury).toLocaleString();
    tr.appendChild(c1);
    tr.appendChild(c2);
    tr.appendChild(c3);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const tfoot = document.createElement('tfoot');
  const trf = document.createElement('tr');
  trf.style.fontWeight = 'bold';
  const f1 = document.createElement('td');
  f1.textContent = 'Total';
  f1.colSpan = 2;
  const f2 = document.createElement('td');
  f2.className = 'num';
  f2.textContent = Math.round(total).toLocaleString();
  trf.appendChild(f1);
  trf.appendChild(f2);
  tfoot.appendChild(trf);
  table.appendChild(tfoot);

  section.appendChild(table);
  return section;
};

// --- Buildings: grouped by kind, with hexes -------------------------------

const renderBuildingsSection = (s: Settlement): HTMLElement => {
  const section = popupSection('Buildings');

  if (s.buildings.length === 0 && s.pendingBuildings.length === 0) {
    section.appendChild(popupEmpty('(no buildings)'));
    return section;
  }

  // Group standing buildings by buildingId.
  const grouped = new Map<string, SettlementBuilding[]>();
  for (const b of s.buildings) {
    const key = String(b.buildingId);
    let arr = grouped.get(key);
    if (arr === undefined) {
      arr = [];
      grouped.set(key, arr);
    }
    arr.push(b);
  }
  const groupRows = Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length);

  const table = document.createElement('table');
  table.className = 'popup-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr><th>Building</th><th class="num">Count</th><th>Hexes</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const [bid, list] of groupRows) {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    // getBuilding may throw on unknown id (catalog miss); guard so a stale
    // id from the buf can't crash the popup render.
    let name = bid;
    try {
      const def = getBuilding(list[0]!.buildingId);
      name = def.name;
    } catch {
      // fall back to id
    }
    c1.textContent = name;
    const c2 = document.createElement('td');
    c2.className = 'num';
    c2.textContent = String(list.length);
    const c3 = document.createElement('td');
    c3.style.fontSize = '11px';
    c3.style.color = 'var(--muted)';
    c3.textContent = list
      .slice(0, 12)
      .map((b) => `(${b.hex.q},${b.hex.r})`)
      .join(' ');
    if (list.length > 12) c3.textContent += ` …+${list.length - 12}`;
    tr.appendChild(c1);
    tr.appendChild(c2);
    tr.appendChild(c3);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);

  // Pending construction.
  if (s.pendingBuildings.length > 0) {
    const ph = document.createElement('div');
    ph.style.marginTop = '8px';
    ph.style.color = 'var(--muted)';
    ph.style.fontSize = '11px';
    ph.textContent = `Under construction (${s.pendingBuildings.length}):`;
    section.appendChild(ph);
    const pendList = document.createElement('div');
    pendList.style.fontSize = '11px';
    for (const pb of s.pendingBuildings) {
      let name = String(pb.buildingId);
      try {
        name = getBuilding(pb.buildingId).name;
      } catch {
        // fall through
      }
      const pct = Math.round((1 - pb.workerDaysRemaining / Math.max(1, pb.workerDaysTotal)) * 100);
      const row = document.createElement('div');
      row.style.color = 'var(--muted)';
      row.textContent = `· ${name} at (${pb.hex.q},${pb.hex.r}) — ${pct}% (${pb.workerDaysRemaining.toFixed(0)} worker-days left)`;
      pendList.appendChild(row);
    }
    section.appendChild(pendList);
  }

  return section;
};

// --- Stockpile / market goods ---------------------------------------------

interface StockRow {
  readonly resource: string;
  readonly quantity: number;
  readonly lastPrice: number | null;
  readonly imp: number;
  readonly exp: number;
  readonly prod: number;
  readonly cons: number;
  readonly priceSeries: readonly number[];
}

const renderStockpileSection = (
  world: WorldState,
  s: Settlement,
  history: ViewerHistory,
): HTMLElement => {
  const section = popupSection('Stockpile & market goods');

  // Aggregate quantities across stockpile owners.
  const totals = new Map<string, number>();
  for (const ownerId of s.stockpileOwners) {
    const a = world.actors.get(ownerId);
    if (a === undefined) continue;
    for (const [res, qty] of a.stockpile) {
      totals.set(String(res), (totals.get(String(res)) ?? 0) + qty);
    }
  }

  // Last-clearing prices may include resources not currently in any owner's
  // stockpile (the market cleared them down to zero); include those too.
  const seenResources = new Set<string>(totals.keys());
  for (const r of s.market.lastClearingPrice.keys()) seenResources.add(String(r));
  for (const r of s.market.recentImports.keys()) seenResources.add(String(r));
  for (const r of s.market.recentExports.keys()) seenResources.add(String(r));
  for (const r of s.market.recentProduction.keys()) seenResources.add(String(r));
  for (const r of s.market.recentConsumption.keys()) seenResources.add(String(r));

  if (seenResources.size === 0) {
    section.appendChild(popupEmpty('(no stockpile, no market activity)'));
    return section;
  }

  // Build per-resource price series from the per-entity history buffer
  // (last 60 ticks). Keyed by stringified ResourceId.
  const buf = history.settlements.get(s.id);
  const seriesByResource = new Map<string, number[]>();
  if (buf !== undefined) {
    const recent = buf.slice(-60);
    for (const snap of recent) {
      for (const [r, p] of snap.clearingPrices) {
        const key = String(r);
        let arr = seriesByResource.get(key);
        if (arr === undefined) {
          arr = [];
          seriesByResource.set(key, arr);
        }
        arr.push(p);
      }
    }
  }

  const rows: StockRow[] = [];
  for (const r of seenResources) {
    const qty = totals.get(r) ?? 0;
    const lp = s.market.lastClearingPrice.get(r as ResourceId);
    const imp = s.market.recentImports.get(r as ResourceId) ?? 0;
    const exp = s.market.recentExports.get(r as ResourceId) ?? 0;
    const prod = s.market.recentProduction.get(r as ResourceId) ?? 0;
    const cons = s.market.recentConsumption.get(r as ResourceId) ?? 0;
    rows.push({
      resource: r,
      quantity: qty,
      lastPrice: lp ?? null,
      imp,
      exp,
      prod,
      cons,
      priceSeries: seriesByResource.get(r) ?? [],
    });
  }
  // Sort: rows with quantity first (descending), then those with only market
  // activity by last-price descending.
  rows.sort((a, b) => {
    if (a.quantity !== b.quantity) return b.quantity - a.quantity;
    return (b.lastPrice ?? 0) - (a.lastPrice ?? 0);
  });

  const table = document.createElement('table');
  table.className = 'popup-table';
  const thead = document.createElement('thead');
  // Flow columns reflect the ~30-day rolling window (exponential decay
  // factor exp(-1/30) per day in src/sim/tick.ts.ageRecentFlowsPhase).
  thead.innerHTML = `<tr>
    <th>Resource</th>
    <th class="num">Stock</th>
    <th class="num">Last price</th>
    <th class="num" title="Goods made here by recipes (~30d)">Produced</th>
    <th class="num" title="Goods used up here by recipes/population (~30d)">Consumed</th>
    <th class="num" title="Goods arriving from elsewhere (~30d)">Imported</th>
    <th class="num" title="Goods sent elsewhere (~30d)">Exported</th>
    <th>Price (60d)</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = r.resource;
    const c2 = document.createElement('td');
    c2.className = 'num';
    c2.textContent = r.quantity === 0 ? '—' : Math.round(r.quantity).toLocaleString();
    const c3 = document.createElement('td');
    c3.className = 'num';
    c3.textContent = r.lastPrice === null ? '—' : r.lastPrice.toFixed(2);
    const cProd = document.createElement('td');
    cProd.className = 'num';
    cProd.textContent = r.prod === 0 ? '—' : fmtCompact(r.prod);
    if (r.prod > 0) cProd.style.color = '#7eb87e';
    const cCons = document.createElement('td');
    cCons.className = 'num';
    cCons.textContent = r.cons === 0 ? '—' : fmtCompact(r.cons);
    if (r.cons > 0) cCons.style.color = '#d89a6a';
    const cImp = document.createElement('td');
    cImp.className = 'num';
    cImp.textContent = r.imp === 0 ? '—' : fmtCompact(r.imp);
    if (r.imp > 0) cImp.style.color = '#7e9ec8';
    const cExp = document.createElement('td');
    cExp.className = 'num';
    cExp.textContent = r.exp === 0 ? '—' : fmtCompact(r.exp);
    if (r.exp > 0) cExp.style.color = '#c89e7e';
    const cSpark = document.createElement('td');
    if (r.priceSeries.length >= 2) {
      cSpark.appendChild(createSparkline(r.priceSeries, { width: 100, height: 16 }));
    } else {
      cSpark.textContent = '—';
      cSpark.style.color = 'var(--muted)';
    }
    tr.appendChild(c1);
    tr.appendChild(c2);
    tr.appendChild(c3);
    tr.appendChild(cProd);
    tr.appendChild(cCons);
    tr.appendChild(cImp);
    tr.appendChild(cExp);
    tr.appendChild(cSpark);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
};

const renderEventsSection = (history: ViewerHistory, id: SettlementId): HTMLElement | null => {
  const events = history.settlementEvents.get(id);
  if (events === undefined || events.length === 0) return null;
  const section = popupSection('Recent events');
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
