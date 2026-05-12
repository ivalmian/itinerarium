/**
 * Shared helpers for rendering clickable named-entity links throughout
 * the viewer's UI. Every place that used to print a raw branded id
 * (caravan id, settlement id, bandit camp id, actor id) should go
 * through here so the player sees the entity's human name and can
 * navigate to it by clicking.
 *
 * Per docs/00-pillars `no hidden hands` — the player sees identifiable
 * people, not opaque ids.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type {
  ActorId,
  BanditCampId,
  BanditPartyId,
  CaravanId,
  Position,
  SettlementId,
} from '../../src/sim/types.js';
import type { Hex } from '../../src/sim/world/hex.js';
import { setSelection, type ViewerState } from '../state/viewerState.js';

// --- Name lookup -----------------------------------------------------------

export const settlementName = (world: WorldState, id: SettlementId): string =>
  world.settlements.get(id)?.name ?? `(unknown settlement)`;

export const banditCampName = (world: WorldState, id: BanditCampId): string =>
  world.banditCamps?.get(id)?.name ?? `(unknown camp)`;

export const actorName = (world: WorldState, id: ActorId): string =>
  world.actors.get(id)?.name ?? `(unknown actor)`;

/**
 * Caravans don't have their own name field — they're identified by
 * "{owner-name}'s caravan". Falls back to the actor id if the owner has
 * vanished from the world.
 */
export const caravanLabel = (world: WorldState, id: CaravanId): string => {
  const c = world.caravans.get(id);
  if (c === undefined) return `(former caravan)`;
  const owner = world.actors.get(c.ownerActor);
  if (owner === undefined) return `caravan`;
  return `${owner.name}'s caravan`;
};

export const banditPartyLabel = (world: WorldState, id: BanditPartyId): string => {
  const p = world.banditParties?.get(id);
  if (p === undefined) return `(former bandit party)`;
  const home = p.homeCamp !== null ? world.banditCamps?.get(p.homeCamp) : undefined;
  if (home !== undefined) return `${home.name}'s raid party`;
  return `bandit party`;
};

/** First settlement anchored at the given hex, if any. */
export const findSettlementAtHex = (
  world: WorldState,
  hex: Position,
): { id: SettlementId; name: string } | null => {
  for (const s of world.settlements.values()) {
    if (s.anchor.q === hex.q && s.anchor.r === hex.r) {
      return { id: s.id, name: s.name };
    }
  }
  return null;
};

/** First bandit camp at the given hex, if any. */
export const findBanditCampAtHex = (
  world: WorldState,
  hex: Position,
): { id: BanditCampId; name: string } | null => {
  if (world.banditCamps === undefined) return null;
  for (const c of world.banditCamps.values()) {
    if (c.hex.q === hex.q && c.hex.r === hex.r) {
      return { id: c.id, name: c.name };
    }
  }
  return null;
};

// --- Link builders ---------------------------------------------------------

const baseLink = (label: string, onClick: () => void): HTMLButtonElement => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'popup-link';
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
};

export const settlementLink = (
  world: WorldState,
  state: ViewerState,
  id: SettlementId,
  labelOverride?: string,
): HTMLButtonElement =>
  baseLink(labelOverride ?? settlementName(world, id), () => {
    setSelection(state, { kind: 'settlement', id });
  });

export const caravanLink = (
  world: WorldState,
  state: ViewerState,
  id: CaravanId,
  labelOverride?: string,
): HTMLButtonElement =>
  baseLink(labelOverride ?? caravanLabel(world, id), () => {
    setSelection(state, { kind: 'caravan', id });
  });

export const banditCampLink = (
  world: WorldState,
  state: ViewerState,
  id: BanditCampId,
  labelOverride?: string,
): HTMLButtonElement =>
  baseLink(labelOverride ?? banditCampName(world, id), () => {
    setSelection(state, { kind: 'bandit_camp', id });
  });

export const banditPartyLink = (
  world: WorldState,
  state: ViewerState,
  id: BanditPartyId,
  labelOverride?: string,
): HTMLButtonElement =>
  baseLink(labelOverride ?? banditPartyLabel(world, id), () => {
    setSelection(state, { kind: 'bandit_party', id });
  });

/**
 * Show a hex in human terms: if there's a settlement anchored there,
 * a clickable settlement link; if there's a bandit camp there, a camp
 * link; otherwise fall back to coordinates.
 */
