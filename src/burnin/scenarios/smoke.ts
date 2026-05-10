/**
 * Smoke scenario (T42): the smallest end-to-end integration test.
 *
 * Builds a deliberately tiny hand-crafted world (1 capital + 3
 * villages + 1 patrician family + 1 governor + 1 bandit camp +
 * 2 NPC caravans) and runs it through the docs/01 daily tick loop
 * for N days. The result is the full WorldState plus a flat list of
 * events the tick produced and any invariant violations detected
 * along the way.
 *
 * Exists to catch "the tick loop wired things up wrong" before the
 * larger stabilization scenario (T44) does.
 */

import { generateRoads } from '../../procgen/roads.js';
import { generateTerrain } from '../../procgen/terrain.js';
import { siteSettlements, type SettlementSite } from '../../procgen/settlements.js';
import { seedWorld, type WorldState } from '../../procgen/seed.js';
import {
  STANDARD_INVARIANTS,
  checkInvariants,
  summarizeForDay,
  type DailySummary,
  type InvariantViolation,
} from '../invariants.js';
import { createCamp, type BanditCamp } from '../../sim/bandit/camp.js';
import { createCaravan } from '../../sim/caravan/caravan.js';
import { addBuilding } from '../../sim/world/settlement.js';
import {
  createActor,
  createCharacter,
  createFaction,
  generateFullName,
} from '../../sim/politics/index.js';
import { createRng } from '../../sim/rng.js';
import { tick, type TickEvent } from '../../sim/tick.js';
import {
  actorId,
  banditCampId,
  buildingId,
  caravanId,
  characterId,
  factionId,
  resourceId,
  type ActorId,
} from '../../sim/types.js';
import type { Hex } from '../../sim/world/hex.js';

export interface SmokeScenarioOpts {
  /** Deterministic seed for procgen + tick RNGs. Defaults to a stable string. */
  readonly seed?: string;
  /** Days to advance through the tick loop. Defaults to 30. */
  readonly days?: number;
}

export interface SmokeScenarioResult {
  readonly world: WorldState;
  readonly daysRun: number;
  readonly events: readonly TickEvent[];
  readonly invariantViolations: readonly InvariantViolation[];
  readonly summary: DailySummary;
  readonly banditCamps: readonly BanditCamp[];
  readonly startTotalPopulation: number;
}

const DEFAULT_DAYS = 30;
const DEFAULT_SEED = 'smoke-default';
const GRID_WIDTH = 30;
const GRID_HEIGHT = 30;

/**
 * Build a tiny procgen world. The dimensions are small enough to
 * keep the test under the 10-second budget on CI.
 */
const buildBaseWorld = (seed: string): WorldState => {
  const grid = generateTerrain({
    seed,
    widthHexes: GRID_WIDTH,
    heightHexes: GRID_HEIGHT,
    oceanCoveragePct: 5,
    forestCoveragePct: 20,
    mountainsCoveragePct: 5,
    marshCoveragePct: 2,
  });
  const sites = siteSettlements({
    seed,
    grid,
    cityCount: 1, // capital
    townCount: 0,
    villageCount: 3,
    hamletCount: 0,
    clusterRadiusHexes: 12,
  });
  // Roads: connect settlements with dirt + roman where the procgen sees fit.
  generateRoads({ seed, grid, settlements: sites, clusterRadiusHexes: 12 });
  return seedWorld({
    seed,
    grid,
    settlementSites: sites,
    patricianFamiliesPerCity: 1, // exactly the documented family
    freeVillageFraction: 0, // all villages are patron-client so the family owns hexes
  });
};

const findCapital = (world: WorldState): { site: SettlementSite; hex: Hex } => {
  const capitalSite = world.bySite.find((s) => s.kind === 'capital');
  if (capitalSite === undefined) {
    throw new Error('smoke scenario: procgen produced no capital');
  }
  return { site: capitalSite, hex: capitalSite.anchor };
};

