import { describe, expect, it } from 'vitest';
import {
  createCaravan,
  dailyCarriedFoodReserveKg,
  totalCarryKg,
  totalCargoWeightKg,
} from '../caravan/caravan.js';
import { getResource } from '../resources/index.js';
import { createRng } from '../rng.js';
import {
  actorId,
  caravanId,
  resourceId,
  settlementId,
  type ActorId,
  type Day,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { createActor } from './actor.js';
import {
  HARVEST_TRIBUTE_DAY_OF_YEAR,
  MONTHLY_ASSESSMENT_INTERVAL_DAYS,
  assessTaxes,
  createTaxShipmentCaravan,
  isHarvestTributeDay,
  isMonthlyAssessmentDay,
  sizeShipmentForCargo,
  type TaxAssessment,
  type TaxAssessmentInputs,
  type TaxKind,
} from './taxShipment.js';

const governorId: ActorId = actorId('governor-quintus');
const vibianId: ActorId = actorId('vibian-family');
const villageA: SettlementId = settlementId('village-a');
const villageB: SettlementId = settlementId('village-b');
const cityX: SettlementId = settlementId('city-x');
const grain: ResourceId = resourceId('food.grain');
const cloth: ResourceId = resourceId('goods.cloth');
const coin: ResourceId = resourceId('goods.coin');

const baseAssessment = (overrides: Partial<TaxAssessment> = {}): TaxAssessment => ({
  kind: 'grain_tribute',
  fromSettlement: villageA,
  fromOwnerActor: vibianId,
  resource: grain,
  quantityOwed: 200,
  dueByDay: 280 as Day,
  ...overrides,
});

const baseInputs = (overrides: Partial<TaxAssessmentInputs> = {}): TaxAssessmentInputs => {
  const governor = createActor({
    id: governorId,
    kind: 'governor_office',
    name: 'Governor Quintus',
  });
  return {
    governor,
    taxRatesPercent: { harvestPct: 10, cartTollPerCart: 0, coinTaxPctOfWealth: 1 },
    settlements: [
      {
        id: villageA,
        tier: 'village',
        recentHarvestQuantity: 1000,
        recentClothProduction: 0,
        ownerActors: [{ id: vibianId, treasury: 0 }],
      },
    ],
    today: HARVEST_TRIBUTE_DAY_OF_YEAR as Day,
    ...overrides,
  };
};

describe('cadence helpers', () => {
  it('isHarvestTributeDay matches HARVEST_TRIBUTE_DAY_OF_YEAR each year', () => {
    expect(isHarvestTributeDay(HARVEST_TRIBUTE_DAY_OF_YEAR as Day)).toBe(true);
    expect(isHarvestTributeDay((HARVEST_TRIBUTE_DAY_OF_YEAR + 365) as Day)).toBe(true);
    expect(isHarvestTributeDay((HARVEST_TRIBUTE_DAY_OF_YEAR + 1) as Day)).toBe(false);
    expect(isHarvestTributeDay(0 as Day)).toBe(false);
  });

  it('isMonthlyAssessmentDay matches every MONTHLY_ASSESSMENT_INTERVAL_DAYS', () => {
    expect(isMonthlyAssessmentDay(0 as Day)).toBe(true);
    expect(isMonthlyAssessmentDay(MONTHLY_ASSESSMENT_INTERVAL_DAYS as Day)).toBe(true);
    expect(isMonthlyAssessmentDay((MONTHLY_ASSESSMENT_INTERVAL_DAYS * 5) as Day)).toBe(true);
    expect(isMonthlyAssessmentDay(1 as Day)).toBe(false);
    expect(isMonthlyAssessmentDay((MONTHLY_ASSESSMENT_INTERVAL_DAYS - 1) as Day)).toBe(false);
  });

  it('HARVEST_TRIBUTE_DAY_OF_YEAR is in autumn/early winter (≥270)', () => {
    expect(HARVEST_TRIBUTE_DAY_OF_YEAR).toBeGreaterThanOrEqual(270);
    expect(HARVEST_TRIBUTE_DAY_OF_YEAR).toBeLessThan(365);
  });

  it('MONTHLY_ASSESSMENT_INTERVAL_DAYS is approximately a month (28..32)', () => {
    expect(MONTHLY_ASSESSMENT_INTERVAL_DAYS).toBeGreaterThanOrEqual(28);
    expect(MONTHLY_ASSESSMENT_INTERVAL_DAYS).toBeLessThanOrEqual(32);
  });
});

describe('assessTaxes — harvest tribute', () => {
  it('assesses harvestPct of recentHarvestQuantity per owning actor', () => {
    const inputs = baseInputs();
    const out = assessTaxes(inputs);
    const grainBills = out.filter((a) => a.kind === 'grain_tribute');
    expect(grainBills).toHaveLength(1);
    expect(grainBills[0]?.quantityOwed).toBe(100); // 10% of 1000
    expect(grainBills[0]?.fromSettlement).toBe(villageA);
    expect(grainBills[0]?.fromOwnerActor).toBe(vibianId);
    expect(grainBills[0]?.resource).toBe(grain);
  });

  it('returns no harvest tribute outside of HARVEST_TRIBUTE_DAY_OF_YEAR', () => {
    const inputs = baseInputs({ today: 100 as Day });
    const out = assessTaxes(inputs);
    expect(out.filter((a) => a.kind === 'grain_tribute')).toHaveLength(0);
  });

  it('splits tribute across multiple owner actors equally per ownerActors[]', () => {
    const otherId = actorId('aurelian-family');
    const inputs = baseInputs({
      settlements: [
        {
          id: villageA,
          tier: 'village',
          recentHarvestQuantity: 1000,
          recentClothProduction: 0,
          ownerActors: [
            { id: vibianId, treasury: 0 },
            { id: otherId, treasury: 0 },
          ],
        },
      ],
    });
    const out = assessTaxes(inputs);
    const grainBills = out.filter((a) => a.kind === 'grain_tribute');
    expect(grainBills).toHaveLength(2);
    const sum = grainBills.reduce((s, a) => s + a.quantityOwed, 0);
    expect(sum).toBe(100);
    // Equal split.
    expect(grainBills[0]?.quantityOwed).toBe(50);
    expect(grainBills[1]?.quantityOwed).toBe(50);
  });

  it('produces no bills for a settlement with zero harvest', () => {
    const inputs = baseInputs({
      settlements: [
        {
          id: villageA,
          tier: 'village',
          recentHarvestQuantity: 0,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 0 }],
        },
      ],
    });
    const out = assessTaxes(inputs);
    expect(out.filter((a) => a.kind === 'grain_tribute')).toHaveLength(0);
  });

  it('handles multiple settlements independently', () => {
    const inputs = baseInputs({
      settlements: [
        {
          id: villageA,
          tier: 'village',
          recentHarvestQuantity: 1000,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 0 }],
        },
        {
          id: villageB,
          tier: 'village',
          recentHarvestQuantity: 500,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 0 }],
        },
      ],
    });
    const out = assessTaxes(inputs);
    const grainBills = out.filter((a) => a.kind === 'grain_tribute');
    expect(grainBills).toHaveLength(2);
    const fromB = grainBills.find((b) => b.fromSettlement === villageB);
    expect(fromB?.quantityOwed).toBe(50);
  });

  it('rejects negative or non-integer harvest', () => {
    const inputs = baseInputs({
      settlements: [
        {
          id: villageA,
          tier: 'village',
          recentHarvestQuantity: -10,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 0 }],
        },
      ],
    });
    expect(() => assessTaxes(inputs)).toThrow();
  });
});

