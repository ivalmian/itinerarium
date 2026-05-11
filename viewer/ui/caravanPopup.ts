/**
 * Rich modal-popup content for a selected caravan.
 *
 * Sections:
 *   - Header: owner actor (kind + name + home settlement), caravan id.
 *   - Position / destination / distance / ETA. ETA is computed from
 *     hexDistance ÷ baseMp × loadMult — a coarse estimate because
 *     terrain & road grade vary along the route; we surface it as a
 *     range. If no destination we say "idle".
 *   - Why: render the top of caravan.goalStack as a human string (or
 *     fall back to inferring from cargo + destination).
 *   - Cargo manifest: per resource we show qty + last known buy/sell
 *     price (priceBook is keyed by hex; we surface "at current hex"
 *     and "at destination hex" when known).
 *   - Crew breakdown by kind, plus animals and vehicles.
 *   - Recent P/L: caravans don't track a per-trip ledger today, so we
 *     summarize what IS available — treasury sparkline from the per-
 *     entity history buffer (the closest surrogate for P/L).
 *   - Trip history: condensed route trace + last few visited destinations.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { CaravanId } from '../../src/sim/types.js';
import type { Caravan } from '../../src/sim/caravan/caravan.js';
import { caravanMovementStats } from '../../src/sim/caravan/caravan.js';
import type { Goal } from '../../src/sim/caravan/goal.js';
import { hexDistance } from '../../src/sim/world/hex.js';
import type { ViewerHistory } from '../state/history.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';
import { createSparkline, fmtCompact } from './sparkline.js';
import { popupEmpty, popupKv, popupSection } from './popup.js';
import { createFactionLink } from './factionLink.js';
import { findFactionByActor } from './factionScreen.js';

export interface CaravanPopupContent {
  readonly element: HTMLElement;
  readonly title: string;
}

export interface CaravanPopupOpts {
  readonly world: WorldState;
  readonly id: CaravanId;
  readonly state: ViewerState;
  readonly history: ViewerHistory;
}

export const renderCaravanPopup = (opts: CaravanPopupOpts): CaravanPopupContent | null => {
  const { world, id, state, history } = opts;
  const c = world.caravans.get(id);
  if (c === undefined) return null;

  const owner = world.actors.get(c.ownerActor);
  const ownerLabel = owner?.name ?? String(c.ownerActor);

  const root = document.createElement('div');
  root.appendChild(renderHeader(world, c, state));
  root.appendChild(renderRouteSection(c));
  root.appendChild(renderCargoSection(world, c));
  root.appendChild(renderCrewSection(c));
  root.appendChild(renderHistorySection(c, history));
  const transactions = renderTransactionsSection(history, c.id);
  if (transactions !== null) root.appendChild(transactions);
  const events = renderEventsSection(history, c.id);
  if (events !== null) root.appendChild(events);

  return {
    element: root,
    title: `${ownerLabel}'s caravan`,
  };
};

// --- Header -----------------------------------------------------------------

const renderHeader = (world: WorldState, c: Caravan, state: ViewerState): HTMLElement => {
  const section = popupSection('Overview');
  const owner = world.actors.get(c.ownerActor);

  const overview = popupKv([
    ['Owner', owner?.name ?? String(c.ownerActor)],
    ['Owner kind', owner?.kind ?? 'unknown'],
    ['Caravan id', shortId(String(c.id))],
    ['Treasury', `${Math.round(c.treasury).toLocaleString()} coin`],
    ['Health', `${(c.health * 100).toFixed(0)}%`],
    ['MP today', `${Math.round(c.mpRemainingToday)}`],
  ]);
  section.appendChild(overview);

  if (owner?.homeSettlement !== undefined) {
    const home = world.settlements.get(owner.homeSettlement);
    if (home !== undefined) {
      const row = document.createElement('div');
      row.style.marginTop = '6px';
      const lbl = document.createElement('span');
      lbl.style.color = 'var(--muted)';
      lbl.style.marginRight = '6px';
      lbl.textContent = 'Home:';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'popup-link';
      btn.textContent = `${home.name} (${home.tier})`;
      btn.addEventListener('click', () => {
        setSelection(state, { kind: 'settlement', id: home.id });
      });
      row.appendChild(lbl);
      row.appendChild(btn);
      section.appendChild(row);
    }
  }

  // Owner faction (clickable to open faction screen) if the owning actor
  // backs one.
  const faction = findFactionByActor(world, c.ownerActor);
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

// --- Route + ETA + why -----------------------------------------------------

const renderRouteSection = (c: Caravan): HTMLElement => {
  const section = popupSection('Route');

  const dist =
    c.destination !== null ? hexDistance(c.position, c.destination) : null;
  const stats = caravanMovementStats(c);
  let etaText = '—';
  if (dist !== null) {
    if (dist === 0) {
      etaText = 'at destination';
    } else if (stats.baseMp > 0) {
      // Coarse: use baseMp × loadMult as expected per-day MP at full road
      // grade. Real movement is lower (roads aren't all roman; terrain
      // multipliers cap). Surface as a range: best case = baseMp,
      // worst case = baseMp × 0.25 (off-road).
      const best = stats.baseMp * stats.loadMult;
      const worst = best * 0.25;
      const dBest = Math.max(1, Math.ceil(dist / best));
      const dWorst = Math.max(1, Math.ceil(dist / worst));
      etaText = dBest === dWorst ? `${dBest}d` : `${dBest}–${dWorst}d`;
    } else {
      etaText = 'unable to move (no MP)';
    }
  }

  const overview = popupKv([
    ['Position', `(${c.position.q}, ${c.position.r})`],
    [
      'Destination',
      c.destination !== null ? `(${c.destination.q}, ${c.destination.r})` : '— (idle)',
    ],
    ['Distance', dist !== null ? `${dist} hex` : '—'],
    ['Estimated days', etaText],
    ['Base MP/day', stats.baseMp.toFixed(1)],
    ['Load mult', stats.loadMult.toFixed(2)],
  ]);
  section.appendChild(overview);

  // "Why?" — synthesize from the goal stack if any, else infer.
  const reason = describeWhy(c);
  if (reason !== null) {
    const why = document.createElement('div');
    why.style.marginTop = '8px';
    why.style.padding = '6px 10px';
    why.style.background = 'var(--panel-2)';
    why.style.borderLeft = '3px solid var(--accent)';
    why.style.fontStyle = 'italic';
    why.textContent = reason;
    section.appendChild(why);
  }

  return section;
};

const describeWhy = (c: Caravan): string | null => {
  const stack = c.goalStack;
  if (stack !== undefined && stack.length > 0) {
    const top = stack[stack.length - 1] as Goal;
    switch (top.type) {
      case 'move_to':
        return `Travelling to (${top.hex.q}, ${top.hex.r}).`;
      case 'trade_at':
        return `Trading at ${shortId(String(top.settlement))}${top.buy && top.buy.length > 0 ? `; buying ${top.buy.map(String).join(', ')}` : ''}${top.sell && top.sell.length > 0 ? `; selling ${top.sell.map(String).join(', ')}` : ''}.`;
      case 'escort':
        return `Escorting ${shortId(String(top.target))} (within ${top.maxDistanceHexes} hex).`;
      case 'patrol':
        return `Patrolling — ${top.cyclesRemaining} cycles remaining.`;
      case 'return_home':
        return `Returning home to (${top.home.q}, ${top.home.r}).`;
      case 'flee_to':
        return `Fleeing to (${top.safe.q}, ${top.safe.r}).`;
    }
  }
  // No goal stack: infer from cargo + destination.
  let cargoUnits = 0;
  for (const v of c.cargo.values()) cargoUnits += v;
  if (c.destination !== null) {
    if (cargoUnits > 0) {
      return `Hauling ${Math.round(cargoUnits)} units of cargo toward (${c.destination.q}, ${c.destination.r}).`;
    }
    return `Travelling empty toward (${c.destination.q}, ${c.destination.r}).`;
  }
  if (cargoUnits > 0) {
    return `Stationary with ${Math.round(cargoUnits)} units of cargo aboard.`;
  }
  return null;
};

// --- Cargo + price book ----------------------------------------------------

const renderCargoSection = (world: WorldState, c: Caravan): HTMLElement => {
  const section = popupSection('Cargo manifest');

  if (c.cargo.size === 0) {
    section.appendChild(popupEmpty('(empty)'));
    return section;
  }

  // Look up prices at the caravan's home settlement (best surrogate for
  // "buy price") and at the destination (the "sell price" target).
  const owner = world.actors.get(c.ownerActor);
  const home =
    owner?.homeSettlement !== undefined ? world.settlements.get(owner.homeSettlement) : undefined;

  const destSettlement = (() => {
    if (c.destination === null) return undefined;
    for (const s of world.settlements.values()) {
      if (s.anchor.q === c.destination.q && s.anchor.r === c.destination.r) return s;
    }
    return undefined;
  })();

  const table = document.createElement('table');
  table.className = 'popup-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Resource</th>
    <th class="num">Quantity</th>
    <th class="num">Last buy (home)</th>
    <th class="num">Sell (destination)</th>
    <th class="num">Implied margin</th>
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  const sorted = Array.from(c.cargo.entries()).sort((a, b) => b[1] - a[1]);
  for (const [r, qty] of sorted) {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = String(r);
    const c2 = document.createElement('td');
    c2.className = 'num';
    c2.textContent = Math.round(qty).toLocaleString();
    const c3 = document.createElement('td');
    c3.className = 'num';
    const buyPrice = home?.market.lastClearingPrice.get(r);
    c3.textContent = buyPrice !== undefined ? buyPrice.toFixed(2) : '—';
    const c4 = document.createElement('td');
    c4.className = 'num';
    const sellPrice = destSettlement?.market.lastClearingPrice.get(r);
    c4.textContent = sellPrice !== undefined ? sellPrice.toFixed(2) : '—';
    const c5 = document.createElement('td');
    c5.className = 'num';
    if (buyPrice !== undefined && sellPrice !== undefined && buyPrice > 0) {
      const margin = ((sellPrice - buyPrice) / buyPrice) * 100;
      c5.textContent = `${margin >= 0 ? '+' : ''}${margin.toFixed(0)}%`;
      c5.style.color = margin >= 0 ? 'var(--good)' : 'var(--bad)';
    } else {
      c5.textContent = '—';
      c5.style.color = 'var(--muted)';
    }
    tr.appendChild(c1);
    tr.appendChild(c2);
    tr.appendChild(c3);
    tr.appendChild(c4);
    tr.appendChild(c5);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(table);

  // PriceBook surfacing: many caravans accumulate per-hex observations.
  // We pick the top-N by recency and render a small table so the player
  // sees what the caravan "knows" about prices in the wild.
  const pricedHexes: { hex: string; resource: string; price: number; day: number }[] = [];
  for (const [res, hexMap] of c.priceBook) {
    for (const [hexKey, obs] of hexMap) {
      pricedHexes.push({
        hex: hexKey,
        resource: String(res),
        price: obs.price,
        day: obs.observedOnDay,
      });
    }
  }
  if (pricedHexes.length > 0) {
    pricedHexes.sort((a, b) => b.day - a.day);
    const ph = document.createElement('div');
    ph.style.marginTop = '10px';
    ph.style.color = 'var(--muted)';
    ph.style.fontSize = '11px';
    ph.textContent = `Price book (${pricedHexes.length} observations, newest first):`;
    section.appendChild(ph);

    const tbl = document.createElement('table');
    tbl.className = 'popup-table';
    const th2 = document.createElement('thead');
    th2.innerHTML = `<tr><th>Resource</th><th>Hex</th><th class="num">Price</th><th class="num">Day</th></tr>`;
    tbl.appendChild(th2);
    const tb2 = document.createElement('tbody');
    for (const row of pricedHexes.slice(0, 10)) {
      const tr = document.createElement('tr');
      const d1 = document.createElement('td');
      d1.textContent = row.resource;
      const d2 = document.createElement('td');
      d2.textContent = row.hex;
      d2.style.fontFamily = 'ui-monospace, monospace';
      d2.style.fontSize = '11px';
      const d3 = document.createElement('td');
      d3.className = 'num';
      d3.textContent = row.price.toFixed(2);
      const d4 = document.createElement('td');
      d4.className = 'num';
      d4.textContent = `d${row.day}`;
      tr.appendChild(d1);
      tr.appendChild(d2);
      tr.appendChild(d3);
      tr.appendChild(d4);
      tb2.appendChild(tr);
    }
    tbl.appendChild(tb2);
    section.appendChild(tbl);
  }

  return section;
};

// --- Crew & animals --------------------------------------------------------

const renderCrewSection = (c: Caravan): HTMLElement => {
  const section = popupSection('Crew & transport');

  // Crew table.
  if (c.crew.length > 0) {
    const tbl = document.createElement('table');
    tbl.className = 'popup-table';
    const head = document.createElement('thead');
    head.innerHTML = `<tr><th>Kind</th><th class="num">Count</th><th class="num">Weapons</th><th class="num">Armor</th></tr>`;
    tbl.appendChild(head);
    const tb = document.createElement('tbody');
    for (const m of c.crew) {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      c1.textContent = m.kind;
      const c2 = document.createElement('td');
      c2.className = 'num';
      c2.textContent = String(m.count);
      const c3 = document.createElement('td');
      c3.className = 'num';
      c3.textContent = `${(m.weapons * 100).toFixed(0)}%`;
      const c4 = document.createElement('td');
      c4.className = 'num';
      c4.textContent = `${(m.armor * 100).toFixed(0)}%`;
      tr.appendChild(c1);
      tr.appendChild(c2);
      tr.appendChild(c3);
      tr.appendChild(c4);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    section.appendChild(tbl);
  }

  // Animals.
  const animalEntries = Object.entries(c.animals).filter(([, n]) => (n ?? 0) > 0);
  const vehicleEntries = Object.entries(c.vehicles).filter(([, n]) => (n ?? 0) > 0);
  if (animalEntries.length > 0 || vehicleEntries.length > 0) {
    const grid = document.createElement('div');
    grid.style.marginTop = '8px';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';
    grid.style.gap = '8px';

    if (animalEntries.length > 0) {
      const cell = document.createElement('div');
      cell.style.background = 'var(--panel-2)';
      cell.style.border = '1px solid var(--border)';
      cell.style.padding = '6px 10px';
      const lbl = document.createElement('div');
      lbl.style.color = 'var(--muted)';
      lbl.style.fontSize = '10px';
      lbl.style.textTransform = 'uppercase';
      lbl.style.letterSpacing = '0.05em';
      lbl.textContent = 'Animals';
      cell.appendChild(lbl);
      for (const [k, n] of animalEntries) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.fontSize = '12px';
        const a = document.createElement('span');
        a.textContent = k;
        const b = document.createElement('span');
        b.style.fontVariantNumeric = 'tabular-nums';
        b.textContent = String(n);
        row.appendChild(a);
        row.appendChild(b);
        cell.appendChild(row);
      }
      grid.appendChild(cell);
    }
    if (vehicleEntries.length > 0) {
      const cell = document.createElement('div');
      cell.style.background = 'var(--panel-2)';
      cell.style.border = '1px solid var(--border)';
      cell.style.padding = '6px 10px';
      const lbl = document.createElement('div');
      lbl.style.color = 'var(--muted)';
      lbl.style.fontSize = '10px';
      lbl.style.textTransform = 'uppercase';
      lbl.style.letterSpacing = '0.05em';
      lbl.textContent = 'Vehicles';
      cell.appendChild(lbl);
      for (const [k, n] of vehicleEntries) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.fontSize = '12px';
        const a = document.createElement('span');
        a.textContent = k;
        const b = document.createElement('span');
        b.style.fontVariantNumeric = 'tabular-nums';
        b.textContent = String(n);
        row.appendChild(a);
        row.appendChild(b);
        cell.appendChild(row);
      }
      grid.appendChild(cell);
    }
    section.appendChild(grid);
  }
  return section;
};

// --- History: P/L surrogate + route trace ---------------------------------

const renderHistorySection = (c: Caravan, history: ViewerHistory): HTMLElement => {
  const section = popupSection('Recent activity (P/L surrogate)');

  const buf = history.caravans.get(c.id);
  if (buf === undefined || buf.length < 2) {
    section.appendChild(
      popupEmpty(
        'P/L not tracked yet — per-trip ledger requires journal support. Showing live treasury / cargo only.',
      ),
    );
    const live = popupKv([
      ['Current treasury', `${Math.round(c.treasury).toLocaleString()} coin`],
      ['Current cargo', `${cargoUnits(c).toLocaleString()} units`],
    ]);
    section.appendChild(live);
    return section;
  }

  const recent = buf.slice(-60);
  const lastSnap = recent[recent.length - 1]!;
  const firstSnap = recent[0]!;

  const treasuryDelta = lastSnap.treasury - firstSnap.treasury;
  const overview = popupKv([
    ['Treasury Δ (60d)', `${treasuryDelta >= 0 ? '+' : ''}${Math.round(treasuryDelta).toLocaleString()}`],
    ['Current treasury', `${Math.round(lastSnap.treasury).toLocaleString()} coin`],
    ['Current cargo', `${Math.round(lastSnap.cargoUnits).toLocaleString()} units`],
    ['Crew', String(lastSnap.crewCount)],
    ['Health', `${(lastSnap.health * 100).toFixed(0)}%`],
  ]);
  section.appendChild(overview);

  // Sparkline trio side-by-side.
  const tri = document.createElement('div');
  tri.style.marginTop = '8px';
  tri.style.display = 'grid';
  tri.style.gridTemplateColumns = 'repeat(auto-fit, minmax(160px, 1fr))';
  tri.style.gap = '8px';
  tri.appendChild(sparkCell('Treasury', recent.map((s) => s.treasury), fmtCompact(lastSnap.treasury)));
  tri.appendChild(sparkCell('Cargo', recent.map((s) => s.cargoUnits), fmtCompact(lastSnap.cargoUnits)));
  tri.appendChild(sparkCell('Crew', recent.map((s) => s.crewCount), String(lastSnap.crewCount)));
  tri.appendChild(
    sparkCell('Health', recent.map((s) => s.health), `${(lastSnap.health * 100).toFixed(0)}%`),
  );
  section.appendChild(tri);

  // Trip history: condensed route (consecutive-equal hexes collapsed).
  const route: { day: number; q: number; r: number }[] = [];
  for (const snap of recent) {
    const last = route[route.length - 1];
    if (last !== undefined && last.q === snap.position.q && last.r === snap.position.r) continue;
    route.push({ day: snap.day, q: snap.position.q, r: snap.position.r });
  }
  if (route.length > 0) {
    const rh = document.createElement('div');
    rh.style.marginTop = '10px';
    rh.style.color = 'var(--muted)';
    rh.style.fontSize = '11px';
    rh.textContent = `Trip history — ${route.length} distinct stops over the last ${recent.length} days:`;
    section.appendChild(rh);
    const list = document.createElement('div');
    list.style.fontSize = '11px';
    list.style.fontFamily = 'ui-monospace, monospace';
    list.style.maxHeight = '160px';
    list.style.overflowY = 'auto';
    list.style.background = 'var(--panel-2)';
    list.style.padding = '6px 8px';
    list.style.border = '1px solid var(--border)';
    for (const r of route.slice(-20)) {
      const row = document.createElement('div');
      row.style.color = 'var(--muted)';
      row.textContent = `d${r.day}  (${r.q}, ${r.r})`;
      list.appendChild(row);
    }
    section.appendChild(list);
  }

  return section;
};

/** Event kinds that the Transactions section already covers. The
 *  generic Recent-events section skips them so the same row doesn't
 *  appear twice. */
