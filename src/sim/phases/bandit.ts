/**
 * Bandit cluster — per-day bandit decisions, party movement, recruitment,
 * starvation, settlement raids, caravan ambushes, and post-incident news
 * carriers (docs/12 + docs/15 §C32).
 *
 * Two phase entry points are exported:
 *
 *   - `banditPhase` — runs every camp's `decideCampAction`, dispatches
 *     bandit parties, runs `recruitFromIdle`, applies `applyBanditStarvation`,
 *     and decays per-camp recruit-drive multipliers.
 *
 *   - `banditPartyPhase` — moves every alive party, handles flee/pursue,
 *     and resolves arrival missions (raid_settlement, raid_caravan,
 *     fence_loot, recruit_drive, bribe_settlement, migrate).
 *
 * Two module-local Maps track per-camp short-term state across passes:
 *   - `lastSuccessfulRaidDay`: feeds `decideCampAction`'s `lay_low` lean
 *     after a fresh hit.
 *   - `recruitDriveMultiplier`: amplifies `recruitFromIdle`'s pull from
 *     a settlement for several days after a recruit-drive party is
 *     dispatched.
 *
 * Both decay/clean themselves and don't need explicit reset.
 *
 * Originally lived inline in `src/sim/tick.ts`.
 */

import {
  createCamp,
  decideCampAction,
  recruit,
  type BanditCamp,
} from '../bandit/camp.js';
import {
  createBanditParty,
  missionTargetHex,
  partyAtHome,
  partyAtMissionTarget,
  type BanditParty,
  type BanditPartyMission,
} from '../bandit/party.js';
import { totalCrewCount, type Caravan } from '../caravan/caravan.js';
import { resolveAmbush, type AmbushResult } from '../conflict/ambush.js';
import { resolveRaid, type WallLevel } from '../conflict/raid.js';
import type { Patrol } from '../conflict/patrol.js';
import {
  advanceAwayFromHex,
  advanceTowardHex,
  BANDIT_PARTY_MOVEMENT_HEXES_PER_DAY,
  visibleThreatForParty,
} from '../conflict/unitMovement.js';
import {
  actorStockEntriesAt,
  addStockAt,
  createActor,
  getStockAt,
  removeStockAt,
  type Actor,
} from '../politics/actor.js';
import { createCharacter, generateFullName } from '../politics/character.js';
import { createFaction } from '../politics/faction.js';
import {
  createNewsCarrier,
  createNewsItem,
  NEWS_CARRIER_SPEED,
} from '../reputation/news.js';
import type { ReputationKey, ReputationMagnitude } from '../reputation/table.js';
import { getResource } from '../resources/catalog.js';
import type { Rng } from '../rng.js';
import {
  actorId,
  banditCampId as makeBanditCampId,
  characterId,
  factionId,
  resourceId,
  type ActorId,
  type BanditCampId,
  type BanditPartyId,
  type Day,
  type Quantity,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { faminePressure } from '../world/faminePressure.js';
import { hexDistance, hexEquals, hexKey, type Hex } from '../world/hex.js';
import type { Settlement } from '../world/settlement.js';
import { settlementAnchorIndexForWorld } from '../world/settlementIndex.js';
import { adultPopulation } from '../world/subsistence.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

// --- Per-camp short-term state -----------------------------------------------

/**
 * Per-camp last-success tracker. Map by camp id so it survives camp
 * re-creation through `recruit()` (which returns a new BanditCamp with
 * the same id). Stores the day on which the camp last had a successful
 * raid; used by `decideCampAction` to favour `lay_low` after a fresh hit.
 */
const lastSuccessfulRaidDay: Map<BanditCampId, Day> = new Map();

/**
 * Per-camp recruit-pressure tracker (active multiplier after a recruit_drive
 * action). Counts down toward 1 each day. Used by recruitFromIdle.
 */
const recruitDriveMultiplier: Map<BanditCampId, number> = new Map();

const RECRUIT_RANGE_HEXES = 50;
// Recruitment is a low background trickle in normal years and a visible
// pressure valve during food stress. Earlier viewer-tuned values pushed
// every seeded camp to insurgency scale within two years, which converted
// trade into a guaranteed kill-zone instead of an economic risk premium.
const BASE_RECRUIT_FRAC_PER_DAY = 0.0005;
const POOR_VILLAGE_RECRUIT_BOOST = 3;
/**
 * Per-camp soft cap. Beyond this size a camp is too conspicuous and
 * logistically brittle to keep absorbing opportunistic recruits. True
 * 500+ insurgency scale should come from future war/demobilization events,
 * not the peaceful baseline recruitment loop.
 */
const CAMP_RECRUIT_CAP = 120;

// --- Camp decision + dispatch ------------------------------------------------

export const banditPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  // Don't early-exit when banditCamps is empty: recruitFromIdle below is
  // the only path by which the world's bandit population can recover from
  // zero (after patrols wipe out the seeded camps).
  if (world.banditCamps === undefined) return;
  const settlementIndex = settlementAnchorIndexForWorld(world);

  // Step 1: bandit decisions + raid resolution.
  for (const [campId, camp] of [...world.banditCamps]) {
    if (camp.banditCount <= 0) {
      world.banditCamps.delete(campId);
      continue;
    }
    const subRng = rng.derive(`camp-${String(campId)}`);

    // Build the inputs for decideCampAction.
    const knownNearbyCaravans: {
      hex: Hex;
      estimatedCargoValue: number;
      guards: number;
    }[] = [];
    for (const c of world.caravans.values()) {
      if (hexDistance(c.position, camp.hex) > 8) continue;
      // Skip caravans currently at a settlement (urban hex) — too risky,
      // bandits prefer the road. We approximate "urban" by checking a
      // settlement anchor.
      const atSettlement = settlementIndex.byAnchorHex.has(hexKey(c.position));
      if (atSettlement) continue;
      knownNearbyCaravans.push({
        hex: c.position,
        estimatedCargoValue: estimateCargoValue(c),
        guards: countGuards(c),
      });
    }

    const lastDay = lastSuccessfulRaidDay.get(campId) ?? -1000;
    const daysSinceLastSuccessfulRaid = today - lastDay;

    // Patrols visible to the camp: any patrol whose current position is
    // within 8 hexes (matches our PATROL_DETECTION_HEXES symmetry).
    const knownNearbyPatrols: { hex: Hex; size: number }[] = [];
    if (world.patrols !== undefined) {
      for (const p of world.patrols.values()) {
        if (hexDistance(p.position, camp.hex) <= 8) {
          knownNearbyPatrols.push({ hex: p.position, size: p.unit.count });
        }
      }
    }

    // "Friendly" settlements: bandits know nearby small unfortified villages
    // (raid targets) AND nearby large cities with a corrupt fence (looting
    // outlets). v1 shorthand: any settlement within 30 hexes whose tier is
    // hamlet/village/town qualifies as a raid target; cities qualify as
    // fence outlets if the bandit's reputation with them is non-negative.
    const knownFriendlySettlements: { id: SettlementId; hex: Hex }[] = [];
    for (const s of world.settlements.values()) {
      if (hexDistance(s.anchor, camp.hex) > 30) continue;
      if (s.tier === 'hamlet' || s.tier === 'village' || s.tier === 'town') {
        knownFriendlySettlements.push({ id: s.id, hex: s.anchor });
      } else {
        // City: include only if the city's authority isn't actively hostile
        // to the camp. Authority = governor_office or city_corporation
        // anchored at the settlement.
        let hostile = false;
        for (const oId of s.stockpileOwners) {
          const a = world.actors.get(oId);
          if (a !== undefined && (a.kind === 'governor_office' || a.kind === 'city_corporation')) {
            const rep = world.reputation.get(camp.ownerActor, a.id);
            if (rep < -0.3) {
              hostile = true;
              break;
            }
          }
        }
        if (!hostile) knownFriendlySettlements.push({ id: s.id, hex: s.anchor });
      }
    }

    const action = decideCampAction({
      camp,
      knownNearbyCaravans,
      knownNearbyPatrols,
      knownFriendlySettlements,
      daysSinceLastSuccessfulRaid,
      rng: subRng.derive('decide'),
    });

    applyCampAction(world, campId, camp, action, today, subRng.derive('act'), events);
  }

  // Step 2: recruitment from settlements with idle pop / hardship.
  recruitFromIdle(world, rng.derive('recruit'), today, events);

  // Step 3: starvation desertion (camps with empty loot lose bandits).
  applyBanditStarvation(world, rng.derive('starve'), today);

  // Step 4: decay recruit drives.
  for (const [campId, mult] of [...recruitDriveMultiplier]) {
    const next = mult <= 1.05 ? 1 : mult - 0.1;
    if (next <= 1) recruitDriveMultiplier.delete(campId);
    else recruitDriveMultiplier.set(campId, next);
  }
};

