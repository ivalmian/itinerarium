import { describe, expect, it } from 'vitest';
import { actorId, caravanId, resourceId } from '../types.js';
import {
  ANIMAL_KINDS,
  ANIMAL_SPECS,
  CREW_KINDS,
  VEHICLE_KINDS,
  VEHICLE_SPECS,
  createCaravan,
  dailyAnimalFodderKg,
  dailyCrewRationKg,
  dailyMpAllowance,
  loadFraction,
  totalCargoWeightKg,
  totalCarryKg,
  totalCrewCount,
  type AnimalKind,
  type Caravan,
  type CrewMember,
  type VehicleKind,
} from './caravan.js';

const ownerId = actorId('vibian');
const grain = resourceId('food.grain');
const wine = resourceId('food.wine');

const baseCaravan = (overrides: Partial<Parameters<typeof createCaravan>[0]> = {}): Caravan =>
  createCaravan({
    id: caravanId('cara-1'),
    ownerActor: ownerId,
    position: { q: 0, r: 0 },
    crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
    animals: { mule: 10 },
    vehicles: {},
    ...overrides,
  });

describe('ANIMAL_SPECS', () => {
  it('matches docs/06 reference numbers', () => {
    expect(ANIMAL_SPECS.donkey.carryKg).toBe(50);
    expect(ANIMAL_SPECS.donkey.fodderKgPerDay).toBe(3);
    expect(ANIMAL_SPECS.mule.carryKg).toBe(100);
    expect(ANIMAL_SPECS.mule.fodderKgPerDay).toBe(6);
    expect(ANIMAL_SPECS.horse.carryKg).toBe(80);
    expect(ANIMAL_SPECS.horse.fodderKgPerDay).toBe(7);
    expect(ANIMAL_SPECS.camel.carryKg).toBe(180);
    expect(ANIMAL_SPECS.camel.fodderKgPerDay).toBe(3);
    expect(ANIMAL_SPECS.ox.fodderKgPerDay).toBeGreaterThan(0);
  });

  it('exposes all animal kinds', () => {
    for (const k of ANIMAL_KINDS) {
      expect(ANIMAL_SPECS[k].kind).toBe(k);
    }
  });
});

describe('VEHICLE_SPECS', () => {
  it('matches docs/06 reference numbers', () => {
    expect(VEHICLE_SPECS.pack_saddle.carryKg).toBe(0); // saddle is metadata, capacity comes from animal
    expect(VEHICLE_SPECS.light_cart.carryKg).toBe(200);
    expect(VEHICLE_SPECS.ox_cart.carryKg).toBe(500);
    expect(VEHICLE_SPECS.heavy_wagon.carryKg).toBe(1200);
    expect(VEHICLE_SPECS.heavy_wagon.needsRoad).toBe(true);
    expect(VEHICLE_SPECS.ox_cart.needsRoad).toBe(true);
    expect(VEHICLE_SPECS.pack_saddle.needsRoad).toBe(false);
  });

  it('exposes all vehicle kinds', () => {
    for (const k of VEHICLE_KINDS) {
      expect(VEHICLE_SPECS[k].kind).toBe(k);
    }
  });
});

describe('CREW_KINDS', () => {
  it('exposes the docs/06 crew kinds', () => {
    expect(CREW_KINDS).toContain('merchant');
    expect(CREW_KINDS).toContain('drover');
    expect(CREW_KINDS).toContain('caravan_guard');
    expect(CREW_KINDS).toContain('soldier');
  });
});

describe('createCaravan', () => {
  it('populates required fields with sensible defaults', () => {
    const c = baseCaravan();
    expect(c.id).toBe(caravanId('cara-1'));
    expect(c.ownerActor).toBe(ownerId);
    expect(c.position).toEqual({ q: 0, r: 0 });
    expect(c.destination).toBeNull();
    expect(c.crew).toHaveLength(1);
    expect(c.animals.mule).toBe(10);
    expect(c.cargo.size).toBe(0);
    expect(c.treasury).toBe(0);
    expect(c.mpRemainingToday).toBe(0);
    expect(c.priceBook.size).toBe(0);
    expect(c.health).toBeGreaterThan(0);
    expect(c.health).toBeLessThanOrEqual(1);
  });

  it('rejects empty crew', () => {
    expect(() => baseCaravan({ crew: [] })).toThrow();
  });

  it('rejects crew with non-positive count', () => {
    expect(() =>
      baseCaravan({ crew: [{ kind: 'merchant', count: 0, weapons: 0, armor: 0 }] }),
    ).toThrow();
  });

  it('rejects negative animal counts', () => {
    expect(() => baseCaravan({ animals: { mule: -1 } })).toThrow();
  });

  it('accepts an optional destination', () => {
    const c = baseCaravan({ destination: { q: 5, r: 0 } });
    expect(c.destination).toEqual({ q: 5, r: 0 });
  });
});

