/**
 * Initial state seeding: turn a procgen output (terrain grid + settlement
 * sites) into a complete WorldState ready for the burn-in tick loop.
 *
 * Reference: docs/07-geography.md "Phase 1 — Procgen, step 10: Seed initial
 * state" and docs/11-politics-and-ownership.md (governor + patrician
 * families + village leadership + hex-level ownership).
 *
 * Pillar 1 ("no hidden hands") is the reason this file exists. Every actor
 * (family, free village, hamlet household, governor's office, city
 * corporation) is a real ledger holder; every named character has an
 * identity, age, and faction; every catchment hex is owned by exactly one
 * actor. That ownership graph is what later economy / politics / reputation
 * systems read from — there is no aggregate "settlement pool".
 *
 * The seeder is deterministic in the seed: same opts → same world. All RNG
 * flows through `Rng.derive('label')` so adding new sub-systems doesn't
 * perturb existing streams.
 */

import { createRng, type Rng } from '../sim/rng.js';
import {
  addBuilding,
  tierOfPopulation,
  createSettlement,
  type Settlement,
  type SettlementTier,
} from '../sim/world/settlement.js';
import {
  CHARACTER_CLASSES,
  AGE_BANDS,
  agedKey,
  type AgeBand,
  type CharacterClass,
  type Sex,
} from '../sim/population/index.js';
import { drawDemographicsFromPool, ROLE_BIASES } from '../sim/population/demographics.js';
import {
  ACTOR_KINDS,
  addStockAt,
  createActor,
  createCharacter,
  createFaction,
  generateFamilyMemberName,
  generateFullName,
  generateLatinNomen,
  type Actor,
  type Faction,
  type NamedCharacter,
} from '../sim/politics/index.js';
import { createReputationTable, type ReputationTable } from '../sim/reputation/table.js';
import type { NewsCarrier } from '../sim/reputation/news.js';
import type { Caravan } from '../sim/caravan/caravan.js';
import type { Patrol } from '../sim/conflict/patrol.js';
import type { BanditCamp } from '../sim/bandit/camp.js';
import type { BanditParty } from '../sim/bandit/party.js';
import { createGuild, addGuildMember, type Guild } from '../sim/politics/guild.js';
import {
  actorId,
  banditCampId,
  buildingId,
  characterId,
  factionId,
  jobId,
  personId,
  resourceId,
  settlementId,
  type ActorId,
  type BanditCampId,
  type BanditPartyId,
  type CaravanId,
  type CharacterId,
  type Day,
  type FactionId,
  type JobId,
  type PersonId,
  type ResourceId,
  type SettlementId,
} from '../sim/types.js';
import { type Person, createPerson, emptyPersonRegistry, registerPerson } from '../sim/people/index.js';
import { generateLatinPraenomen } from '../sim/politics/character.js';
import { parseDemoKey } from '../sim/population/demographics.js';
import { jobsForBuilding } from '../sim/jobs/buildingJobs.js';
import type { HexGrid } from '../sim/world/grid.js';
import { hexDistance, hexEquals, hexKey, hexesWithinRange, type Hex } from '../sim/world/hex.js';
import { pickBestHex, type PlacementCandidate } from '../sim/buildings/placement.js';
import { createCamp } from '../sim/bandit/camp.js';
import { campaignerUnit } from '../sim/conflict/battle.js';
import { createPatrol, type Patrol as PatrolType } from '../sim/conflict/patrol.js';
import { routeForGarrisonPatrol, routeForCityWatch } from '../sim/conflict/patrolRoutes.js';
import type { SettlementSite } from './settlements.js';
import { generateRoads } from './roads.js';

// --- Public types -----------------------------------------------------------

export interface WorldState {
  day: Day;
  readonly grid: HexGrid;
  readonly settlements: Map<SettlementId, Settlement>;
  readonly actors: Map<ActorId, Actor>;
  readonly factions: Map<FactionId, Faction>;
  readonly characters: Map<CharacterId, NamedCharacter>;
  readonly caravans: Map<CaravanId, Caravan>;
  /**
   * Politics-phase entities. Optional on the type so tests with minimal
   * stubs don't need to populate them; the canonical seedWorld() always
   * initializes them as empty Maps. Consumers should treat undefined as
   * empty-Map equivalent.
   */
  readonly patrols?: Map<string, Patrol>;
  readonly banditCamps?: Map<BanditCampId, BanditCamp>;
  /**
   * Per docs/15 §C32: bandit parties — movable units that handle
   * camp-originated actions (raid, fence, recruit, migrate). Optional
   * for back-compat with snapshots that pre-date the refactor.
   */
  readonly banditParties?: Map<BanditPartyId, BanditParty>;
  readonly newsCarriers?: Map<string, NewsCarrier>;
  /** Merchant guilds (per docs/15 §C17). Keyed by their Actor id. */
  readonly guilds?: Map<ActorId, Guild>;
  /**
   * Per docs/04 §"Person registry for moving units": named individuals
   * who walk with a moving unit (caravan crew, patrol soldiers, bandit
   * fighters, raid party members, migrants). Settled villagers stay
   * aggregate; this Map only holds people who physically move. Optional
   * for back-compat with snapshots that pre-date the registry.
   */
  readonly persons?: Map<PersonId, Person>;
  /**
   * Per-Person equipment slots. Each PersonId maps to a sparse
   * `Map<ResourceId, count>` of the weapons / armor / shield the
   * Person currently carries. Empty maps and absent entries are
   * equivalent ("no kit"). Kept globally rather than nested on units
   * so the registry can be serialized as a flat table and casualty
   * loot can be reattached to the camp/patrol cleanly.
   */
  readonly personEquipment?: Map<PersonId, Map<ResourceId, number>>;
  readonly reputation: ReputationTable;
  /**
   * Diagnostic: the procgen sites that were used to seed this world, in the
   * same order seedSettlements() returned them. Useful for tests and tooling
   * that wants to walk back from a Settlement to its kind/estimatedPopulation.
   * Required: tests that build WorldState manually pass `bySite: []`.
   */
  readonly bySite: readonly SettlementSite[];
}

export interface SeedOpts {
  readonly seed: string;
  readonly grid: HexGrid;
  readonly settlementSites: readonly SettlementSite[];
  /**
   * Patrician families per city (and per the capital). Default 4. Per docs/11,
   * the historical bracket is 3–7. Defensive bounds: must be in [1, 12].
   */
  readonly patricianFamiliesPerCity?: number;
  /**
   * Fraction of villages that are free villages (vs. patron-client). Default
   * 0.2 (20%) per docs/11 ("less common").
   */
  readonly freeVillageFraction?: number;
}

// --- Catchment computation --------------------------------------------------

/**
 * Catchment radius in hexes per docs/05 §"Catchment". 1 km/hex.
 * Hamlet ≈ 1, Village ≈ 2, Town ≈ 3, City ≈ 5, Capital ≈ 5.
 */
const catchmentRadiusFor = (kind: SettlementSite['kind']): number => {
  switch (kind) {
    case 'hamlet':
      return 1;
    case 'village':
      return 2;
    case 'town':
      return 3;
    case 'city':
      return 5;
    case 'capital':
      return 5;
  }
};

/**
 * The catchment hexes for a site: every hex within radius around any of its
 * urban hexes that exists in the grid AND is not itself one of the site's
 * urban hexes AND has not already been claimed by a closer settlement.
 */
const computeCatchment = (
  site: SettlementSite,
  grid: HexGrid,
  alreadyClaimed: ReadonlySet<string>,
): Hex[] => {
  const radius = catchmentRadiusFor(site.kind);
  const urbanKeys = new Set(site.urbanHexes.map(hexKey));
  const out: Hex[] = [];
  const seen = new Set<string>();
  for (const u of site.urbanHexes) {
    for (const candidate of hexesWithinRange(u, radius)) {
      const k = hexKey(candidate);
      if (urbanKeys.has(k)) continue;
      if (seen.has(k)) continue;
      if (alreadyClaimed.has(k)) continue;
      if (!grid.has(candidate)) continue;
      seen.add(k);
      out.push(candidate);
    }
  }
  return out;
};

// --- Tier mapping -----------------------------------------------------------

const tierFromSiteKind = (
  kind: SettlementSite['kind'],
  estimatedPopulation: number,
): Settlement['tier'] => {
  switch (kind) {
    case 'capital':
      return 'large_city';
    case 'city':
      return tierOfPopulation(estimatedPopulation) === 'large_city' ? 'large_city' : 'small_city';
    case 'town':
      return 'town';
    case 'village':
      return 'village';
    case 'hamlet':
      return 'hamlet';
  }
};

// --- Population pyramid -----------------------------------------------------

/**
 * Roman demographic pyramid by 5-year age band, summing to 1.0. Heavy at the
 * bottom (high birthrate, high child mortality, fewer elders). Numbers are a
 * simplification of model life-table West Level 3 rescaled to the 17 bands
 * in our cohort module. Tuning is downstream.
 */
const AGE_PYRAMID: Record<AgeBand, number> = {
  '0-4': 0.135,
  '5-9': 0.115,
  '10-14': 0.1,
  '15-19': 0.09,
  '20-24': 0.08,
  '25-29': 0.075,
  '30-34': 0.07,
  '35-39': 0.06,
  '40-44': 0.055,
  '45-49': 0.045,
  '50-54': 0.04,
  '55-59': 0.035,
  '60-64': 0.03,
  '65-69': 0.025,
  '70-74': 0.018,
  '75-79': 0.012,
  '80+': 0.015,
};

interface ClassMix {
  readonly patrician: number;
  readonly plebeian: number;
  readonly freedman: number;
  readonly slave: number;
  readonly foreigner: number;
}

/**
 * Per-tier class mix per docs/04 §"Class structure". Hamlets are mostly free
 * smallholders with no slaves; villages have a handful; towns and cities
 * have the full pyramid including patricians and a slave class.
 */