const estimateCargoValue = (c: Caravan): number => {
  // Coarse: sum of cargo weights ≈ proxy for value. 1 unit cargo ≈ 1 coin.
  let v = 0;
  for (const qty of c.cargo.values()) v += qty;
  v += c.treasury * 0.5; // treasury is coin, slightly less prized than goods
  return v;
};

const countGuards = (c: Caravan): number => {
  let guards = 0;
  for (const m of c.crew) {
    if (m.kind === 'soldier' || m.kind === 'caravan_guard') guards += m.count;
  }
  return guards;
};

/**
 * Per docs/15 §C32 — does this camp currently have a party out on a
 * mission? One party at a time per camp (the user's design).
 */
const campHasOutgoingParty = (world: WorldState, campId: BanditCampId): boolean => {
  if (world.banditParties === undefined) return false;
  for (const party of world.banditParties.values()) {
    if (party.homeCamp === campId) return true;
  }
  return false;
};

const makeBanditPartyId = (campId: BanditCampId, today: Day): BanditPartyId => {
  // Per-camp-per-day id — deterministic across runs since each camp can
  // only have one outgoing party at a time.
  return `bp-${String(campId)}-${today}` as BanditPartyId;
};

/**
 * Per docs/15 §C32: split off a subset of the camp's bandits into a
 * party. The party fraction is mission-dependent:
 *   raid_settlement: ~half the camp (capped at 12)
 *   raid_caravan:    ~half the camp (capped at 12)
 *   fence_loot:      a small escort (~25%, capped at 4)
 *   recruit_drive:   a couple of messengers (~20%, capped at 3)
 *   migrate:         the entire camp roster (one-way trip)
 *   bribe_settlement: a tiny coin-bag party (~20%, capped at 3)
 * The camp keeps the rest (at least 1 bandit unless migrating). If the
 * camp can't spare any bandits the party is not spawned.
 */
const splitOffPartyRoster = (
  camp: BanditCamp,
  mission: BanditPartyMission,
): { partyCount: number; campCount: number } => {
  const total = Math.max(0, Math.floor(camp.banditCount));
  if (total <= 0) return { partyCount: 0, campCount: 0 };
  let fraction = 0.5;
  let cap = 12;
  let migrate = false;
  switch (mission.type) {
    case 'raid_settlement':
    case 'raid_caravan':
      fraction = 0.5;
      cap = 12;
      break;
    case 'fence_loot':
      fraction = 0.25;
      cap = 4;
      break;
    case 'recruit_drive':
      fraction = 0.2;
      cap = 3;
      break;
    case 'bribe_settlement':
      fraction = 0.2;
      cap = 3;
      break;
    case 'migrate':
      migrate = true;
      break;
  }
  if (migrate) return { partyCount: total, campCount: 0 };
  const ideal = Math.min(cap, Math.max(1, Math.floor(total * fraction)));
  // Keep at least 1 bandit behind for non-migrate missions.
  const partyCount = Math.min(ideal, total - 1);
  return { partyCount: Math.max(0, partyCount), campCount: total - Math.max(0, partyCount) };
};

const spawnBanditParty = (
  world: WorldState,
  campId: BanditCampId,
  camp: BanditCamp,
  mission: BanditPartyMission,
  today: Day,
  events: TickEvent[],
  initialCargo?: ReadonlyMap<ResourceId, Quantity>,
  initialTreasury?: number,
): BanditParty | null => {
  if (world.banditParties === undefined) return null;
  if (campHasOutgoingParty(world, campId)) return null;
  const split = splitOffPartyRoster(camp, mission);
  if (split.partyCount <= 0) return null;

  const partyId = makeBanditPartyId(campId, today);
  const party = createBanditParty({
    id: partyId,
    homeCamp: mission.type === 'migrate' ? null : campId,
    homeHex: camp.hex,
    ownerActor: camp.ownerActor,
    position: camp.hex,
    mission,
    banditCount: split.partyCount,
    weaponsPerBandit: camp.weaponsPerBandit,
    armorPerBandit: camp.armorPerBandit,
    averageHealth: camp.averageHealth,
    ...(initialCargo !== undefined ? { cargo: initialCargo } : {}),
    ...(initialTreasury !== undefined ? { treasury: initialTreasury } : {}),
  });
  world.banditParties.set(partyId, party);

  // For non-migrate missions, the camp keeps its remaining bandits +
  // shrinks its banditCount to reflect those who left.
  if (mission.type !== 'migrate' && world.banditCamps !== undefined) {
    const updated: BanditCamp = { ...camp, banditCount: split.campCount };
    world.banditCamps.set(campId, updated);
  }

  events.push({
    type: 'bandit_party_dispatched',
    party: partyId,
    fromCamp: campId,
    missionType: mission.type,
    at: { q: camp.hex.q, r: camp.hex.r },
  });
  return party;
};

