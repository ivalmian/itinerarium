/**
 * Faction screen — modal popup that inspects one Faction at a time.
 *
 * Per the design (no hidden hands; docs/11 + docs/13): every reputation
 * relationship, every owned settlement, every owned building/caravan belongs
 * to a named actor. The faction screen is the inspector that walks that
 * graph for one faction: identity, leadership, holdings, and the directional
 * reputation table to every OTHER faction.
 *
 * Reputation lookups go through world.reputation, which is keyed by Actor /
 * Character ids (not Faction ids). For faction-to-faction reputation we
 * look up `world.reputation.get(thisFaction.actor, otherFaction.actor)`.
 *
 * UI is a self-contained DOM tree appended to a host element (typically
 * document.body). Visibility is controlled by toggling .visible on the
 * backdrop. The screen does NOT subscribe to ticks — it snapshots on open
 * and on re-target (clicking a faction-link inside the rep table re-renders
 * for that faction). This is intentional: it's an "open a window on the
 * world" affordance, not a live monitor.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type {
  ActorId,
  CaravanId,
  CharacterId,
  FactionId,
  ResourceId,
  SettlementId,
} from '../../src/sim/types.js';
import type { Faction } from '../../src/sim/politics/faction.js';
import type { Actor } from '../../src/sim/politics/actor.js';
import type { NamedCharacter } from '../../src/sim/politics/character.js';
import type { ViewerState } from '../state/viewerState.js';
import { setSelection } from '../state/viewerState.js';

export interface FactionScreen {
  openForFaction(id: FactionId): void;
  close(): void;
  /** Re-render with the latest world data (called after each sim tick). */
  refresh(world: WorldState): void;
  /** True iff currently open. */
  isOpen(): boolean;
}

export interface FactionScreenOpts {
  readonly host: HTMLElement;
  readonly state: ViewerState;
  readonly getWorld: () => WorldState;
  /** Called when the screen closes (so the parent can clear the selection). */
  readonly onClose: () => void;
}

const FACTION_TYPE_LABELS: Record<string, string> = {
  patrician_family: 'Patrician family',
  free_village: 'Free village council',
  // docs/15 §C21: per-class household disaggregation.
  plebeian_household: 'Plebeian households',
  freedman_household: 'Freedman households',
  foreigner_household: 'Foreigner households',
  hamlet_household: 'Hamlet household',
  governor_office: "Governor's office",
  temple: 'Temple',
  bandit_camp: 'Bandit band',
  caravan_owner: 'Caravan house',
  player: 'Player',
  off_map_house: 'Off-map house',
  city_corporation: 'City corporation',
  merchant_guild: 'Merchant guild',
};

export const createFactionScreen = (opts: FactionScreenOpts): FactionScreen => {
  const { host, state, getWorld, onClose } = opts;

  // Build the modal skeleton lazily once; reuse on every open.
  const backdrop = document.createElement('div');
  backdrop.className = 'faction-screen-backdrop';
  backdrop.style.display = 'none';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const panel = document.createElement('div');
  panel.className = 'faction-screen-panel';
  backdrop.appendChild(panel);

  // Close on backdrop click (but NOT on panel-internal clicks).
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) requestClose();
  });

  host.appendChild(backdrop);

  let currentId: FactionId | null = null;

  const requestClose = (): void => {
    if (currentId === null) return;
    currentId = null;
    backdrop.style.display = 'none';
    onClose();
  };

  // Escape key handler — only active while open.
  const onKeydown = (e: KeyboardEvent): void => {
    if (currentId === null) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    }
  };
  window.addEventListener('keydown', onKeydown, true);

  const openForFaction = (id: FactionId): void => {
    currentId = id;
    backdrop.style.display = 'flex';
    render();
  };

  const close = (): void => {
    requestClose();
  };

  const refresh = (_world: WorldState): void => {
    if (currentId !== null) render();
  };

  const isOpen = (): boolean => currentId !== null;

  const render = (): void => {
    if (currentId === null) return;
    const world = getWorld();
    const faction = world.factions.get(currentId);
    panel.innerHTML = '';
    if (faction === undefined) {
      renderMissing(panel, currentId, requestClose);
      return;
    }
    renderFaction(panel, world, faction, state, openForFaction, requestClose);
  };

  return { openForFaction, close, refresh, isOpen };
};

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const renderMissing = (panel: HTMLElement, id: FactionId, onClose: () => void): void => {
  const h = document.createElement('h2');
  h.className = 'faction-screen-title';
  h.textContent = 'Faction not found';
  panel.appendChild(h);
  const sub = document.createElement('div');
  sub.className = 'faction-screen-muted';
  sub.textContent = `Faction id ${String(id)} no longer exists in the world.`;
  panel.appendChild(sub);
  panel.appendChild(makeCloseButton(onClose));
};