const classMixForTier = (tier: Settlement['tier']): ClassMix => {
  switch (tier) {
    case 'hamlet':
      // No patricians, no slaves; mostly plebs + a few freedmen + an
      // occasional foreigner trader passing through.
      return {
        patrician: 0,
        plebeian: 0.95,
        freedman: 0.04,
        slave: 0,
        foreigner: 0.01,
      };
    case 'village':
      return {
        patrician: 0,
        plebeian: 0.85,
        freedman: 0.05,
        slave: 0.08,
        foreigner: 0.02,
      };
    case 'town':
      return {
        patrician: 0.01,
        plebeian: 0.78,
        freedman: 0.05,
        slave: 0.13,
        foreigner: 0.03,
      };
    case 'small_city':
      return {
        patrician: 0.02,
        plebeian: 0.72,
        freedman: 0.06,
        slave: 0.16,
        foreigner: 0.04,
      };
    case 'large_city':
      return {
        patrician: 0.025,
        plebeian: 0.7,
        freedman: 0.07,
        slave: 0.18,
        foreigner: 0.025,
      };
  }
};

/**
 * Distribute a single integer total across the 17 age bands using the pyramid
 * weights. Uses largest-remainder rounding so the sum is always exactly total.
 */
const distributeAcrossAges = (total: number): readonly { age: AgeBand; count: number }[] => {
  if (total <= 0) return AGE_BANDS.map((age) => ({ age, count: 0 }));
  const raw = AGE_BANDS.map((age) => ({ age, exact: AGE_PYRAMID[age] * total }));
  const floored = raw.map((r) => ({
    age: r.age,
    count: Math.floor(r.exact),
    frac: r.exact - Math.floor(r.exact),
  }));
  let assigned = floored.reduce((a, b) => a + b.count, 0);
  const remainder = total - assigned;
  // Sort by descending fractional remainder; bump the top `remainder` entries.
  const order = floored
    .map((_, i) => i)
    .sort((a, b) => {
      const fa = floored[a]?.frac ?? 0;
      const fb = floored[b]?.frac ?? 0;
      return fb - fa;
    });
  for (let i = 0; i < remainder; i++) {
    const idx = order[i];
    if (idx === undefined) break;
    const entry = floored[idx];
    if (entry === undefined) break;
    entry.count += 1;
    assigned += 1;
  }
  return floored.map((f) => ({ age: f.age, count: f.count }));
};

const SEX_SPLIT: readonly Sex[] = ['male', 'female'];

/**
 * Fill a settlement's PopulationPool from a target total + class mix. The
 * algorithm: split the total into class buckets via the mix, then split each
 * class bucket across the age pyramid, then split each age bucket 50/50
 * between male and female (with a one-person odd-bucket fix).
 */
const seedPopulation = (settlement: Settlement, total: number): void => {
  if (total <= 0) return;
  const mix = classMixForTier(settlement.tier);
  const byClass: Record<CharacterClass, number> = {
    patrician: Math.round(total * mix.patrician),
    plebeian: Math.round(total * mix.plebeian),
    freedman: Math.round(total * mix.freedman),
    slave: Math.round(total * mix.slave),
    foreigner: Math.round(total * mix.foreigner),
  };
  // Reconcile rounding so the class sum equals total.
  let classSum = 0;
  for (const c of CHARACTER_CLASSES) classSum += byClass[c];
  // Allocate any drift to plebeians (the dominant class).
  byClass.plebeian += total - classSum;
  if (byClass.plebeian < 0) byClass.plebeian = 0;

  for (const klass of CHARACTER_CLASSES) {
    const classTotal = byClass[klass];
    if (classTotal <= 0) continue;
    const ageBuckets = distributeAcrossAges(classTotal);
    for (const { age, count } of ageBuckets) {
      if (count <= 0) continue;
      const male = Math.floor(count / 2);
      const female = count - male;
      if (male > 0) {
        settlement.population.set({ age, sex: 'male', class: klass }, male);
      }
      if (female > 0) {
        settlement.population.set({ age, sex: 'female', class: klass }, female);
      }
    }
  }
  // SEX_SPLIT is referenced indirectly above; keep the binding for future
  // generators that need the full sex enumeration.
  void SEX_SPLIT;
};

// --- Stockpiles -------------------------------------------------------------

const GRAIN_KG_PER_DAY = 0.4; // docs/04 §"Consumption per adult per day"
const KG_PER_MODIUS = 6.7; // see resources/catalog.ts food.grain
// 180-day reserve. Per docs/15 §C5 we aim for 30 ultimately, but C6
// Initial reserves per docs/15 §C5 + the realism-pass-9 rebalance:
// every basic consumable is capped at **at most 1 year of consumption
// per settlement**, with most categories well below that. The
// city-corp / village / hamlet seeders all hit this same set of
// constants so the cap holds in every settlement tier.
//
// Grain reserve halved from the v1.5 30-day target to 14 days because
// the burn-in showed city corps starting unreasonably stocked at the
// 5×-scaled price level (the 30-day grain heap looked like decades of
// civic wealth to the price layer).
const GRAIN_DAYS_OF_RESERVE = 14;
const WOOD_DAYS_OF_RESERVE = 7;
const WOOD_CORDS_PER_ADULT_PER_DAY = 0.001;
const STARTER_TOOLS_PER_CAPITA = 0.2;
/** Hard upper bound applied to every starter consumable grant: 365 days. */
const MAX_INITIAL_RESERVE_DAYS = 365;

const grainModiiForPopulation = (totalPop: number, days: number): number => {
  const kg = totalPop * GRAIN_KG_PER_DAY * days;
  return Math.round(kg / KG_PER_MODIUS);
};

const woodCordsForPopulation = (totalPop: number, minCords: number): number =>
  Math.max(minCords, totalPop * WOOD_CORDS_PER_ADULT_PER_DAY * WOOD_DAYS_OF_RESERVE);

const toolsForPopulation = (totalPop: number, minTools: number): number =>
  Math.max(minTools, totalPop * STARTER_TOOLS_PER_CAPITA);

const grantStockpile = (
  actor: Actor,
  settlement: SettlementId,
  resource: string,
  qty: number,
): void => {
  if (qty <= 0) return;
  // Per docs/15 §C30 the grant lands at the actor's slice for the named
  // settlement. ADD to existing slice so multiple grants accumulate.
  addStockAt(actor, settlement, resourceId(resource), qty);
};

const grantStarterMarketInventory = (actor: Actor, settlement: Settlement, scale = 1): void => {
  const pop = settlement.population.total();
  if (pop <= 0 || scale <= 0) return;
  // Per realism pass 18: per-capita consumption rates re-calibrated to
  // the historical Roman reference in docs/04 §"Per-capita consumption
  // sanity ranges". Daily rates here MUST match
  // src/sim/market/scheduleBuilder.ts COMFORT_WANT_QTY so the procgen-
  // seeded stockpile and the per-day demand reference the same units.
  // Days-of-supply are tuned to land starter quantities near the Q8
  // post-stabilization shape, capped at MAX_INITIAL_RESERVE_DAYS so no
  // consumable starts above 1 year of supply.
  const clampDays = (d: number): number => Math.min(MAX_INITIAL_RESERVE_DAYS, Math.max(0, d));
  // v1.6 pass-21 (Phase 29): starter days tuned to LOW end of observed
  // Q8 stockpile ranges across hamlet/village/town/small_city/large_city
  // (3-year burn-in on realism-compare seed). Goal: cities start at or
  // BELOW their natural equilibrium so they don't begin in a flush
  // transient that has to drain. Settlements that produce a resource
  // grow stockpile from here organically; settlements that consume it
  // import as needed. Q8 medians still showed multi-year bloat for
  // furniture / pottery / salted_meat / cloth in cities — the bloat
  // is a production/consumption-recipe issue that requires recipe
  // calibration to fully fix, not a starter-reserve issue. Setting
  // starters low at least avoids worsening the transient.
  const grants: ReadonlyArray<readonly [string, number]> = [
    ['food.wine', pop * 0.25 * clampDays(10) * scale],         // Q8 obs: 0-20 days (cities low)
    ['food.olive_oil', pop * 0.04 * clampDays(20) * scale],    // Q8 obs: 1-200 days (variable)
    ['food.cheese', pop * 0.012 * clampDays(14) * scale],      // Q8 obs: 11-90 days (kept)
    ['food.salted_fish', pop * 0.015 * clampDays(5) * scale],  // Q8 obs: 0-3 days hamlets
    ['food.salted_meat', pop * 0.025 * clampDays(5) * scale],  // Q8 obs: massive bloat upstream
    ['goods.cloth', pop * 0.005 * clampDays(30) * scale],
    ['goods.clothing', pop * 0.004 * clampDays(30) * scale],
    ['goods.furniture', pop * 0.0003 * clampDays(20) * scale], // Q8 obs: hamlets ~45d, cities bloated
    ['material.pottery', pop * 0.012 * clampDays(20) * scale],
  ];
  for (const [resource, qty] of grants) grantStockpile(actor, settlement.id, resource, qty);
};

// --- Hex ownership ----------------------------------------------------------

const setOwner = (grid: HexGrid, hex: Hex, owner: ActorId | null): void => {
  const tile = grid.get(hex);
  if (tile === undefined) return;
  tile.ownerActor = owner;
};

// --- ID generators ----------------------------------------------------------

let _idCounter = 0;
const resetIdCounter = (): void => {
  _idCounter = 0;
};
const nextId = (prefix: string): string => {
  _idCounter += 1;
  return `${prefix}-${String(_idCounter).padStart(5, '0')}`;
};

// --- Settlement / actor / character builders --------------------------------

interface BuildContext {
  readonly rng: Rng;
  readonly grid: HexGrid;
  readonly settlements: Map<SettlementId, Settlement>;
  readonly actors: Map<ActorId, Actor>;
  readonly factions: Map<FactionId, Faction>;
  readonly characters: Map<CharacterId, NamedCharacter>;
}

const addActor = (ctx: BuildContext, actor: Actor): void => {
  ctx.actors.set(actor.id, actor);
};

const addFaction = (ctx: BuildContext, faction: Faction): void => {
  ctx.factions.set(faction.id, faction);
};

const addCharacter = (ctx: BuildContext, character: NamedCharacter): void => {
  ctx.characters.set(character.id, character);
};