const applyCampAction = (
  world: WorldState,
  campId: BanditCampId,
  camp: BanditCamp,
  action: ReturnType<typeof decideCampAction>,
  today: Day,
  rng: Rng,
  events: TickEvent[],
): void => {
  if (world.banditCamps === undefined) return;
  // Per docs/15 §C32: every camp-originated action that touches another
  // hex goes through a bandit party. The camp still stays put.
  if (campHasOutgoingParty(world, campId)) {
    // The camp's hand is busy already — act `lay_low` this tick.
    void today;
    void rng;
    return;
  }
  switch (action.type) {
    case 'lay_low':
      return;
    case 'recruit_drive': {
      recruitDriveMultiplier.set(campId, 2);
      // Also spawn a small visible party that walks toward the nearest
      // friendly-ish village to "spread the word." We use the closest
      // settlement (tier ≤ village) as the recruiting target hex.
      const nearVillage = findNearestSettlementByTier(world, camp.hex, ['village', 'hamlet']);
      if (nearVillage !== null) {
        spawnBanditParty(
          world,
          campId,
          camp,
          {
            type: 'recruit_drive',
            fromSettlement: nearVillage.id,
            fromHex: nearVillage.anchor,
          },
          today,
          events,
        );
      }
      return;
    }
    case 'move_camp': {
      // Spawn a one-way migration party with the camp's full roster; on
      // arrival it founds a new camp at the target hex and the old camp
      // is deleted.
      const targetHex = { q: action.toHex.q, r: action.toHex.r };
      const tile = world.grid.get(targetHex);
      if (tile === undefined) return;
      const party = spawnBanditParty(
        world,
        campId,
        camp,
        { type: 'migrate', targetHex },
        today,
        events,
      );
      if (party !== null) {
        // Camp is leaving — clear it from the registry. The new camp
        // will be founded by the party on arrival at targetHex.
        world.banditCamps.delete(campId);
      }
      return;
    }
    case 'raid_caravan': {
      // Per docs/15 §C32: spawn a party that walks toward the caravan's
      // last-seen hex. The caravan may have moved by the time the party
      // arrives; the party's executing tick scans for any caravan still
      // at the target hex.
      spawnBanditParty(
        world,
        campId,
        camp,
        {
          type: 'raid_caravan',
          targetHex: { q: action.targetHex.q, r: action.targetHex.r },
        },
        today,
        events,
      );
      return;
    }
    case 'raid_settlement': {
      const target = world.settlements.get(action.targetSettlement);
      if (target === undefined) return;
      spawnBanditParty(
        world,
        campId,
        camp,
        {
          type: 'raid_settlement',
          target: target.id,
          targetHex: target.anchor,
        },
        today,
        events,
      );
      return;
    }
    case 'fence_loot': {
      const through = world.settlements.get(action.throughSettlement);
      if (through === undefined) return;
      // Transfer ALL loot to the party — that's what the caravan is
      // carrying. Coin returns on arrival.
      const cargo = new Map(camp.loot);
      camp.loot.clear();
      spawnBanditParty(
        world,
        campId,
        camp,
        {
          type: 'fence_loot',
          through: through.id,
          throughHex: through.anchor,
        },
        today,
        events,
        cargo,
      );
      return;
    }
    case 'bribe_settlement': {
      const target = world.settlements.get(action.settlement);
      if (target === undefined) return;
      const amount = Math.min(camp.treasury, action.amount);
      if (amount <= 0) return;
      camp.treasury -= amount;
      spawnBanditParty(
        world,
        campId,
        camp,
        {
          type: 'bribe_settlement',
          settlement: target.id,
          settlementHex: target.anchor,
          amount,
        },
        today,
        events,
        undefined,
        amount,
      );
      return;
    }
  }
};

// --- Settlement raid execution ---------------------------------------------

const tierToWallLevel = (tier: Settlement['tier']): WallLevel => {
  switch (tier) {
    case 'hamlet':
      return 0;
    case 'village':
      return 0;
    case 'town':
      return 1;
    case 'small_city':
      return 2;
    case 'large_city':
      return 3;
  }
};

const aggregateSettlementStockpile = (
  world: WorldState,
  settlement: Settlement,
): Map<ResourceId, Quantity> => {
  const out = new Map<ResourceId, Quantity>();
  for (const oId of settlement.stockpileOwners) {
    const a = world.actors.get(oId);
    if (a === undefined) continue;
    for (const [res, qty] of actorStockEntriesAt(a, settlement.id)) {
      out.set(res, (out.get(res) ?? 0) + qty);
    }
  }
  return out;
};

const drainSettlementStockpile = (
  world: WorldState,
  settlement: Settlement,
  loot: ReadonlyMap<ResourceId, Quantity>,
): void => {
  // Drain each resource proportionally across stockpile owners' slices at
  // THIS settlement (per docs/15 §C30 — loot comes from goods physically
  // here, not from the owner's holdings elsewhere).
  for (const [res, qty] of loot) {
    let remaining = qty;
    for (const oId of settlement.stockpileOwners) {
      if (remaining <= 1e-9) break;
      const a = world.actors.get(oId);
      if (a === undefined) continue;
      const have = getStockAt(a, settlement.id, res);
      if (have <= 0) continue;
      const take = Math.min(have, remaining);
      removeStockAt(a, settlement.id, res, take);
      remaining -= take;
    }
  }
};