export const hexDestinationNode = (
  world: WorldState,
  state: ViewerState,
  hex: Hex,
): Node => {
  const s = findSettlementAtHex(world, hex);
  if (s !== null) return settlementLink(world, state, s.id);
  const camp = findBanditCampAtHex(world, hex);
  if (camp !== null) return banditCampLink(world, state, camp.id);
  // Wilderness — make the hex coords themselves a clickable target so
  // the player can still inspect the tile.
  return baseLink(`hex (${hex.q}, ${hex.r})`, () => {
    setSelection(state, { kind: 'hex', hex });
  });
};

// --- Trip-origin lookup ----------------------------------------------------

/**
 * Cheap reverse lookup: is this hex the anchor of a settlement?
 * Linear over `world.settlements` which is small at viewer scale (<300).
 */
const settlementAtHex = (
  world: WorldState,
  hex: { q: number; r: number },
): SettlementId | null => {
  for (const s of world.settlements.values()) {
    if (s.anchor.q === hex.q && s.anchor.r === hex.r) return s.id;
  }
  return null;
};

const banditCampAtHex = (
  world: WorldState,
  hex: { q: number; r: number },
): BanditCampId | null => {
  if (world.banditCamps === undefined) return null;
  for (const c of world.banditCamps.values()) {
    if (c.hex.q === hex.q && c.hex.r === hex.r) return c.id;
  }
  return null;
};

export type TripOrigin =
  | { readonly kind: 'settlement'; readonly id: SettlementId; readonly hex: { q: number; r: number } }
  | { readonly kind: 'camp'; readonly id: BanditCampId; readonly hex: { q: number; r: number } }
  | { readonly kind: 'hex'; readonly hex: { q: number; r: number } };

/**
 * Where the caravan's current leg started. Scans backward through the
 * viewer history's per-caravan position snapshots looking for the most
 * recent hex that's NOT the current position — preferring named
 * places (settlement anchors / bandit camp hexes) over wilderness.
 *
 * Per the user's framing: "A→B→C, on the B→C leg the line reads 'from
 * B to C'." We don't claim the owner's home as origin — the origin is
 * literally where this leg began.
 */
export const findTripOrigin = (
  world: WorldState,
  history: import('../state/history.js').ViewerHistory,
  caravan: { id: import('../../src/sim/types.js').CaravanId; position: { q: number; r: number } },
): TripOrigin | null => {
  const buf = history.caravans.get(caravan.id);
  if (buf === undefined || buf.length === 0) return null;
  const curQ = caravan.position.q;
  const curR = caravan.position.r;
  // Walk backward; remember the most recent named place seen at a
  // different hex than the current one. A bare-hex fallback is used
  // only if no named place is found in the whole buffer.
  let bareHex: { q: number; r: number } | null = null;
  for (let i = buf.length - 1; i >= 0; i--) {
    const snap = buf[i]!;
    if (snap.position.q === curQ && snap.position.r === curR) continue;
    const sid = settlementAtHex(world, snap.position);
    if (sid !== null) {
      return { kind: 'settlement', id: sid, hex: { q: snap.position.q, r: snap.position.r } };
    }
    const cid = banditCampAtHex(world, snap.position);
    if (cid !== null) {
      return { kind: 'camp', id: cid, hex: { q: snap.position.q, r: snap.position.r } };
    }
    if (bareHex === null) {
      bareHex = { q: snap.position.q, r: snap.position.r };
    }
  }
  if (bareHex !== null) return { kind: 'hex', hex: bareHex };
  return null;
};

// --- Event-summary rendering ----------------------------------------------

/**
 * Placeholder syntax produced by `viewer/state/history.ts`:
 *   `[settlement:<id>]` / `[caravan:<id>]` / `[bandit_camp:<id>]`
 *
 * The renderer below substitutes each placeholder with a clickable
 * entity link, looking up the live name at render time so we don't
 * have to capture the name when the event fires.
 */
const PLACEHOLDER = /\[(settlement|caravan|bandit_camp):([^\]]+)\]/g;

export const appendEventSummary = (
  host: HTMLElement,
  world: WorldState,
  state: ViewerState,
  summary: string,
): void => {
  let last = 0;
  for (const match of summary.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0;
    if (start > last) {
      host.appendChild(document.createTextNode(summary.slice(last, start)));
    }
    const kind = match[1];
    const idStr = match[2] ?? '';
    if (kind === 'settlement') {
      host.appendChild(settlementLink(world, state, idStr as SettlementId));
    } else if (kind === 'caravan') {
      host.appendChild(caravanLink(world, state, idStr as CaravanId));
    } else if (kind === 'bandit_camp') {
      host.appendChild(banditCampLink(world, state, idStr as BanditCampId));
    }
    last = start + match[0].length;
  }
  if (last < summary.length) {
    host.appendChild(document.createTextNode(summary.slice(last)));
  }
};
