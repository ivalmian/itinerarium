/**
 * Tax shipment caravan generator.
 *
 * Per docs/11 §"Tax revenue is real": the governor periodically collects
 * tax in kind and in coin. These flow as REAL caravans on the road network
 * — village → city → capital — and a tax-shipment caravan that gets
 * ambushed (docs/12) is an unfunded garrison the next month. This module
 * is the assessor + caravan factory; physical movement is handled by the
 * caravan-movement module already in place (T23).
 *
 * Cadence:
 *   - Harvest tribute: once per year just after autumn harvest. We pin to a
 *     fixed day-of-year (273) so determinism is easy.
 *   - Coin tax + cloth levy: monthly (every 30 days from epoch).
 *   - Cart toll: per-passing-caravan, handled elsewhere — this module
 *     defines the kind so consumers can switch on it but does not assess.
 *
 * Sizing: a shipment carries `quantityOwed * weightKgPerResource` kg of
 * cargo, plus a crew sized to the cargo (1+ official, 1+ drovers per pack
 * animal cluster, ≥2 guards because tax shipments are juicy targets).
 * Animals are mules sized to give ~30% headroom over cargo weight.
 */

import {
  ANIMAL_SPECS,
  type AnimalKind,
  type Caravan,
  type CrewMember,
  createCaravan,
} from '../caravan/caravan.js';
import { getResource } from '../resources/index.js';
import type { Rng } from '../rng.js';
import type {
  ActorId,
  CaravanId,
  Day,
  Position,
  Quantity,
  ResourceId,
  SettlementId,
} from '../types.js';
import type { Actor } from './actor.js';

// ---------------------------------------------------------------------------
// Constants & cadence helpers.
// ---------------------------------------------------------------------------

/**
 * Day-of-year on which the harvest tribute is assessed. Chosen to land just
 * after autumn (which ends day 272) so the tribute reflects the just-completed
 * harvest. docs/07 §"Seasons" defines the season boundaries.
 */
export const HARVEST_TRIBUTE_DAY_OF_YEAR = 273;

/**
 * Monthly assessment interval. Roman months are roughly lunar; we use 30 days
 * uniformly so monthly checks line up cleanly across years.
 */
export const MONTHLY_ASSESSMENT_INTERVAL_DAYS = 30;

const DAYS_PER_YEAR = 365;

const positiveModulo = (n: number, m: number): number => ((n % m) + m) % m;

export const isHarvestTributeDay = (today: Day): boolean => {
  return positiveModulo(today, DAYS_PER_YEAR) === HARVEST_TRIBUTE_DAY_OF_YEAR;
};

export const isMonthlyAssessmentDay = (today: Day): boolean => {
  return positiveModulo(today, MONTHLY_ASSESSMENT_INTERVAL_DAYS) === 0;
};

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type TaxKind = 'grain_tribute' | 'cart_toll' | 'coin_tax' | 'cloth_levy';

export interface TaxAssessment {
  readonly kind: TaxKind;
  readonly fromSettlement: SettlementId;
  readonly fromOwnerActor: ActorId;
  readonly resource: ResourceId;
  readonly quantityOwed: Quantity;
  readonly dueByDay: Day;
}

export interface SettlementTaxView {
  readonly id: SettlementId;
  readonly tier: 'hamlet' | 'village' | 'town' | 'small_city' | 'large_city';
  readonly recentHarvestQuantity: Quantity;
  readonly recentClothProduction: Quantity;
  readonly ownerActors: readonly { readonly id: ActorId; readonly treasury: number }[];
}

export interface TaxRatesPercent {
  /** Percent of recent harvest owed as grain tribute. */
  readonly harvestPct: number;
  /** Per-cart toll on roads (handled elsewhere; included for completeness). */
  readonly cartTollPerCart: number;
  /** Percent of an owning actor's coin treasury owed as coin tax. */
  readonly coinTaxPctOfWealth: number;
}

export interface TaxAssessmentInputs {
  readonly governor: Actor;
  readonly taxRatesPercent: TaxRatesPercent;
  readonly settlements: readonly SettlementTaxView[];
  readonly today: Day;
}

// ---------------------------------------------------------------------------
// Resource-id constants used by the assessor.
// ---------------------------------------------------------------------------

const GRAIN_RESOURCE: ResourceId = 'food.grain' as ResourceId;
const CLOTH_RESOURCE: ResourceId = 'goods.cloth' as ResourceId;
const COIN_RESOURCE: ResourceId = 'goods.coin' as ResourceId;

// ---------------------------------------------------------------------------
// Assessment.
// ---------------------------------------------------------------------------