const executeSettlementRaid = (
  world: WorldState,
  today: Day,
  campId: BanditCampId,
  camp: BanditCamp,
  target: Settlement,
  rng: Rng,
  events: TickEvent[],
): void => {
  if (world.banditCamps === undefined) return;

  // Gather defenders: any patrol based at this settlement.
  const defendingPatrols: Patrol[] = [];
  if (world.patrols !== undefined) {
    for (const p of world.patrols.values()) {
      if (p.basedAt === target.id && p.unit.count > 0) defendingPatrols.push(p);
    }
  }

  // Coarse militia estimate: 5% of working-age adults rally.
  const militiaCount = Math.floor(adultPopulation(target) * 0.05);

  const stockpile = aggregateSettlementStockpile(world, target);
  const wallLevel = tierToWallLevel(target.tier);

  const result = resolveRaid({
    attacker: camp,
    target,
    defendingPatrols,
    militiaCount,
    wallLevel,
    settlementStockpile: stockpile,
    rng: rng.derive('raid'),
  });

  // Apply loot drain.
  drainSettlementStockpile(world, target, result.lootTaken);
  // Add loot to camp.
  for (const [res, qty] of result.lootTaken) {
    camp.loot.set(res, (camp.loot.get(res) ?? 0) + qty);
  }

  // Apply civilian deaths.
  if (result.settlementCasualties.civilianDeaths > 0) {
    const killed = applyCivilianDeaths(target, result.settlementCasualties.civilianDeaths);
    if (killed > 0) {
      events.push({
        type: 'cohort_deaths',
        settlement: target.id,
        deaths: killed,
        cause: 'war',
      });
    }
  }
  // Apply patrol casualties (one defender unit aggregates them all; we
  // distribute proportionally across patrols by their size).
  const totalPatrolCount = defendingPatrols.reduce((acc, p) => acc + p.unit.count, 0);
  if (totalPatrolCount > 0 && result.settlementCasualties.defenderDeaths > 0) {
    let remaining = result.settlementCasualties.defenderDeaths;
    for (const p of defendingPatrols) {
      if (remaining <= 0) break;
      const share = Math.round(
        (p.unit.count / totalPatrolCount) * result.settlementCasualties.defenderDeaths,
      );
      const take = Math.min(share, p.unit.count, remaining);
      if (take <= 0) continue;
      p.unit = { ...p.unit, count: p.unit.count - take };
      remaining -= take;
      if (p.unit.count <= 0 && world.patrols !== undefined) world.patrols.delete(p.id);
    }
  }
  // Apply bandit casualties.
  const banditDeaths = result.banditCasualties.deaths;
  const survivingCamp = Math.max(0, camp.banditCount - banditDeaths);
  if (survivingCamp <= 0) world.banditCamps.delete(campId);
  else world.banditCamps.set(campId, { ...camp, banditCount: survivingCamp });

  // Total cargo lost (count) for telemetry.
  let cargoLost = 0;
  for (const qty of result.lootTaken.values()) cargoLost += qty;
  events.push({
    type: 'settlement_raided',
    settlement: target.id,
    by: campId,
    cargoLost,
    defendersKilled: result.settlementCasualties.defenderDeaths,
  });

  // News from survivors. Settlement raids are visible — every village
  // family that lost livestock has a witness. Spawn a carrier to the
  // nearest large settlement (likely the city the village reports to)
  // OR back to the village itself (if it has named characters present).
  // Magnitude scales with civilian deaths + cargo lost.
  let mag: ReputationMagnitude = 'moderate';
  if (result.settlementCasualties.civilianDeaths > 20 || cargoLost > 200) mag = 'severe';
  if (result.settlementCasualties.civilianDeaths > 100 || cargoLost > 1000) mag = 'atrocious';
  // Always emit news of the attack — the village itself is the spawn point.
  const dest = nearestSettlementWithinRange(
    world,
    target.anchor,
    NEWS_CARRIER_MAX_DESTINATION_HEXES,
  );
  if (dest !== null && world.newsCarriers !== undefined) {
    const id = `news-${today}-raid-${String(campId)}-${String(target.id)}`;
    if (!world.newsCarriers.has(id)) {
      const news = createNewsItem({
        id,
        perpetrator: camp.ownerActor as ReputationKey,
        victim: null,
        magnitude: mag,
        isCriminalAct: true,
        occurredAtHex: target.anchor,
        occurredOnDay: today,
      });
      const carrier = createNewsCarrier({
        id,
        news,
        spawnHex: target.anchor,
        destination: dest.anchor,
        spawnDay: today,
        speed: NEWS_CARRIER_SPEED,
      });
      world.newsCarriers.set(id, carrier);
      events.push({
        type: 'news_carrier_spawned',
        id,
        perpetrator: news.perpetrator,
        victim: null,
        destination: dest.anchor,
        magnitude: mag,
      });
    }
  }
  if (banditDeaths > 0 || result.lootTaken.size > 0) {
    lastSuccessfulRaidDay.set(campId, today);
  }
};

const applyCivilianDeaths = (settlement: Settlement, count: number): number => {
  // Use the same priority-by-vulnerability as famine deaths.
  let remaining = count;
  let killed = 0;
  const order: readonly string[] = ['0-4', '80+', '5-9', '75-79', '70-74'];
  const fallback: readonly string[] = ['10-14', '15-19', '20-24', '25-29', '30-34', '35-39'];
  const all: readonly string[] = [...order, ...fallback];
  for (const ageStr of all) {
    if (remaining <= 0) break;
    const age = ageStr as unknown as Parameters<Settlement['population']['totalByAgeBand']>[0];
    const inBand = settlement.population.totalByAgeBand(age);
    if (inBand <= 0) continue;
    const take = Math.min(remaining, inBand);
    let drained = 0;
    const snap: Array<[Parameters<Settlement['population']['set']>[0], number]> = [];
    settlement.population.forEachCohort((key, c) => {
      if (key.age === age && c > 0) snap.push([key, c]);
    });
    for (const [key, c] of snap) {
      if (drained >= take) break;
      const share = Math.max(1, Math.round((c / inBand) * take));
      const drop = Math.min(share, c, take - drained);
      if (drop <= 0) continue;
      settlement.population.set(key, c - drop);
      drained += drop;
      killed += drop;
    }
    remaining -= drained;
  }
  return killed;
};

const FENCE_PRICE_FRACTION = 0.6;

const executeFenceTransaction = (
  world: WorldState,
  _today: Day,
  campId: BanditCampId,
  camp: BanditCamp,
  through: Settlement,
  events: TickEvent[],
): void => {
  // Pick a fence-eligible actor at the target settlement: prefer city
  // corporation; fall back to first stockpile owner with positive treasury.
  let fence: Actor | undefined;
  for (const oId of through.stockpileOwners) {
    const a = world.actors.get(oId);
    if (a === undefined) continue;
    if (a.kind === 'city_corporation' && a.treasury > 0) {
      fence = a;
      break;
    }
  }
  if (fence === undefined) {
    for (const oId of through.stockpileOwners) {
      const a = world.actors.get(oId);
      if (a !== undefined && a.treasury > 0) {
        fence = a;
        break;
      }
    }
  }
  if (fence === undefined) return;

  // Compute total coin value of camp loot using local clearing prices
  // (fall back to 1 coin/unit when no price observed).
  let totalCoin = 0;
  const transferable: { res: ResourceId; qty: number; price: number }[] = [];
  for (const [res, qty] of camp.loot) {
    if (qty <= 0) continue;
    const lastPrice = through.market.lastClearingPrice.get(res) ?? 1;
    const fencePrice = lastPrice * FENCE_PRICE_FRACTION;
    const value = qty * fencePrice;
    if (value <= 0) continue;
    transferable.push({ res, qty, price: fencePrice });
    totalCoin += value;
  }
  if (totalCoin <= 0) return;
  // Cap at fence's treasury.
  const coinPaid = Math.min(totalCoin, fence.treasury);
  if (coinPaid <= 0) return;
  const fraction = coinPaid / totalCoin;

  for (const t of transferable) {
    const moveQty = t.qty * fraction;
    if (moveQty <= 1e-9) continue;
    const have = camp.loot.get(t.res) ?? 0;
    const newCampQty = have - moveQty;
    if (newCampQty > 1e-9) camp.loot.set(t.res, newCampQty);
    else camp.loot.delete(t.res);
    addStockAt(fence, through.id, t.res, moveQty);
  }
  fence.treasury -= coinPaid;
  camp.treasury += coinPaid;
  // Reputation: fence becomes friendlier to camp; camp likewise.
  world.reputation.apply(fence.id, camp.ownerActor, 0.05);
  world.reputation.apply(camp.ownerActor, fence.id, 0.05);
  events.push({
    type: 'fence_traded',
    camp: campId,
    through: through.id,
    coinPaid,
  });
};