const findVillages = (world: WorldState): SettlementSite[] => {
  return world.bySite.filter((s) => s.kind === 'village');
};

/**
 * Pick a wilderness hex within range of the capital. Falls back to
 * the capital itself if none is found (only happens in pathologically
 * small/empty worlds, which we'd want to fail loudly anyway).
 */
const pickBanditHex = (world: WorldState, capital: Hex): Hex => {
  for (const [hex, tile] of world.grid.tiles()) {
    if (tile.ownerActor !== null) continue;
    if (tile.terrain === 'lake') continue;
    const dq = hex.q - capital.q;
    const dr = hex.r - capital.r;
    const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
    if (dist >= 4 && dist <= 10) return hex;
  }
  return capital;
};

const seedBanditCampInWorld = (world: WorldState, seedStr: string, capital: Hex): BanditCamp => {
  const rng = createRng(`${seedStr}|bandit`);
  // The bandit camp itself is an Actor (the camp holds loot + treasury).
  const ownerId = actorId('smoke-bandit-actor');
  const ownerActor = createActor({
    id: ownerId,
    kind: 'bandit_camp',
    name: 'Caelian Brigands',
    treasury: 0,
  });
  world.actors.set(ownerId, ownerActor);

  // A named bandit leader for completeness.
  const leaderFactionId = factionId('smoke-bandit-faction');
  const leaderId = characterId('smoke-bandit-leader');
  const leader = createCharacter({
    id: leaderId,
    name: generateFullName(rng, 'male'),
    age: rng.int(28, 45),
    sex: 'male',
    class: 'plebeian',
    faction: leaderFactionId,
    role: 'bandit_leader',
    location: pickBanditHex(world, capital),
  });
  const faction = createFaction({
    id: leaderFactionId,
    actor: ownerId,
    name: 'Caelian Brigands',
    members: [leaderId],
  });
  world.characters.set(leaderId, leader);
  world.factions.set(leaderFactionId, faction);

  const camp = createCamp({
    id: banditCampId('smoke-bandit-camp'),
    name: 'Caelian Hideout',
    hex: leader.location,
    ownerActor: ownerId,
    banditCount: 8,
    hangersOnCount: 4,
    weaponsPerBandit: 0.6,
    armorPerBandit: 0.2,
    averageHealth: 0.9,
  });
  return camp;
};

/**
 * Add two small NPC merchant caravans. Each is owned by the
 * patrician family if one exists (else the city corporation), starts
 * at the capital, and is given a destination at the first village so
 * the movement phase has something concrete to do during the run.
 */