const TRANSACTION_KINDS: ReadonlySet<string> = new Set([
  'caravan_traded',
  'caravan_profit_remitted',
  'caravan_exported_off_map',
]);

const renderEventsSection = (
  history: ViewerHistory,
  id: CaravanId,
): HTMLElement | null => {
  const events = history.caravanEvents.get(id);
  if (events === undefined || events.length === 0) return null;
  const nonTx = events.filter((e) => !TRANSACTION_KINDS.has(e.kind));
  if (nonTx.length === 0) return null;
  const section = popupSection('Recent events');
  const list = document.createElement('div');
  list.className = 'popup-event-list';
  for (const e of nonTx.slice(-25)) {
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

/**
 * Per-caravan transaction log: every caravan_traded / profit_remitted /
 * off-map export event, newest at the bottom, with a running net P/L
 * shown at the bottom. Coin sign convention: buys are negative cash flow
 * (the caravan spent coin), sells are positive (the caravan received it).
 */
const renderTransactionsSection = (
  history: ViewerHistory,
  id: CaravanId,
): HTMLElement | null => {
  const events = history.caravanEvents.get(id);
  if (events === undefined || events.length === 0) return null;
  const tx = events.filter((e) => TRANSACTION_KINDS.has(e.kind));
  if (tx.length === 0) return null;
  const section = popupSection('Transactions');
  const list = document.createElement('div');
  list.className = 'popup-event-list';
  // Show the last 40 to keep the popup bounded; the per-entity buffer
  // already caps at ~250 (history.ts pushBoundedEvents) so this is a
  // soft display cap.
  const recent = tx.slice(-40);
  for (const e of recent) {
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

// --- Helpers ---------------------------------------------------------------

const cargoUnits = (c: Caravan): number => {
  let n = 0;
  for (const v of c.cargo.values()) n += v;
  return n;
};

const shortId = (id: string): string => {
  const parts = id.split(':');
  if (parts.length <= 1) return id.slice(-8);
  return parts[parts.length - 1] ?? id;
};

const sparkCell = (
  label: string,
  values: readonly number[],
  current: string,
): HTMLElement => {
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