const addSettlement = (ctx: BuildContext, settlement: Settlement): void => {
  ctx.settlements.set(settlement.id, settlement);
};

interface FamilySeed {
  readonly actor: Actor;
  readonly faction: Faction;
  readonly patriarch: NamedCharacter;
  readonly nomen: string;
}

const seedPatricianFamily = (
  ctx: BuildContext,
  city: Settlement,
  cityNameHint: string,
): FamilySeed => {
  const familyRng = ctx.rng.derive(`family-${nextId('fam')}`);
  const nomen = generateLatinNomen(familyRng);
  const aId = actorId(nextId('actor'));
  const fId = factionId(nextId('faction'));
  const cId = characterId(nextId('char'));
  const actor = createActor({
    id: aId,
    kind: 'patrician_family',
    name: `Family ${nomen} of ${cityNameHint}`,
    homeSettlement: city.id,
    // docs/15 §C20: patricians get working-capital reserve so they
    // survive the first quarter before fiscal redistribution kicks in.
    // Earlier 2000-8000 led to treasury collapsing to ~0 within months
    // (wage payouts > grain-sale income) which froze status/comfort
    // markets across the province.
    // 5× scaled vs. pre-pass-7 baseline so patricians keep working
    // capital under the inflated post-realism price level.
    treasury: familyRng.int(40000, 120000),
  });
  // docs/15 §C24 + docs/11 §"Every faction has named characters":
  // a patrician family is "Patriarch + adult members", and ALL of them
  // share the family's nomen. The Vibii are e.g. "Lucius Vibian"
  // (patriarch) + "Marcus Vibian" (heir) + "Tullia Vibian" (matron)
  // + "Quintus Vibian" (younger scion). Without this loop the family
  // had exactly one named character, and the faction screen looked
  // empty.
  const patriarch = createCharacter({
    id: cId,
    name: generateFamilyMemberName(familyRng, 'male', nomen),
    age: familyRng.int(35, 60),
    sex: 'male',
    class: 'patrician',
    faction: fId,
    role: 'patriarch',
    location: city.anchor,
  });
  const memberIds: (typeof cId)[] = [cId];
  const extraMemberCount = familyRng.int(2, 4);
  for (let m = 0; m < extraMemberCount; m++) {
    const memberId = characterId(nextId('char'));
    const sex: 'male' | 'female' = familyRng.chance(0.45) ? 'female' : 'male';
    // Age profile: an heir (15-35), a matron (35-55), a younger scion
    // (10-25), and an occasional elder (50-70). Use slot index to make
    // the mix predictable but not robotic.
    const age =
      m === 0
        ? familyRng.int(18, 32) // heir
        : m === 1
          ? familyRng.int(35, 55) // matron
          : m === 2
            ? familyRng.int(10, 24) // scion
            : familyRng.int(45, 68); // elder
    const member = createCharacter({
      id: memberId,
      name: generateFamilyMemberName(familyRng, sex, nomen),
      age,
      sex,
      class: 'patrician',
      faction: fId,
      role: 'family_member',
      location: city.anchor,
    });
    addCharacter(ctx, member);
    memberIds.push(memberId);
  }
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `Family ${nomen}`,
    members: memberIds,
  });
  addActor(ctx, actor);
  addFaction(ctx, faction);
  addCharacter(ctx, patriarch);
  city.factions.push(fId);
  city.stockpileOwners.push(aId);
  return { actor, faction, patriarch, nomen };
};

const seedGovernor = (ctx: BuildContext, capital: Settlement, capitalName: string): void => {
  const govRng = ctx.rng.derive('governor');
  const aId = actorId(nextId('actor'));
  const fId = factionId(nextId('faction'));
  const cId = characterId(nextId('char'));
  const actor = createActor({
    id: aId,
    kind: 'governor_office',
    name: `Provincial Governor's Office of ${capitalName}`,
    homeSettlement: capital.id,
    // 5× scaled per realism pass 8.
    treasury: govRng.int(100000, 250000),
  });
  const governor = createCharacter({
    id: cId,
    name: generateFullName(govRng, 'male'),
    age: govRng.int(40, 65),
    sex: 'male',
    class: 'patrician',
    faction: fId,
    role: 'governor',
    location: capital.anchor,
  });
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `Office of the Governor`,
    members: [cId],
  });
  addActor(ctx, actor);
  addFaction(ctx, faction);
  addCharacter(ctx, governor);
  capital.factions.push(fId);
  capital.stockpileOwners.push(aId);
};

const seedCityCorporation = (
  ctx: BuildContext,
  settlement: Settlement,
  settlementName: string,
): Actor => {
  const aId = actorId(nextId('actor'));
  const actor = createActor({
    id: aId,
    kind: 'city_corporation',
    name: `Corporation of ${settlementName}`,
    homeSettlement: settlement.id,
    // 5× scaled per realism pass 8.
    treasury: 25000,
  });
  addActor(ctx, actor);
  settlement.stockpileOwners.push(aId);
  // City reserves: ~30 days of grain + ~7 days of wood/tools at expected
  // consumption. Per docs/15 §C5: production must come online within the
  // first month; anything more is a v1 bootstrap hack. Amphorae are kept
  // higher because pottery production has a long bake_bread / wine /
  // oil cycle and amphora is durable.
  const pop = settlement.population.total();
  grantStockpile(
    actor,
    settlement.id,
    'food.grain',
    grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE),
  );
  grantStockpile(actor, settlement.id, 'material.wood', woodCordsForPopulation(pop, 20));
  grantStockpile(actor, settlement.id, 'material.amphora', Math.max(20, Math.floor(pop / 5)));
  grantStockpile(actor, settlement.id, 'goods.tools', toolsForPopulation(pop, 50));
  // Per realism pass 9: city corp no longer gets a 1.25× scale on
  // starter market inventory — every city tier seeds at the baseline
  // scale so the urban warehouses don't begin the burn-in flush with
  // multi-month surpluses.
  grantStarterMarketInventory(actor, settlement, 1.0);
  return actor;
};

/**
 * Per docs/15 §C21: per-class initial treasury for each household actor.
 * Matches the liquid-wealth assumptions in market/scheduleBuilder.ts
 * (plebeian 30, freedman 15, foreigner 50 coin-equivalent per head).
 */
const CLASS_HOUSEHOLD_SEED: ReadonlyArray<{
  readonly class: 'plebeian' | 'freedman' | 'foreigner';
  readonly kind: 'plebeian_household' | 'freedman_household' | 'foreigner_household';
  readonly perCapita: number;
  readonly displayName: string;
}> = [
  // 5× scaled per-capita treasury seeding (realism pass 8) so common
  // households keep a real comfort/status budget at the post-scale
  // price level.
  { class: 'plebeian', kind: 'plebeian_household', perCapita: 150, displayName: 'Plebeians' },
  { class: 'freedman', kind: 'freedman_household', perCapita: 75, displayName: 'Freedmen' },
  { class: 'foreigner', kind: 'foreigner_household', perCapita: 250, displayName: 'Foreigners' },
];

/**
 * Per docs/15 §C21: seed up to three per-class household actors for a
 * settlement. Only classes with positive population get an actor — a
 * settlement with no plebeians (rare, e.g. slave-only estates) gets no
 * `plebeian_household`. Each actor carries the class's own treasury and
 * stockpile so demand is bounded by its own cash, not a shared pool.
 *
 * Returns the list of created actors so callers (mostly tests + post-seed
 * grants) can grant additional stockpile. Most callers just need the side
 * effect of registering actors + stockpile owners.
 */
const seedClassHouseholds = (
  ctx: BuildContext,
  settlement: Settlement,
  settlementName: string,
): Actor[] => {
  const out: Actor[] = [];
  for (const cfg of CLASS_HOUSEHOLD_SEED) {
    const pop = settlement.population.totalByClass(cfg.class);
    if (pop <= 0) continue;
    const aId = actorId(nextId('actor'));
    const treasury = Math.max(50, Math.floor(pop * cfg.perCapita));
    const actor = createActor({
      id: aId,
      kind: cfg.kind,
      name: `${cfg.displayName} of ${settlementName}`,
      homeSettlement: settlement.id,
      treasury,
    });
    addActor(ctx, actor);
    settlement.stockpileOwners.push(aId);
    out.push(actor);
  }
  return out;
};

const seedFreeVillage = (
  ctx: BuildContext,
  settlement: Settlement,
  settlementName: string,
): Actor => {
  const villageRng = ctx.rng.derive(`free-village-${String(settlement.id)}`);
  const aId = actorId(nextId('actor'));
  const fId = factionId(nextId('faction'));
  const elderId = characterId(nextId('char'));
  const actor = createActor({
    id: aId,
    kind: 'free_village',
    name: `Free Village of ${settlementName}`,
    homeSettlement: settlement.id,
    treasury: villageRng.int(250, 1500),
  });
  const elder = createCharacter({
    id: elderId,
    name: generateFullName(villageRng, 'male'),
    age: villageRng.int(45, 70),
    sex: 'male',
    class: 'plebeian',
    faction: fId,
    role: 'elder',
    location: settlement.anchor,
  });
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `Council of ${settlementName}`,
    members: [elderId],
  });
  addActor(ctx, actor);
  addFaction(ctx, faction);
  addCharacter(ctx, elder);
  settlement.factions.push(fId);
  settlement.stockpileOwners.push(aId);
  // ~30 days of grain + ~7 days of tools/wood at expected consumption,
  // per docs/15 §C5. Local farms + the village smithy have to come
  // online within the first month; trade fills any remaining gap.
  const pop = settlement.population.total();
  grantStockpile(
    actor,
    settlement.id,
    'food.grain',
    grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE),
  );
  grantStockpile(actor, settlement.id, 'goods.tools', toolsForPopulation(pop, 10));
  grantStockpile(actor, settlement.id, 'material.wood', woodCordsForPopulation(pop, 5));
  grantStockpile(actor, settlement.id, 'material.amphora', Math.max(10, Math.floor(pop / 10)));
  grantStarterMarketInventory(actor, settlement, 0.7);
  return actor;
};