const seedCaravansInWorld = (world: WorldState, capital: Hex): void => {
  const family = [...world.actors.values()].find((a) => a.kind === 'patrician_family');
  const corp = [...world.actors.values()].find((a) => a.kind === 'city_corporation');
  const owner = family?.id ?? corp?.id;
  if (owner === undefined) {
    throw new Error('smoke scenario: no patrician family or city corporation to own caravans');
  }

  const villages = findVillages(world);
  const firstVillageHex = villages[0]?.anchor ?? capital;
  const secondVillageHex = villages[1]?.anchor ?? firstVillageHex;

  const c1 = createCaravan({
    id: caravanId('smoke-caravan-1'),
    ownerActor: owner,
    position: capital,
    destination: firstVillageHex,
    crew: [
      { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
      { kind: 'drover', count: 4, weapons: 0, armor: 0 },
      { kind: 'caravan_guard', count: 4, weapons: 1, armor: 0.3 },
    ],
    animals: { mule: 12 },
    vehicles: {},
  });
  // Give the caravan some grain so it has cargo to move.
  c1.cargo.set(resourceId('food.grain'), 50);
  const c2 = createCaravan({
    id: caravanId('smoke-caravan-2'),
    ownerActor: owner,
    position: capital,
    destination: secondVillageHex,
    crew: [
      { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
      { kind: 'drover', count: 3, weapons: 0, armor: 0 },
      { kind: 'caravan_guard', count: 2, weapons: 1, armor: 0.2 },
    ],
    animals: { mule: 8 },
    vehicles: {},
  });
  world.caravans.set(c1.id, c1);
  world.caravans.set(c2.id, c2);
};

/**
 * Place a small set of buildings in every settlement so the
 * production phase has work to do. We deliberately use pasture
 * recipes (raise_sheep, raise_cattle) which need no inputs beyond
 * a nominal one — that way day-1 production fires regardless of
 * which season procgen happened to start in.
 */
const seedBuildingsInWorld = (world: WorldState): void => {
  for (const settlement of world.settlements.values()) {
    // Pick an owner: city corporation if present, else first stockpile owner.
    const corp = [...world.actors.values()].find(
      (a) => a.kind === 'city_corporation' && a.homeSettlement === settlement.id,
    );
    let ownerActor: ActorId | undefined = corp?.id ?? settlement.stockpileOwners[0];
    if (ownerActor === undefined) continue;

    // Pasture in a catchment hex for animal recipes.
    const catchmentForPasture = settlement.catchmentHexes[0];
    if (catchmentForPasture !== undefined) {
      addBuilding(settlement, {
        buildingId: buildingId('pasture'),
        hex: catchmentForPasture,
        ownerActor,
        capacity: 4,
        daysSinceMaintained: 0,
      });
    }
    // Farm in a second catchment hex for grain recipes.
    const catchmentForFarm = settlement.catchmentHexes[1] ?? catchmentForPasture;
    if (catchmentForFarm !== undefined && catchmentForFarm !== catchmentForPasture) {
      addBuilding(settlement, {
        buildingId: buildingId('farm'),
        hex: catchmentForFarm,
        ownerActor,
        capacity: 4,
        daysSinceMaintained: 0,
      });
    }
  }
};

/**
 * Total population across every settlement in the world. The summary
 * helper does the same internally; this is the pre-tick number we
 * compare against in the "within-5%" assertion.
 */
const totalPopulation = (world: WorldState): number => {
  let total = 0;
  for (const settlement of world.settlements.values()) {
    total += settlement.population.total();
  }
  return total;
};

export const runSmokeScenario = async (
  opts: SmokeScenarioOpts = {},
): Promise<SmokeScenarioResult> => {
  const seed = opts.seed ?? DEFAULT_SEED;
  const days = opts.days ?? DEFAULT_DAYS;

  const world = buildBaseWorld(seed);

  const capital = findCapital(world);
  // If procgen failed to produce 3 villages we'd want to know — fail loudly.
  const villages = findVillages(world);
  if (villages.length < 3) {
    throw new Error(
      `smoke scenario expected ≥3 villages, procgen produced ${villages.length} — try a different seed`,
    );
  }

  // seedWorld now adds starter pasture+farm to every settlement (per
  // docs/07 §"Place starter production buildings"), so we no longer need
  // to manually seed them here. Kept the function around in case the
  // smoke scenario needs to layer extra buildings later.
  void seedBuildingsInWorld; // suppress unused-var
  const camp = seedBanditCampInWorld(world, seed, capital.hex);
  seedCaravansInWorld(world, capital.hex);

  const startTotalPopulation = totalPopulation(world);
  const events: TickEvent[] = [];
  const violations: InvariantViolation[] = [];

  const tickRng = createRng(`${seed}|tick`);
  for (let i = 0; i < days; i++) {
    const result = tick({ world, rng: tickRng.derive(`day-${i}`) });
    for (const e of result.events) events.push(e);
  }

  const ctx = { world, day: world.day };
  const allViolations = checkInvariants(ctx, STANDARD_INVARIANTS);
  for (const v of allViolations) violations.push(v);

  const summary = summarizeForDay(world, world.day);
  return {
    world,
    daysRun: days,
    events,
    invariantViolations: violations,
    summary,
    banditCamps: [camp],
    startTotalPopulation,
  };
};