const findCaravanAtHex = (world: WorldState, hex: Hex): Caravan | null => {
  for (const c of world.caravans.values()) {
    if (hexEquals(c.position, hex)) return c;
  }
  return null;
};

// --- Bandit party movement + mission resolution (docs/15 §C32) ----------

const findNearestSettlementByTier = (
  world: WorldState,
  from: Hex,
  tiers: readonly Settlement['tier'][],
): Settlement | null => {
  let best: Settlement | null = null;
  let bestD = Infinity;
  for (const s of world.settlements.values()) {
    if (!tiers.includes(s.tier)) continue;
    const d = hexDistance(from, s.anchor);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
};

/**
 * Build a synthetic BanditCamp record from a party so that existing
 * combat / fence resolution code (which is written against BanditCamp
 * structurally) can be called with a party as the attacker. The
 * returned record points at FRESH mutable Maps so we can extract the
 * side-effects (loot taken, treasury earned) back into the party.
 */
const partyAsSyntheticCamp = (party: BanditParty): BanditCamp => ({
  id: party.homeCamp ?? (`synthetic-${String(party.id)}` as BanditCampId),
  name: `Party ${String(party.id)}`,
  hex: party.position,
  ownerActor: party.ownerActor,
  banditCount: party.banditCount,
  hangersOnCount: 0,
  loot: new Map(party.cargo),
  treasury: party.treasury,
  weaponsPerBandit: party.weaponsPerBandit,
  armorPerBandit: party.armorPerBandit,
  averageHealth: party.averageHealth,
});

/** When a returning party arrives home, fold its stats back into the camp. */
const mergePartyIntoCamp = (camp: BanditCamp, party: BanditParty): BanditCamp => {
  const mergedLoot = new Map(camp.loot);
  for (const [r, q] of party.cargo) {
    mergedLoot.set(r, (mergedLoot.get(r) ?? 0) + q);
  }
  return {
    ...camp,
    banditCount: camp.banditCount + party.banditCount,
    loot: mergedLoot,
    treasury: camp.treasury + party.treasury,
  };
};

/** Found a new camp from a party that has no home (migrate / orphaned). */
const foundCampFromParty = (
  world: WorldState,
  party: BanditParty,
  today: Day,
): BanditCampId | null => {
  if (world.banditCamps === undefined) return null;
  const aId = `actor-emergent-party-${String(party.id)}-${today}` as ActorId;
  if (!world.actors.has(aId)) {
    world.actors.set(
      aId,
      createActor({
        id: aId,
        kind: 'bandit_camp',
        name: `Band of ${String(party.id)}`,
        treasury: 0,
      }),
    );
  }
  const cId = `camp-from-party-${String(party.id)}-${today}` as BanditCampId;
  const camp = createCamp({
    id: cId,
    name: `Band at (${party.position.q},${party.position.r})`,
    hex: party.position,
    ownerActor: aId,
    banditCount: party.banditCount,
    hangersOnCount: 0,
    weaponsPerBandit: party.weaponsPerBandit,
    armorPerBandit: party.armorPerBandit,
    averageHealth: party.averageHealth,
    loot: party.cargo,
    treasury: party.treasury,
  });
  world.banditCamps.set(cId, camp);
  return cId;
};

/**
 * Per docs/15 §C32: resolve whatever the party came here to do. Returns
 * `true` if the party should now switch to `returning` (round-trip
 * missions) or `done` (one-way migrate).
 */
const resolvePartyMissionAtTarget = (
  world: WorldState,
  partyId: BanditPartyId,
  party: BanditParty,
  today: Day,
  rng: Rng,
  events: TickEvent[],
): void => {
  void partyId;
  const homeCampId = party.homeCamp;
  const homeCamp = homeCampId !== null ? world.banditCamps?.get(homeCampId) : undefined;
  switch (party.mission.type) {
    case 'raid_settlement': {
      const target = world.settlements.get(party.mission.target);
      if (
        target === undefined ||
        homeCamp === undefined ||
        homeCampId === null ||
        world.banditCamps === undefined
      ) {
        party.phase = 'returning';
        return;
      }
      // Use a synthetic camp for the combat call; extract the side-effects.
      const synth = partyAsSyntheticCamp(party);
      // executeSettlementRaid mutates `synth.loot`, `synth.treasury` and
      // writes back to world.banditCamps[homeCampId] for casualties. We
      // temporarily install the synth under the home camp's id so the
      // function's writes land somewhere we can read.
      const realCampSnapshot = homeCamp;
      world.banditCamps.set(homeCampId, synth);
      executeSettlementRaid(world, today, homeCampId, synth, target, rng.derive('raid'), events);
      const afterRaid = world.banditCamps.get(homeCampId);
      // Restore the real camp (preserving its bandit count from before)
      // and read the synth's loot back into the party.
      world.banditCamps.set(homeCampId, realCampSnapshot);
      if (afterRaid !== undefined) {
        party.banditCount = afterRaid.banditCount;
        party.cargo = new Map(afterRaid.loot);
        party.treasury = afterRaid.treasury;
      } else {
        // Synthetic camp was deleted (zero count) — the party was wiped.
        party.banditCount = 0;
        party.cargo = new Map();
        party.treasury = 0;
      }
      party.phase = 'returning';
      return;
    }
    case 'raid_caravan': {
      const targetCaravan = findCaravanAtHex(world, party.position);
      if (targetCaravan === null || homeCamp === undefined || world.banditCamps === undefined) {
        party.phase = 'returning';
        return;
      }
      const tile = world.grid.get(targetCaravan.position);
      if (tile === undefined) {
        party.phase = 'returning';
        return;
      }
      const synth = partyAsSyntheticCamp(party);
      const result = resolveAmbush({
        attacker: synth,
        target: targetCaravan,
        ambushHexTerrain: tile.terrain,
        rng: rng.derive('ambush'),
      });
      // Apply caravan casualties.
      let deathsRemaining = result.caravanCasualties.crewDeaths;
      for (const m of targetCaravan.crew) {
        if (deathsRemaining <= 0) break;
        const take = Math.min(m.count, deathsRemaining);
        m.count -= take;
        deathsRemaining -= take;
      }
      targetCaravan.crew = targetCaravan.crew.filter((m) => m.count > 0);
      const caravanCrewWiped = totalCrewCount(targetCaravan) <= 0;
      // Transfer cargo from caravan to PARTY (not camp loot — party
      // carries it home).
      for (const [resId, qty] of result.cargoTaken) {
        const have = targetCaravan.cargo.get(resId) ?? 0;
        const newQty = have - qty;
        if (newQty <= 1e-9) targetCaravan.cargo.delete(resId);
        else targetCaravan.cargo.set(resId, newQty);
        party.cargo.set(resId, (party.cargo.get(resId) ?? 0) + qty);
      }
      targetCaravan.treasury = Math.max(0, targetCaravan.treasury - result.coinTaken);
      party.treasury += result.coinTaken;
      // Apply party casualties.
      party.banditCount = Math.max(0, party.banditCount - result.banditCasualties.deaths);
      if (result.outcome === 'attacker_won' || result.outcome === 'caravan_fled') {
        if (homeCampId !== null) lastSuccessfulRaidDay.set(homeCampId, today);
      }
      let cargoLost = 0;
      for (const qty of result.cargoTaken.values()) cargoLost += qty;
      if (cargoLost > 0 || result.coinTaken > 0 || result.caravanCasualties.crewDeaths > 0) {
        events.push({
          type: 'caravan_robbed',
          caravan: targetCaravan.id,
          by: homeCampId ?? (`party:${String(party.id)}` as BanditCampId),
          cargoLost,
        });
      }
      spawnNewsFromAmbush(
        world,
        today,
        targetCaravan,
        homeCampId ?? (`party:${String(party.id)}` as BanditCampId),
        synth,
        result,
        cargoLost,
        events,
      );
      if (caravanCrewWiped) {
        world.caravans.delete(targetCaravan.id);
        events.push({
          type: 'caravan_disbanded',
          caravan: targetCaravan.id,
          at: { q: targetCaravan.position.q, r: targetCaravan.position.r },
          reason: 'zero_crew',
        });
      }
      party.phase = 'returning';
      return;
    }
    case 'fence_loot': {
      const through = world.settlements.get(party.mission.through);
      if (through === undefined || homeCamp === undefined || world.banditCamps === undefined) {
        party.phase = 'returning';
        return;
      }
      // Reuse the existing fence transaction by handing it a synthetic
      // camp (party stats + party cargo).
      const synth = partyAsSyntheticCamp(party);
      const realCampSnapshot = homeCamp;
      if (homeCampId !== null) world.banditCamps.set(homeCampId, synth);
      executeFenceTransaction(
        world,
        today,
        homeCampId ?? (`party:${String(party.id)}` as BanditCampId),
        synth,
        through,
        events,
      );
      if (homeCampId !== null) world.banditCamps.set(homeCampId, realCampSnapshot);
      party.cargo = new Map(synth.loot);
      party.treasury = synth.treasury;
      party.phase = 'returning';
      return;
    }
    case 'recruit_drive': {
      // Recruitment side-effect already handled by recruitDriveMultiplier
      // at dispatch time. The visible party walking to the village is a
      // physical anchor for the recruitment narrative — no further
      // action required at target.
      party.phase = 'returning';
      return;
    }
    case 'bribe_settlement': {
      const target = world.settlements.get(party.mission.settlement);
      if (target === undefined) {
        party.phase = 'returning';
        return;
      }
      let receiver: Actor | undefined;
      for (const oId of target.stockpileOwners) {
        const a = world.actors.get(oId);
        if (a !== undefined && (a.kind === 'city_corporation' || a.kind === 'governor_office')) {
          receiver = a;
          break;
        }
      }
      const amount = Math.min(party.treasury, party.mission.amount);
      if (amount > 0) {
        party.treasury -= amount;
        if (receiver !== undefined) receiver.treasury += amount;
        if (receiver !== undefined) {
          world.reputation.apply(party.ownerActor, receiver.id, 0.05);
          world.reputation.apply(receiver.id, party.ownerActor, 0.1);
        }
      }
      party.phase = 'returning';
      return;
    }
    case 'migrate': {
      // Found a new camp here. Party despawns; the new camp inherits
      // the party's roster.
      foundCampFromParty(world, party, today);
      party.phase = 'done';
      events.push({
        type: 'bandit_party_returned',
        party: party.id,
        outcome: 'founded_camp',
        at: { q: party.position.q, r: party.position.r },
      });
      return;
    }
  }
};

export const banditPartyPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  if (world.banditParties === undefined) return;
  for (const [partyId, party] of Array.from(world.banditParties.entries())) {
    party.daysOnTrip += 1;
    // If the party has been wiped (count <= 0), despawn.
    if (party.banditCount <= 0) {
      world.banditParties.delete(partyId);
      events.push({
        type: 'bandit_party_returned',
        party: partyId,
        outcome: 'lost',
        at: { q: party.position.q, r: party.position.r },
      });
      continue;
    }
    if (party.phase === 'done') {
      world.banditParties.delete(partyId);
      continue;
    }
    // Per docs/15 §C32: each tick scan for likely-to-win patrols within
    // sight. If one's there, flee; if the threat clears, resume.
    const threat = visibleThreatForParty(world, party);
    if (threat !== undefined) {
      party.phase = 'fleeing';
      party.fleeingFromHex = { q: threat.position.q, r: threat.position.r };
    } else if (party.phase === 'fleeing') {
      // Threat is gone — resume mission. If we've been driven far away,
      // the planner falls back to returning home empty rather than
      // wandering further.
      party.phase = partyAtMissionTarget(party) ? 'returning' : 'outbound';
      delete party.fleeingFromHex;
    }
    // Per-phase movement decision — advance up to 25 hex toward the
    // current waypoint (target / home) or away from a threat.
    if (party.phase === 'fleeing' && party.fleeingFromHex !== undefined) {
      party.position = advanceAwayFromHex(
        party.position,
        party.fleeingFromHex,
        BANDIT_PARTY_MOVEMENT_HEXES_PER_DAY,
        world,
      );
    } else if (party.phase === 'outbound') {
      party.position = advanceTowardHex(
        party.position,
        missionTargetHex(party.mission),
        BANDIT_PARTY_MOVEMENT_HEXES_PER_DAY,
        world,
      );
    } else if (party.phase === 'returning') {
      party.position = advanceTowardHex(
        party.position,
        party.homeHex,
        BANDIT_PARTY_MOVEMENT_HEXES_PER_DAY,
        world,
      );
    }

    // Arrival logic.
    if (party.phase === 'outbound' && partyAtMissionTarget(party)) {
      resolvePartyMissionAtTarget(
        world,
        partyId,
        party,
        today,
        rng.derive(`party-${partyId}`),
        events,
      );
    }
    if (party.phase === 'returning' && partyAtHome(party)) {
      // Merge back into home camp; or, if camp is gone, found a new one.
      const homeCampId = party.homeCamp;
      const home = homeCampId !== null ? world.banditCamps?.get(homeCampId) : undefined;
      if (home !== undefined && homeCampId !== null && world.banditCamps !== undefined) {
        world.banditCamps.set(homeCampId, mergePartyIntoCamp(home, party));
        events.push({
          type: 'bandit_party_returned',
          party: partyId,
          outcome: 'merged_home',
          at: { q: party.position.q, r: party.position.r },
        });
      } else {
        foundCampFromParty(world, party, today);
        events.push({
          type: 'bandit_party_returned',
          party: partyId,
          outcome: 'founded_camp',
          at: { q: party.position.q, r: party.position.r },
        });
      }
      world.banditParties.delete(partyId);
    }
  }
};