describe('totalCarryKg', () => {
  it('sums animal carry capacity', () => {
    const c = baseCaravan({ animals: { mule: 10, donkey: 5 } });
    // 10 mules * 100 + 5 donkeys * 50 = 1250
    expect(totalCarryKg(c)).toBe(1250);
  });

  it('sums vehicle carry capacity', () => {
    const c = baseCaravan({ animals: { ox: 4 }, vehicles: { ox_cart: 2 } });
    // 4 oxen pull 2 ox_carts: animal carry = 4 * (ox.carryKg) + vehicle = 2 * 500
    const animalKg = 4 * ANIMAL_SPECS.ox.carryKg;
    expect(totalCarryKg(c)).toBe(animalKg + 1000);
  });

  it('returns 0 for empty animals + vehicles', () => {
    const c = baseCaravan({ animals: {}, vehicles: {} });
    expect(totalCarryKg(c)).toBe(0);
  });
});

describe('totalCargoWeightKg', () => {
  it('uses resource catalog weights', () => {
    const c = baseCaravan();
    // grain = 6.7 kg/unit
    c.cargo.set(grain, 100);
    // wine: look up real weight via catalog
    c.cargo.set(wine, 10);
    const w = totalCargoWeightKg(c);
    expect(w).toBeGreaterThan(670); // at least the grain mass
  });

  it('returns 0 for empty cargo', () => {
    const c = baseCaravan();
    expect(totalCargoWeightKg(c)).toBe(0);
  });
});

describe('loadFraction', () => {
  it('is 0 for empty cargo', () => {
    const c = baseCaravan();
    expect(loadFraction(c)).toBe(0);
  });

  it('reflects cargo / capacity', () => {
    const c = baseCaravan({ animals: { mule: 10 } });
    // capacity 1000 kg; load grain to weigh 500 kg
    c.cargo.set(grain, Math.round(500 / 6.7));
    const lf = loadFraction(c);
    expect(lf).toBeGreaterThan(0.4);
    expect(lf).toBeLessThan(0.6);
  });

  it('clamps to 1 when cargo > capacity (overload — caller should warn separately)', () => {
    const c = baseCaravan({ animals: { mule: 1 } });
    c.cargo.set(grain, 10000);
    expect(loadFraction(c)).toBe(1);
  });

  it('returns 0 if capacity is 0 even with cargo (degenerate caravan)', () => {
    const c = baseCaravan({ animals: {}, vehicles: {} });
    c.cargo.set(grain, 1);
    expect(loadFraction(c)).toBe(0);
  });
});

describe('totalCrewCount', () => {
  it('sums counts across crew entries', () => {
    const c = baseCaravan({
      crew: [
        { kind: 'merchant', count: 1, weapons: 1, armor: 0 },
        { kind: 'drover', count: 4, weapons: 0, armor: 0 },
        { kind: 'caravan_guard', count: 6, weapons: 1, armor: 0.5 },
      ],
    });
    expect(totalCrewCount(c)).toBe(11);
  });
});