const requireNonNegativeInteger = (n: number, label: string): void => {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${n}`);
  }
};

/**
 * Allocate `total` units across `n` actors as evenly as possible. The first
 * `total % n` actors get one extra unit; the rest get floor(total/n). This is
 * deterministic and order-stable, which matches the rest of the sim's
 * allocation conventions.
 */
const splitEvenly = (total: number, n: number): number[] => {
  if (n === 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  const out: number[] = new Array<number>(n).fill(base);
  for (let i = 0; i < remainder; i++) {
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
};

export const assessTaxes = (inputs: TaxAssessmentInputs): readonly TaxAssessment[] => {
  const out: TaxAssessment[] = [];
  const { taxRatesPercent: rates, settlements, today } = inputs;
  const harvestToday = isHarvestTributeDay(today);
  const monthlyToday = isMonthlyAssessmentDay(today);

  for (const s of settlements) {
    requireNonNegativeInteger(s.recentHarvestQuantity, 'recentHarvestQuantity');
    requireNonNegativeInteger(s.recentClothProduction, 'recentClothProduction');

    if (harvestToday && s.recentHarvestQuantity > 0 && s.ownerActors.length > 0) {
      const owedTotal = Math.floor((s.recentHarvestQuantity * rates.harvestPct) / 100);
      if (owedTotal > 0) {
        const split = splitEvenly(owedTotal, s.ownerActors.length);
        for (let i = 0; i < s.ownerActors.length; i++) {
          const owner = s.ownerActors[i];
          const portion = split[i] ?? 0;
          if (!owner || portion <= 0) continue;
          out.push({
            kind: 'grain_tribute',
            fromSettlement: s.id,
            fromOwnerActor: owner.id,
            resource: GRAIN_RESOURCE,
            quantityOwed: portion,
            dueByDay: (today + 7) as Day,
          });
        }
      }
    }

    if (harvestToday && s.recentClothProduction > 0 && s.ownerActors.length > 0) {
      const owedTotal = Math.floor((s.recentClothProduction * rates.harvestPct) / 100);
      if (owedTotal > 0) {
        const split = splitEvenly(owedTotal, s.ownerActors.length);
        for (let i = 0; i < s.ownerActors.length; i++) {
          const owner = s.ownerActors[i];
          const portion = split[i] ?? 0;
          if (!owner || portion <= 0) continue;
          out.push({
            kind: 'cloth_levy',
            fromSettlement: s.id,
            fromOwnerActor: owner.id,
            resource: CLOTH_RESOURCE,
            quantityOwed: portion,
            dueByDay: (today + 7) as Day,
          });
        }
      }
    }

    if (monthlyToday) {
      for (const owner of s.ownerActors) {
        if (owner.treasury <= 0) continue;
        const owed = Math.floor((owner.treasury * rates.coinTaxPctOfWealth) / 100);
        if (owed <= 0) continue;
        out.push({
          kind: 'coin_tax',
          fromSettlement: s.id,
          fromOwnerActor: owner.id,
          resource: COIN_RESOURCE,
          quantityOwed: owed,
          dueByDay: (today + 5) as Day,
        });
      }
    }
  }

  return out;
};

// ---------------------------------------------------------------------------
// Sizing & escort.
// ---------------------------------------------------------------------------

const CARGO_BUFFER_FRACTION = 0.3;

export interface SizedShipment {
  readonly animals: Partial<Record<AnimalKind, number>>;
  readonly crew: CrewMember[];
}

export const sizeShipmentForCargo = (resource: ResourceId, quantity: Quantity): SizedShipment => {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`sizeShipmentForCargo: quantity must be positive, got ${quantity}`);
  }
  const def = getResource(resource);
  const cargoKg = def.weightKgPerUnit * quantity;
  const requiredCapKg = cargoKg * (1 + CARGO_BUFFER_FRACTION);
  const muleCarry = ANIMAL_SPECS.mule.carryKg;
  const mules = Math.max(1, Math.ceil(requiredCapKg / muleCarry));

  // Crew: 1 official (modeled as the merchant kind in v1 — the caravan
  // module's CrewKind set), 1 drover per ~5 mules (rounded up), at least 2
  // guards plus 1 extra per ~10 mules.
  const drovers = Math.max(1, Math.ceil(mules / 5));
  const guards = Math.max(2, 2 + Math.floor(mules / 10));

  const crew: CrewMember[] = [
    { kind: 'merchant', count: 1, weapons: 0.1, armor: 0.1 },
    { kind: 'drover', count: drovers, weapons: 0.1, armor: 0 },
    { kind: 'caravan_guard', count: guards, weapons: 0.6, armor: 0.5 },
  ];

  return {
    animals: { mule: mules },
    crew,
  };
};

// ---------------------------------------------------------------------------
// Caravan factory.
// ---------------------------------------------------------------------------

export interface TaxShipmentInputs {
  readonly id: CaravanId;
  readonly assessment: TaxAssessment;
  readonly fromHex: Position;
  readonly toHex: Position;
  readonly governorActor: ActorId;
  readonly rng: Rng;
}

export const createTaxShipmentCaravan = (input: TaxShipmentInputs): Caravan => {
  const sized = sizeShipmentForCargo(input.assessment.resource, input.assessment.quantityOwed);
  // Reserve the rng parameter for future jitter (random crew names, slight
  // animal mix variation). Currently deterministic; consume one value so the
  // signature stays stable and seed advancement is documented.
  void input.rng.next();

  const caravan = createCaravan({
    id: input.id,
    ownerActor: input.governorActor,
    position: input.fromHex,
    destination: input.toHex,
    crew: sized.crew,
    animals: sized.animals,
    vehicles: {},
  });
  caravan.cargo.set(input.assessment.resource, input.assessment.quantityOwed);
  return caravan;
};
