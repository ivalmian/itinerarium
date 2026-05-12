/**
 * Resource-level bid-ask book popup (docs/15 §C19 + §C21).
 *
 * Opens when the player clicks a resource row in the settlement popup. Shows
 * the per-source ladder of asks (sellers, ascending) and bids (buyers,
 * descending), plus the aggregate book summary (best bid / ask / spread /
 * mid / depth) and last-cleared metadata.
 *
 * Each ladder row labels the actor kind so the player can see "patrician
 * family Vibian asking 7.20", "plebeian household bidding 6.80", "off-map
 * house asking 12.50 (residual import)" without leaving the popup.
 */

import type { ResourceId, SettlementId } from '../../src/sim/types.js';
import type { Settlement } from '../../src/sim/world/settlement.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { popupKv, popupSection } from './popup.js';

export interface MarketBookPopupOpts {
  readonly world: WorldState;
  readonly settlementId: SettlementId;
  readonly resource: ResourceId;
}

export interface MarketBookPopupContent {
  readonly element: HTMLElement;
  readonly title: string;
}

const FACTION_LABELS: Record<string, string> = {
  patrician_family: 'Patrician family',
  free_village: 'Free village',
  plebeian_household: 'Plebeian household',
  freedman_household: 'Freedman household',
  foreigner_household: 'Foreigner household',
  hamlet_household: 'Hamlet household',
  governor_office: "Governor's office",
  temple: 'Temple',
  bandit_camp: 'Bandit band',
  caravan_owner: 'Caravan house',
  player: 'Player',
  off_map_house: 'Off-map house',
  city_corporation: 'City corp.',
  merchant_guild: 'Merchant guild',
};

const CURVE_LABELS: Record<string, string> = {
  subsistence: 'subsistence',
  comfort: 'comfort',
  status: 'status',
  derived: 'producer input',
};

const fmtNum = (n: number, digits = 2): string => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n.toFixed(digits);
};

export const renderMarketBookPopup = (opts: MarketBookPopupOpts): MarketBookPopupContent | null => {
  const { world, settlementId, resource } = opts;
  const s = world.settlements.get(settlementId);
  if (s === undefined) return null;

  const root = document.createElement('div');
  root.appendChild(renderHeader(world, s, resource));
  root.appendChild(renderLadder(world, s, resource));

  return {
    element: root,
    title: `${String(resource)} — book at ${s.name}`,
  };
};

const renderHeader = (world: WorldState, s: Settlement, resource: ResourceId): HTMLElement => {
  const today = world.day;
  const lastPrice = s.market.lastClearingPrice.get(resource);
  const bestBid = s.market.bestBid.get(resource);
  const bestAsk = s.market.bestAsk.get(resource);
  const bidDepth = s.market.bidDepth.get(resource) ?? 0;
  const askDepth = s.market.askDepth.get(resource) ?? 0;
  const mid = s.market.midPrice.get(resource);
  const spread = s.market.spread.get(resource);
  const clearedDay = s.market.lastClearedDay.get(resource);
  const inflow = s.market.recentInflows.get(resource) ?? 0;
  const outflow = s.market.recentOutflows.get(resource) ?? 0;

  const lastTrade =
    clearedDay !== undefined
      ? today === clearedDay
        ? 'today'
        : `${today - clearedDay} day(s) ago`
      : '(no trade recorded — shadow quote)';

  const overview = popupKv([
    ['Last trade price', lastPrice !== undefined ? fmtNum(lastPrice) : '—'],
    ['Last trade day', lastTrade],
    ['Best bid', bestBid !== undefined ? `${fmtNum(bestBid)} (depth ${fmtNum(bidDepth)})` : '—'],
    ['Best ask', bestAsk !== undefined ? `${fmtNum(bestAsk)} (depth ${fmtNum(askDepth)})` : '—'],
    ['Spread', spread !== undefined ? fmtNum(spread) : '—'],
    ['Mid price', mid !== undefined ? fmtNum(mid) : '—'],
    ['Inflow (~30d)', fmtNum(inflow, 0)],
    ['Outflow (~30d)', fmtNum(outflow, 0)],
  ]);
  const section = popupSection('Book summary');
  section.appendChild(overview);
  return section;
};