describe('assessTaxes — coin tax', () => {
  it('assesses coinTaxPctOfWealth of each owning actor treasury on monthly day', () => {
    const inputs = baseInputs({
      today: MONTHLY_ASSESSMENT_INTERVAL_DAYS as Day,
      settlements: [
        {
          id: cityX,
          tier: 'small_city',
          recentHarvestQuantity: 0,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 10000 }],
        },
      ],
      taxRatesPercent: { harvestPct: 10, cartTollPerCart: 0, coinTaxPctOfWealth: 1 },
    });
    const out = assessTaxes(inputs);
    const coinBills = out.filter((a) => a.kind === 'coin_tax');
    expect(coinBills).toHaveLength(1);
    expect(coinBills[0]?.quantityOwed).toBe(100); // 1% of 10000
    expect(coinBills[0]?.resource).toBe(coin);
  });

  it('does not assess coin tax outside monthly assessment day', () => {
    const inputs = baseInputs({
      today: 5 as Day,
      settlements: [
        {
          id: cityX,
          tier: 'small_city',
          recentHarvestQuantity: 0,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 10000 }],
        },
      ],
    });
    const out = assessTaxes(inputs);
    expect(out.filter((a) => a.kind === 'coin_tax')).toHaveLength(0);
  });

  it('skips actors with zero treasury', () => {
    const inputs = baseInputs({
      today: MONTHLY_ASSESSMENT_INTERVAL_DAYS as Day,
      settlements: [
        {
          id: cityX,
          tier: 'small_city',
          recentHarvestQuantity: 0,
          recentClothProduction: 0,
          ownerActors: [{ id: vibianId, treasury: 0 }],
        },
      ],
    });
    const out = assessTaxes(inputs);
    expect(out.filter((a) => a.kind === 'coin_tax')).toHaveLength(0);
  });
});