const renderFaction = (
  panel: HTMLElement,
  world: WorldState,
  faction: Faction,
  state: ViewerState,
  openForFaction: (id: FactionId) => void,
  onClose: () => void,
): void => {
  const actor = world.actors.get(faction.actor);
  panel.appendChild(makeHeader(world, faction, actor, state, onClose));
  panel.appendChild(makeLeadershipSection(world, faction));
  panel.appendChild(makeAssetsSection(world, faction, actor, state));
  panel.appendChild(makeReputationSection(world, faction, openForFaction));
  panel.appendChild(makeFooter(onClose));
};

const makeHeader = (
  world: WorldState,
  faction: Faction,
  actor: Actor | undefined,
  state: ViewerState,
  onClose: () => void,
): HTMLElement => {
  const header = document.createElement('div');
  header.className = 'faction-screen-header';

  const titleRow = document.createElement('div');
  titleRow.className = 'faction-screen-title-row';

  const title = document.createElement('h2');
  title.className = 'faction-screen-title';
  title.textContent = faction.name;
  titleRow.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'faction-screen-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close faction screen');
  closeBtn.addEventListener('click', onClose);
  titleRow.appendChild(closeBtn);

  header.appendChild(titleRow);

  // Subtitle: type + HQ settlement.
  const sub = document.createElement('div');
  sub.className = 'faction-screen-subtitle';
  const typeLabel =
    actor === undefined ? 'unknown type' : (FACTION_TYPE_LABELS[actor.kind] ?? actor.kind);
  const hq =
    actor !== undefined && actor.homeSettlement !== undefined
      ? world.settlements.get(actor.homeSettlement)
      : undefined;
  if (hq !== undefined) {
    const sNode = document.createElement('span');
    sNode.textContent = `${typeLabel} · HQ `;
    sub.appendChild(sNode);
    const hqLink = document.createElement('button');
    hqLink.className = 'faction-screen-inline-link';
    hqLink.textContent = `${hq.name} (${hq.tier})`;
    hqLink.addEventListener('click', () => {
      setSelection(state, { kind: 'settlement', id: hq.id });
      onClose();
    });
    sub.appendChild(hqLink);
  } else {
    sub.textContent = `${typeLabel} · no anchor settlement`;
  }
  header.appendChild(sub);

  // Controlling-actor line: name + kind. Useful for debugging the mapping.
  if (actor !== undefined) {
    const ctrl = document.createElement('div');
    ctrl.className = 'faction-screen-muted';
    ctrl.textContent = `Controlling actor: ${actor.name}`;
    header.appendChild(ctrl);
  }

  return header;
};

