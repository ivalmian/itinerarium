/**
 * Initial NPC caravan spawner.
 *
 * `seedWorld` (T26) leaves `world.caravans` empty, so a fresh burn-in
 * starts with zero commerce on the road. This module gives the world a
 * warm-start: create a bounded initial standing fleet and place those
 * caravans at sensible origins with planned destinations and small starter
 * cargo. Burn-in then has actual trade flowing from day 1 without injecting
 * one random caravan per generated settlement on large maps.
 *
 * What we do NOT do here:
 *   - Drain origin stockpiles. Cargo is fabricated from thin air (a
 *     small wealth injection — within the noise floor of burn-in
 *     stabilization). The alternative would couple the seeder to the
 *     production model and need fallback paths when origins are sparse;
 *     not worth it for an opening warm-start.
 *   - Pick interesting routes. Origin = owner's home settlement; destination
 *     is a random *other* settlement, biased toward closer ones so we get
 *     short intra-cluster runs rather than every caravan trying to cross
 *     the map. The NPC AI tick will replace these routes once they arrive.
 *
 * Re-entry rule: the default warm-start is a one-shot no-op on worlds that
 * already have caravans. Callers that explicitly pass `totalCaravans` can
 * top up to that target total, but existing caravans still count toward the
 * target and each owner's cap. This prevents viewer/debug warm-start code
 * from accidentally injecting another full random batch.
 *
 * Determinism: every random pick flows through `Rng.derive(label)`. Same
 * `(seed, world)` → same caravans.
 *
 * References:
 *   docs/06-caravans.md (composition, mules / pack saddles, crew counts)
 *   docs/11-politics-and-ownership.md (who owns caravans)
 */

import { createRng, type Rng } from '../sim/rng.js';
import {
  caravanId,
  personId,
  resourceId,
  type ActorId,
  type CaravanId,
  type Position,
  type ResourceId,
  type SettlementId,
} from '../sim/types.js';
import { createPerson, registerPerson, type Person } from '../sim/people/index.js';
import {
  generateLatinPraenomen,
  generateLatinNomen,
} from '../sim/politics/character.js';
import { parseDemoKey } from '../sim/population/demographics.js';
import type { Actor } from '../sim/politics/actor.js';
import {
  createCaravan,
  dailyCarriedFoodReserveKg,
  totalCargoWeightKg,
  totalCarryKg,
  type Caravan,
  type CrewKind,
  type CrewMember,
} from '../sim/caravan/caravan.js';
import {
  drawDemographicsFromPool,
  ROLE_BIASES,
  type RoleBias,
} from '../sim/population/demographics.js';
import { getResource } from '../sim/resources/catalog.js';
import { hexDistance, hexEquals, type Hex } from '../sim/world/hex.js';
import type { Settlement } from '../sim/world/settlement.js';
import type { WorldState } from './seed.js';

export interface SeedCaravansOpts {
  readonly seed: string;
  readonly world: WorldState;
  /**
   * Total caravans to attempt to seed. Defaults to an initial standing-fleet
   * target, not one per settlement. The actual count may be lower if eligible
   * owners are scarce or the per-owner cap kicks in.
   */
  readonly totalCaravans?: number;
  /** Default 0.85. */
  readonly shareOwnedByFamilies?: number;
  /** Default 0.15. */
  readonly shareOwnedByGovernor?: number;
}

const PER_OWNER_CAP = 3;
const MIN_DESTINATION_HEX_DISTANCE = 1;
const DEFAULT_WARM_START_PER_SETTLEMENT = 0.25;
const DEFAULT_WARM_START_MIN = 4;
const DEFAULT_WARM_START_MAX = 80;

type OwnerKindShare = 'family' | 'governor';

const computeShares = (opts: SeedCaravansOpts): Map<OwnerKindShare, number> => {
  // docs/10 decision 45 (v1.9): the procgen "merchant_house" share is
  // deleted. Off-map merchants have no permanent on-map presence; the
  // warm-start fleet is owned exclusively by patrician families and the
  // governor's office.
  const f = opts.shareOwnedByFamilies ?? 0.85;
  const g = opts.shareOwnedByGovernor ?? 0.15;
  const total = f + g;
  // Renormalize so callers can pass weights instead of strict probabilities.
  const norm = total > 0 ? total : 1;
  return new Map<OwnerKindShare, number>([
    ['family', f / norm],
    ['governor', g / norm],
  ]);
};

