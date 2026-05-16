/**
 * Modal popup content for moving sim entities that don't have a richer
 * inspector of their own: patrols, news carriers, and bandit raid
 * parties. Per docs/16-viewer + the task spec, every moving entity is
 * selectable. Where the caravan / settlement / bandit-camp popups have
 * deep per-entity history, these three are simpler — we show the unit's
 * role, position, destination (as a settlement link where possible),
 * owner, and current activity.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type {
  BanditPartyId,
  Position,
  SettlementId,
} from '../../src/sim/types.js';
import type { BanditParty } from '../../src/sim/bandit/party.js';
import { missionTargetHex } from '../../src/sim/bandit/party.js';
import type { Patrol } from '../../src/sim/conflict/patrol.js';
import type { NewsCarrier } from '../../src/sim/reputation/news.js';
import { hexDistance } from '../../src/sim/world/hex.js';
import type { ViewerState } from '../state/viewerState.js';
import { popupKv, popupSection } from './popup.js';
import { appendUnitPersonnelSection } from './personnelSection.js';
import { findFactionByActor } from './factionScreen.js';
import { createFactionLink } from './factionLink.js';
import {
  banditCampLink,
  hexDestinationNode,
  settlementLink,
  settlementName,
} from './entityLinks.js';

export interface UnitPopupContent {
  readonly element: HTMLElement;
  readonly title: string;
}

/**
 * Italic "doing X from Y to Z" callout used by every unit popup.
 * Caravan, patrol, news-carrier, and bandit-party popups all open
 * with one of these so the player can read what the unit is doing
 * at a glance — without parsing the kv-table below.
 */
const buildActivityLine = (parts: readonly Node[]): HTMLElement => {
  const box = document.createElement('div');
  box.style.margin = '0 0 8px 0';
  box.style.padding = '6px 10px';
  box.style.background = 'var(--panel-2)';
  box.style.borderLeft = '3px solid var(--accent)';
  box.style.fontStyle = 'italic';
  for (const part of parts) box.appendChild(part);
  return box;
};

// --- Patrols ---------------------------------------------------------------

export interface PatrolPopupOpts {
  readonly world: WorldState;
  readonly id: string;
  readonly state: ViewerState;
}

export const renderPatrolPopup = (opts: PatrolPopupOpts): UnitPopupContent | null => {
  const { world, id, state } = opts;
  if (world.patrols === undefined) return null;
  const p = world.patrols.get(id);
  if (p === undefined) return null;

  const root = document.createElement('div');
  root.appendChild(renderPatrolOverview(world, p, state));
  root.appendChild(renderPatrolRoute(world, p, state));

  const baseName = settlementName(world, p.basedAt);
  return {
    element: root,
    title: `${patrolKindLabel(p.kind)} from ${baseName}`,
  };
};

const patrolKindLabel = (k: Patrol['kind']): string => {
  switch (k) {
    case 'provincial_garrison':
      return 'Provincial garrison patrol';
    case 'city_watch':
      return 'City watch patrol';
    case 'family_guard':
      return 'Family-guard patrol';
    case 'caravan_escort':
      return 'Caravan escort';
  }
};

const renderPatrolOverview = (
  world: WorldState,
  p: Patrol,
  state: ViewerState,
): HTMLElement => {
  const section = popupSection('Overview');
  const owner = world.actors.get(p.ownerActor);
  const ownerLabel = owner?.name ?? '(unknown)';

  // Lead with a single-line "doing X from Y to Z" so the player can
  // see what this unit is up to without parsing the kv-grid below.
  section.appendChild(buildActivityLine(buildPatrolActivity(world, p, state)));

  section.appendChild(
    popupKv([
      ['Kind', patrolKindLabel(p.kind)],
      ['Position', `(${p.position.q}, ${p.position.r})`],
      ['Strength', `${p.unit.count} soldiers`],
      ['Weapons / armor', `${(p.unit.weapons * 100).toFixed(0)}% / ${(p.unit.armor * 100).toFixed(0)}%`],
      ['Health', `${(p.unit.health * 100).toFixed(0)}%`],
      ['Days on patrol', String(p.daysOnPatrol)],
      ['Days since engagement', String(p.daysWithoutEngagement)],
      ['Owner', ownerLabel],
    ]),
  );

  const baseRow = document.createElement('div');
  baseRow.style.marginTop = '6px';
  const baseLbl = document.createElement('span');
  baseLbl.style.color = 'var(--muted)';
  baseLbl.style.marginRight = '6px';
  baseLbl.textContent = 'Based at:';
  baseRow.appendChild(baseLbl);
  baseRow.appendChild(settlementLink(world, state, p.basedAt));
  section.appendChild(baseRow);

  const faction = findFactionByActor(world, p.ownerActor);
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

  // Named personnel — list each named soldier + their kit (docs/04).
  // Patrols register Persons by patrol id (string key) at procgen.
  appendUnitPersonnelSection(section, world, p.id);

  return section;
};