const makeLeadershipSection = (world: WorldState, faction: Faction): HTMLElement => {
  const section = makeSection('Leadership');
  if (faction.members.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'faction-screen-muted';
    empty.textContent = '(no named members)';
    section.appendChild(empty);
    return section;
  }
  // Resolve to NamedCharacter and rank: patriarch/elder/headman/governor at top.
  type Resolved = { id: CharacterId; c: NamedCharacter | undefined };
  const resolved: Resolved[] = faction.members.map((id) => ({ id, c: world.characters.get(id) }));

  const roleRank = (c: NamedCharacter | undefined): number => {
    if (c === undefined) return 99;
    switch (c.role) {
      case 'patriarch':
      case 'governor':
      case 'headman':
      case 'bandit_leader':
        return 0;
      case 'elder':
      case 'lieutenant':
      case 'magistrate':
      case 'watch_captain':
        return 1;
      case 'merchant':
      case 'priest':
      case 'patrol_officer':
        return 2;
      default:
        return 3;
    }
  };
  resolved.sort((a, b) => roleRank(a.c) - roleRank(b.c));

  const list = document.createElement('div');
  list.className = 'faction-screen-leadership';
  for (const { id, c } of resolved) {
    const row = document.createElement('div');
    row.className = 'faction-screen-member';
    if (c === undefined) {
      const name = document.createElement('span');
      name.className = 'faction-screen-member-name faction-screen-muted';
      name.textContent = `(unknown ${String(id).slice(-8)})`;
      row.appendChild(name);
    } else {
      const name = document.createElement('span');
      name.className = 'faction-screen-member-name';
      const leader =
        c.role === 'patriarch' ||
        c.role === 'governor' ||
        c.role === 'headman' ||
        c.role === 'bandit_leader';
      if (leader) name.classList.add('faction-screen-member-leader');
      name.textContent = c.name;
      row.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'faction-screen-member-meta';
      const role = c.role !== undefined ? `${c.role}` : 'member';
      const status = c.status !== 'alive' ? ` · ${c.status}` : '';
      meta.textContent = ` — ${role} · age ${c.age}${status}`;
      row.appendChild(meta);
    }
    list.appendChild(row);
  }
  section.appendChild(list);
  return section;
};

