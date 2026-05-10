/**
 * Settlement: an anchor + multi-hex urban extent + catchment +
 * population pool + per-owner stockpile + market state.
 *
 * docs/05 §"Multi-hex entry UX (locked)": the player entering ANY
 * urban or catchment hex opens the settlement screen — there's
 * no single "settlement hex." docs/05 §"Ownership of catchment
 * hexes": each catchment hex is owned by a specific actor, and
 * recipe outputs flow to the owner's stockpile, not a generic
 * settlement pool. Stockpile *holders* are tracked here so the
 * UI can enumerate them; actual quantities live on each Actor
 * (T6 — see src/sim/politics/actor.ts).
 *
 * Design references:
 *   docs/05-settlements.md
 *   docs/11-politics-and-ownership.md
 */

import { emptyPool, type PopulationPool } from '../population/index.js';
import type { ActorId, BuildingId, FactionId, ResourceId, SettlementId } from '../types.js';
import { hex as makeHex, hexEquals, hexKey, type Hex } from './hex.js';

export type SettlementTier = 'hamlet' | 'village' | 'town' | 'small_city' | 'large_city';

export const SETTLEMENT_TIERS = [
  'hamlet',
  'village',
  'town',
  'small_city',
  'large_city',
] as const satisfies readonly SettlementTier[];

export interface SettlementBuilding {
  /** Type of building (lookup against src/sim/buildings/catalog.ts). */
  buildingId: BuildingId;
  /** Specific hex within the settlement (urban or catchment). */
  hex: Hex;
  /** The actor that owns this physical building. */
  ownerActor: ActorId;
  /** Current capacity (may be reduced from def by decay). */
  capacity: number;
  daysSinceMaintained: number;
}

export interface MarketSnapshot {
  /** Inflows accumulated since the last reset (typically last ~10 days). */
  recentInflows: Map<ResourceId, number>;
  /** Outflows accumulated since the last reset. */
  recentOutflows: Map<ResourceId, number>;
  /** Last clearing price per resource (set by the market clearing tick). */
  lastClearingPrice: Map<ResourceId, number>;
}

export interface Settlement {
  readonly id: SettlementId;
  tier: SettlementTier;
  readonly name: string;
  readonly anchor: Hex;
  readonly urbanHexes: readonly Hex[];
  readonly catchmentHexes: readonly Hex[];
  readonly population: PopulationPool;
  readonly buildings: SettlementBuilding[];
  readonly factions: FactionId[];
  readonly stockpileOwners: ActorId[];
  readonly market: MarketSnapshot;
}

export interface CreateSettlementInput {
  readonly id: SettlementId;
  readonly tier: SettlementTier;
  readonly name: string;
  readonly anchor: Hex;
  readonly urbanHexes: readonly Hex[];
  readonly catchmentHexes: readonly Hex[];
  readonly factions?: readonly FactionId[];
  readonly stockpileOwners?: readonly ActorId[];
}

const cloneHex = (h: Hex): Hex => makeHex(h.q, h.r);

const containsHex = (hexes: readonly Hex[], h: Hex): boolean => {
  for (const x of hexes) {
    if (hexEquals(x, h)) return true;
  }
  return false;
};

export const createSettlement = (input: CreateSettlementInput): Settlement => {
  if (input.name.length === 0) {
    throw new Error(`Settlement ${String(input.id)} must have a non-empty name`);
  }
  if (input.urbanHexes.length === 0) {
    throw new Error(`Settlement ${String(input.id)} must have at least one urban hex`);
  }
  if (!containsHex(input.urbanHexes, input.anchor)) {
    throw new Error(`Settlement ${String(input.id)} anchor must be one of its urban hexes`);
  }
  // Defensively reject overlap so addBuilding/settlementContainsHex stay
  // unambiguous about whether a hex is urban or catchment.
  const urbanKeys = new Set(input.urbanHexes.map(hexKey));
  for (const c of input.catchmentHexes) {
    if (urbanKeys.has(hexKey(c))) {
      throw new Error(
        `Settlement ${String(input.id)} hex ${hexKey(c)} is both urban and catchment`,
      );
    }
  }

  return {
    id: input.id,
    tier: input.tier,
    name: input.name,
    anchor: cloneHex(input.anchor),
    urbanHexes: input.urbanHexes.map(cloneHex),
    catchmentHexes: input.catchmentHexes.map(cloneHex),
    population: emptyPool(),
    buildings: [],
    factions: input.factions ? [...input.factions] : [],
    stockpileOwners: input.stockpileOwners ? [...input.stockpileOwners] : [],
    market: {
      recentInflows: new Map(),
      recentOutflows: new Map(),
      lastClearingPrice: new Map(),
    },
  };
};