/**
 * Build the leading "doing X from Y to Z" activity line for a patrol.
 * Same pattern as the caravan popup's `describeWhy` so the experience
 * is consistent across unit types.
 */
const buildPatrolActivity = (
  world: WorldState,
  p: Patrol,
  state: ViewerState,
): Node[] => {
  const out: Node[] = [];
  const text = (s: string): Text => document.createTextNode(s);
  if (p.pursuit !== undefined) {
    // Per user feedback: "Patrol from X chasing Y" reads more
    // naturally than "Patrol pursuing target at (q, r)".
    out.push(text(`${patrolKindLabel(p.kind)} from `));
    out.push(settlementLink(world, state, p.basedAt));
    out.push(text(` chasing `));
    out.push(hexDestinationNode(world, state, p.pursuit.targetHex));
    out.push(text(` (day ${p.pursuit.daysActive} of chase).`));
    return out;
  }
  out.push(text(`${patrolKindLabel(p.kind)} from `));
  out.push(settlementLink(world, state, p.basedAt));
  const nextIdx = (p.routeIndex + 1) % p.route.length;
  const next = p.route[nextIdx];
  if (next !== undefined) {
    out.push(text(' patrolling toward '));
    out.push(hexDestinationNode(world, state, next));
  }
  out.push(text('.'));
  return out;
};

const renderPatrolRoute = (
  world: WorldState,
  p: Patrol,
  state: ViewerState,
): HTMLElement => {
  const section = popupSection('Route');
  const hint = document.createElement('div');
  hint.style.color = 'var(--muted)';
  hint.style.fontSize = '11px';
  hint.style.marginBottom = '6px';
  hint.textContent = `${p.route.length} hexes on this cyclic patrol — next stop:`;
  section.appendChild(hint);

  const nextIdx = (p.routeIndex + 1) % p.route.length;
  const next = p.route[nextIdx];
  if (next !== undefined) {
    const row = document.createElement('div');
    row.appendChild(hexDestinationNode(world, state, next));
    section.appendChild(row);
  }
  return section;
};

// --- News carriers ---------------------------------------------------------

export interface NewsCarrierPopupOpts {
  readonly world: WorldState;
  readonly id: string;
  readonly state: ViewerState;
}

export const renderNewsCarrierPopup = (
  opts: NewsCarrierPopupOpts,
): UnitPopupContent | null => {
  const { world, id, state } = opts;
  if (world.newsCarriers === undefined) return null;
  const c = world.newsCarriers.get(id);
  if (c === undefined) return null;

  const root = document.createElement('div');
  root.appendChild(renderNewsCarrierOverview(world, c, state));
  root.appendChild(renderNewsCarrierCargo(world, c, state));
  return { element: root, title: `News carrier` };
};

const renderNewsCarrierOverview = (
  world: WorldState,
  c: NewsCarrier,
  state: ViewerState,
): HTMLElement => {
  const section = popupSection('Overview');
  const dist = hexDistance(c.position, c.destination);

  // Lead with "Carrying news from <event hex> to <destination>" so the
  // player can read the carrier's purpose at a glance.
  const activity: Node[] = [];
  const text = (s: string): Text => document.createTextNode(s);
  activity.push(text('Carrying news from '));
  activity.push(hexDestinationNode(world, state, c.carrying.occurredAtHex));
  activity.push(text(' to '));
  activity.push(hexDestinationNode(world, state, c.destination));
  if (c.arrived) {
    activity.push(text(' (arrived).'));
  } else {
    activity.push(text('.'));
  }
  section.appendChild(buildActivityLine(activity));

  section.appendChild(
    popupKv([
      ['Position', `(${c.position.q}, ${c.position.r})`],
      ['Started on', `d${c.startedOnDay}`],
      ['Speed', `${c.movementPointsPerDay} hex/day`],
      ['Distance to go', `${dist} hex`],
      ['Status', c.arrived ? 'arrived' : 'walking'],
    ]),
  );
  return section;
};