const recruitFromIdle = (
  world: WorldState,
  rng: Rng,
  _today: Day,
  events: TickEvent[],
): void => {
  // Note: we don't early-exit on banditCamps.size === 0. When patrols wipe
  // all camps, the founding branch below is the ONLY way the world's
  // bandit population can recover — exiting here would freeze the world
  // in a no-bandits state forever.
  if (world.banditCamps === undefined) return;
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const adults = adultPopulation(settlement);
    if (adults <= 0) continue;
    // Pressure pool ≈ adults × jobless fraction. Normal settlements leak only
    // a few socially marginal adults toward banditry; food stress widens that
    // pool sharply without making every village a bandit factory.
    const isPoor = (faminePressure.get(settlement)?.consecutiveShortageDays ?? 0) >= 1;
    const pressureFraction = isPoor ? 0.15 : 0.03;
    const pressurePool = adults * pressureFraction;
    if (pressurePool <= 0) continue;

    // Find the nearest camp within RECRUIT_RANGE_HEXES that is still under
    // the soft size cap. Above-cap camps don't accept recruits.
    let nearest: { id: BanditCampId; dist: number } | null = null;
    for (const [campId, camp] of world.banditCamps) {
      if (camp.banditCount >= CAMP_RECRUIT_CAP) continue;
      const d = hexDistance(camp.hex, settlement.anchor);
      if (d > RECRUIT_RANGE_HEXES) continue;
      if (nearest === null || d < nearest.dist) nearest = { id: campId, dist: d };
    }

    // Found a new camp if no nearby host exists. Probability is tiny per
    // settlement-day; this gives the bandit population a slow recovery
    // path after patrols wipe out existing camps. Per docs/12 §"Joining
    // vs founding". Without this, once the seeded camps are eliminated
    // the bandit count stays at zero forever (unrealistic).
    if (nearest === null && pressurePool >= 5) {
      const foundProb = isPoor ? 0.002 : 0.0002; // poor villages found camps faster
      const noise2 = rng.derive(`found-${String(settlement.id)}-roll`).next();
      if (noise2 < foundProb) {
        const founded = foundNewCamp(
          world,
          settlement,
          rng.derive(`found-${String(settlement.id)}`),
        );
        if (founded !== null) nearest = { id: founded, dist: 0 };
      }
    }
    if (nearest === null) continue;

    let frac = BASE_RECRUIT_FRAC_PER_DAY;
    if (isPoor) frac *= POOR_VILLAGE_RECRUIT_BOOST;
    const driveMult = recruitDriveMultiplier.get(nearest.id) ?? 1;
    frac *= driveMult;

    const expected = pressurePool * frac;
    // Stochastic recruit count (Poisson-ish via uniform jitter).
    const noise = rng.derive(`pool-${String(settlement.id)}`).next();
    const newRecruits = Math.floor(expected + noise);
    if (newRecruits <= 0) continue;

    const actuallyTake = Math.min(newRecruits, Math.floor(adults * 0.01));
    if (actuallyTake <= 0) continue;
    drainAdultsFromSettlement(settlement, actuallyTake);
    const camp = world.banditCamps.get(nearest.id);
    if (camp === undefined) continue;
    world.banditCamps.set(nearest.id, recruit(camp, actuallyTake));
    events.push({
      type: 'bandit_recruited',
      camp: nearest.id,
      fromSettlement: settlement.id,
      count: actuallyTake,
    });
  }
};

