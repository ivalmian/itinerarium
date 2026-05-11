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
import { hexDistance } from '../../src/sim/world/hex.js';
import type { Settlement } from '../../src/sim/world/settlement.js';
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
    if (tile.hasCoast) meta.innerHTML += ` · coast`;
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

    appendDeselect(root, opts.onClear);
  };

  return { update };
};

const appendDeselect = (host: HTMLElement, onClear: () => void): void => {
  const clearBtn = document.createElement('button');
  clearBtn.className = 'copy-btn';
  clearBtn.textContent = 'Deselect';
  clearBtn.style.marginTop = '6px';
  clearBtn.addEventListener('click', onClear);
  host.appendChild(clearBtn);
};
