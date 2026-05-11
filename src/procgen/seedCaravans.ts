/**
 * Initial NPC caravan spawner.
 *
 * `seedWorld` (T26) leaves `world.caravans` empty, so a fresh burn-in
 * starts with zero commerce on the road. This module gives the world a
 * warm-start: pick N caravans and place them at sensible origins with
 * planned destinations and small starter cargo. Burn-in then has actual
 * trade flowing from day 1 instead of needing weeks of in-sim time for
 * caravans to spawn organically.
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
 * Determinism: every random pick flows through `Rng.derive(label)`. Same
 * `(seed, world)` → same caravans.
 *
 * References:
 *   docs/06-caravans.md (composition, mules / pack saddles, crew counts)
 *   docs/11-politics-and-ownership.md (who owns caravans)
 */

import { createRng, type Rng } from '../sim/rng.js';
import {
  actorId,
  caravanId,
  resourceId,
  type CaravanId,
  type Position,
  type ResourceId,
  type SettlementId,
} from '../sim/types.js';
import { createActor, type Actor } from '../sim/politics/actor.js';
import { createCaravan, type Caravan, type CrewKind, type CrewMember } from '../sim/caravan/caravan.js';
import {
  drawDemographicsFromPool,
  ROLE_BIASES,
  type RoleBias,
} from '../sim/population/demographics.js';
import { hexDistance, hexEquals, type Hex } from '../sim/world/hex.js';
import type { Settlement } from '../sim/world/settlement.js';
import type { WorldState } from './seed.js';

export interface SeedCaravansOpts {
  readonly seed: string;
  readonly world: WorldState;
  /**
   * Total caravans to attempt to seed. Defaults to roughly 1 per
   * settlement. The actual count may be lower if eligible owners are
   * scarce or the per-owner cap kicks in.
   */
  readonly totalCaravans?: number;
  /** Default 0.7. */
  readonly shareOwnedByFamilies?: number;
  /** Default 0.2. Spawns synthetic off_map_house actors as needed. */
  readonly shareOwnedByMerchantHouses?: number;
  /** Default 0.1. */
  readonly shareOwnedByGovernor?: number;
}

const PER_OWNER_CAP = 3;
const MIN_DESTINATION_HEX_DISTANCE = 1;

type OwnerKindShare = 'family' | 'merchant_house' | 'governor';

const computeShares = (opts: SeedCaravansOpts): Map<OwnerKindShare, number> => {
  const f = opts.shareOwnedByFamilies ?? 0.7;
  const m = opts.shareOwnedByMerchantHouses ?? 0.2;
  const g = opts.shareOwnedByGovernor ?? 0.1;
  const total = f + m + g;
  // Renormalize so callers can pass weights instead of strict probabilities.
  const norm = total > 0 ? total : 1;
  return new Map<OwnerKindShare, number>([
    ['family', f / norm],
    ['merchant_house', m / norm],
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

const findGovernor = (world: WorldState): Actor | undefined => {
  for (const a of world.actors.values()) {
    if (a.kind === 'governor_office') return a;
  }
  return undefined;
};

const cities = (world: WorldState): Settlement[] => {
  const out: Settlement[] = [];
  for (const s of world.settlements.values()) {
    if (s.tier === 'small_city' || s.tier === 'large_city') out.push(s);
  }
  return out;
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

const STARTER_CARGO_OPTIONS: readonly { resource: ResourceId; minUnits: number; maxUnits: number }[] =
  [
    { resource: resourceId('food.grain'), minUnits: 5, maxUnits: 20 },
    { resource: resourceId('food.wine'), minUnits: 2, maxUnits: 8 },
    { resource: resourceId('food.olive_oil'), minUnits: 2, maxUnits: 6 },
    { resource: resourceId('material.pottery'), minUnits: 2, maxUnits: 6 },
    { resource: resourceId('goods.cloth'), minUnits: 2, maxUnits: 5 },
    { resource: resourceId('goods.tools'), minUnits: 1, maxUnits: 3 },
  ];

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
  const guardCount = rng.int(1, 3);
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
    mk('caravan_guard', guardCount, 0.4, 0.2),
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

/**
 * Spawn (or re-use) a synthetic off_map_house actor. Each new house picks
 * a random city as its on-map base; this gives merchant houses an actual
 * place to operate from instead of being floating refs.
 */
const ensureMerchantHouseOwner = (
  rng: Rng,
  world: WorldState,
  spawnedHouses: Actor[],
): OwnerSlot | undefined => {
  const cs = cities(world);
  if (cs.length === 0) return undefined;
  // 50% chance to reuse an existing spawned house under cap; otherwise spawn new.
  const reusable = spawnedHouses.filter((h) => h.homeSettlement !== undefined);
  if (reusable.length > 0 && rng.next() < 0.5) {
    const i = rng.int(0, reusable.length - 1);
    const house = reusable[i] as Actor;
    if (house.homeSettlement === undefined) return undefined;
    const home = settlementById(world, house.homeSettlement);
    if (home === undefined) return undefined;
    return { actor: house, origin: home };
  }
  const homeCity = cs[rng.int(0, cs.length - 1)] as Settlement;
  const idx = world.actors.size + spawnedHouses.length;
  const aId = actorId(`actor:house:${idx}`);
  const houseName = `Merchant House ${idx}`;
  const actor = createActor({
    id: aId,
    kind: 'off_map_house',
    name: houseName,
    homeSettlement: homeCity.id,
    treasury: rng.int(1000, 5000),
  });
  world.actors.set(aId, actor);
  spawnedHouses.push(actor);
  return { actor, origin: homeCity };
};

const cloneHex = (h: Hex): Position => ({ q: h.q, r: h.r });

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
    treasury: rng.int(50, 500),
  });
  for (const [res, qty] of buildStarterCargo(rng.derive('cargo'))) {
    caravan.cargo.set(res, qty);
  }
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
  const haveCity = cities(world).length > 0; // needed for merchant houses
  if (!haveFamily && !haveGov && !haveCity) return;

  const rng = createRng(opts.seed).derive('caravans');
  const target = Math.max(0, Math.floor(opts.totalCaravans ?? settlementCount));
  if (target === 0) return;

  const shares = computeShares(opts);
  const caravansByOwner = new Map<string, number>();
  const spawnedHouses: Actor[] = [];
  // Pre-seed the index counter from existing caravans (so re-runs append
  // cleanly if a caller chains us after a prior seeding step).
  let idx = world.caravans.size;

  for (let i = 0; i < target; i++) {
    const kind = pickByShare(rng.derive(`pick-${i}`), shares);
    let owner: OwnerSlot | undefined;
    switch (kind) {
      case 'family':
        owner = pickFamilyOwner(rng.derive(`fam-${i}`), world, caravansByOwner);
        break;
      case 'governor':
        owner = pickGovernorOwner(world);
        break;
      case 'merchant_house':
        owner = ensureMerchantHouseOwner(rng.derive(`house-${i}`), world, spawnedHouses);
        break;
    }
    if (owner === undefined) continue;
    const ownerKey = String(owner.actor.id);
    if ((caravansByOwner.get(ownerKey) ?? 0) >= PER_OWNER_CAP) continue;
    const caravan = buildOneCaravan(rng.derive(`build-${i}`), world, owner, idx);
    if (caravan === undefined) continue;
    world.caravans.set(caravan.id, caravan);
    caravansByOwner.set(ownerKey, (caravansByOwner.get(ownerKey) ?? 0) + 1);
    idx += 1;
  }
};
