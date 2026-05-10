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
import {
  ACTOR_KINDS,
  createActor,
  createCharacter,
  createFaction,
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
import {
  actorId,
  banditCampId,
  buildingId,
  characterId,
  factionId,
  resourceId,
  settlementId,
  type ActorId,
  type BanditCampId,
  type CaravanId,
  type CharacterId,
  type Day,
  type FactionId,
  type SettlementId,
} from '../sim/types.js';
import type { HexGrid } from '../sim/world/grid.js';
import { hexDistance, hexEquals, hexKey, hexesWithinRange, type Hex } from '../sim/world/hex.js';
import { createCamp } from '../sim/bandit/camp.js';
import { campaignerUnit } from '../sim/conflict/battle.js';
import { createPatrol, type Patrol as PatrolType } from '../sim/conflict/patrol.js';
import { routeForGarrisonPatrol, routeForCityWatch } from '../sim/conflict/patrolRoutes.js';
import type { SettlementSite } from './settlements.js';

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
  readonly newsCarriers?: Map<string, NewsCarrier>;
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
// 365-day reserve so the world survives from any procgen start day to the
// first autumn harvest. Historically Roman granaries held a few months;
// burn-in stability needs more headroom because we don't yet model
// shipped-in tribute grain that smoothed real-world seasonality. Tunable.
const GRAIN_DAYS_OF_RESERVE = 365;

const grainModiiForPopulation = (totalPop: number, days: number): number => {
  const kg = totalPop * GRAIN_KG_PER_DAY * days;
  return Math.round(kg / KG_PER_MODIUS);
};

const grantStockpile = (actor: Actor, resource: string, qty: number): void => {
  if (qty <= 0) return;
  // ADD to existing stockpile (not replace) so a patron family granted
  // reserves by multiple of their client villages accumulates the total.
  // The previous .set() silently dropped earlier grants, leaving multi-
  // village patrons with only their last village's grant — the root
  // cause of the burn-in famine cascade.
  const id = resourceId(resource);
  const existing = actor.stockpile.get(id) ?? 0;
  actor.stockpile.set(id, existing + qty);
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
    treasury: familyRng.int(2000, 8000),
  });
  const patriarch = createCharacter({
    id: cId,
    name: generateFullName(familyRng, 'male'),
    age: familyRng.int(35, 60),
    sex: 'male',
    class: 'patrician',
    faction: fId,
    role: 'patriarch',
    location: city.anchor,
  });
  const faction = createFaction({
    id: fId,
    actor: aId,
    name: `Family ${nomen}`,
    members: [cId],
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
    treasury: govRng.int(20000, 50000),
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
    treasury: 5000,
  });
  addActor(ctx, actor);
  settlement.stockpileOwners.push(aId);
  // City reserves: a year of grain + ample wood for bakeries/charcoal +
  // amphorae for olive press / wine + tools so smiths can equip people
  // even before the smithy produces fresh ones. v1 burn-in stability
  // bootstrap; v1.5 will replace these with proper storage capacity.
  const pop = settlement.population.total();
  grantStockpile(actor, 'food.grain', grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE));
  grantStockpile(actor, 'material.wood', pop * 5);
  grantStockpile(actor, 'material.amphora', Math.max(20, Math.floor(pop / 5)));
  grantStockpile(actor, 'goods.tools', Math.max(500, pop * 20));
  return actor;
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
    treasury: villageRng.int(50, 300),
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
  // Year's grain reserve so the village survives until first autumn
  // harvest under any procgen start day. See GRAIN_DAYS_OF_RESERVE rationale.
  const pop = settlement.population.total();
  grantStockpile(actor, 'food.grain', grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE));
  // Tools: bumped to a year's worth at expected farm consumption (~3
  // tools/day on a village farm). v1.5: replace with smithy production.
  grantStockpile(actor, 'goods.tools', Math.max(500, pop * 20));
  // Wood + amphora reserves so the food chain isn't immediately blocked
  // (bake_bread needs wood; press_olives needs amphora).
  grantStockpile(actor, 'material.wood', pop * 5);
  grantStockpile(actor, 'material.amphora', Math.max(10, Math.floor(pop / 10)));
  return actor;
};