describe('dailyCrewRationKg', () => {
  it('approximates 0.4 kg per crew per day', () => {
    const c = baseCaravan({
      crew: [{ kind: 'drover', count: 10, weapons: 0, armor: 0 }],
    });
    expect(dailyCrewRationKg(c)).toBeCloseTo(4.0, 5);
  });

  it('handles mixed crew', () => {
    const c = baseCaravan({
      crew: [
        { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
        { kind: 'caravan_guard', count: 4, weapons: 1, armor: 1 },
      ],
    });
    expect(dailyCrewRationKg(c)).toBeCloseTo(5 * 0.4, 5);
  });
});

describe('dailyAnimalFodderKg', () => {
  it('sums per-animal fodder', () => {
    const c = baseCaravan({ animals: { mule: 10, donkey: 5 } });
    // 10 * 6 + 5 * 3 = 75
    expect(dailyAnimalFodderKg(c)).toBe(75);
  });

  it('returns 0 with no animals', () => {
    const c = baseCaravan({ animals: {} });
    expect(dailyAnimalFodderKg(c)).toBe(0);
  });
});

describe('dailyMpAllowance', () => {
  it('a laden mule caravan on a Roman road in summer ≈ 25 hexes/day', () => {
    const c = baseCaravan({ animals: { mule: 10 } });
    c.cargo.set(grain, Math.round(800 / 6.7)); // ~80% laden
    const mp = dailyMpAllowance(c, 'plains', 'roman', 'summer');
    expect(mp).toBeGreaterThanOrEqual(20);
    expect(mp).toBeLessThanOrEqual(28);
  });

  it('off-road rough terrain laden mule ≈ 10 hexes/day', () => {
    const c = baseCaravan({ animals: { mule: 10 } });
    c.cargo.set(grain, Math.round(800 / 6.7));
    const mp = dailyMpAllowance(c, 'hills', 'none', 'summer');
    expect(mp).toBeGreaterThanOrEqual(7);
    expect(mp).toBeLessThanOrEqual(13);
  });

  it('mountain pass in winter is near-impassable (0–2 hexes)', () => {
    const c = baseCaravan({ animals: { mule: 10 } });
    c.cargo.set(grain, Math.round(800 / 6.7));
    const mp = dailyMpAllowance(c, 'mountains', 'none', 'winter');
    expect(mp).toBeGreaterThanOrEqual(0);
    expect(mp).toBeLessThanOrEqual(3);
  });

  it('an unladen caravan moves faster than a laden one', () => {
    const empty = baseCaravan({ animals: { mule: 10 } });
    const laden = baseCaravan({ animals: { mule: 10 } });
    laden.cargo.set(grain, Math.round(900 / 6.7));
    expect(dailyMpAllowance(empty, 'plains', 'roman', 'summer')).toBeGreaterThan(
      dailyMpAllowance(laden, 'plains', 'roman', 'summer'),
    );
  });

  it('road-needing vehicles drag movement off-road', () => {
    const c = baseCaravan({ animals: { ox: 4 }, vehicles: { ox_cart: 1 } });
    const onRoad = dailyMpAllowance(c, 'plains', 'roman', 'summer');
    const offRoad = dailyMpAllowance(c, 'plains', 'none', 'summer');
    expect(offRoad).toBeLessThan(onRoad);
  });

  it('returns 0 for impassable terrain (lake) regardless of season/road', () => {
    const c = baseCaravan({ animals: { mule: 10 } });
    expect(dailyMpAllowance(c, 'lake', 'roman', 'summer')).toBe(0);
  });
});

describe('caravan with full owner-and-crew structure', () => {
  it('a CrewMember can be a caravan_guard with weapons + armor', () => {
    const guard: CrewMember = { kind: 'caravan_guard', count: 6, weapons: 1, armor: 0.5 };
    const c = baseCaravan({ crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }, guard] });
    expect(totalCrewCount(c)).toBe(7);
  });
});

describe('animal kinds enumeration', () => {
  it('all 5 documented kinds are present', () => {
    const expected: readonly AnimalKind[] = ['donkey', 'mule', 'horse', 'camel', 'ox'];
    for (const k of expected) expect(ANIMAL_KINDS).toContain(k);
    expect(ANIMAL_KINDS).toHaveLength(expected.length);
  });
});

describe('vehicle kinds enumeration', () => {
  it('all 4 documented kinds are present', () => {
    const expected: readonly VehicleKind[] = [
      'pack_saddle',
      'light_cart',
      'ox_cart',
      'heavy_wagon',
    ];
    for (const k of expected) expect(VEHICLE_KINDS).toContain(k);
    expect(VEHICLE_KINDS).toHaveLength(expected.length);
  });
});