describe('assessTaxes — cloth levy', () => {
  it('assesses harvestPct of recent cloth production on the harvest tribute day', () => {
    const inputs = baseInputs({
      settlements: [
        {
          id: cityX,
          tier: 'small_city',
          recentHarvestQuantity: 0,
          recentClothProduction: 200,
          ownerActors: [{ id: vibianId, treasury: 0 }],
        },
      ],
    });
    const out = assessTaxes(inputs);
    const clothBills = out.filter((a) => a.kind === 'cloth_levy');
    expect(clothBills).toHaveLength(1);
    expect(clothBills[0]?.resource).toBe(cloth);
    expect(clothBills[0]?.quantityOwed).toBe(20); // 10% of 200
  });
});

describe('sizeShipmentForCargo', () => {
  it('grain shipment uses mules sized to ~80 kg net per mule (with buffer)', () => {
    // 100 modii of grain × 6.7 kg = 670 kg. Mules carry 100 kg each but with
    // 30% buffer we want ~870 kg of capacity → ceil(870/100) = 9 mules.
    const sized = sizeShipmentForCargo(grain, 100);
    expect(sized.animals.mule ?? 0).toBeGreaterThanOrEqual(9);
    expect(sized.animals.mule ?? 0).toBeLessThanOrEqual(11);
  });

  it('larger quantity → more animals (proportional scaling)', () => {
    const small = sizeShipmentForCargo(grain, 50);
    const big = sizeShipmentForCargo(grain, 500);
    expect(big.animals.mule ?? 0).toBeGreaterThan(small.animals.mule ?? 0);
    expect(big.animals.mule ?? 0).toBeGreaterThan(5 * (small.animals.mule ?? 0) * 0.8);
  });

  it('crew always includes at least 1 official, 2 guards, and at least 1 drover', () => {
    const sized = sizeShipmentForCargo(grain, 50);
    const officials = sized.crew.find((m) => m.kind === 'merchant'); // we use 'merchant' as the official-stand-in (no 'official' crew kind in v1)
    const guards = sized.crew.find((m) => m.kind === 'caravan_guard');
    const drovers = sized.crew.find((m) => m.kind === 'drover');
    expect(officials?.count ?? 0).toBeGreaterThanOrEqual(1);
    expect(guards?.count ?? 0).toBeGreaterThanOrEqual(2);
    expect(drovers?.count ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('larger shipments scale guards and drovers up too', () => {
    const small = sizeShipmentForCargo(grain, 50);
    const big = sizeShipmentForCargo(grain, 1000);
    const guardsSmall = small.crew.find((m) => m.kind === 'caravan_guard')?.count ?? 0;
    const guardsBig = big.crew.find((m) => m.kind === 'caravan_guard')?.count ?? 0;
    const droversSmall = small.crew.find((m) => m.kind === 'drover')?.count ?? 0;
    const droversBig = big.crew.find((m) => m.kind === 'drover')?.count ?? 0;
    expect(guardsBig).toBeGreaterThan(guardsSmall);
    expect(droversBig).toBeGreaterThan(droversSmall);
  });

  it('coin shipments use a small horse-mounted escort (coin is light per unit)', () => {
    const sized = sizeShipmentForCargo(coin, 1000);
    // 1000 coins × 1 kg/unit (per catalog) = 1000 kg. Either way, it should
    // produce some animals and an escort.
    const totalAnimals = Object.values(sized.animals).reduce((s, n) => s + (n ?? 0), 0);
    expect(totalAnimals).toBeGreaterThan(0);
    const guards = sized.crew.find((m) => m.kind === 'caravan_guard')?.count ?? 0;
    expect(guards).toBeGreaterThanOrEqual(2);
  });

  it('rejects non-positive quantities', () => {
    expect(() => sizeShipmentForCargo(grain, 0)).toThrow();
    expect(() => sizeShipmentForCargo(grain, -1)).toThrow();
  });
});

describe('createTaxShipmentCaravan', () => {
  it('produces a caravan owned by the governor with the assessed cargo loaded', () => {
    const caravan = createTaxShipmentCaravan({
      id: caravanId('tax-1'),
      assessment: baseAssessment({ resource: grain, quantityOwed: 50 }),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 30, r: 0 },
      governorActor: governorId,
      rng: createRng('tax-1'),
    });
    expect(caravan.ownerActor).toBe(governorId);
    expect(caravan.cargo.get(grain) ?? 0).toBeGreaterThan(50);
    expect(caravan.position.q).toBe(0);
    expect(caravan.destination?.q).toBe(30);
  });

  it('caravan has enough capacity for the cargo (with buffer)', () => {
    const caravan = createTaxShipmentCaravan({
      id: caravanId('tax-cap'),
      assessment: baseAssessment({ resource: grain, quantityOwed: 200 }),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 30, r: 0 },
      governorActor: governorId,
      rng: createRng('tax-cap'),
    });
    const cargoKg = totalCargoWeightKg(caravan);
    const capKg = totalCarryKg(caravan);
    expect(capKg).toBeGreaterThanOrEqual(cargoKg);
    // Buffer should be ≥10% above cargo weight.
    expect(capKg).toBeGreaterThanOrEqual(cargoKg * 1.1);
  });

  it('bigger assessment → more guards and animals than smaller (proportional escort)', () => {
    const small = createTaxShipmentCaravan({
      id: caravanId('small'),
      assessment: baseAssessment({ quantityOwed: 30 }),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 10, r: 0 },
      governorActor: governorId,
      rng: createRng('small'),
    });
    const big = createTaxShipmentCaravan({
      id: caravanId('big'),
      assessment: baseAssessment({ quantityOwed: 600 }),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 10, r: 0 },
      governorActor: governorId,
      rng: createRng('big'),
    });
    const guardsOf = (c: ReturnType<typeof createTaxShipmentCaravan>): number =>
      c.crew.find((m) => m.kind === 'caravan_guard')?.count ?? 0;
    const animalsOf = (c: ReturnType<typeof createTaxShipmentCaravan>): number =>
      Object.values(c.animals).reduce((s, n) => s + (n ?? 0), 0);
    expect(guardsOf(big)).toBeGreaterThan(guardsOf(small));
    expect(animalsOf(big)).toBeGreaterThan(animalsOf(small));
  });

  it('guard equipment level is non-zero (escort is armed)', () => {
    const caravan = createTaxShipmentCaravan({
      id: caravanId('armed'),
      assessment: baseAssessment(),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 20, r: 0 },
      governorActor: governorId,
      rng: createRng('armed'),
    });
    const guards = caravan.crew.find((m) => m.kind === 'caravan_guard');
    expect(guards?.weapons ?? 0).toBeGreaterThan(0);
    expect(guards?.armor ?? 0).toBeGreaterThan(0);
  });

  it('is deterministic — same inputs (including rng seed) produce identical caravan structures', () => {
    const a = createTaxShipmentCaravan({
      id: caravanId('det'),
      assessment: baseAssessment(),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 25, r: 0 },
      governorActor: governorId,
      rng: createRng('det'),
    });
    const b = createTaxShipmentCaravan({
      id: caravanId('det'),
      assessment: baseAssessment(),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 25, r: 0 },
      governorActor: governorId,
      rng: createRng('det'),
    });
    expect(a.cargo.get(grain)).toBe(b.cargo.get(grain));
    expect(a.crew.length).toBe(b.crew.length);
    for (let i = 0; i < a.crew.length; i++) {
      expect(a.crew[i]?.kind).toBe(b.crew[i]?.kind);
      expect(a.crew[i]?.count).toBe(b.crew[i]?.count);
    }
  });

  it('integrates with the caravan module: a tax caravan can be built with createCaravan-compatible data', () => {
    const caravan = createTaxShipmentCaravan({
      id: caravanId('integ'),
      assessment: baseAssessment({ quantityOwed: 100 }),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 50, r: 0 },
      governorActor: governorId,
      rng: createRng('integ'),
    });
    // The caravan must satisfy the createCaravan contract (round-trip clone).
    const rebuilt = createCaravan({
      id: caravan.id,
      ownerActor: caravan.ownerActor,
      position: caravan.position,
      crew: caravan.crew,
      animals: caravan.animals,
      vehicles: caravan.vehicles,
      destination: caravan.destination,
    });
    expect(rebuilt.ownerActor).toBe(governorId);
  });

  it('cargo weight is recorded correctly per the resource catalog', () => {
    const caravan = createTaxShipmentCaravan({
      id: caravanId('w'),
      assessment: baseAssessment({ resource: grain, quantityOwed: 10 }),
      fromHex: { q: 0, r: 0 },
      toHex: { q: 5, r: 0 },
      governorActor: governorId,
      rng: createRng('w'),
    });
    expect(totalCargoWeightKg(caravan)).toBeCloseTo(
      10 * getResource(grain).weightKgPerUnit + dailyCarriedFoodReserveKg(caravan) * 21,
      6,
    );
  });
});

describe('TaxKind enum is exhaustive over the v1 set', () => {
  it('contains the four tax kinds from docs/11', () => {
    const kinds: TaxKind[] = ['grain_tribute', 'cart_toll', 'coin_tax', 'cloth_levy'];
    for (const k of kinds) {
      // Just confirms the type literal is acceptable.
      const a: TaxKind = k;
      expect(a).toBe(k);
    }
  });
});