const seedClientVillage = (ctx: BuildContext, settlement: Settlement, patron: Actor): Actor => {
  const villageRng = ctx.rng.derive(`client-village-${String(settlement.id)}`);
  // Per docs/15 §C29: the patron is NOT a stockpile owner of the village.
  // The village has its own household actor (same kind as a free village)
  // that holds the harvest. The patron collects quarterly coin tribute via
  // `tributePhase`. The headman is still a freedman in the patron's faction
  // so reputation lookups walk back to the patron, but the village's
  // economic ledger is its own.
  const aId = actorId(nextId('actor'));
  const headmanId = characterId(nextId('char'));
  // Find the patron's faction (each patrician_family has exactly one).
  const patronFaction = [...ctx.factions.values()].find((f) => f.actor === patron.id);
  if (patronFaction === undefined) {
    throw new Error(`seedClientVillage: patron ${String(patron.id)} has no faction`);
  }
  const actor = createActor({
    id: aId,
    kind: 'free_village',
    name: `Client Village of ${settlement.name}`,
    homeSettlement: settlement.id,
    treasury: villageRng.int(250, 1500),
  });
  const headman = createCharacter({
    id: headmanId,
    name: generateFullName(villageRng, 'male'),
    age: villageRng.int(35, 60),
    sex: 'male',
    class: 'freedman',
    faction: patronFaction.id,
    role: 'headman',
    location: settlement.anchor,
  });
  patronFaction.members.push(headmanId);
  addActor(ctx, actor);
  addCharacter(ctx, headman);
  settlement.factions.push(patronFaction.id);
  settlement.stockpileOwners.push(aId);
  settlement.clientPatron = patron.id;
  seedClassHouseholds(ctx, settlement, settlement.name);
  // ~30 days of grain + ~7 days of tools/wood for the village's own pool,
  // per docs/15 §C5 + §C29. Local farms + the village smithy have to come
  // online within the first month; trade fills any remaining gap.
  const pop = settlement.population.total();
  grantStockpile(
    actor,
    settlement.id,
    'food.grain',
    grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE),
  );
  grantStockpile(actor, settlement.id, 'goods.tools', toolsForPopulation(pop, 10));
  grantStockpile(actor, settlement.id, 'material.wood', woodCordsForPopulation(pop, 5));
  grantStockpile(actor, settlement.id, 'material.amphora', Math.max(10, Math.floor(pop / 10)));
  grantStarterMarketInventory(actor, settlement, 0.7);
  return actor;
};

const seedHamlet = (ctx: BuildContext, settlement: Settlement, settlementName: string): Actor => {
  const hamletRng = ctx.rng.derive(`hamlet-${String(settlement.id)}`);
  const aId = actorId(nextId('actor'));
  const fId = factionId(nextId('faction'));
  const headmanId = characterId(nextId('char'));
  const actor = createActor({
    id: aId,
    kind: 'hamlet_household',
    name: `Household of ${settlementName}`,
    homeSettlement: settlement.id,
    treasury: hamletRng.int(50, 400),
  });
  const headman = createCharacter({
    id: headmanId,
    name: generateFullName(hamletRng, 'male'),
    age: hamletRng.int(35, 60),
    sex: 'male',
    class: 'plebeian',
    faction: fId,
    role: 'headman',
    location: settlement.anchor,
  });
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `Household of ${settlementName}`,
    members: [headmanId],
  });
  addActor(ctx, actor);
  addFaction(ctx, faction);
  addCharacter(ctx, headman);
  settlement.factions.push(fId);
  settlement.stockpileOwners.push(aId);
  const pop = settlement.population.total();
  grantStockpile(
    actor,
    settlement.id,
    'food.grain',
    grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE),
  );
  grantStockpile(actor, settlement.id, 'goods.tools', toolsForPopulation(pop, 10));
  grantStockpile(actor, settlement.id, 'material.wood', woodCordsForPopulation(pop, 5));
  grantStarterMarketInventory(actor, settlement, 0.25);
  return actor;
};

// --- Settlement naming ------------------------------------------------------

const settlementNameFor = (rng: Rng, kind: SettlementSite['kind']): string => {
  // Lightweight Roman placename generator. Real procgen could use a more
  // varied corpus; this is enough to make the world legible.
  const ROOTS = [
    'Aquileia',
    'Patavium',
    'Verona',
    'Mediolanum',
    'Cremona',
    'Bononia',
    'Ravenna',
    'Brixia',
    'Mantua',
    'Pisaurum',
    'Ariminum',
    'Faventia',
    'Forum Cornelii',
    'Fanum Fortunae',
    'Volsinii',
    'Praeneste',
    'Tibur',
    'Nomentum',
    'Cumae',
    'Capua',
    'Salernum',
    'Beneventum',
    'Suessa',
    'Reate',
    'Spoletium',
    'Asculum',
    'Hadria',
    'Auximum',
    'Camerinum',
    'Iguvium',
  ];
  const ABSURDLY_SMALL_ROOTS = ['Vicus Albus', 'Pagus Niger', 'Mons Calidus', 'Vallis Frigida'];
  const root = rng.pick(kind === 'hamlet' ? [...ROOTS, ...ABSURDLY_SMALL_ROOTS] : ROOTS);
  switch (kind) {
    case 'capital':
    case 'city':
      return root;
    case 'town':
      return root;
    case 'village':
      return `Pagus ${root}`;
    case 'hamlet':
      return root.startsWith('Pagus') || root.startsWith('Vicus') ? root : `Vicus ${root}`;
  }
};

// --- Main entry -------------------------------------------------------------