/** Cumulative-distribution pick, deterministic via `rng.next()`. */
const pickByShare = (rng: Rng, shares: ReadonlyMap<OwnerKindShare, number>): OwnerKindShare => {
  const r = rng.next();
  let cum = 0;
  for (const [k, v] of shares) {
    cum += v;
    if (r <= cum) return k;
  }
  // Floating-point fallthrough.
  const last = Array.from(shares.keys()).pop();
  return (last ?? 'family') as OwnerKindShare;
};

const allFamilies = (world: WorldState): Actor[] => {
  const out: Actor[] = [];
  for (const a of world.actors.values()) {
    if (a.kind === 'patrician_family' && a.homeSettlement !== undefined) {
      out.push(a);
    }
  }
  return out;
};

const countExistingCaravansByOwner = (world: WorldState): Map<string, number> => {
  const out = new Map<string, number>();
  for (const c of world.caravans.values()) {
    const ownerKey = String(c.ownerActor);
    out.set(ownerKey, (out.get(ownerKey) ?? 0) + 1);
  }
  return out;
};

const findGovernor = (world: WorldState): Actor | undefined => {
  for (const a of world.actors.values()) {
    if (a.kind === 'governor_office') return a;
  }
  return undefined;
};

/** Sort settlements by hexKey of anchor for deterministic iteration. */
const sortedSettlements = (world: WorldState): Settlement[] => {
  return Array.from(world.settlements.values()).sort((a, b) => {
    const ka = `${a.anchor.q},${a.anchor.r}`;
    const kb = `${b.anchor.q},${b.anchor.r}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
};

const settlementById = (world: WorldState, id: SettlementId): Settlement | undefined =>
  world.settlements.get(id);

interface PickedDestination {
  readonly settlement: Settlement;
  readonly hex: Hex;
}

/**
 * Pick a destination for a caravan starting at `origin`. Bias toward
 * closer settlements so we don't seed a fleet of cross-province
 * expeditions. Distance-weighted via 1 / (1 + d).
 */
const pickDestination = (
  rng: Rng,
  world: WorldState,
  origin: Settlement,
): PickedDestination | undefined => {
  const candidates: { settlement: Settlement; weight: number }[] = [];
  for (const s of sortedSettlements(world)) {
    if (s.id === origin.id) continue;
    const d = hexDistance(origin.anchor, s.anchor);
    if (d < MIN_DESTINATION_HEX_DISTANCE) continue;
    candidates.push({ settlement: s, weight: 1 / (1 + d) });
  }
  if (candidates.length === 0) return undefined;
  const total = candidates.reduce((acc, c) => acc + c.weight, 0);
  let pick = rng.next() * total;
  for (const c of candidates) {
    pick -= c.weight;
    if (pick <= 0) {
      return { settlement: c.settlement, hex: c.settlement.anchor };
    }
  }
  const last = candidates[candidates.length - 1];
  if (last === undefined) return undefined;
  return { settlement: last.settlement, hex: last.settlement.anchor };
};

const STARTER_CARGO_OPTIONS: readonly {
  resource: ResourceId;
  minUnits: number;
  maxUnits: number;
}[] = [
  { resource: resourceId('food.grain'), minUnits: 5, maxUnits: 20 },
  { resource: resourceId('food.wine'), minUnits: 2, maxUnits: 8 },
  { resource: resourceId('food.olive_oil'), minUnits: 2, maxUnits: 6 },
  { resource: resourceId('material.pottery'), minUnits: 2, maxUnits: 6 },
  { resource: resourceId('goods.cloth'), minUnits: 2, maxUnits: 5 },
  { resource: resourceId('goods.tools'), minUnits: 1, maxUnits: 3 },
];

const STARTER_RATION_DAYS = 21;
const STARTER_RATION_RESOURCE = resourceId('food.grain');

const buildStarterCargo = (rng: Rng): Map<ResourceId, number> => {
  const cargo = new Map<ResourceId, number>();
  // Always at least one cargo item so caravans aren't empty.
  const options = STARTER_CARGO_OPTIONS.slice();
  const itemCount = rng.int(1, 3);
  const shuffled = rng.shuffle(options);
  for (let i = 0; i < itemCount && i < shuffled.length; i++) {
    const opt = shuffled[i] as (typeof STARTER_CARGO_OPTIONS)[number];
    const qty = rng.int(opt.minUnits, opt.maxUnits);
    cargo.set(opt.resource, qty);
  }
  return cargo;
};

const addStarterRations = (caravan: Caravan): void => {
  const grain = getResource(STARTER_RATION_RESOURCE);
  if (grain.weightKgPerUnit <= 0) return;
  const targetUnits =
    (dailyCarriedFoodReserveKg(caravan) * STARTER_RATION_DAYS) / grain.weightKgPerUnit;
  const current = caravan.cargo.get(STARTER_RATION_RESOURCE) ?? 0;
  if (current < targetUnits) caravan.cargo.set(STARTER_RATION_RESOURCE, targetUnits);
};

const trimStarterCargoToCapacity = (caravan: Caravan): void => {
  let excessKg = totalCargoWeightKg(caravan) - totalCarryKg(caravan);
  if (excessKg <= 1e-9) return;

  for (const [resource, qty] of Array.from(caravan.cargo.entries())) {
    if (resource === STARTER_RATION_RESOURCE) continue;
    const weightKgPerUnit = getResource(resource).weightKgPerUnit;
    if (weightKgPerUnit <= 0 || qty <= 0) continue;
    const removeQty = Math.min(qty, excessKg / weightKgPerUnit);
    const remaining = qty - removeQty;
    if (remaining > 1e-9) caravan.cargo.set(resource, remaining);
    else caravan.cargo.delete(resource);
    excessKg -= removeQty * weightKgPerUnit;
    if (excessKg <= 1e-9) return;
  }

  const grainQty = caravan.cargo.get(STARTER_RATION_RESOURCE) ?? 0;
  if (grainQty <= 0 || excessKg <= 1e-9) return;
  const grainWeightKg = getResource(STARTER_RATION_RESOURCE).weightKgPerUnit;
  const removeGrainQty = Math.min(grainQty, excessKg / grainWeightKg);
  const remainingGrain = grainQty - removeGrainQty;
  if (remainingGrain > 1e-9) caravan.cargo.set(STARTER_RATION_RESOURCE, remainingGrain);
  else caravan.cargo.delete(STARTER_RATION_RESOURCE);
};

const CREW_ROLE_BIAS: Record<CrewKind, RoleBias> = {
  merchant: ROLE_BIASES.caravan_merchant,
  drover: ROLE_BIASES.caravan_drover,
  caravan_guard: ROLE_BIASES.caravan_guard,
  soldier: ROLE_BIASES.caravan_soldier,
};

/**
 * Build the crew for a starter caravan, sampling per-role demographics from
 * the origin settlement's working-age population pool. Per CLAUDE.md
 * ("everyone in all units has gender and age") + docs/06 §"Crew demographics":
 * each `CrewMember.demographics` map sums to its `count`.
 *
 * The same `rng` is used for both the count rolls and demographics draws —
 * sub-derived per role so adding a new crew kind doesn't shift older streams.
 */
const buildStarterCrew = (rng: Rng, origin: Settlement): CrewMember[] => {
  const merchantCount = 1;
  const droverCount = rng.int(2, 4);
  const guardCount = rng.int(3, 5);
  const pool = origin.population;
  const mk = (kind: CrewKind, count: number, weapons: number, armor: number): CrewMember => ({
    kind,
    count,
    weapons,
    armor,
    demographics: drawDemographicsFromPool(
      pool,
      count,
      CREW_ROLE_BIAS[kind],
      rng.derive(`demo-${kind}`),
    ),
  });
  return [
    mk('merchant', merchantCount, 0, 0),
    mk('drover', droverCount, 0, 0),
    mk('caravan_guard', guardCount, 0.6, 0.4),
  ];
};

const buildStarterAnimals = (rng: Rng): Partial<Record<'mule' | 'donkey', number>> => {
  // Small caravans: ~5-15 mules, optionally a few donkeys.
  return {
    mule: rng.int(5, 15),
    donkey: rng.int(0, 5),
  };
};

interface OwnerSlot {
  readonly actor: Actor;
  readonly origin: Settlement;
}

/**
 * Find a (family, family's home settlement) slot to use as caravan owner.
 * Returns undefined if no family is available or all are at the per-owner cap.
 */
const pickFamilyOwner = (
  rng: Rng,
  world: WorldState,
  caravansByOwner: Map<string, number>,
): OwnerSlot | undefined => {
  const families = allFamilies(world);
  const eligible: OwnerSlot[] = [];
  for (const f of families) {
    if ((caravansByOwner.get(String(f.id)) ?? 0) >= PER_OWNER_CAP) continue;
    if (f.homeSettlement === undefined) continue;
    const home = settlementById(world, f.homeSettlement);
    if (home === undefined) continue;
    eligible.push({ actor: f, origin: home });
  }
  if (eligible.length === 0) return undefined;
  const i = rng.int(0, eligible.length - 1);
  return eligible[i];
};

const pickGovernorOwner = (world: WorldState): OwnerSlot | undefined => {
  const gov = findGovernor(world);
  if (gov === undefined || gov.homeSettlement === undefined) return undefined;
  const home = settlementById(world, gov.homeSettlement);
  if (home === undefined) return undefined;
  return { actor: gov, origin: home };
};

const cloneHex = (h: Hex): Position => ({ q: h.q, r: h.r });

const defaultWarmStartTarget = (settlementCount: number): number => {
  const raw = Math.floor(settlementCount * DEFAULT_WARM_START_PER_SETTLEMENT);
  return Math.max(DEFAULT_WARM_START_MIN, Math.min(DEFAULT_WARM_START_MAX, raw));
};

const buildOneCaravan = (
  rng: Rng,
  world: WorldState,
  owner: OwnerSlot,
  index: number,
): Caravan | undefined => {
  const dest = pickDestination(rng.derive('dest'), world, owner.origin);
  if (dest === undefined) return undefined;
  // Originate at the owner's settlement anchor (a stable urban hex).
  const originHex: Position = cloneHex(owner.origin.anchor);
  // Don't double-place at the same spot as destination.
  if (hexEquals(originHex, dest.hex)) return undefined;
  const cId: CaravanId = caravanId(`caravan:seed:${index}:${String(owner.actor.id)}`);
  const caravan = createCaravan({
    id: cId,
    ownerActor: owner.actor.id,
    position: originHex,
    destination: cloneHex(dest.hex),
    crew: buildStarterCrew(rng.derive('crew'), owner.origin),
    animals: buildStarterAnimals(rng.derive('animals')),
    vehicles: { pack_saddle: 1 },
    treasury: rng.int(250, 1000),
  });
  for (const [res, qty] of buildStarterCargo(rng.derive('cargo'))) {
    caravan.cargo.set(res, qty);
  }
  addStarterRations(caravan);
  trimStarterCargoToCapacity(caravan);
  return caravan;
};

export const seedCaravans = (opts: SeedCaravansOpts): void => {
  const { world } = opts;
  const settlementCount = world.settlements.size;
  if (settlementCount === 0) return;

  // No caravans without at least one viable owner — short-circuit so
  // callers with empty actor maps get a no-op rather than an error.
  const haveFamily = allFamilies(world).length > 0;
  const haveGov = findGovernor(world) !== undefined;
  if (!haveFamily && !haveGov) return;

  const rng = createRng(opts.seed).derive('caravans');
  const explicitTarget = opts.totalCaravans !== undefined;
  if (!explicitTarget && world.caravans.size > 0) return;

  const requestedTarget = Math.max(
    0,
    Math.floor(opts.totalCaravans ?? defaultWarmStartTarget(settlementCount)),
  );
  const targetTotal = requestedTarget;
  if (targetTotal === 0 || world.caravans.size >= targetTotal) return;

  const shares = computeShares(opts);
  const caravansByOwner = countExistingCaravansByOwner(world);
  // Pre-seed the index counter from existing caravans so any deliberate
  // top-up uses fresh ids without turning a repeated warm-start into a
  // discontinuous second fleet.
  let idx = world.caravans.size;

  for (let i = 0; i < targetTotal && world.caravans.size < targetTotal; i++) {
    const kind = pickByShare(rng.derive(`pick-${i}`), shares);
    let owner: OwnerSlot | undefined;
    switch (kind) {
      case 'family':
        owner = pickFamilyOwner(rng.derive(`fam-${i}`), world, caravansByOwner);
        break;
      case 'governor':
        owner = pickGovernorOwner(world);
        break;
    }
    if (owner === undefined) continue;
    const ownerKey = String(owner.actor.id);
    if ((caravansByOwner.get(ownerKey) ?? 0) >= PER_OWNER_CAP) continue;
    const caravan = buildOneCaravan(rng.derive(`build-${i}`), world, owner, idx);
    if (caravan === undefined) continue;
    world.caravans.set(caravan.id, caravan);
    // Per docs/04 §"Person registry for moving units": materialize a
    // Person record for every crew member, drawing names + ages from
    // the crew's demographics map. Each guard gets a kit issued per
    // docs/03 §"Weapon-archetype substitution policy".
    materializePersonsForCaravan(
      world,
      caravan,
      owner.actor,
      rng.derive(`crew-persons-${i}`),
    );
    caravansByOwner.set(ownerKey, (caravansByOwner.get(ownerKey) ?? 0) + 1);
    idx += 1;
  }
};

let _personCounter = 0;

const materializePersonsForCaravan = (
  world: WorldState,
  caravan: Caravan,
  ownerActor: Actor,
  rng: Rng,
): void => {
  if (world.persons === undefined || world.personEquipment === undefined) return;
  const factionForOwner = findFactionForActor(world, ownerActor.id);
  for (const member of caravan.crew) {
    if (member.demographics === undefined) continue;
    for (const [key, count] of member.demographics) {
      if (!Number.isInteger(count) || count <= 0) continue;
      const { sex, age: ageBand } = parseDemoKey(key);
      const ageMid = ageBandMidpoint(ageBand);
      for (let i = 0; i < count; i++) {
        const id = personId(`person-c-${String(_personCounter++).padStart(6, '0')}`);
        const person = createPerson({
          id,
          name: `${generateLatinPraenomen(rng, sex)} ${generateLatinNomen(rng)}`,
          age: ageMid,
          sex,
          class: crewMemberClass(member.kind),
          faction: factionForOwner,
          role: crewKindToPersonRole(member.kind),
          bornOnDay: 0,
          unitId: String(caravan.id),
        });
        registerPerson(world.persons, person);
        // Equip per role + the crew's weapons/armor scalar.
        const kit = derivedKitForCrew(member.kind, member.weapons, member.armor);
        if (kit.length > 0) {
          const slot = new Map<ResourceId, number>();
          for (const item of kit) slot.set(item, (slot.get(item) ?? 0) + 1);
          world.personEquipment.set(id, slot);
        }
      }
    }
  }
};

const findFactionForActor = (world: WorldState, actor: ActorId) => {
  for (const [fid, f] of world.factions) {
    if (f.actor === actor) return fid;
  }
  // Synthesize a stable id when the owner has no faction (e.g., a
  // synthetic off-map endpoint). Persons still need *some* faction tag so
  // future reputation queries don't crash.
  return `faction:${String(actor)}` as Person['faction'];
};

const crewMemberClass = (kind: CrewKind): Person['class'] => {
  // Merchants & guards are typically free citizens; drovers can be
  // freedmen but plebeian is the default class for caravan crew. We
  // don't yet specialize per-crew-member; this is a coarse default.
  if (kind === 'merchant') return 'plebeian';
  if (kind === 'caravan_guard' || kind === 'soldier') return 'plebeian';
  return 'plebeian';
};

const crewKindToPersonRole = (kind: CrewKind): Person['role'] => {
  switch (kind) {
    case 'merchant':
      return 'merchant';
    case 'drover':
      return 'drover';
    case 'caravan_guard':
      return 'caravan_guard';
    case 'soldier':
      return 'soldier';
  }
};

const derivedKitForCrew = (
  kind: CrewKind,
  weaponsScore: number,
  armorScore: number,
): readonly ResourceId[] => {
  // Merchants and drovers carry a sidearm at best; only guards/soldiers
  // get a real kit. Substitution priority follows docs/03.
  const kit: ResourceId[] = [];
  if (kind === 'merchant' || kind === 'drover') {
    if (weaponsScore >= 0.1) kit.push(resourceId('goods.dagger'));
    return kit;
  }
  // Guard / soldier
  if (weaponsScore >= 0.7) {
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
  return kit;
};

const ageBandMidpoint = (band: string): number => {
  if (band === '80+') return 82;
  const dash = band.indexOf('-');
  if (dash === -1) return 30;
  const lo = Number(band.slice(0, dash));
  const hi = Number(band.slice(dash + 1));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 30;
  return Math.round((lo + hi) / 2);
};

// Suppress unused-import warning if PersonId isn't referenced directly.
void personId;
