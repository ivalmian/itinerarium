import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import {
  actorId,
  caravanId,
  resourceId,
  settlementId,
  type Day,
  type ResourceId,
  type SettlementId,
} from '../types.js';
import { hex, hexKey } from '../world/hex.js';
import { expectedRisk, planCaravanRoute, travelCost, type PlanCaravanRouteInputs } from './ai.js';
import {
  createCaravan,
  dailyCarriedFoodReserveKg,
  type Caravan,
  type PriceObservation,
} from './caravan.js';

const grain = resourceId('food.grain');
const wine = resourceId('food.wine');
const milk = resourceId('food.milk');
const silver = resourceId('metal.silver');
const cattle = resourceId('livestock.cattle');

const aquileia: SettlementId = settlementId('aquileia');
const ravenna: SettlementId = settlementId('ravenna');
const verona: SettlementId = settlementId('verona');

const homeHex = hex(0, 0);

const baseCaravan = (overrides: Partial<Parameters<typeof createCaravan>[0]> = {}): Caravan =>
  createCaravan({
    id: caravanId('cara-test'),
    ownerActor: actorId('vibian-house'),
    position: homeHex,
    crew: [
      { kind: 'merchant', count: 1, weapons: 0, armor: 0 },
      { kind: 'drover', count: 4, weapons: 0, armor: 0 },
      { kind: 'caravan_guard', count: 4, weapons: 1, armor: 0.5 },
    ],
    animals: { mule: 20 },
    vehicles: {},
    ...overrides,
  });

const observePrice = (
  c: Caravan,
  resource: ResourceId,
  atHex: ReturnType<typeof hex>,
  price: number,
  day: Day = 0,
): void => {
  let perHex = c.priceBook.get(resource);
  if (!perHex) {
    perHex = new Map<string, PriceObservation>();
    c.priceBook.set(resource, perHex);
  }
  perHex.set(hexKey(atHex), { price, observedOnDay: day });
};

const candAquileia = { id: aquileia, hex: hex(20, 0), tier: 'small_city' as const };
const candRavenna = { id: ravenna, hex: hex(40, 0), tier: 'town' as const };
const candVerona = { id: verona, hex: hex(0, 25), tier: 'village' as const };
const candidates = [candAquileia, candRavenna, candVerona];

const baseInputs = (
  c: Caravan,
  overrides: Partial<PlanCaravanRouteInputs> = {},
): PlanCaravanRouteInputs => ({
  caravan: c,
  candidateSettlements: candidates,
  knownPrices: c.priceBook,
  knownBanditDensity: new Map<string, number>(),
  knownToll: () => 0,
  rng: createRng('plan'),
  ...overrides,
});

describe('travelCost', () => {
  it('is positive and proportional to distance', () => {
    const c = baseCaravan();
    const c10 = travelCost(c, 10);
    const c50 = travelCost(c, 50);
    expect(c10).toBeGreaterThan(0);
    expect(c50).toBeGreaterThan(c10);
    // Roughly linear in hexes
    expect(c50 / c10).toBeGreaterThan(4);
    expect(c50 / c10).toBeLessThan(6);
  });

  it('a bigger caravan has a higher daily cost than a smaller one', () => {
    const small = baseCaravan({ animals: { mule: 5 } });
    const big = baseCaravan({ animals: { mule: 50 } });
    expect(travelCost(big, 30)).toBeGreaterThan(travelCost(small, 30));
  });

  it('returns 0 for zero hex distance', () => {
    expect(travelCost(baseCaravan(), 0)).toBe(0);
  });

  it('prices animal feed using the carried fodder reserve, not full daily fodder', () => {
    const c = baseCaravan();
    const roundTripDaysForSixHexes = 2;
    const wearForTwoDays = 1;
    expect(travelCost(c, 6)).toBeCloseTo(
      dailyCarriedFoodReserveKg(c) * roundTripDaysForSixHexes + wearForTwoDays,
      6,
    );
  });
});