export const seedWorld = (opts: SeedOpts): WorldState => {
  resetIdCounter();
  const rng = createRng(opts.seed);
  const familiesPerCity = clampFamilies(opts.patricianFamiliesPerCity ?? 4);
  const freeFraction = clampFraction(opts.freeVillageFraction ?? 0.2);

  const ctx: BuildContext = {
    rng,
    grid: opts.grid,
    settlements: new Map(),
    actors: new Map(),
    factions: new Map(),
    characters: new Map(),
  };

  // Phase 1: build Settlement entities for every site, with catchments
  // assigned in city → town → village → hamlet order so larger settlements
  // claim their catchment first.
  const order = orderSitesForCatchment(opts.settlementSites);
  const claimed = new Set<string>();
  for (const u of order.flatMap((s) => s.urbanHexes)) {
    claimed.add(hexKey(u));
  }
  const siteToSettlement = new Map<SettlementSite, Settlement>();
  for (const site of order) {
    const catchment = computeCatchment(site, opts.grid, claimed);
    for (const c of catchment) claimed.add(hexKey(c));
    const tier = tierFromSiteKind(site.kind, site.estimatedPopulation);
    const sId = settlementId(nextId('settlement'));
    const nameRng = rng.derive(`name-${nextId('name')}`);
    const settlement = createSettlement({
      id: sId,
      tier,
      name: settlementNameFor(nameRng, site.kind),
      anchor: site.anchor,
      urbanHexes: site.urbanHexes,
      catchmentHexes: catchment,
      // docs/05 §"Dynamic catchment recompute": baseline = day-0 population.
      // Subsequent ±25% pop swings + 365d cooldown trigger a recompute.
      catchmentBaselinePop: site.estimatedPopulation,
      catchmentDayLastChanged: 0,
    });
    seedPopulation(settlement, site.estimatedPopulation);
    addSettlement(ctx, settlement);
    siteToSettlement.set(site, settlement);
  }

  // Phase 2: governor in the capital.
  const capitalSite = opts.settlementSites.find((s) => s.kind === 'capital');
  if (capitalSite !== undefined) {
    const capital = siteToSettlement.get(capitalSite);
    if (capital !== undefined) {
      seedGovernor(ctx, capital, capital.name);
    }
  }

  // Phase 3: city corporations + patrician families per city/capital.
  const familiesByCity = new Map<SettlementId, FamilySeed[]>();
  for (const site of opts.settlementSites) {
    if (site.kind !== 'city' && site.kind !== 'capital') continue;
    const city = siteToSettlement.get(site);
    if (city === undefined) continue;
    seedCityCorporation(ctx, city, city.name);
    seedClassHouseholds(ctx, city, city.name);
    const seeds: FamilySeed[] = [];
    for (let i = 0; i < familiesPerCity; i++) {
      seeds.push(seedPatricianFamily(ctx, city, city.name));
    }
    familiesByCity.set(city.id, seeds);
  }

  // Phase 4: town corporations (small-ish stockpile owner).
  for (const site of opts.settlementSites) {
    if (site.kind !== 'town') continue;
    const town = siteToSettlement.get(site);
    if (town === undefined) continue;
    seedCityCorporation(ctx, town, town.name);
    seedClassHouseholds(ctx, town, town.name);
  }

  // Phase 5: villages — assign as patron-client to a nearby family or as a
  // free village. Hex ownership flows from this choice.
  const allFamilies: FamilySeed[] = [...familiesByCity.values()].flat();
  const villageRng = rng.derive('village-leadership');
  for (const site of opts.settlementSites) {
    if (site.kind !== 'village') continue;
    const village = siteToSettlement.get(site);
    if (village === undefined) continue;
    const isFree = villageRng.next() < freeFraction || allFamilies.length === 0;
    if (isFree) {
      const owner = seedFreeVillage(ctx, village, village.name);
      claimVillageHexes(ctx.grid, village, owner.id);
    } else {
      const patron = villageRng.pick(allFamilies).actor;
      seedClientVillage(ctx, village, patron);
      claimVillageHexes(ctx.grid, village, patron.id);
    }
  }

  // Phase 6: hamlets — each gets its own household actor.
  for (const site of opts.settlementSites) {
    if (site.kind !== 'hamlet') continue;
    const hamlet = siteToSettlement.get(site);
    if (hamlet === undefined) continue;
    const owner = seedHamlet(ctx, hamlet, hamlet.name);
    claimVillageHexes(ctx.grid, hamlet, owner.id);
  }

  // Phase 7: ensure city / town urban + catchment hexes are owned. Default
  // owner is the city_corporation; if a city has families, distribute
  // catchment hexes across them round-robin so estates feel real.
  for (const site of opts.settlementSites) {
    if (site.kind !== 'city' && site.kind !== 'capital' && site.kind !== 'town') continue;
    const settlement = siteToSettlement.get(site);
    if (settlement === undefined) continue;
    const cityCorp = [...ctx.actors.values()].find(
      (a) => a.kind === 'city_corporation' && a.homeSettlement === settlement.id,
    );
    if (cityCorp === undefined) continue;
    for (const u of settlement.urbanHexes) {
      setOwner(ctx.grid, u, cityCorp.id);
    }
    const families = familiesByCity.get(settlement.id) ?? [];
    if (families.length === 0) {
      for (const c of settlement.catchmentHexes) setOwner(ctx.grid, c, cityCorp.id);
    } else {
      let rri = 0;
      for (const c of settlement.catchmentHexes) {
        const fam = families[rri % families.length];
        if (fam === undefined) {
          setOwner(ctx.grid, c, cityCorp.id);
        } else {
          setOwner(ctx.grid, c, fam.actor.id);
        }
        rri += 1;
      }
    }
  }

  // Phase 8: ensure wilderness (any tile not in any settlement) is unowned.
  // Most procgen tiles default to ownerActor=null already, but be defensive
  // for re-seeds: clear any tile we did not explicitly claim.
  for (const tile of opts.grid.tiles()) {
    const [hex] = tile;
    if (!claimed.has(hexKey(hex))) {
      setOwner(opts.grid, hex, null);
    }
  }

  // Phase 8b: roads. Capital ↔ cities = Roman roads; cities ↔ villages
  // within cluster radius = dirt roads. Patrols, caravans, news carriers,
  // and the viewer all read tile.road; without this step the world has
  // no roads at all and every patrol collapses to a 5-hex urban loop.
  generateRoads({
    seed: `${opts.seed}|roads`,
    grid: opts.grid,
    settlements: opts.settlementSites,
  });

  // Phase 9: starter production buildings (per docs/07 §"Place starter
  // production buildings"). Every settlement gets pasture + farm so day-1
  // production has work; towns/cities additionally get mill + bakery +
  // granary; cities also get smithy + weaver_workshop.
  for (const site of opts.settlementSites) {
    const settlement = siteToSettlement.get(site);
    if (settlement === undefined) continue;
    seedStarterBuildings(ctx, settlement, site.kind);
  }

  // Phase 9b: assign each settlement's working-age adults to job roles
  // proportional to seeded building capacity (docs/04 §"Worker reallocation
  // by demand"). Without this, the production engine sees zero workers in
  // any role and recipes block on labor; the monthly reallocation hook in
  // tick.ts then nudges workers between roles based on observed shortages.
  for (const site of opts.settlementSites) {
    const settlement = siteToSettlement.get(site);
    if (settlement === undefined) continue;
    seedJobAllocations(settlement);
  }

  // Phase 10: initial bandit camps in wilderness (per docs/12 §"Bandit
  // emergence in the tick loop"). Procgen places ~1 small camp per
  // settled cluster in a forest/hill hex within 3-8 hexes of a road.
  // Without this seed, banditry never bootstraps because the recruit-
  // from-idle-pop fraction is tiny.
  const banditCamps = new Map<BanditCampId, BanditCamp>();
  seedInitialBanditCamps(ctx, opts.grid, opts.settlementSites, banditCamps);

  // Phase 11: initial patrols (per docs/12 §"Patrols (Roman-era)"). Each
  // city gets a provincial garrison (governor's stationarii) that walks the
  // road network up to ~30 hexes out, plus a city watch that loops the
  // urban core. Without these, no enforcement vs. bandit camps ever
  // happens — the docs/12 escalation chain has no first link.
  const patrols = new Map<string, Patrol>();
  seedInitialPatrols(ctx, opts.grid, opts.settlementSites, siteToSettlement, patrols);

  // Phase 12: merchant guilds (per docs/15 §C17). Each town/city gets a
  // guild Actor + a price ledger; nearby caravan_owner actors are auto-
  // enrolled. Without guilds, NPC caravan AI flies blind and crowding-
  // aware planning isn't possible (docs/08 + Decision 27).
  const guilds = new Map<ActorId, Guild>();
  seedMerchantGuilds(ctx, opts.settlementSites, siteToSettlement, guilds);

  // Phase 13: materialize Person records for every seeded moving unit.
  // Per docs/04 §"Person registry for moving units": each caravan crew
  // member, patrol soldier, and bandit fighter is a named individual
  // in the central registry. Settled villagers stay aggregate.
  const persons = emptyPersonRegistry();
  const personEquipment = new Map<PersonId, Map<ResourceId, number>>();
  seedPersonsForUnits(ctx, persons, personEquipment, patrols, banditCamps, opts.seed);

  return {
    day: 0,
    grid: opts.grid,
    settlements: ctx.settlements,
    actors: ctx.actors,
    factions: ctx.factions,
    characters: ctx.characters,
    caravans: new Map<CaravanId, Caravan>(),
    patrols,
    banditCamps,
    banditParties: new Map<BanditPartyId, BanditParty>(),
    newsCarriers: new Map<string, NewsCarrier>(),
    guilds,
    persons,
    personEquipment,
    reputation: createReputationTable(),
    bySite: opts.settlementSites,
  };
};

/**
 * Phase 13 — materialize a Person record per individual in every
 * seeded moving unit. Each Person's sex/age comes from the unit's
 * existing demographics map; names are generated via the same Latin
 * name pool used by NamedCharacter.
 *
 * Bandit camp fighters get the camp's faction. Patrol soldiers get a
 * derived faction id (governor / city). The newly-materialized records
 * are written into `persons` and linked back via `unitId`. No
 * equipment is issued at this stage — the equipment-issue path
 * follows later when starter weapons are pulled from the owning
 * actor's stockpile.
 */
const seedPersonsForUnits = (
  ctx: BuildContext,
  persons: Map<PersonId, Person>,
  personEquipment: Map<PersonId, Map<ResourceId, number>>,
  patrols: Map<string, PatrolType>,
  banditCamps: Map<BanditCampId, BanditCamp>,
  seed: string,
): void => {
  const nameRng = createRng(`seed-persons-${seed}`);
  let counter = 0;
  const newPersonId = (): PersonId => personId(`person-${String(counter++).padStart(6, '0')}`);

  const issueKit = (id: PersonId, items: readonly ResourceId[]): void => {
    const slot = new Map<ResourceId, number>();
    for (const item of items) {
      slot.set(item, (slot.get(item) ?? 0) + 1);
    }
    if (slot.size > 0) personEquipment.set(id, slot);
  };

  const draw = (
    role: 'soldier' | 'bandit' | 'bandit_hanger_on',
    demographics: ReadonlyMap<string, number> | undefined,
    unitId: string,
    faction: FactionId,
    klass: 'plebeian' | 'slave' | 'freedman' | 'foreigner' | 'patrician',
    weaponsScore: number,
    armorScore: number,
  ): void => {
    if (demographics === undefined) return;
    for (const [key, count] of demographics) {
      if (!Number.isInteger(count) || count <= 0) continue;
      const { sex, age: ageBand } = parseDemoKey(key);
      // Pick a representative age within the band (cohort midpoint).
      const bandMid = midpointOfAgeBand(ageBand);
      for (let i = 0; i < count; i++) {
        const name = `${generateLatinPraenomen(nameRng, sex)} ${generateLatinNomen(nameRng)}`;
        const id = newPersonId();
        const person = createPerson({
          id,
          name,
          age: bandMid,
          sex,
          class: klass,
          faction,
          role,
          bornOnDay: 0,
          unitId,
        });
        registerPerson(persons, person);
        // Issue kit deterministically from the unit's weapons/armor
        // scalars and the role. Per docs/03 §"Weapon-archetype
        // substitution policy": better-equipped units get the
        // preferred melee + a defense bundle; under-equipped
        // bandits/hangers-on carry only what their scalar implies.
        if (role === 'bandit_hanger_on') {
          // Hangers-on are not fighters; no kit.
          continue;
        }
        const kit: ResourceId[] = [];
        if (weaponsScore >= 0.7) {
          // Full-kit soldier.
          kit.push(resourceId('goods.gladius'));
          kit.push(resourceId('goods.pilum'));
        } else if (weaponsScore >= 0.4) {
          kit.push(resourceId('goods.hasta'));
        } else if (weaponsScore >= 0.1) {
          kit.push(resourceId('goods.dagger'));
        }
        if (armorScore >= 0.6) {
          kit.push(resourceId('goods.helmet'));
          kit.push(resourceId('goods.body_armor'));
          kit.push(resourceId('goods.shield'));
        } else if (armorScore >= 0.3) {
          kit.push(resourceId('goods.helmet'));
          kit.push(resourceId('goods.shield'));
        } else if (armorScore >= 0.1) {
          kit.push(resourceId('goods.shield'));
        }
        issueKit(id, kit);
      }
    }
  };

  for (const [campId, camp] of banditCamps) {
    // Bandit camps don't have a clean "class" field for fighters; treat
    // them as freedmen since they've left settled society. Hangers-on
    // inherit the same. Faction comes from camp's owner actor lookup —
    // we use the camp owner faction if discoverable, else camp id.
    const banditFaction = factionForActor(ctx, camp.ownerActor) ?? factionId(`faction:${String(campId)}`);
    draw(
      'bandit',
      camp.banditDemographics,
      String(campId),
      banditFaction,
      'freedman',
      camp.weaponsPerBandit,
      camp.armorPerBandit,
    );
    draw(
      'bandit_hanger_on',
      camp.hangersOnDemographics,
      String(campId),
      banditFaction,
      'freedman',
      0,
      0,
    );
  }

  for (const [id, patrol] of patrols) {
    const patrolFaction =
      factionForActor(ctx, patrol.ownerActor) ?? factionId(`faction:${String(patrol.ownerActor)}`);
    draw(
      'soldier',
      patrol.demographics,
      id,
      patrolFaction,
      'plebeian',
      patrol.unit.weapons,
      patrol.unit.armor,
    );
  }
};