const renderNewsCarrierCargo = (
  world: WorldState,
  c: NewsCarrier,
  state: ViewerState,
): HTMLElement => {
  const section = popupSection('Carrying');
  const news = c.carrying;
  section.appendChild(
    popupKv([
      ['Event day', `d${news.occurredOnDay}`],
      ['Event hex', `(${news.occurredAtHex.q}, ${news.occurredAtHex.r})`],
      ['Magnitude', news.magnitude],
      ['Criminal act', news.isCriminalAct ? 'yes' : 'no'],
    ]),
  );

  // Perpetrator / victim are reputation keys (CharacterId | ActorId).
  // Look the perpetrator up in actors for a human name; characters
  // aren't carried in `world.actors` so the id fallback covers them.
  const perpRow = document.createElement('div');
  perpRow.style.marginTop = '6px';
  const perpLbl = document.createElement('span');
  perpLbl.style.color = 'var(--muted)';
  perpLbl.style.marginRight = '6px';
  perpLbl.textContent = 'Perpetrator:';
  perpRow.appendChild(perpLbl);
  const perpName =
    world.actors.get(news.perpetrator as unknown as Parameters<typeof world.actors.get>[0])?.name ??
    String(news.perpetrator);
  const perpSpan = document.createElement('span');
  perpSpan.textContent = perpName;
  perpRow.appendChild(perpSpan);
  section.appendChild(perpRow);

  if (news.victim !== null) {
    const vRow = document.createElement('div');
    vRow.style.marginTop = '4px';
    const vLbl = document.createElement('span');
    vLbl.style.color = 'var(--muted)';
    vLbl.style.marginRight = '6px';
    vLbl.textContent = 'Victim:';
    vRow.appendChild(vLbl);
    const victimName =
      world.actors.get(news.victim as unknown as Parameters<typeof world.actors.get>[0])?.name ??
      String(news.victim);
    const vSpan = document.createElement('span');
    vSpan.textContent = victimName;
    vRow.appendChild(vSpan);
    section.appendChild(vRow);
  }

  // `state` is reserved for future per-named-character link wiring once
  // characters become first-class selectable entities.
  void state;
  return section;
};

// --- Bandit raid parties ---------------------------------------------------

export interface BanditPartyPopupOpts {
  readonly world: WorldState;
  readonly id: BanditPartyId;
  readonly state: ViewerState;
}

export const renderBanditPartyPopup = (
  opts: BanditPartyPopupOpts,
): UnitPopupContent | null => {
  const { world, id, state } = opts;
  if (world.banditParties === undefined) return null;
  const p = world.banditParties.get(id);
  if (p === undefined) return null;

  const root = document.createElement('div');
  root.appendChild(renderBanditPartyOverview(world, p, state));
  root.appendChild(renderBanditPartyMission(world, p, state));
  if (p.cargo.size > 0) root.appendChild(renderBanditPartyCargo(p));

  const home = p.homeCamp !== null ? world.banditCamps?.get(p.homeCamp) : undefined;
  return {
    element: root,
    title: home !== undefined ? `${home.name}'s ${missionLabel(p.mission.type)}` : 'Bandit raid party',
  };
};

const missionLabel = (k: BanditParty['mission']['type']): string => {
  switch (k) {
    case 'raid_settlement':
      return 'raid party';
    case 'raid_caravan':
      return 'caravan-ambush party';
    case 'fence_loot':
      return 'fence party';
    case 'recruit_drive':
      return 'recruitment party';
    case 'migrate':
      return 'migration party';
    case 'bribe_settlement':
      return 'bribe party';
  }
};

const phaseLabel = (p: BanditParty['phase']): string => {
  switch (p) {
    case 'outbound':
      return 'heading to target';
    case 'executing':
      return 'on target';
    case 'returning':
      return 'returning home';
    case 'fleeing':
      return 'fleeing pursuer';
    case 'done':
      return 'done';
  }
};