const makeAssetsSection = (
  world: WorldState,
  faction: Faction,
  actor: Actor | undefined,
  state: ViewerState,
): HTMLElement => {
  const section = makeSection('Owned assets');

  // Treasury.
  const treasuryRow = document.createElement('div');
  treasuryRow.className = 'stat-row';
  const tL = document.createElement('span');
  tL.className = 'label';
  tL.textContent = 'Treasury';
  treasuryRow.appendChild(tL);
  const tV = document.createElement('span');
  tV.className = 'value';
  tV.textContent =
    actor === undefined ? '—' : `${Math.round(actor.treasury).toLocaleString()} coin`;
  treasuryRow.appendChild(tV);
  section.appendChild(treasuryRow);

  // Stockpile.
  const stockHeader = document.createElement('div');
  stockHeader.className = 'faction-screen-subhead';
  stockHeader.textContent = 'Stockpile';
  section.appendChild(stockHeader);
  // Per docs/15 §C30: collapse the actor's per-settlement slices into a
  // total view for the faction screen (most actors home to one settlement
  // anyway). For multi-location actors we sum across — they'd see the
  // settlement breakdown in a future drill-down view.
  const totals = new Map<ResourceId, number>();
  if (actor !== undefined) {
    for (const slice of actor.stockpile.values()) {
      for (const [r, q] of slice) {
        totals.set(r, (totals.get(r) ?? 0) + q);
      }
    }
  }
  if (actor === undefined || totals.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'faction-screen-muted';
    empty.textContent = '(empty)';
    section.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'stocklist faction-screen-stocklist';
    const sorted = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    for (const [r, qty] of sorted) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = String(r);
      const v = document.createElement('span');
      v.className = 'value';
      v.textContent = qty >= 1000 ? `${(qty / 1000).toFixed(1)}k` : Math.round(qty).toString();
      row.appendChild(l);
      row.appendChild(v);
      list.appendChild(row);
    }
    section.appendChild(list);
  }

  // Settlements where this faction is listed.
  const settlements: { id: SettlementId; name: string; tier: string }[] = [];
  for (const s of world.settlements.values()) {
    if (s.factions.includes(faction.id)) {
      settlements.push({ id: s.id, name: s.name, tier: s.tier });
    }
  }
  const sHead = document.createElement('div');
  sHead.className = 'faction-screen-subhead';
  sHead.textContent = `Settlements (${settlements.length})`;
  section.appendChild(sHead);
  if (settlements.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'faction-screen-muted';
    empty.textContent = '(none)';
    section.appendChild(empty);
  } else {
    const sList = document.createElement('div');
    sList.className = 'faction-screen-chiplist';
    for (const s of settlements) {
      const chip = document.createElement('button');
      chip.className = 'faction-screen-chip';
      chip.textContent = `${s.name} (${s.tier})`;
      chip.addEventListener('click', () => {
        setSelection(state, { kind: 'settlement', id: s.id });
      });
      sList.appendChild(chip);
    }
    section.appendChild(sList);
  }

  // Buildings owned (count across all settlements).
  let buildingCount = 0;
  if (actor !== undefined) {
    for (const s of world.settlements.values()) {
      for (const b of s.buildings) {
        if (b.ownerActor === actor.id) buildingCount += 1;
      }
    }
  }
  const bRow = document.createElement('div');
  bRow.className = 'stat-row';
  const bL = document.createElement('span');
  bL.className = 'label';
  bL.textContent = 'Buildings';
  bRow.appendChild(bL);
  const bV = document.createElement('span');
  bV.className = 'value';
  bV.textContent = String(buildingCount);
  bRow.appendChild(bV);
  section.appendChild(bRow);

  // Caravans owned.
  const ownedCaravans: { id: CaravanId; q: number; r: number; destQ?: number; destR?: number }[] =
    [];
  if (actor !== undefined) {
    for (const c of world.caravans.values()) {
      if (c.ownerActor === actor.id) {
        ownedCaravans.push({
          id: c.id,
          q: c.position.q,
          r: c.position.r,
          ...(c.destination !== undefined && c.destination !== null
            ? { destQ: c.destination.q, destR: c.destination.r }
            : {}),
        });
      }
    }
  }
  const cHead = document.createElement('div');
  cHead.className = 'faction-screen-subhead';
  cHead.textContent = `Caravans (${ownedCaravans.length})`;
  section.appendChild(cHead);
  if (ownedCaravans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'faction-screen-muted';
    empty.textContent = '(none)';
    section.appendChild(empty);
  } else {
    const cList = document.createElement('div');
    cList.className = 'faction-screen-caravans';
    for (const c of ownedCaravans.slice(0, 10)) {
      const row = document.createElement('button');
      row.className = 'faction-screen-caravan-row';
      const dest = c.destQ !== undefined && c.destR !== undefined ? `(${c.destQ},${c.destR})` : '—';
      row.textContent = `${String(c.id).slice(-8)} · (${c.q},${c.r}) → ${dest}`;
      row.addEventListener('click', () => {
        setSelection(state, { kind: 'caravan', id: c.id });
      });
      cList.appendChild(row);
    }
    if (ownedCaravans.length > 10) {
      const more = document.createElement('div');
      more.className = 'faction-screen-muted';
      more.textContent = `… and ${ownedCaravans.length - 10} more`;
      cList.appendChild(more);
    }
    section.appendChild(cList);
  }

  return section;
};

interface RepRow {
  readonly other: Faction;
  readonly outgoing: number;
  readonly incoming: number;
  readonly maxAbs: number;
}

const makeReputationSection = (
  world: WorldState,
  faction: Faction,
  openForFaction: (id: FactionId) => void,
): HTMLElement => {
  const section = makeSection('Reputation');

  const rows: RepRow[] = [];
  for (const other of world.factions.values()) {
    if (other.id === faction.id) continue;
    const outgoing = world.reputation.get(faction.actor, other.actor);
    const incoming = world.reputation.get(other.actor, faction.actor);
    if (outgoing === 0 && incoming === 0) continue;
    const maxAbs = Math.max(Math.abs(outgoing), Math.abs(incoming));
    rows.push({ other, outgoing, incoming, maxAbs });
  }
  rows.sort((a, b) => b.maxAbs - a.maxAbs);

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'faction-screen-muted';
    empty.textContent = '(no recorded reputation with any other faction)';
    section.appendChild(empty);
    const total = document.createElement('div');
    total.className = 'faction-screen-muted faction-screen-rep-meta';
    total.textContent = `${world.factions.size - 1} other factions in the world.`;
    section.appendChild(total);
    return section;
  }

  // Header row.
  const head = document.createElement('div');
  head.className = 'faction-screen-rep-head';
  const hF = document.createElement('span');
  hF.className = 'faction-screen-rep-col-name';
  hF.textContent = 'Faction';
  head.appendChild(hF);
  const hOut = document.createElement('span');
  hOut.className = 'faction-screen-rep-col-bar';
  hOut.textContent = '→ them';
  head.appendChild(hOut);
  const hIn = document.createElement('span');
  hIn.className = 'faction-screen-rep-col-bar';
  hIn.textContent = '← from them';
  head.appendChild(hIn);
  section.appendChild(head);

  for (const row of rows) {
    section.appendChild(makeRepRow(row, openForFaction));
  }
  const total = document.createElement('div');
  total.className = 'faction-screen-muted faction-screen-rep-meta';
  total.textContent = `${rows.length} of ${world.factions.size - 1} other factions have non-zero relations.`;
  section.appendChild(total);

  return section;
};