/**
 * Found a fresh bandit camp in wilderness 5-10 hexes from `near`. Returns
 * the new camp's id, or null if no acceptable hex was found. Wires up
 * the necessary actor + faction + leader so reputation propagation works
 * the same as procgen-seeded camps.
 */
const foundNewCamp = (world: WorldState, near: Settlement, rng: Rng): BanditCampId | null => {
  if (world.banditCamps === undefined) return null;
  // Search outward from settlement anchor for an acceptable wilderness hex.
  const acceptable: Hex[] = [];
  for (let radius = 5; radius <= 12 && acceptable.length === 0; radius++) {
    for (let dq = -radius; dq <= radius; dq++) {
      for (let dr = -radius; dr <= radius; dr++) {
        const cand = { q: near.anchor.q + dq, r: near.anchor.r + dr };
        if (hexDistance(cand, near.anchor) !== radius) continue;
        const tile = world.grid.get(cand);
        if (tile === undefined) continue;
        // Bandits prefer cover but desperate bands settle anywhere. Reject
        // only "obviously impossible" terrain (water + urban). Forest /
        // hills get scored higher implicitly because the spiral search
        // returns them first.
        if (tile.terrain === 'lake' || tile.terrain === 'river' || tile.terrain === 'urban') {
          continue;
        }
        // Don't found ON top of an existing camp.
        let occupied = false;
        for (const c of world.banditCamps.values()) {
          if (hexEquals(c.hex, cand)) {
            occupied = true;
            break;
          }
        }
        if (occupied) continue;
        acceptable.push(cand);
      }
    }
  }
  if (acceptable.length === 0) return null;
  const hex = rng.pick(acceptable);

  // Spawn actor + faction + named leader, mirroring procgen seeding.
  const aId = actorId(`actor-emergent-${String(near.id)}-${world.day}-${rng.next().toFixed(6)}`);
  const fId = factionId(`faction-${String(aId)}`);
  const leaderId = characterId(`char-${String(aId)}`);
  const newId = makeBanditCampId(`camp-${String(aId)}`);
  const leaderName = generateFullName(rng.derive('leader'), 'male');
  const actor = createActor({
    id: aId,
    kind: 'bandit_camp',
    name: `${leaderName}'s band`,
    treasury: rng.int(0, 30),
  });
  world.actors.set(aId, actor);
  const leader = createCharacter({
    id: leaderId,
    name: leaderName,
    age: rng.int(22, 50),
    sex: 'male',
    class: 'plebeian',
    faction: fId,
    role: 'bandit_leader',
    location: hex,
  });
  world.characters.set(leaderId, leader);
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `${leaderName}'s band`,
    members: [leaderId],
  });
  world.factions.set(fId, faction);
  const camp = createCamp({
    id: newId,
    name: `${leaderName}'s band`,
    hex,
    ownerActor: aId,
    banditCount: 5,
    hangersOnCount: 1,
    weaponsPerBandit: 0.3,
    armorPerBandit: 0.05,
    averageHealth: 0.8,
    treasury: actor.treasury,
  });
  world.banditCamps.set(newId, camp);
  return newId;
};