const renderBanditPartyOverview = (
  world: WorldState,
  p: BanditParty,
  state: ViewerState,
): HTMLElement => {
  const section = popupSection('Overview');
  const owner = world.actors.get(p.ownerActor);

  section.appendChild(buildActivityLine(buildBanditPartyActivity(world, p, state)));

  section.appendChild(
    popupKv([
      ['Mission', missionLabel(p.mission.type)],
      ['Phase', phaseLabel(p.phase)],
      ['Position', `(${p.position.q}, ${p.position.r})`],
      ['Bandits', String(p.banditCount)],
      ['Weapons / armor', `${(p.weaponsPerBandit * 100).toFixed(0)}% / ${(p.armorPerBandit * 100).toFixed(0)}%`],
      ['Health', `${(p.averageHealth * 100).toFixed(0)}%`],
      ['Days on trip', String(p.daysOnTrip)],
      ['Treasury', `${Math.round(p.treasury).toLocaleString()} coin`],
      ['Owner', owner?.name ?? '(unknown)'],
    ]),
  );

  if (p.homeCamp !== null) {
    const row = document.createElement('div');
    row.style.marginTop = '6px';
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Home camp:';
    row.appendChild(lbl);
    row.appendChild(banditCampLink(world, state, p.homeCamp));
    section.appendChild(row);
  }

  const faction = findFactionByActor(world, p.ownerActor);
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

/**
 * Build the leading "doing X from Y to Z" activity line for a bandit
 * party. Mission resolution + phase produce a different framing per
 * phase: outbound = "raiding X from camp Y", returning = "going home
 * to camp Y after X", fleeing = "running away from <pursuer hex>".
 */
const buildBanditPartyActivity = (
  world: WorldState,
  p: BanditParty,
  state: ViewerState,
): Node[] => {
  const out: Node[] = [];
  const text = (s: string): Text => document.createTextNode(s);

  // Identify the mission target as a named entity where possible.
  let targetSettlement: SettlementId | null = null;
  switch (p.mission.type) {
    case 'raid_settlement':
      targetSettlement = p.mission.target;
      break;
    case 'fence_loot':
      targetSettlement = p.mission.through;
      break;
    case 'recruit_drive':
      targetSettlement = p.mission.fromSettlement;
      break;
    case 'bribe_settlement':
      targetSettlement = p.mission.settlement;
      break;
    default:
      break;
  }
  const homeCamp = p.homeCamp !== null ? world.banditCamps?.get(p.homeCamp) : undefined;

  if (p.phase === 'fleeing') {
    // Threat hex is recorded on the party — show "running away from"
    // that, with the safe destination implicit (home camp).
    out.push(text('Running away from '));
    if (p.fleeingFromHex !== undefined) {
      out.push(hexDestinationNode(world, state, p.fleeingFromHex));
    } else {
      out.push(text('a pursuer'));
    }
    if (homeCamp !== undefined) {
      out.push(text(' toward '));
      out.push(banditCampLink(world, state, homeCamp.id));
    }
    out.push(text('.'));
    return out;
  }
  if (p.phase === 'returning') {
    out.push(text('Returning to '));
    if (homeCamp !== undefined) {
      out.push(banditCampLink(world, state, homeCamp.id));
    } else {
      out.push(hexDestinationNode(world, state, p.homeHex));
    }
    out.push(text('.'));
    return out;
  }
  // outbound / executing — describe the mission.
  out.push(text(`${missionLabel(p.mission.type)} from `));
  if (homeCamp !== undefined) {
    out.push(banditCampLink(world, state, homeCamp.id));
  } else {
    out.push(hexDestinationNode(world, state, p.homeHex));
  }
  out.push(text(' targeting '));
  if (targetSettlement !== null) {
    out.push(settlementLink(world, state, targetSettlement));
  } else {
    out.push(hexDestinationNode(world, state, missionTargetHex(p.mission)));
  }
  out.push(text('.'));
  return out;
};

const renderBanditPartyMission = (
  world: WorldState,
  p: BanditParty,
  state: ViewerState,
): HTMLElement => {
  const section = popupSection('Mission target');

  // Mission-specific target node.
  let targetSettlement: SettlementId | null = null;
  switch (p.mission.type) {
    case 'raid_settlement':
      targetSettlement = p.mission.target;
      break;
    case 'fence_loot':
      targetSettlement = p.mission.through;
      break;
    case 'recruit_drive':
      targetSettlement = p.mission.fromSettlement;
      break;
    case 'bribe_settlement':
      targetSettlement = p.mission.settlement;
      break;
    default:
      break;
  }

  if (targetSettlement !== null) {
    const row = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Target:';
    row.appendChild(lbl);
    row.appendChild(settlementLink(world, state, targetSettlement));
    section.appendChild(row);
  } else {
    const hex: Position = missionTargetHex(p.mission);
    const row = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.style.color = 'var(--muted)';
    lbl.style.marginRight = '6px';
    lbl.textContent = 'Target:';
    row.appendChild(lbl);
    row.appendChild(hexDestinationNode(world, state, hex));
    section.appendChild(row);
  }

  const dist = hexDistance(p.position, missionTargetHex(p.mission));
  const homeRow = document.createElement('div');
  homeRow.style.marginTop = '4px';
  homeRow.style.color = 'var(--muted)';
  homeRow.textContent = `Distance to target: ${dist} hex · home hex (${p.homeHex.q}, ${p.homeHex.r}).`;
  section.appendChild(homeRow);
  return section;
};

const renderBanditPartyCargo = (p: BanditParty): HTMLElement => {
  const section = popupSection('Cargo');
  const table = document.createElement('table');
  table.className = 'popup-table';
  const head = document.createElement('thead');
  head.innerHTML = `<tr><th>Resource</th><th class="num">Quantity</th></tr>`;
  table.appendChild(head);
  const body = document.createElement('tbody');
  for (const [res, qty] of p.cargo) {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td');
    c1.textContent = String(res);
    const c2 = document.createElement('td');
    c2.className = 'num';
    c2.textContent = Math.round(qty).toLocaleString();
    tr.appendChild(c1);
    tr.appendChild(c2);
    body.appendChild(tr);
  }
  table.appendChild(body);
  section.appendChild(table);
  return section;
};