const makeRepRow = (row: RepRow, openForFaction: (id: FactionId) => void): HTMLElement => {
  const r = document.createElement('div');
  r.className = 'faction-screen-rep-row';

  const nameCell = document.createElement('span');
  nameCell.className = 'faction-screen-rep-col-name';
  const link = document.createElement('button');
  link.className = 'faction-screen-inline-link';
  link.textContent = row.other.name;
  link.title = 'Open this faction';
  link.addEventListener('click', () => openForFaction(row.other.id));
  nameCell.appendChild(link);
  r.appendChild(nameCell);

  r.appendChild(makeRepBar(row.outgoing));
  r.appendChild(makeRepBar(row.incoming));

  return r;
};

const makeRepBar = (value: number): HTMLElement => {
  const cell = document.createElement('span');
  cell.className = 'faction-screen-rep-col-bar';

  const track = document.createElement('span');
  track.className = 'faction-screen-rep-bar-track';

  const fill = document.createElement('span');
  fill.className = 'faction-screen-rep-bar-fill';
  // value in [-1, +1]; bar spans 50% from center either direction.
  const clamped = Math.max(-1, Math.min(1, value));
  const pct = Math.abs(clamped) * 50;
  if (clamped >= 0) {
    fill.style.left = '50%';
    fill.style.width = `${pct}%`;
    fill.style.background = clamped === 0 ? 'var(--muted)' : 'var(--good)';
  } else {
    fill.style.left = `${50 - pct}%`;
    fill.style.width = `${pct}%`;
    fill.style.background = 'var(--bad)';
  }
  track.appendChild(fill);
  cell.appendChild(track);

  const num = document.createElement('span');
  num.className = 'faction-screen-rep-bar-num';
  num.textContent = value === 0 ? '0' : value.toFixed(2);
  if (value > 0) num.style.color = 'var(--good)';
  else if (value < 0) num.style.color = 'var(--bad)';
  else num.style.color = 'var(--muted)';
  cell.appendChild(num);

  return cell;
};

const makeFooter = (onClose: () => void): HTMLElement => {
  const footer = document.createElement('div');
  footer.className = 'faction-screen-footer';
  footer.appendChild(makeCloseButton(onClose));
  const hint = document.createElement('span');
  hint.className = 'faction-screen-muted';
  hint.textContent = ' Esc closes';
  footer.appendChild(hint);
  return footer;
};

const makeCloseButton = (onClose: () => void): HTMLElement => {
  const btn = document.createElement('button');
  btn.className = 'copy-btn faction-screen-close-btn';
  btn.textContent = 'Close';
  btn.addEventListener('click', onClose);
  return btn;
};

const makeSection = (title: string): HTMLElement => {
  const root = document.createElement('div');
  root.className = 'faction-screen-section';
  const h = document.createElement('h3');
  h.className = 'faction-screen-section-title';
  h.textContent = title;
  root.appendChild(h);
  return root;
};

// Lookup helper used by panels that have an owner-actor and want to know if
// the actor backs a Faction (i.e. whether to render a clickable link or just
// plain text).
export const findFactionByActor = (world: WorldState, actorId: ActorId): Faction | undefined => {
  for (const f of world.factions.values()) {
    if (f.actor === actorId) return f;
  }
  return undefined;
};