const renderLadder = (world: WorldState, s: Settlement, resource: ResourceId): HTMLElement => {
  const section = popupSection('Book ladder');
  const ladder = s.market.bookLadder.get(resource);
  if (ladder === undefined || (ladder.asks.length === 0 && ladder.bids.length === 0)) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--muted)';
    empty.style.fontStyle = 'italic';
    empty.textContent = '(no residual quotes — market was fully crossed today, or no orders exist)';
    section.appendChild(empty);
    return section;
  }

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '1fr 1fr';
  grid.style.gap = '12px';
  grid.style.alignItems = 'start';

  // Bids (left): highest first.
  const bidPanel = document.createElement('div');
  const bidHeader = document.createElement('div');
  bidHeader.textContent = `Bids (${ladder.bids.length})`;
  bidHeader.style.color = '#7e9ec8';
  bidHeader.style.fontSize = '12px';
  bidHeader.style.fontWeight = '600';
  bidHeader.style.marginBottom = '4px';
  bidPanel.appendChild(bidHeader);
  bidPanel.appendChild(renderOrderTable(world, ladder.bids, 'bid'));
  grid.appendChild(bidPanel);

  // Asks (right): lowest first.
  const askPanel = document.createElement('div');
  const askHeader = document.createElement('div');
  askHeader.textContent = `Asks (${ladder.asks.length})`;
  askHeader.style.color = '#c89e7e';
  askHeader.style.fontSize = '12px';
  askHeader.style.fontWeight = '600';
  askHeader.style.marginBottom = '4px';
  askPanel.appendChild(askHeader);
  askPanel.appendChild(renderOrderTable(world, ladder.asks, 'ask'));
  grid.appendChild(askPanel);

  section.appendChild(grid);

  const note = document.createElement('div');
  note.style.color = 'var(--muted)';
  note.style.fontSize = '11px';
  note.style.marginTop = '8px';
  note.textContent =
    'Showing residual orders after today’s clearing — orders that did not match. Bids/asks are capped to 12 entries per side; full schedules are not persisted.';
  section.appendChild(note);

  return section;
};

const renderOrderTable = (
  world: WorldState,
  orders: ReadonlyArray<{
    readonly actorId: import('../../src/sim/types.js').ActorId;
    readonly actorKind: string;
    readonly price: number;
    readonly quantity: number;
    readonly curve?: string;
  }>,
  side: 'bid' | 'ask',
): HTMLElement => {
  const table = document.createElement('table');
  table.className = 'popup-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>Actor</th>
    <th class="num">Price</th>
    <th class="num">Qty</th>
    ${side === 'bid' ? '<th>Curve</th>' : ''}
  </tr>`;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const order of orders) {
    const tr = document.createElement('tr');
    const cActor = document.createElement('td');
    const actor = world.actors.get(order.actorId);
    const kindLabel = FACTION_LABELS[order.actorKind] ?? order.actorKind;
    cActor.textContent = actor !== undefined ? `${actor.name} (${kindLabel})` : kindLabel;
    cActor.style.fontSize = '11px';
    const cPrice = document.createElement('td');
    cPrice.className = 'num';
    cPrice.textContent = fmtNum(order.price);
    const cQty = document.createElement('td');
    cQty.className = 'num';
    cQty.textContent = fmtNum(order.quantity, 0);
    tr.appendChild(cActor);
    tr.appendChild(cPrice);
    tr.appendChild(cQty);
    if (side === 'bid') {
      const cCurve = document.createElement('td');
      cCurve.style.color = 'var(--muted)';
      cCurve.style.fontSize = '11px';
      cCurve.textContent =
        order.curve !== undefined ? (CURVE_LABELS[order.curve] ?? order.curve) : '—';
      tr.appendChild(cCurve);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
};