const factionForActor = (ctx: BuildContext, actor: ActorId): FactionId | undefined => {
  for (const [fid, f] of ctx.factions) {
    if (f.actor === actor) return fid;
  }
  return undefined;
};

const midpointOfAgeBand = (band: string): number => {
  // Bands look like '0-4', '5-9', ..., '80+'. Use the midpoint as the
  // representative age for materialized Persons.
  if (band === '80+') return 82;
  const dash = band.indexOf('-');
  if (dash === -1) return 30;
  const lo = Number(band.slice(0, dash));
  const hi = Number(band.slice(dash + 1));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 30;
  return Math.round((lo + hi) / 2);
};

/**
 * Phase 12 — seed one merchant guild per town/city. Each guild has a
 * dedicated Actor entry (kind: 'merchant_guild') so coin movements
 * (membership dues, etc.) flow through the standard ledger.
 *
 * Members: every existing caravan_owner Actor that's homed at the
 * settlement (today there aren't any — caravans are owned by the
 * patron who dispatches them — but the structure is in place for
 * future merchant houses, and the cross-guild rumor exchange in
 * tick.ts uses this membership graph).
 *
 * For v1.5 we also auto-enroll the city corporation + the wealthiest
 * patrician family at the settlement as honorary members so the
 * guild ledger exchanges in tick.ts have something to trade.
 */
const seedMerchantGuilds = (
  ctx: BuildContext,
  sites: readonly SettlementSite[],
  siteToSettlement: Map<SettlementSite, Settlement>,
  guilds: Map<ActorId, Guild>,
): void => {
  for (const site of sites) {
    if (site.kind === 'hamlet' || site.kind === 'village') continue;
    const settlement = siteToSettlement.get(site);
    if (settlement === undefined) continue;

    const aId = actorId(nextId('actor'));
    const guildActor = createActor({
      id: aId,
      kind: 'merchant_guild',
      name: `Guild of Merchants of ${settlement.name}`,
      homeSettlement: settlement.id,
      // 5× scaled per realism pass 8.
      treasury: 2500,
    });
    addActor(ctx, guildActor);

    const guild = createGuild({
      id: aId,
      name: guildActor.name,
      homeSettlement: settlement.id,
    });

    // Auto-enroll local stockpile-owning patrician families + city corp.
    for (const oId of settlement.stockpileOwners) {
      const a = ctx.actors.get(oId);
      if (a === undefined) continue;
      if (a.kind === 'patrician_family' || a.kind === 'city_corporation') {
        addGuildMember(guild, a.id);
      }
    }

    guilds.set(aId, guild);
  }
};

/**
 * Phase 10 — seed a few initial bandit camps in wilderness near the
 * settled clusters. Each camp gets its own bandit_camp Actor + a
 * Faction + a named leader, plus the BanditCamp record itself in
 * world.banditCamps. Without these, banditry never bootstraps.
 */
const seedInitialBanditCamps = (
  ctx: BuildContext,
  grid: HexGrid,
  sites: readonly SettlementSite[],
  banditCamps: Map<BanditCampId, BanditCamp>,
): void => {
  const rng = ctx.rng.derive('initial-bandits');
  // Aim for ~1 camp per city site (≈1 per cluster).
  const targets = sites.filter((s) => s.kind === 'city' || s.kind === 'capital');
  if (targets.length === 0) return;
  const settlementHexKeys = new Set<string>();
  for (const s of sites) {
    for (const u of s.urbanHexes) settlementHexKeys.add(hexKey(u));
  }
  for (const target of targets) {
    // Find a wilderness hex (forest/hills) within ~6-12 hexes of the city
    // anchor that isn't a settlement hex. Spiral outward; first match wins.
    const center = target.anchor;
    const candidates: Hex[] = [];
    for (const ring of [6, 8, 10, 12]) {
      for (const h of hexesWithinRange(center, ring)) {
        if (hexDistance(h, center) < ring - 2) continue; // outer ring only
        if (settlementHexKeys.has(hexKey(h))) continue;
        const tile = grid.get(h);
        if (tile === undefined) continue;
        if (
          tile.terrain !== 'forest' &&
          tile.terrain !== 'dense_forest' &&
          tile.terrain !== 'hills'
        ) {
          continue;
        }
        candidates.push(h);
      }
      if (candidates.length > 0) break;
    }
    if (candidates.length === 0) continue;
    const hex = rng.pick(candidates);

    // Spawn the camp.
    const aId = actorId(nextId('actor'));
    const fId = factionId(nextId('faction'));
    const leaderId = characterId(nextId('char'));
    const campId = banditCampId(nextId('camp'));
    const leaderName = generateFullName(rng, 'male');
    const actor = createActor({
      id: aId,
      kind: 'bandit_camp',
      name: `${leaderName}'s band`,
      // 5× scaled per realism pass 8.
      treasury: rng.int(100, 500),
    });
    const leader = createCharacter({
      id: leaderId,
      name: leaderName,
      age: rng.int(28, 50),
      sex: 'male',
      class: 'plebeian',
      faction: fId,
      role: 'bandit_leader',
      location: hex,
    });
    const faction = createFaction({
      id: fId,
      actor: aId,
      name: `${leaderName}'s band`,
      members: [leaderId],
    });
    addActor(ctx, actor);
    addFaction(ctx, faction);
    addCharacter(ctx, leader);

    // v1.9 step 5: bumped from rng.int(8, 18) so seeded camps survive
    // first patrol contact. A 24-strong governor garrison with kit
    // 0.85/0.65 obliterated 8-bandit camps in days; 20-40 bandits
    // gives them a fighting chance to grow toward the recruitment
    // cap before being wiped.
    const banditCount = rng.int(20, 40);
    const hangersOnCount = rng.int(5, 12);
    // Demographics: bandits are recruited locally per docs/12 §"Banditry as
    // a fate" → draw from the city's working-age pool the camp shadows.
    // Hangers-on (children, captives, dependents) come from the same pool
    // but with a wider, less male-dominated bias.
    const sourceCity = [...ctx.settlements.values()].find(
      (s) => s.anchor.q === target.anchor.q && s.anchor.r === target.anchor.r,
    );
    const banditDemographics = drawDemographicsFromPool(
      sourceCity?.population,
      banditCount,
      ROLE_BIASES.bandit,
      rng.derive(`bandit-demo-${String(campId)}`),
    );
    const hangersOnDemographics = drawDemographicsFromPool(
      sourceCity?.population,
      hangersOnCount,
      ROLE_BIASES.bandit_hanger_on,
      rng.derive(`hangers-demo-${String(campId)}`),
    );
    const camp = createCamp({
      id: campId,
      name: `${leaderName}'s band`,
      hex,
      ownerActor: aId,
      banditCount,
      hangersOnCount,
      weaponsPerBandit: 0.4,
      armorPerBandit: 0.15,
      averageHealth: 0.85,
      treasury: actor.treasury,
      banditDemographics,
      hangersOnDemographics,
    });
    banditCamps.set(campId, camp);
  }
};

/**
 * Phase 11 — seed garrison + city-watch patrols around each city. Per
 * docs/12: the governor's office bases its provincial garrison at the
 * capital (and any other major city); each city watch is funded by the
 * city corporation. Patrol units are small but trained — enough to
 * deter or kill a small bandit camp on the road.
 */
const seedInitialPatrols = (
  ctx: BuildContext,
  grid: HexGrid,
  sites: readonly SettlementSite[],
  siteToSettlement: Map<SettlementSite, Settlement>,
  patrols: Map<string, PatrolType>,
): void => {
  const rng = ctx.rng.derive('initial-patrols');
  let counter = 0;
  for (const site of sites) {
    if (site.kind !== 'city' && site.kind !== 'capital') continue;
    const settlement = siteToSettlement.get(site);
    if (settlement === undefined) continue;

    // Find the actors anchored to this settlement.
    let governorActor: Actor | undefined;
    let cityCorpActor: Actor | undefined;
    for (const a of ctx.actors.values()) {
      if (a.kind === 'governor_office' && a.homeSettlement === settlement.id) {
        governorActor = a;
      }
      if (a.kind === 'city_corporation' && a.homeSettlement === settlement.id) {
        cityCorpActor = a;
      }
    }

    // 1 garrison patrol per major city (governor's stationarii).
    if (governorActor !== undefined) {
      const garrisonRoute = routeForGarrisonPatrol(settlement, grid);
      if (garrisonRoute.length > 0) {
        const id = `patrol-garrison-${counter++}`;
        const count = 24; // ~one century / contubernia detachment
        const unit = campaignerUnit({
          id: `patrol:${id}`,
          posture: 'attacking',
          count,
          training: 0.85,
          weapons: 0.8,
          armor: 0.65,
          health: 0.95,
          terrainBonus: 0,
        });
        const demographics = drawDemographicsFromPool(
          settlement.population,
          count,
          ROLE_BIASES.patrol_soldier,
          rng.derive(`patrol-demo-${id}`),
        );
        patrols.set(
          id,
          createPatrol({
            id,
            kind: 'provincial_garrison',
            ownerActor: governorActor.id,
            basedAt: settlement.id,
            route: garrisonRoute,
            unit,
            demographics,
          }),
        );
      }
    }

    // 1 city watch per city (city corporation funds).
    if (cityCorpActor !== undefined) {
      const watchRoute = routeForCityWatch(settlement, grid);
      if (watchRoute.length > 0) {
        const id = `patrol-watch-${counter++}`;
        const count = 12; // a small watch
        const unit = campaignerUnit({
          id: `patrol:${id}`,
          posture: 'attacking',
          count,
          training: 0.55,
          weapons: 0.5,
          armor: 0.3,
          health: 0.9,
          terrainBonus: 0,
        });
        const demographics = drawDemographicsFromPool(
          settlement.population,
          count,
          ROLE_BIASES.patrol_soldier,
          rng.derive(`patrol-demo-${id}`),
        );
        patrols.set(
          id,
          createPatrol({
            id,
            kind: 'city_watch',
            ownerActor: cityCorpActor.id,
            basedAt: settlement.id,
            route: watchRoute,
            unit,
            demographics,
          }),
        );
      }
    }
  }
};