const seedClientVillage = (ctx: BuildContext, settlement: Settlement, patron: Actor): void => {
  const villageRng = ctx.rng.derive(`client-village-${String(settlement.id)}`);
  // The patron's faction is in the city, but we still want a named headman in
  // the village. The headman belongs to the patron's faction (a freedman
  // managing the estate) so reputation lookups walk back to the patron.
  const headmanId = characterId(nextId('char'));
  // Find the patron's faction (each patrician_family has exactly one).
  const patronFaction = [...ctx.factions.values()].find((f) => f.actor === patron.id);
  if (patronFaction === undefined) {
    throw new Error(`seedClientVillage: patron ${String(patron.id)} has no faction`);
  }
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
  addCharacter(ctx, headman);
  settlement.factions.push(patronFaction.id);
  settlement.stockpileOwners.push(patron.id);
  // Year's grain reserve held by the patron — same survival window as other tiers.
  const pop = settlement.population.total();
  grantStockpile(patron, 'food.grain', grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE));
  grantStockpile(patron, 'goods.tools', Math.max(500, pop * 20));
  grantStockpile(patron, 'material.wood', pop * 5);
  grantStockpile(patron, 'material.amphora', Math.max(10, Math.floor(pop / 10)));
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
    treasury: hamletRng.int(10, 80),
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
  grantStockpile(actor, 'food.grain', grainModiiForPopulation(pop, GRAIN_DAYS_OF_RESERVE));
  grantStockpile(actor, 'goods.tools', Math.max(500, pop * 20));
  grantStockpile(actor, 'material.wood', pop * 5);
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

  // Phase 9: starter production buildings (per docs/07 §"Place starter
  // production buildings"). Every settlement gets pasture + farm so day-1
  // production has work; towns/cities additionally get mill + bakery +
  // granary; cities also get smithy + weaver_workshop.
  for (const site of opts.settlementSites) {
    const settlement = siteToSettlement.get(site);
    if (settlement === undefined) continue;
    seedStarterBuildings(ctx, settlement);
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
    newsCarriers: new Map<string, NewsCarrier>(),
    reputation: createReputationTable(),
    bySite: opts.settlementSites,
  };
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
        if (tile.terrain !== 'forest' && tile.terrain !== 'dense_forest' && tile.terrain !== 'hills') {
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
      treasury: rng.int(20, 100),
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

    const camp = createCamp({
      id: campId,
      name: `${leaderName}'s band`,
      hex,
      ownerActor: aId,
      banditCount: rng.int(8, 18),
      hangersOnCount: rng.int(2, 6),
      weaponsPerBandit: 0.4,
      armorPerBandit: 0.15,
      averageHealth: 0.85,
      treasury: actor.treasury,
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
        const unit = campaignerUnit({
          id: `patrol:${id}`,
          posture: 'attacking',
          count: 24, // ~one century / contubernia detachment
          training: 0.85,
          weapons: 0.8,
          armor: 0.65,
          health: 0.95,
          terrainBonus: 0,
        });
        patrols.set(
          id,
          createPatrol({
            id,
            kind: 'provincial_garrison',
            ownerActor: governorActor.id,
            basedAt: settlement.id,
            route: garrisonRoute,
            unit,
          }),
        );
      }
    }

    // 1 city watch per city (city corporation funds).
    if (cityCorpActor !== undefined) {
      const watchRoute = routeForCityWatch(settlement, grid);
      if (watchRoute.length > 0) {
        const id = `patrol-watch-${counter++}`;
        const unit = campaignerUnit({
          id: `patrol:${id}`,
          posture: 'attacking',
          count: 12, // a small watch
          training: 0.55,
          weapons: 0.5,
          armor: 0.3,
          health: 0.9,
          terrainBonus: 0,
        });
        patrols.set(
          id,
          createPatrol({
            id,
            kind: 'city_watch',
            ownerActor: cityCorpActor.id,
            basedAt: settlement.id,
            route: watchRoute,
            unit,
          }),
        );
      }
    }
  }
  void rng;
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
  return [...sites].sort((a, b) => {
    const ai = SITE_ORDER.get(a.kind) ?? 99;
    const bi = SITE_ORDER.get(b.kind) ?? 99;
    return ai - bi;
  });
};

const claimVillageHexes = (grid: HexGrid, settlement: Settlement, owner: ActorId): void => {
  for (const u of settlement.urbanHexes) setOwner(grid, u, owner);
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

/**
 * Phase 9 building seeding. Per docs/07 §"Place starter production
 * buildings": every settlement gets a pasture + farm; towns/cities
 * additionally get mill + bakery + granary; cities also get smithy +
 * weaver_workshop. All sit in catchment hexes (production) or urban
 * hexes (workshops/storage). Hex picks are deterministic from the
 * settlement's existing hex order.
 */
const seedStarterBuildings = (ctx: BuildContext, settlement: Settlement): void => {
  const owner = pickBuildingOwner(ctx, settlement);
  if (owner === undefined) return;
  const cap = TIER_CAPACITY[settlement.tier];

  const catchment = settlement.catchmentHexes;
  if (catchment.length === 0) return;

  const cHex = (i: number): Hex => (catchment[i % catchment.length] ?? (catchment[0] as Hex)) as Hex;
  const uHex = (i: number): Hex =>
    (settlement.urbanHexes[i % settlement.urbanHexes.length] ?? (settlement.urbanHexes[0] as Hex)) as Hex;

  // Every settlement: pasture + farm + forester_camp + sawmill so wood
  // and lumber regenerate (closing the chain that supplies bake_bread,
  // smithy maintenance, etc.). Pasture provides year-round protein
  // alongside grain.
  tryAddBuilding(settlement, 'pasture', cHex(0), owner, cap);
  tryAddBuilding(settlement, 'farm', cHex(1), owner, cap);
  tryAddBuilding(settlement, 'forester_camp', cHex(2), owner, cap);
  tryAddBuilding(settlement, 'sawmill', cHex(3), owner, cap);

  // Village+: add charcoal_kiln so smithies have fuel; mine + bloomery so
  // iron production isn't gated on a procgen ore deposit landing in the
  // catchment (deposits are rare).
  if (
    settlement.tier === 'village' ||
    settlement.tier === 'town' ||
    settlement.tier === 'small_city' ||
    settlement.tier === 'large_city'
  ) {
    tryAddBuilding(settlement, 'charcoal_kiln', cHex(4), owner, cap);
    tryAddBuilding(settlement, 'mine', cHex(5), owner, cap);
    tryAddBuilding(settlement, 'bloomery', uHex(0), owner, cap);
    tryAddBuilding(settlement, 'smithy', uHex(0), owner, cap);
  }

  // Town+: refining chain (mill + bakery + granary) and weaver_workshop.
  if (
    settlement.tier === 'town' ||
    settlement.tier === 'small_city' ||
    settlement.tier === 'large_city'
  ) {
    tryAddBuilding(settlement, 'mill', uHex(0), owner, cap);
    tryAddBuilding(settlement, 'bakery', uHex(0), owner, cap);
    tryAddBuilding(settlement, 'granary', uHex(0), owner, cap);
    tryAddBuilding(settlement, 'weaver_workshop', uHex(1), owner, cap);
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
