/**
 * Shared subsistence helpers used across the production / trade /
 * localTrade / consumption phases.
 *
 * Each settlement resolves daily caloric subsistence as `needModii`
 * (the grain-equivalent need for its age-weighted population) and
 * tracks `fulfilledModii` as the market clearings, local trade,
 * and the consumption-phase fallback rations top each other up.
 * When fulfilled < need by more than 5 % we accrue famine pressure
 * (see `src/sim/world/faminePressure.ts`).
 *
 * Non-grain foods (bread, legumes, milk, fish, cheese, etc.) are
 * counted toward subsistence via `grainEquivalentModiiPerUnit`
 * — bread is dense (~1.3 grain-modii per unit), milk thin
 * (~0.2), etc.
 *
 * Originally lived inline in `src/sim/tick.ts`; lifted here so
 * the consumption phase can extract while trade + localTrade
 * still keep their internal subsistence accounting.
 */

import { getResource } from '../resources/catalog.js';
import type { ResourceId } from '../types.js';
import type { Settlement } from './settlement.js';
import type { WorldState } from '../../procgen/seed.js';

export const SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY = 0.4; // docs/04
export const KG_PER_MODIUS = 6.7; // resources/catalog.ts food.grain unit

export interface SubsistenceAccessRecord {
  readonly needModii: number;
  fulfilledModii: number;
}

export type SubsistenceAccessMap = Map<Settlement, SubsistenceAccessRecord>;

export const populationAgeBuckets = (
  s: Settlement,
): { readonly adults: number; readonly children: number; readonly elders: number } => ({
  adults: s.population.totalAdults(),
  children: s.population.totalChildren(),
  elders: s.population.totalElders(),
});

export const adultPopulation = (s: Settlement): number => s.population.totalAdults();

export const subsistenceNeedModii = (settlement: Settlement): number => {
  const { adults, children, elders } = populationAgeBuckets(settlement);
  // Children consume ~0.5×, elders ~0.8× per docs/04.
  const adultEquivalent = adults + children * 0.5 + elders * 0.8;
  if (adultEquivalent <= 0) return 0;
  const grainNeededKg = adultEquivalent * SUBSISTENCE_GRAIN_KG_PER_ADULT_PER_DAY;
  return grainNeededKg / KG_PER_MODIUS;
};

export const initializeSubsistenceAccess = (world: WorldState): SubsistenceAccessMap => {
  const out: SubsistenceAccessMap = new Map();
  for (const settlement of world.settlements.values()) {
    const needModii = subsistenceNeedModii(settlement);
    if (needModii <= 0) continue;
    out.set(settlement, { needModii, fulfilledModii: 0 });
  }
  return out;
};

/**
 * How many calories per kg one food carries relative to grain.
 * docs/04 doesn't pin precise values; this is a coarse first-pass.
 */
const grainEquivalentMultiplier = (id: ResourceId): number => {
  const idStr = String(id);
  if (idStr === 'food.bread') return 1.3; // 1.3 kg bread ≈ 1 kg grain
  if (idStr === 'food.milk') return 0.2;
  if (idStr === 'food.fish') return 0.5;
  if (idStr === 'food.game') return 0.5;
  if (idStr === 'food.cheese') return 0.6;
  if (idStr === 'food.salted_meat') return 0.5;
  if (idStr === 'food.salted_fish') return 0.5;
  return 1;
};

/**
 * Modii of grain-equivalent in one unit of this food. Used to
 * count non-grain food consumption toward the settlement's
 * subsistence access ledger.
 */
export const grainEquivalentModiiPerUnit = (id: ResourceId): number => {
  const def = getResource(id);
  return (def.weightKgPerUnit / KG_PER_MODIUS) * grainEquivalentMultiplier(id);
};

/**
 * Processing markup over the raw grain-equivalent cost: bread costs
 * more than the raw grain it's milled+baked from, etc. Coarse
 * first-pass; tuned against burn-in.
 */
export const rationProcessingMarkup = (id: ResourceId): number => {
  const idStr = String(id);
  if (idStr === 'food.bread') return 1.35;
  if (idStr === 'food.flour') return 1.15;
  if (idStr === 'food.cheese') return 1.5;
  if (idStr === 'food.salted_meat' || idStr === 'food.salted_fish') return 1.4;
  return 1;
};