// --- helpers ----------------------------------------------------------------

const SITE_ORDER: ReadonlyMap<SettlementSite['kind'], number> = new Map([
  ['capital', 0],
  ['city', 1],
  ['town', 2],
  ['village', 3],
  ['hamlet', 4],
]);

const orderSitesForCatchment = (sites: readonly SettlementSite[]): readonly SettlementSite[] => {
  // Per docs/05 §"Same-hex coexistence": when two settlements compete for
  // the same hex (in particular when they share an urban hex), the larger
  // settlement gets first pick of the surrounding ring. The closer-wins
  // rule already lives inside computeCatchment via the `alreadyClaimed`
  // set; we extend it here by ordering same-tier sites by estimated
  // population (descending) so the bigger village/hamlet runs first.
  // Ties broken deterministically by axial coordinate for reproducibility.
  return [...sites].sort((a, b) => {
    const ai = SITE_ORDER.get(a.kind) ?? 99;
    const bi = SITE_ORDER.get(b.kind) ?? 99;
    if (ai !== bi) return ai - bi;
    if (b.estimatedPopulation !== a.estimatedPopulation) {
      return b.estimatedPopulation - a.estimatedPopulation;
    }
    if (a.anchor.q !== b.anchor.q) return a.anchor.q - b.anchor.q;
    return a.anchor.r - b.anchor.r;
  });
};

const claimVillageHexes = (grid: HexGrid, settlement: Settlement, owner: ActorId): void => {
  // Per docs/05 §"Same-hex coexistence": when a hamlet shares an urban hex
  // with a larger village (or village with a town), the larger settlement
  // retains hex ownership. Catchment hexes have already been arbitrated by
  // `computeCatchment`'s closer-wins rule — no two settlements share a
  // catchment hex — so we always claim those.
  for (const u of settlement.urbanHexes) {
    const tile = grid.get(u);
    if (tile === undefined) continue;
    if (tile.ownerActor === null) {
      tile.ownerActor = owner;
    }
    // else: a larger-tier settlement already owns this hex; skip.
  }
  for (const c of settlement.catchmentHexes) setOwner(grid, c, owner);
};

/**
 * Pick the most appropriate stockpile owner for a building in this
 * settlement. Preference: city_corporation > first stockpile owner >
 * undefined.
 */
const pickBuildingOwner = (ctx: BuildContext, settlement: Settlement): ActorId | undefined => {
  for (const a of ctx.actors.values()) {
    if (a.kind === 'city_corporation' && a.homeSettlement === settlement.id) {
      return a.id;
    }
  }
  return settlement.stockpileOwners[0];
};

/**
 * Add a building of `kind` at `hex` if `hex` is in the settlement and
 * the building hasn't been added there already (idempotent). Capacity
 * defaults are scaled with the settlement tier.
 */
const tryAddBuilding = (
  settlement: Settlement,
  kind: string,
  hex: Hex,
  ownerActor: ActorId,
  capacity: number,
): void => {
  // Don't double-add at the same hex/type.
  for (const b of settlement.buildings) {
    if (String(b.buildingId) === kind && hexEquals(b.hex, hex)) return;
  }
  addBuilding(settlement, {
    buildingId: buildingId(kind),
    hex,
    ownerActor,
    capacity,
    maxCapacity: capacity,
    daysSinceMaintained: 0,
  });
};

// Building capacity scales with tier. Each unit = one recipe-instance per
// day. We size these so a settlement's per-day production roughly meets
// its per-day subsistence — population × ~0.4 kg grain-equiv / day, with
// each capacity unit producing ~30-50 kg of food. A hamlet of 100 needs
// ~40 kg/day; cap=10 with mix of pasture+farm covers it. A city of 30k
// needs ~12 t/day; cap=400 across multiple buildings is the start.
const TIER_CAPACITY: Record<SettlementTier, number> = {
  hamlet: 10,
  village: 30,
  town: 80,
  small_city: 200,
  large_city: 400,
};

// Building-specific multipliers on the tier capacity. Reasoning:
//   - forester_camp + charcoal_kiln carry a much heavier load now that
//     fell_timber outputs only 1.5 wood/instance and bake_bread consumes
//     5 wood/instance (per docs/03 worked examples, restored in v1.5
//     C2). Without these multipliers the wood chain is the binding
//     constraint and the world starves within ~60 days of a fresh seed.
//   - bloomery + smithy similarly need higher per-building throughput
//     because smelt_iron at 60+100→15 means each tool-forging cycle
//     burns through orders of magnitude more charcoal.
//   - pasture is a real bottleneck per the steady-state analyzer; one
//     pasture per settlement at the tier cap covers most pastoral
//     demand once the herd is established.
//   - bakery needs ~1.5x mill capacity: mill_grain produces 45 flour/run
//     and bake_bread consumes 30 flour/run.
// All other buildings keep the tier-default cap.
const BUILDING_CAP_MULTIPLIER: Record<string, number> = {
  bakery: 1.5,
  forester_camp: 4,
  charcoal_kiln: 2,
  bloomery: 2,
  smithy: 2,
  pasture: 2,
};

const capacityFor = (kind: string, tier: SettlementTier): number => {
  const base = TIER_CAPACITY[tier];
  const mul = BUILDING_CAP_MULTIPLIER[kind] ?? 1;
  return base * mul;
};

const MINEABLE_DEPOSIT_RESOURCES: ReadonlySet<string> = new Set([
  'mineral.iron_ore',
  'mineral.copper_ore',
  'mineral.tin_ore',
  'mineral.lead_ore',
  'mineral.silver_ore',
  'mineral.gold_ore',
  'mineral.salt',
]);

const SMELTABLE_ORE_RESOURCES: ReadonlySet<string> = new Set([
  'mineral.iron_ore',
  'mineral.copper_ore',
  'mineral.tin_ore',
  'mineral.lead_ore',
  'mineral.silver_ore',
  'mineral.gold_ore',
]);

const depositResourceAt = (ctx: BuildContext, h: Hex): string | undefined => {
  const deposit = ctx.grid.get(h)?.deposit;
  if (deposit === undefined || deposit.remaining <= 0) return undefined;
  return String(deposit.resource);
};

const mineableDepositHexes = (ctx: BuildContext, hexes: readonly Hex[]): readonly Hex[] =>
  hexes.filter((h) => {
    const resource = depositResourceAt(ctx, h);
    return resource !== undefined && MINEABLE_DEPOSIT_RESOURCES.has(resource);
  });

const hasSmeltableOreDeposit = (ctx: BuildContext, hexes: readonly Hex[]): boolean =>
  hexes.some((h) => {
    const resource = depositResourceAt(ctx, h);
    return resource !== undefined && SMELTABLE_ORE_RESOURCES.has(resource);
  });

const miningClaimRadiusFor = (tier: SettlementTier): number => {
  switch (tier) {
    case 'hamlet':
      return 0;
    case 'village':
      return 4;
    case 'town':
      return 7;
    case 'small_city':
    case 'large_city':
      return 10;
  }
};

const settlementHexKeys = (settlement: Settlement): Set<string> =>
  new Set([...settlement.urbanHexes, ...settlement.catchmentHexes].map(hexKey));

const claimNearbyMiningDeposits = (
  ctx: BuildContext,
  settlement: Settlement,
  ownerActor: ActorId,
): void => {
  const radius = miningClaimRadiusFor(settlement.tier);
  if (radius <= 0) return;
  const known = settlementHexKeys(settlement);
  for (const [h, tile] of ctx.grid.withinRange(settlement.anchor, radius)) {
    const deposit = tile.deposit;
    if (
      deposit === undefined ||
      deposit.remaining <= 0 ||
      !MINEABLE_DEPOSIT_RESOURCES.has(String(deposit.resource))
    ) {
      continue;
    }
    const key = hexKey(h);
    if (tile.ownerActor !== null && !known.has(key)) continue;
    if (!known.has(key)) {
      settlement.catchmentHexes.push(h);
      known.add(key);
    }
    if (tile.ownerActor === null) tile.ownerActor = ownerActor;
  }
};

/**
 * Phase 9 building seeding. Per docs/07 §"Place starter production
 * buildings" + docs/05 §"Stage-1 seeding rules": every settlement
 * gets pasture + farm; villages/towns/cities additionally get crafts,
 * mines (where deposits exist), and refining; towns/cities add the
 * grain refining chain and Mediterranean comfort foods.
 *
 * Hex selection is **terrain-aware** via `pickBestHex` from
 * `src/sim/buildings/placement.ts`: each candidate hex is scored
 * against the building's terrain affinity matrix and the highest-
 * scoring free hex wins. A farm picks fertile valley over steppe; a
 * vineyard picks a Mediterranean hill over plains; a forester camp
 * picks the forest hex in the catchment over wilderness flatland.
 * Ties are broken by deterministic (q, r) order so seeded worlds stay
 * reproducible.
 */