const drainAdultsFromSettlement = (settlement: Settlement, count: number): void => {
  let remaining = count;
  // Prefer the working-age bands.
  const order: readonly string[] = [
    '20-24',
    '25-29',
    '15-19',
    '30-34',
    '35-39',
    '40-44',
    '45-49',
    '50-54',
  ];
  for (const ageStr of order) {
    if (remaining <= 0) break;
    const age = ageStr as unknown as Parameters<Settlement['population']['totalByAgeBand']>[0];
    const inBand = settlement.population.totalByAgeBand(age);
    if (inBand <= 0) continue;
    const take = Math.min(remaining, inBand);
    let drained = 0;
    const snap: Array<[Parameters<Settlement['population']['set']>[0], number]> = [];
    settlement.population.forEachCohort((key, c) => {
      if (key.age === age && c > 0) snap.push([key, c]);
    });
    for (const [key, c] of snap) {
      if (drained >= take) break;
      const share = Math.max(1, Math.floor((c / inBand) * take));
      const drop = Math.min(share, c, take - drained);
      if (drop <= 0) continue;
      settlement.population.set(key, c - drop);
      drained += drop;
    }
    remaining -= drained;
  }
};

const applyBanditStarvation = (world: WorldState, rng: Rng, _today: Day): void => {
  if (world.banditCamps === undefined) return;
  for (const [campId, camp] of [...world.banditCamps]) {
    let lootKg = 0;
    for (const [resId, qty] of camp.loot) {
      const def = getResource(resId);
      lootKg += qty * def.weightKgPerUnit;
    }
    const dailyNeedKg = camp.banditCount * 0.4;
    if (lootKg >= dailyNeedKg) {
      // Consume from the highest-weight food first (grain prefers to be
      // eaten before luxuries).
      let remaining = dailyNeedKg;
      const eatable: ResourceId[] = [
        resourceId('food.grain'),
        resourceId('food.bread'),
        resourceId('food.flour'),
        resourceId('food.legumes'),
        resourceId('food.cheese'),
        resourceId('food.salted_meat'),
        resourceId('food.salted_fish'),
      ];
      for (const id of eatable) {
        if (remaining <= 0) break;
        const have = camp.loot.get(id) ?? 0;
        if (have <= 0) continue;
        const def = getResource(id);
        const haveKg = have * def.weightKgPerUnit;
        const takeKg = Math.min(haveKg, remaining);
        const takeUnits = takeKg / Math.max(1e-9, def.weightKgPerUnit);
        const newQty = have - takeUnits;
        if (newQty > 1e-9) camp.loot.set(id, newQty);
        else camp.loot.delete(id);
        remaining -= takeKg;
      }
    } else {
      // Starvation: 5% desert per day at zero food, scaled.
      const shortfallFrac = 1 - lootKg / Math.max(1, dailyNeedKg);
      const desertRate = 0.05 * shortfallFrac;
      const noise = rng.derive(`starve-${String(campId)}`).next();
      const desertCount = Math.floor(camp.banditCount * desertRate + noise);
      if (desertCount > 0) {
        const remaining = Math.max(0, camp.banditCount - desertCount);
        if (remaining < 3) world.banditCamps.delete(campId);
        else world.banditCamps.set(campId, { ...camp, banditCount: remaining });
      }
    }
  }
};

// --- News-carrier spawn from ambush ----------------------------------------

const NEWS_CARRIER_MAX_DESTINATION_HEXES = 60;

const ambushMagnitude = (
  cargoLost: number,
  crewDeaths: number,
  coinLost: number,
): ReputationMagnitude => {
  if (cargoLost > 200 || crewDeaths > 10 || coinLost > 500) return 'atrocious';
  if (cargoLost > 50 || crewDeaths > 3 || coinLost > 100) return 'severe';
  if (cargoLost > 10 || crewDeaths > 0 || coinLost > 20) return 'moderate';
  return 'petty';
};

const nearestSettlementWithinRange = (
  world: WorldState,
  from: Hex,
  maxDist: number,
): Settlement | null => {
  let best: { s: Settlement; d: number } | null = null;
  for (const s of world.settlements.values()) {
    const d = hexDistance(s.anchor, from);
    if (d > maxDist) continue;
    if (best === null || d < best.d) best = { s, d };
  }
  return best?.s ?? null;
};

const spawnNewsFromAmbush = (
  world: WorldState,
  today: Day,
  caravan: Caravan,
  campId: BanditCampId,
  camp: BanditCamp,
  result: AmbushResult,
  cargoLost: number,
  events: TickEvent[],
): void => {
  if (world.newsCarriers === undefined) return;

  // Aggregate fled_escaped count across all caravan-side survivor entries.
  let fledEscaped = 0;
  for (const s of result.survivors) {
    if (s.unitId === 'caravan' && s.fate === 'fled_escaped') fledEscaped += s.count;
  }

  // Floor: per docs/12 §"Battles aren't total annihilation", even a clean
  // attacker_won leaves rumor traces. If no eyewitnesses escaped but the
  // attack was material, still emit a "rumor" carrier — the missing
  // caravan eventually triggers an investigation upstream.
  const incidentMaterial =
    cargoLost > 0 || result.caravanCasualties.crewDeaths > 0 || result.coinTaken > 0;
  if (fledEscaped <= 0 && !incidentMaterial) return;

  const dest = nearestSettlementWithinRange(
    world,
    caravan.position,
    NEWS_CARRIER_MAX_DESTINATION_HEXES,
  );
  if (dest === null) return;

  const fullMagnitude = ambushMagnitude(
    cargoLost,
    result.caravanCasualties.crewDeaths,
    result.coinTaken,
  );
  // Rumor-only events drop to petty regardless of incident size — without a
  // first-hand witness the news loses specificity.
  const magnitude: ReputationMagnitude = fledEscaped > 0 ? fullMagnitude : 'petty';

  // One carrier per ambush — multiple survivors converge on the same news.
  // Per docs/12: even one survivor is enough to update reputation; numbers
  // matter more for credibility than for delta magnitude.
  const id = `news-${today}-${String(campId)}-${String(caravan.id)}`;
  if (world.newsCarriers.has(id)) return; // dedupe within the same tick

  const news = createNewsItem({
    id,
    perpetrator: camp.ownerActor as ReputationKey,
    victim: caravan.ownerActor as ReputationKey,
    magnitude,
    isCriminalAct: true,
    occurredAtHex: caravan.position,
    occurredOnDay: today,
    battleSurvivors: fledEscaped,
  });
  const carrier = createNewsCarrier({
    id,
    news,
    spawnHex: caravan.position,
    destination: dest.anchor,
    spawnDay: today,
    speed: NEWS_CARRIER_SPEED,
  });
  world.newsCarriers.set(id, carrier);
  events.push({
    type: 'news_carrier_spawned',
    id,
    perpetrator: news.perpetrator,
    victim: news.victim,
    destination: dest.anchor,
    magnitude,
  });
};