describe('expectedRisk', () => {
  it('returns 0 for empty risk map', () => {
    expect(expectedRisk(new Map(), [hex(0, 0), hex(1, 0)])).toBe(0);
  });

  it('aggregates per-hex risk along the path', () => {
    const risk = new Map<string, number>([
      [hexKey(hex(1, 0)), 0.1],
      [hexKey(hex(2, 0)), 0.1],
    ]);
    const r = expectedRisk(risk, [hex(0, 0), hex(1, 0), hex(2, 0)]);
    // p(no incident) = (1-0.1)(1-0.1) = 0.81; loss = 0.19
    expect(r).toBeGreaterThan(0.18);
    expect(r).toBeLessThan(0.2);
  });

  it('returns 1 for a definitely-ambushed hex', () => {
    const risk = new Map<string, number>([[hexKey(hex(1, 0)), 1]]);
    expect(expectedRisk(risk, [hex(0, 0), hex(1, 0)])).toBe(1);
  });

  it('clamps individual probabilities to [0,1]', () => {
    const risk = new Map<string, number>([[hexKey(hex(1, 0)), 5]]);
    expect(expectedRisk(risk, [hex(0, 0), hex(1, 0)])).toBe(1);
  });
});

describe('planCaravanRoute', () => {
  it('returns null when the caravan has no price book observations', () => {
    const c = baseCaravan();
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan).toBeNull();
  });

  it('returns null when no candidate has positive expected profit', () => {
    const c = baseCaravan();
    // Same price at home and at every destination.
    observePrice(c, grain, homeHex, 5);
    for (const cand of candidates) observePrice(c, grain, cand.hex, 5);
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan).toBeNull();
  });

  it('picks the destination with positive spread and reports cargo + profit', () => {
    const c = baseCaravan();
    // Cheap grain at home, dear at aquileia. Other candidates same as home.
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    observePrice(c, grain, candRavenna.hex, 1);
    observePrice(c, grain, candVerona.hex, 1);

    const plan = planCaravanRoute(baseInputs(c));
    expect(plan).not.toBeNull();
    expect(plan?.destinationSettlement).toBe(aquileia);
    expect(plan?.expectedProfit).toBeGreaterThan(0);
    expect(plan?.cargoToCarry.has(grain)).toBe(true);
  });

  it('includes only resources observed at both endpoints', () => {
    const c = baseCaravan();
    // grain: spread at aquileia. wine: spread but missing origin price.
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    observePrice(c, wine, candAquileia.hex, 50); // origin price missing

    const plan = planCaravanRoute(baseInputs(c));
    expect(plan).not.toBeNull();
    expect(plan?.cargoToCarry.has(grain)).toBe(true);
    expect(plan?.cargoToCarry.has(wine)).toBe(false);
  });

  it('caps cargo by the caravan capacity', () => {
    const c = baseCaravan({ animals: { mule: 5 } }); // 500 kg capacity
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 100);
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan).not.toBeNull();
    // Total weight of selected cargo must not exceed capacity.
    let totalKg = 0;
    for (const [res, qty] of plan!.cargoToCarry) {
      // grain is 6.7 kg/unit
      if (res === grain) totalKg += 6.7 * qty;
    }
    // Allow a sub-unit float-rounding slack: the planner may compute the
    // quantity as 74.62... and end up at 500.0000000000001 due to ×6.7
    // multiplication. Anything within 1 kg of the cap is correct.
    expect(totalKg).toBeLessThanOrEqual(501);
  });

  it('caps cargo by available cash', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 2);
    observePrice(c, grain, candAquileia.hex, 500);
    const plan = planCaravanRoute(baseInputs(c, { cargoConstraints: { maxSpendCoin: 10 } }));
    expect(plan).not.toBeNull();
    expect(plan?.cargoToCarry.get(grain)).toBeCloseTo(5, 5);
  });

  it('can reserve trip operating cash before buying speculative cargo', () => {
    const c = baseCaravan();
    const nearby = { id: settlementId('nearby'), hex: hex(6, 0), tier: 'village' as const };
    const spendCoin = 500;
    observePrice(c, grain, homeHex, 2);
    observePrice(c, grain, nearby.hex, 500);

    const plan = planCaravanRoute(
      baseInputs(c, {
        candidateSettlements: [nearby],
        cargoConstraints: {
          maxSpendCoin: spendCoin,
          reserveTripOperatingCost: true,
        },
      }),
    );

    expect(plan).not.toBeNull();
    const expectedSpend = Math.max(0, spendCoin - travelCost(c, 6));
    expect(plan?.cargoToCarry.get(grain)).toBeCloseTo(expectedSpend / 2, 5);
  });

  it('caps cargo by stock actually available at the origin market', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 500);
    const plan = planCaravanRoute(
      baseInputs(c, {
        cargoConstraints: { originAvailableQuantity: new Map([[grain, 3]]) },
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan?.cargoToCarry.get(grain)).toBeCloseTo(3, 5);
  });

  it('caps cargo by destination bid depth (docs/15 §C22 volume-aware planning)', () => {
    // Without the destination bid-depth constraint the caravan would
    // happily plan a giant load of grain that the destination market can't
    // absorb. The book ladder at Aquileia only has bids for 4 units; the
    // planner must respect that and load 4 even though more is available
    // at origin and there's cash to spare.
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 100);
    const destBidDepth = new Map<string, Map<typeof grain, number>>([
      [hexKey(candAquileia.hex), new Map([[grain, 4]])],
    ]);
    const plan = planCaravanRoute(
      baseInputs(c, {
        cargoConstraints: { destinationBidDepth: destBidDepth },
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan?.cargoToCarry.get(grain)).toBeCloseTo(4, 5);
  });

  it('leaves capacity for missing ration reserves', () => {
    const c = baseCaravan({ animals: { mule: 5 } }); // 500 kg capacity
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 100);
    const plan = planCaravanRoute(baseInputs(c, { cargoConstraints: { reserveCapacityKg: 250 } }));
    expect(plan).not.toBeNull();
    const qty = plan?.cargoToCarry.get(grain) ?? 0;
    expect(qty * 6.7).toBeLessThanOrEqual(251);
  });

  it('can plan fractional cargo for heavy goods', () => {
    const c = baseCaravan({ animals: { mule: 5 } }); // 500 kg capacity, less than one cattle herd unit
    observePrice(c, cattle, homeHex, 100);
    observePrice(c, cattle, candAquileia.hex, 10000);
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan).not.toBeNull();
    const qty = plan?.cargoToCarry.get(cattle) ?? 0;
    expect(qty).toBeGreaterThan(0);
    expect(qty).toBeLessThan(1);
  });

  it('does not plan perishable cargo for routes longer than its shelf life', () => {
    const c = baseCaravan();
    const nearbyDairyTown = {
      id: settlementId('nearby-dairy-town'),
      hex: hex(6, 0),
      tier: 'town' as const,
    };
    observePrice(c, milk, homeHex, 1);
    observePrice(c, milk, nearbyDairyTown.hex, 100);
    observePrice(c, milk, candRavenna.hex, 1000);

    const nearbyPlan = planCaravanRoute(baseInputs(c, { candidateSettlements: [nearbyDairyTown] }));
    expect(nearbyPlan).not.toBeNull();
    expect(nearbyPlan?.cargoToCarry.has(milk)).toBe(true);

    const farPlan = planCaravanRoute(baseInputs(c, { candidateSettlements: [candRavenna] }));
    expect(farPlan).toBeNull();
  });

  it('high bandit risk reduces expected profit and may zero the plan', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    // Path from (0,0) to (20,0) — populate every hex along the line with
    // catastrophic risk so total expected loss exceeds the spread.
    const banditDensity = new Map<string, number>();
    for (let q = 0; q <= 20; q++) banditDensity.set(hexKey(hex(q, 0)), 0.99);

    const plan = planCaravanRoute(baseInputs(c, { knownBanditDensity: banditDensity }));
    // Either null or a different (less risky) destination, but not aquileia
    // with a high-confidence positive profit.
    if (plan !== null) {
      expect(plan.destinationSettlement).not.toBe(aquileia);
    }
  });

  it('moderate bandit risk reduces but does not eliminate profit', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 100); // big spread
    const safeInputs = baseInputs(c);
    const safePlan = planCaravanRoute(safeInputs);
    expect(safePlan).not.toBeNull();

    const risky = new Map<string, number>();
    for (let q = 0; q <= 20; q++) risky.set(hexKey(hex(q, 0)), 0.05);
    const riskyPlan = planCaravanRoute(baseInputs(c, { knownBanditDensity: risky }));
    expect(riskyPlan).not.toBeNull();
    expect(riskyPlan!.expectedProfit).toBeLessThan(safePlan!.expectedProfit);
    expect(riskyPlan!.expectedRiskLossMultiplier).toBeGreaterThan(0);
  });

  it('tolls reduce expected profit and can flip a marginal trip to negative', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 1.5); // tiny spread

    const cheapPlan = planCaravanRoute(baseInputs(c));
    // No tolls: maybe just barely positive.
    const heavyToll = (): number => 100000;
    const tolledPlan = planCaravanRoute(baseInputs(c, { knownToll: heavyToll }));
    expect(tolledPlan).toBeNull();
    // The without-toll plan may also be null because spread is small; either way the
    // tolled run must be no better than the untolled one.
    if (cheapPlan !== null && tolledPlan !== null) {
      expect(tolledPlan.expectedProfit).toBeLessThan(cheapPlan.expectedProfit);
    }
  });

  it('is deterministic given the same inputs and rng seed', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    observePrice(c, grain, candRavenna.hex, 5);
    const a = planCaravanRoute(baseInputs(c, { rng: createRng('det') }));
    const b = planCaravanRoute(baseInputs(c, { rng: createRng('det') }));
    expect(a).not.toBeNull();
    expect(a?.destinationSettlement).toBe(b?.destinationSettlement);
    expect(a?.expectedProfit).toBe(b?.expectedProfit);
  });

  it('familiarity tie-break: prefers a destination already in the price book', () => {
    const c = baseCaravan();
    // Two destinations with identical theoretical spread, but only aquileia
    // is in the price book — therefore familiar.
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    // Inject candidate-2 prices via a separate mechanism: the only way this
    // function "knows" about a destination's price is via the price book,
    // so a destination not in the price book has no profit visible.
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan?.destinationSettlement).toBe(aquileia);
  });

  it('family preference biases toward the family home settlement on tied profit', () => {
    const c = baseCaravan();
    // Three EQUAL-distance candidates with identical destination prices.
    // Travel cost is the same for all three, gross spread is the same,
    // so net profits are tied and the family preference is the actual
    // tiebreaker. The default candAquileia / candRavenna / candVerona
    // sit at distances 20 / 40 / 25 from origin, which lets travel
    // cost dominate when the FAMILY_PREFERENCE_FLOOR_FRACTION is 0.5
    // (the family-home eval doesn't clear the floor); the symmetric
    // ones below isolate the preference behavior.
    const tieAquileia = { id: aquileia, hex: hex(20, 0), tier: 'small_city' as const };
    const tieRavenna = { id: ravenna, hex: hex(-20, 0), tier: 'town' as const };
    const tieVerona = { id: verona, hex: hex(0, 20), tier: 'village' as const };
    const tied = [tieAquileia, tieRavenna, tieVerona];

    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, tieAquileia.hex, 10);
    observePrice(c, grain, tieRavenna.hex, 10);
    observePrice(c, grain, tieVerona.hex, 10);

    const noPref = planCaravanRoute(baseInputs(c, { candidateSettlements: tied }));
    expect(noPref).not.toBeNull();

    // With family preference set to ravenna, ravenna should win the tie.
    const withPref = planCaravanRoute(
      baseInputs(c, {
        candidateSettlements: tied,
        ownerPreferences: { preferOwnFamilyFlows: true, familyHomeSettlement: ravenna },
      }),
    );
    expect(withPref?.destinationSettlement).toBe(ravenna);
  });

  it('reports an estimatedDays > 0 for any non-trivial trip', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan?.estimatedDays).toBeGreaterThan(0);
  });

  it('reason is a non-empty string for diagnostics', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 5);
    const plan = planCaravanRoute(baseInputs(c));
    expect(plan?.reason.length).toBeGreaterThan(0);
  });

  it('high-value-per-kg cargo (silver) wins over bulk cargo when both have positive spreads', () => {
    const c = baseCaravan();
    observePrice(c, grain, homeHex, 1);
    observePrice(c, grain, candAquileia.hex, 2); // small spread
    observePrice(c, silver, homeHex, 500);
    observePrice(c, silver, candRavenna.hex, 700); // big spread, light good

    const plan = planCaravanRoute(baseInputs(c));
    // Silver run to ravenna should beat grain run to aquileia.
    expect(plan?.destinationSettlement).toBe(ravenna);
    expect(plan?.cargoToCarry.has(silver)).toBe(true);
  });
});