const seedStarterBuildings = (
  ctx: BuildContext,
  settlement: Settlement,
  siteKind: SettlementSite['kind'],
): void => {
  const owner = pickBuildingOwner(ctx, settlement);
  if (owner === undefined) return;
  const tier = settlement.tier;
  const capOf = (kind: string): number => capacityFor(kind, tier);

  claimNearbyMiningDeposits(ctx, settlement, owner);

  // Build candidate pools once. Each candidate carries its tile and a
  // pre-computed `waterAdjacent` + `isUrban` flag so the affinity
  // scorer doesn't need to repeat neighbor lookups per building, and
  // so urban hexes (which may keep their plains / fertile_valley
  // terrain) still rank as urban for workshops / storage / civic.
  const buildCandidate = (h: Hex, isUrban: boolean): PlacementCandidate | null => {
    const tile = ctx.grid.get(h);
    if (tile === undefined) return null;
    let waterAdjacent = tile.hasRiver || tile.terrain === 'river' || tile.terrain === 'lake';
    if (!waterAdjacent) {
      for (const n of hexesWithinRange(h, 1)) {
        const nt = ctx.grid.get(n);
        if (nt === undefined) continue;
        if (nt.hasRiver || nt.terrain === 'river' || nt.terrain === 'lake') {
          waterAdjacent = true;
          break;
        }
      }
    }
    return { hex: h, tile, waterAdjacent, isUrban };
  };

  const catchmentCandidates = settlement.catchmentHexes
    .map((h) => buildCandidate(h, false))
    .filter((c): c is PlacementCandidate => c !== null);
  const urbanCandidates = settlement.urbanHexes
    .map((h) => buildCandidate(h, true))
    .filter((c): c is PlacementCandidate => c !== null);
  if (urbanCandidates.length === 0) return;

  // Hamlets without claimed catchment fall back to urban land for
  // subsistence buildings (garden plots, common pasture worked from
  // the home hex).
  const subsistenceCandidates =
    catchmentCandidates.length > 0
      ? [...catchmentCandidates, ...urbanCandidates]
      : urbanCandidates;

  // Track which hexes already host this building kind so the picker
  // doesn't choose a duplicate.
  const placeBest = (
    kind: string,
    pool: readonly PlacementCandidate[],
    capacity: number,
  ): boolean => {
    const free = pool.filter((c) => !buildingExistsAt(settlement, kind, c.hex));
    const pick = pickBestHex(buildingId(kind), free);
    if (pick === null) return false;
    tryAddBuilding(settlement, kind, pick.hex, owner, capacity);
    return true;
  };

  // Every settlement: subsistence floor.
  placeBest('pasture', subsistenceCandidates, capOf('pasture'));
  placeBest('farm', subsistenceCandidates, capOf('farm'));
  placeBest('forester_camp', subsistenceCandidates, capOf('forester_camp'));
  // Sawmill prefers river-adjacent land; fall back to urban.
  placeBest('sawmill', [...urbanCandidates, ...catchmentCandidates], capOf('sawmill'));
  // Fishery requires water-adjacent — placement scorer returns 0
  // otherwise, so `placeBest` no-ops when nothing qualifies.
  placeBest('fishery', [...urbanCandidates, ...catchmentCandidates], capOf('fishery'));

  const mineHexes = mineableDepositHexes(ctx, settlement.catchmentHexes);
  const hasOreForSmelting = hasSmeltableOreDeposit(ctx, settlement.catchmentHexes);

  if (
    settlement.tier === 'village' ||
    settlement.tier === 'town' ||
    settlement.tier === 'small_city' ||
    settlement.tier === 'large_city'
  ) {
    // Charcoal kiln likes forest-edge land; fall back to urban.
    placeBest(
      'charcoal_kiln',
      [...urbanCandidates, ...catchmentCandidates],
      capOf('charcoal_kiln'),
    );
    // Mines are deposit-gated; place one per deposit hex (the deposit
    // already enforces the terrain).
    for (const mineHex of mineHexes) {
      tryAddBuilding(settlement, 'mine', mineHex, owner, capOf('mine'));
    }
    if (hasOreForSmelting) {
      placeBest('bloomery', urbanCandidates, capOf('bloomery'));
    }
    placeBest('smithy', urbanCandidates, capOf('smithy'));
    placeBest('dairy', urbanCandidates, capOf('dairy'));
    placeBest('weaver_workshop', urbanCandidates, capOf('weaver_workshop'));
    // Tannery wants water-adjacency for the soaking pits.
    placeBest('tannery', [...urbanCandidates, ...catchmentCandidates], capOf('tannery'));
    placeBest('tailor_shop', urbanCandidates, capOf('tailor_shop'));
    placeBest('kiln', urbanCandidates, capOf('kiln'));
    placeBest('pottery', urbanCandidates, capOf('pottery'));
    placeBest('olive_grove', catchmentCandidates, capOf('olive_grove'));
    placeBest('vineyard', catchmentCandidates, capOf('vineyard'));
    placeBest('oil_press', urbanCandidates, capOf('oil_press'));
    placeBest('winery', urbanCandidates, capOf('winery'));
    placeBest('quarry', catchmentCandidates, capOf('quarry'));
  }

  if (
    settlement.tier === 'town' ||
    settlement.tier === 'small_city' ||
    settlement.tier === 'large_city'
  ) {
    // Mill loves river-adjacent land; sawmill already placed above.
    placeBest('mill', [...urbanCandidates, ...catchmentCandidates], capOf('mill'));
    placeBest('bakery', urbanCandidates, capOf('bakery'));
    placeBest('granary', urbanCandidates, capOf('granary'));
    // Town/city duplicates of village workshops — only place if the
    // village pass missed (lower-tier hamlets don't get to the village
    // block at all, and these are no-ops for towns/cities which
    // already placed them).
    placeBest('weaver_workshop', urbanCandidates, capOf('weaver_workshop'));
    placeBest('tannery', [...urbanCandidates, ...catchmentCandidates], capOf('tannery'));
    placeBest('oil_press', urbanCandidates, capOf('oil_press'));
    placeBest('winery', urbanCandidates, capOf('winery'));
    placeBest('kiln', urbanCandidates, capOf('kiln'));
    placeBest('pottery', urbanCandidates, capOf('pottery'));
    placeBest('tailor_shop', urbanCandidates, capOf('tailor_shop'));
    placeBest('cart_wright', urbanCandidates, capOf('cart_wright'));
    placeBest('forum_market', urbanCandidates, 1);
    placeBest('temple', urbanCandidates, 1);
    placeBest('barracks', urbanCandidates, 1);
  }

  // Mint: per docs/10 decision 46 (v1.9), ONLY the capital hosts a mint.
  // Other cities buy silver-denominated coin from the capital's mint
  // through normal market trade (silver flows from mining sites to the
  // capital because the capital is the only buyer with derived-input
  // demand for silver). Without a mint, no coin enters the province
  // endogenously and the money supply only declines (via off-map
  // exits). Per docs/08 §"Mint output flows to treasury" the mint's
  // output credits the owner's treasury directly.
  if (siteKind === 'capital') {
    placeBest('mint', urbanCandidates, 1);
  }
};

const buildingExistsAt = (s: Settlement, kind: string, hex: Hex): boolean => {
  for (const b of s.buildings) {
    if (String(b.buildingId) === kind && hexEquals(b.hex, hex)) return true;
  }
  return false;
};

/**
 * Distribute working-age adults across job roles based on seeded building
 * capacity. Per docs/04 §"Worker reallocation by demand": each adult is
 * assigned to a single job; the production engine then treats them as
 * available *only* for that role. The monthly reallocation hook in
 * tick.ts shifts ~3% of workers per month between roles based on
 * observed shortages.
 *
 * Algorithm (deterministic):
 *   1. Sum the working-age adult count (15..59 inclusive) across cohorts.
 *   2. For each building, compute its (capacity × labor weight) per job
 *      role using jobsForBuilding(). Skip buildings whose primary job is
 *      restricted by class — we don't enforce class restrictions at this
 *      level; the recipe engine does.
 *   3. Allocate adults to roles in proportion to those weights using
 *      largest-remainder rounding so the total matches.
 *   4. Any leftover adults (no buildings to staff, or rounding drift) go
 *      to the 'idle' bucket.
 */
const seedJobAllocations = (settlement: Settlement): void => {
  let adults = 0;
  for (const [key, count] of settlement.population.cohorts()) {
    const a = parseInt(key.age.split('-')[0] ?? '0', 10);
    if (a >= 15 && a < 60) adults += count;
  }
  // Always reset; this is the procgen day-0 distribution.
  settlement.jobAllocations.clear();
  if (adults <= 0) return;

  // Aggregate per-job weight from buildings × labor weights.
  const weights = new Map<JobId, number>();
  for (const b of settlement.buildings) {
    const jobs = jobsForBuilding(b.buildingId);
    if (jobs.size === 0) continue;
    const cap = Math.max(0, b.capacity);
    for (const [job, w] of jobs) {
      weights.set(job, (weights.get(job) ?? 0) + cap * w);
    }
  }

  if (weights.size === 0) {
    // No staffable buildings; everyone is idle.
    settlement.jobAllocations.set(jobId('idle'), adults);
    return;
  }

  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;
  if (totalWeight <= 0) {
    settlement.jobAllocations.set(jobId('idle'), adults);
    return;
  }

  // Largest-remainder rounding so the integer counts sum to adults.
  // Sort jobs deterministically (lexicographic by id) so the assignment
  // is reproducible across runs.
  const ordered = [...weights.entries()].sort((a, b) =>
    String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
  );
  const exact = ordered.map(([j, w]) => ({ job: j, exact: (adults * w) / totalWeight }));
  const floored = exact.map((e) => ({
    job: e.job,
    count: Math.floor(e.exact),
    frac: e.exact - Math.floor(e.exact),
  }));
  let assigned = floored.reduce((acc, f) => acc + f.count, 0);
  let remainder = adults - assigned;
  // Distribute remainder to highest-fraction entries first; ties broken by
  // job-id order (already sorted).
  const indices = floored
    .map((_, i) => i)
    .sort((a, b) => {
      const fa = floored[a]?.frac ?? 0;
      const fb = floored[b]?.frac ?? 0;
      if (fb !== fa) return fb - fa;
      return a - b;
    });
  for (const idx of indices) {
    if (remainder <= 0) break;
    const f = floored[idx];
    if (f === undefined) continue;
    f.count += 1;
    assigned += 1;
    remainder -= 1;
  }
  for (const f of floored) {
    if (f.count > 0) settlement.jobAllocations.set(f.job, f.count);
  }
};

const clampFamilies = (n: number): number => {
  if (!Number.isFinite(n)) return 4;
  const i = Math.round(n);
  if (i < 1) return 1;
  if (i > 12) return 12;
  return i;
};

const clampFraction = (f: number): number => {
  if (!Number.isFinite(f)) return 0;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
};

// References to keep ts-prune from flagging these as unused; they're part of
// the public surface that callers (tests + future ticks) reach via WorldState.
void hexEquals;
void agedKey;
void ACTOR_KINDS;
