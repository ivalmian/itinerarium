/**
 * Selected-hex inspection panel.
 *
 * Activated when the user clicks an empty hex (background of the map). Shows
 * the underlying tile data (terrain, climate, elevation, road grade,
 * roadWear), ownership chain, deposit (if any), discovered hidden feature,
 * the nearest settlement (computed on click + each refresh), and any
 * settlements anchored on this exact hex.
 *
 * This is read-only — hexes are not selectable entities in the sim model;
 * the panel just inspects the live grid tile + searches the settlement
 * registry for adjacencies. We deliberately don't cache anything here:
 * `update()` runs once per tick while the hex is selected, and most of the
 * computed fields (nearest-settlement, anchored-settlements) are O(N) over
 * the world's settlement count which is small in burn-in viewer territory
 * (~65 by default, capped well under a thousand).
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { Hex } from '../../src/sim/world/hex.js';
import { hexDistance, hexEquals } from '../../src/sim/world/hex.js';
import type { Settlement, SettlementBuilding } from '../../src/sim/world/settlement.js';
import { getBuilding } from '../../src/sim/buildings/catalog.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';

export interface HexPanel {
  update(world: WorldState): void;
}

export interface HexPanelOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly onClear: () => void;
}

interface NearestSettlement {
  readonly settlement: Settlement;
  readonly distanceHexes: number;
}

const findNearestSettlement = (world: WorldState, hex: Hex): NearestSettlement | null => {
  let best: NearestSettlement | null = null;
  for (const s of world.settlements.values()) {
    const d = hexDistance(s.anchor, hex);
    if (best === null || d < best.distanceHexes) {
      best = { settlement: s, distanceHexes: d };
    }
  }
  return best;
};

const findAnchoredSettlements = (
  world: WorldState,
  hex: Hex,
): readonly Settlement[] => {
  const out: Settlement[] = [];
  for (const s of world.settlements.values()) {
    if (s.anchor.q === hex.q && s.anchor.r === hex.r) {
      out.push(s);
    }
  }
  return out;
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const createHexPanel = (opts: HexPanelOpts): HexPanel => {
  const { host, state } = opts;
  const root = document.createElement('div');
  host.appendChild(root);

  const update = (world: WorldState): void => {
    if (state.selection.kind !== 'hex') {
      root.style.display = 'none';
      return;
    }
    const hex = state.selection.hex;
    const tile = world.grid.get(hex);
    root.style.display = '';
    root.innerHTML = '';

    const name = document.createElement('h4');
    name.className = 'entity-name';
    name.textContent = `Hex (${hex.q}, ${hex.r})`;
    root.appendChild(name);

    if (tile === undefined) {
      const meta = document.createElement('div');
      meta.style.color = 'var(--muted)';
      meta.style.fontSize = '11px';
      meta.textContent = 'off-map (no tile data)';
      root.appendChild(meta);
      appendDeselect(root, opts.onClear);
      return;
    }

    // Coords + terrain + climate + elevation block.
    const meta = document.createElement('div');
    meta.style.color = 'var(--muted)';
    meta.style.fontSize = '11px';
    meta.style.marginBottom = '6px';
    meta.innerHTML =
      `terrain: <span style="color:var(--text)">${escapeHtml(tile.terrain)}</span> · ` +
      `climate: <span style="color:var(--text)">${escapeHtml(tile.climate)}</span><br>` +
      `elevation: <span style="color:var(--text)">${Math.round(tile.elevation)} m</span>`;
    if (tile.hasRiver) meta.innerHTML += ` · river`;
    root.appendChild(meta);

    // Road / wear (key for the trail-wear feature).
    const roadRow = document.createElement('div');
    roadRow.className = 'stat-row';
    const rl = document.createElement('span');
    rl.className = 'label';
    rl.textContent = 'Road';
    const rv = document.createElement('span');
    rv.className = 'value';
    rv.textContent = `${tile.road} (wear ${Math.round(tile.roadWear ?? 0)})`;
    roadRow.appendChild(rl);
    roadRow.appendChild(rv);
    root.appendChild(roadRow);

    // Owner.
    const ownerRow = document.createElement('div');
    ownerRow.className = 'stat-row';
    const ol = document.createElement('span');
    ol.className = 'label';
    ol.textContent = 'Owner';
    const ov = document.createElement('span');
    ov.className = 'value';
    if (tile.ownerActor === null) {
      ov.textContent = 'wilderness';
      ov.style.color = 'var(--muted)';
      ov.style.fontStyle = 'italic';
    } else {
      const owner = world.actors.get(tile.ownerActor);
      ov.textContent = owner?.name ?? String(tile.ownerActor);
    }
    ownerRow.appendChild(ol);
    ownerRow.appendChild(ov);
    root.appendChild(ownerRow);

    // Deposit.
    if (tile.deposit !== undefined) {
      const depRow = document.createElement('div');
      depRow.className = 'stat-row';
      const dl = document.createElement('span');
      dl.className = 'label';
      dl.textContent = 'Deposit';
      const dv = document.createElement('span');
      dv.className = 'value';
      dv.textContent = `${String(tile.deposit.resource)} (${Math.round(
        tile.deposit.remaining,
      ).toLocaleString()})`;
      depRow.appendChild(dl);
      depRow.appendChild(dv);
      root.appendChild(depRow);
    }

    // Hidden feature (only if discovered).
    if (
      tile.hiddenFeature !== undefined &&
      tile.hiddenFeatureDiscovered === true
    ) {
      const hfRow = document.createElement('div');
      hfRow.className = 'stat-row';
      const hl = document.createElement('span');
      hl.className = 'label';
      hl.textContent = 'Hidden feature';
      const hv = document.createElement('span');
      hv.className = 'value';
      hv.textContent = tile.hiddenFeature;
      hfRow.appendChild(hl);
      hfRow.appendChild(hv);
      root.appendChild(hfRow);
    }

    // Nearest settlement (computed each refresh — settlement count is small).
    const nearest = findNearestSettlement(world, hex);
    if (nearest !== null) {
      const nrRow = document.createElement('div');
      nrRow.className = 'stat-row';
      const nl = document.createElement('span');
      nl.className = 'label';
      nl.textContent = 'Nearest settlement';
      const nv = document.createElement('span');
      nv.className = 'value';
      nv.textContent = `${nearest.settlement.name} (${nearest.distanceHexes} km)`;
      nrRow.appendChild(nl);
      nrRow.appendChild(nv);
      root.appendChild(nrRow);
    }

    // Settlements anchored ON this hex.
    const anchored = findAnchoredSettlements(world, hex);
    if (anchored.length > 0) {
      const anchorHeader = document.createElement('div');
      anchorHeader.style.color = 'var(--muted)';
      anchorHeader.style.marginTop = '6px';
      anchorHeader.textContent =
        anchored.length === 1 ? 'Settlement on this hex:' : 'Settlements on this hex:';
      root.appendChild(anchorHeader);
      const list = document.createElement('div');
      for (const s of anchored) {
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = `${s.name} (${s.tier}, pop ${s.population.total().toLocaleString()})`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'settlement', id: s.id });
        });
        list.appendChild(link);
      }
      root.appendChild(list);
    }

    // Settlements containing this hex (urban or catchment, but not anchor —
    // anchor is already covered above).
    const containing = findContainingSettlements(world, hex, anchored);
    if (containing.length > 0) {
      const h = document.createElement('div');
      h.style.color = 'var(--muted)';
      h.style.marginTop = '6px';
      h.textContent =
        containing.length === 1
          ? 'Part of settlement (catchment/urban):'
          : 'Part of settlements (catchment/urban):';
      root.appendChild(h);
      const list = document.createElement('div');
      for (const { s, role } of containing) {
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = `${s.name} (${role})`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'settlement', id: s.id });
        });
        list.appendChild(link);
      }
      root.appendChild(list);
    }

    // Buildings standing on this hex (icons in the buildings layer).
    const buildings = findBuildingsOnHex(world, hex);
    if (buildings.length > 0) {
      const h = document.createElement('div');
      h.style.color = 'var(--muted)';
      h.style.marginTop = '6px';
      h.textContent = buildings.length === 1 ? 'Building:' : `Buildings (${buildings.length}):`;
      root.appendChild(h);
      const list = document.createElement('div');
      list.style.fontSize = '11px';
      for (const { b, settlement } of buildings) {
        const def = getBuilding(b.buildingId);
        const owner = world.actors.get(b.ownerActor);
        const ownerName = owner?.name ?? '(unknown)';
        const row = document.createElement('div');
        row.style.marginBottom = '2px';
        row.innerHTML =
          `· <span style="color:var(--text)">${escapeHtml(def.name)}</span>` +
          ` (cap ${b.capacity}) — owned by ${escapeHtml(ownerName)}` +
          `, in ${escapeHtml(settlement.name)}`;
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    // Pending construction on this hex.
    const pending = findPendingBuildingsOnHex(world, hex);
    if (pending.length > 0) {
      const h = document.createElement('div');
      h.style.color = 'var(--muted)';
      h.style.marginTop = '6px';
      h.textContent = `Under construction (${pending.length}):`;
      root.appendChild(h);
      const list = document.createElement('div');
      list.style.fontSize = '11px';
      for (const { pb, settlement } of pending) {
        const def = getBuilding(pb.buildingId);
        const pct = Math.round(
          (1 - pb.workerDaysRemaining / Math.max(1, pb.workerDaysTotal)) * 100,
        );
        const row = document.createElement('div');
        row.textContent = `· ${def.name} — ${pct}% built (${pb.workerDaysRemaining.toFixed(0)} worker-days left), in ${settlement.name}`;
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    // Pending demolition.
    const demos = findPendingDemolitionsOnHex(world, hex);
    if (demos.length > 0) {
      const h = document.createElement('div');
      h.style.color = 'var(--muted)';
      h.style.marginTop = '6px';
      h.textContent = 'Being demolished:';
      root.appendChild(h);
      for (const { pd, settlement } of demos) {
        const row = document.createElement('div');
        row.style.fontSize = '11px';
        row.textContent = `· ${getBuilding(pd.buildingId).name} (${pd.workerDaysRemaining.toFixed(0)} worker-days left), in ${settlement.name}`;
        root.appendChild(row);
      }
    }

    // Bandit camp on this hex.
    if (world.banditCamps !== undefined) {
      for (const camp of world.banditCamps.values()) {
        if (!hexEquals(camp.hex, hex)) continue;
        const h = document.createElement('div');
        h.style.color = 'var(--muted)';
        h.style.marginTop = '6px';
        h.textContent = 'Bandit camp:';
        root.appendChild(h);
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = `${camp.name} — ${camp.banditCount} bandits`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'bandit_camp', id: camp.id });
        });
        root.appendChild(link);
      }
    }

    // Caravans + patrols + news carriers physically here right now.
    const caravansHere = [];
    for (const c of world.caravans.values()) {
      if (!hexEquals(c.position, hex)) continue;
      const owner = world.actors.get(c.ownerActor);
      caravansHere.push({
        id: c.id,
        label: `${owner?.name ?? String(c.ownerActor)}'s caravan (${c.crew.reduce((s, m) => s + m.count, 0)} crew)`,
      });
    }
    if (caravansHere.length > 0) {
      const h = document.createElement('div');
      h.style.color = 'var(--muted)';
      h.style.marginTop = '6px';
      h.textContent = `Caravans here (${caravansHere.length}):`;
      root.appendChild(h);
      for (const c of caravansHere) {
        // Clickable button so the user can route from a hex to its caravan
        // panel the same way settlement and bandit-camp links work.
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = c.label;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'caravan', id: c.id });
        });
        root.appendChild(link);
      }
    }

    const patrolsHere = [];
    if (world.patrols !== undefined) {
      for (const p of world.patrols.values()) {
        if (hexEquals(p.position, hex)) patrolsHere.push(p);
      }
    }
    const newsCarriersHere = [];
    if (world.newsCarriers !== undefined) {
      for (const n of world.newsCarriers.values()) {
        if (hexEquals(n.position, hex)) newsCarriersHere.push(n);
      }
    }
    const banditPartiesHere = [];
    if (world.banditParties !== undefined) {
      for (const p of world.banditParties.values()) {
        if (p.phase === 'done') continue;
        if (hexEquals(p.position, hex)) banditPartiesHere.push(p);
      }
    }
    if (patrolsHere.length > 0 || newsCarriersHere.length > 0 || banditPartiesHere.length > 0) {
      const h = document.createElement('div');
      h.style.color = 'var(--muted)';
      h.style.marginTop = '6px';
      h.textContent = 'Other units here:';
      root.appendChild(h);
      for (const p of patrolsHere) {
        const base = world.settlements.get(p.basedAt);
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = `patrol from ${base?.name ?? '?'} (${p.unit.count} soldiers)`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'patrol', id: p.id });
        });
        root.appendChild(link);
      }
      for (const n of newsCarriersHere) {
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = `news carrier (started d${n.carrying.occurredOnDay})`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'news_carrier', id: n.id });
        });
        root.appendChild(link);
      }
      for (const p of banditPartiesHere) {
        const home = p.homeCamp !== null ? world.banditCamps?.get(p.homeCamp) : undefined;
        const link = document.createElement('button');
        link.className = 'copy-btn';
        link.style.marginRight = '4px';
        link.style.marginBottom = '2px';
        link.textContent = home !== undefined
          ? `${home.name}'s raid party (${p.banditCount} bandits)`
          : `bandit party (${p.banditCount} bandits)`;
        link.addEventListener('click', () => {
          setSelection(state, { kind: 'bandit_party', id: p.id });
        });
        root.appendChild(link);
      }
    }

    appendDeselect(root, opts.onClear);
  };

  return { update };
};

const findContainingSettlements = (
  world: WorldState,
  hex: Hex,
  alreadyAnchored: readonly Settlement[],
): readonly { s: Settlement; role: 'urban' | 'catchment' }[] => {
  const out: { s: Settlement; role: 'urban' | 'catchment' }[] = [];
  const anchorIds = new Set(alreadyAnchored.map((s) => String(s.id)));
  for (const s of world.settlements.values()) {
    if (anchorIds.has(String(s.id))) continue;
    if (s.urbanHexes.some((u) => hexEquals(u, hex))) {
      out.push({ s, role: 'urban' });
      continue;
    }
    if (s.catchmentHexes.some((c) => hexEquals(c, hex))) {
      out.push({ s, role: 'catchment' });
    }
  }
  return out;
};

const findBuildingsOnHex = (
  world: WorldState,
  hex: Hex,
): readonly { b: SettlementBuilding; settlement: Settlement }[] => {
  const out: { b: SettlementBuilding; settlement: Settlement }[] = [];
  for (const s of world.settlements.values()) {
    for (const b of s.buildings) {
      if (hexEquals(b.hex, hex)) out.push({ b, settlement: s });
    }
  }
  return out;
};

const findPendingBuildingsOnHex = (
  world: WorldState,
  hex: Hex,
): readonly { pb: Settlement['pendingBuildings'][number]; settlement: Settlement }[] => {
  const out: { pb: Settlement['pendingBuildings'][number]; settlement: Settlement }[] = [];
  for (const s of world.settlements.values()) {
    for (const pb of s.pendingBuildings) {
      if (hexEquals(pb.hex, hex)) out.push({ pb, settlement: s });
    }
  }
  return out;
};

const findPendingDemolitionsOnHex = (
  world: WorldState,
  hex: Hex,
): readonly { pd: Settlement['pendingDemolitions'][number]; settlement: Settlement }[] => {
  const out: { pd: Settlement['pendingDemolitions'][number]; settlement: Settlement }[] = [];
  for (const s of world.settlements.values()) {
    for (const pd of s.pendingDemolitions) {
      if (hexEquals(pd.hex, hex)) out.push({ pd, settlement: s });
    }
  }
  return out;
};

const appendDeselect = (host: HTMLElement, onClear: () => void): void => {
  const clearBtn = document.createElement('button');
  clearBtn.className = 'copy-btn';
  clearBtn.textContent = 'Deselect';
  clearBtn.style.marginTop = '6px';
  clearBtn.addEventListener('click', onClear);
  host.appendChild(clearBtn);
};