export const settlementContainsHex = (s: Settlement, h: Hex): boolean => {
  return containsHex(s.urbanHexes, h) || containsHex(s.catchmentHexes, h);
};

/**
 * Population → tier classification per docs/05 table:
 *   Hamlet: 30–150 (we treat <150 as hamlet, including 0).
 *   Village: 150–800
 *   Town: 1k–5k (we use ≥1000 as the bottom of town to leave a
 *     small "transitional" gap 800–1000 inside village)
 *   Small city: 5k–15k
 *   Large city: 15k–50k+
 */
export const tierOfPopulation = (totalPop: number): SettlementTier => {
  if (!Number.isFinite(totalPop) || totalPop < 0) {
    throw new Error(`tierOfPopulation: population must be non-negative, got ${totalPop}`);
  }
  if (totalPop < 150) return 'hamlet';
  if (totalPop < 1000) return 'village';
  if (totalPop < 5000) return 'town';
  if (totalPop < 15000) return 'small_city';
  return 'large_city';
};

/** Catchment radius in hexes (1 km/hex). docs/05 §"Catchment". */
export const expectedCatchmentRadius = (tier: SettlementTier): number => {
  switch (tier) {
    case 'hamlet':
      return 1;
    case 'village':
      return 2;
    case 'town':
      return 3;
    case 'small_city':
      return 5;
    case 'large_city':
      return 5;
  }
};

/** Urban hex count band per docs/05 §"Physical extent". */
export const expectedUrbanHexCount = (tier: SettlementTier): { min: number; max: number } => {
  switch (tier) {
    case 'hamlet':
      return { min: 1, max: 1 };
    case 'village':
      return { min: 1, max: 1 };
    case 'town':
      return { min: 1, max: 2 };
    case 'small_city':
      return { min: 2, max: 3 };
    case 'large_city':
      return { min: 3, max: 10 };
  }
};

const buildingMatches = (b: SettlementBuilding, hex: Hex, buildingId: BuildingId): boolean =>
  hexEquals(b.hex, hex) && b.buildingId === buildingId;

export const addBuilding = (s: Settlement, b: SettlementBuilding): void => {
  if (!settlementContainsHex(s, b.hex)) {
    throw new Error(`addBuilding: hex ${hexKey(b.hex)} is not part of settlement ${String(s.id)}`);
  }
  for (const existing of s.buildings) {
    if (buildingMatches(existing, b.hex, b.buildingId) && existing.ownerActor === b.ownerActor) {
      throw new Error(
        `addBuilding: duplicate ${String(b.buildingId)} at ${hexKey(b.hex)} owned by ${String(b.ownerActor)}`,
      );
    }
  }
  s.buildings.push({
    ...b,
    hex: cloneHex(b.hex),
  });
};

export const removeBuilding = (s: Settlement, hex: Hex, buildingId: BuildingId): void => {
  const i = s.buildings.findIndex((b) => buildingMatches(b, hex, buildingId));
  if (i < 0) {
    throw new Error(
      `removeBuilding: no ${String(buildingId)} at ${hexKey(hex)} in settlement ${String(s.id)}`,
    );
  }
  s.buildings.splice(i, 1);
};

const requirePositiveQty = (qty: number, label: string): void => {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`${label} must be positive, got ${qty}`);
  }
};

export const recordInflow = (s: Settlement, resource: ResourceId, qty: number): void => {
  requirePositiveQty(qty, 'recordInflow qty');
  s.market.recentInflows.set(resource, (s.market.recentInflows.get(resource) ?? 0) + qty);
};

export const recordOutflow = (s: Settlement, resource: ResourceId, qty: number): void => {
  requirePositiveQty(qty, 'recordOutflow qty');
  s.market.recentOutflows.set(resource, (s.market.recentOutflows.get(resource) ?? 0) + qty);
};

export const recordClearingPrice = (s: Settlement, resource: ResourceId, price: number): void => {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`recordClearingPrice: price must be non-negative, got ${price}`);
  }
  s.market.lastClearingPrice.set(resource, price);
};
