/**
 * NPC caravan AI.
 *
 * docs/06 §"NPC caravan AI": between trips, a merchant looks at
 * its price book + travel cost + risk + tariffs and picks the
 * destination that maximizes expected profit. This is the
 * heuristic that drives every NPC caravan during burn-in;
 * without it the economy doesn't circulate.
 *
 *   expected_profit =
 *       sum_over_cargo (price_at_destination - price_at_origin)
 *     - travel_cost_in_rations_and_wear
 *     - expected_loss_from_risk
 *     - tolls_and_tariffs
 *
 * Information limit: the planner only knows what the caravan has
 * personally observed (its priceBook) — there is no global price
 * oracle. A destination the caravan has never visited cannot be
 * a target.
 */

import { getResource } from '../resources/index.js';
import type { Rng } from '../rng.js';
import type { Position, Quantity, ResourceId, SettlementId } from '../types.js';
import { hexDistance, hexEquals, hexKey, type Hex } from '../world/hex.js';
import type { SettlementTier } from '../world/settlement.js';
import {
  dailyCarriedFoodReserveKg,
  totalCarryKg,
  totalCargoWeightKg,
  type Caravan,
  type PriceObservation,
} from './caravan.js';

// --- Cost helpers -----------------------------------------------------------

/** Coin cost per kg of crew rations or fodder. Crude but consistent. */
const COIN_PER_KG_FOOD = 1;

/** Wear amortization: per-day fixed maintenance cost. */
const COIN_PER_DAY_WEAR = 0.5;

/**
 * Assumed average pace when estimating trip duration (hexes/day).
 *
 * Roads are endogenous and many early burn-in routes are off-road. With the
 * v1.5 off-road multiplier, a laden mule caravan is closer to 5-7 hexes/day
 * on unimproved ground than the older optimistic 18 hexes/day.
 */
const ASSUMED_HEXES_PER_DAY = 6;

const estimateDays = (hexes: number): number => {
  if (hexes <= 0) return 0;
  return Math.max(1, Math.ceil(hexes / ASSUMED_HEXES_PER_DAY));
};

const cargoCanSurviveTrip = (resource: ResourceId, estimatedTripDays: number): boolean => {
  const perishableDays = getResource(resource).perishableDays;
  if (perishableDays === undefined) return true;
  return estimatedTripDays <= perishableDays;
};

/** Continuous version used for cost so it scales smoothly with distance. */
const continuousDays = (hexes: number): number => {
  if (hexes <= 0) return 0;
  return hexes / ASSUMED_HEXES_PER_DAY;
};

export const travelCost = (caravan: Caravan, hexes: number): number => {
  if (hexes <= 0) return 0;
  // Round trip: a profit-seeking merchant has to come home (or at least
  // sustain itself for the return), so cost both ways.
  const days = continuousDays(hexes) * 2;
  // Match the actual provisioning model: crews eat carried food, but animals
  // graze when possible and caravans carry a prudent fodder reserve rather
  // than assuming every kilogram of daily fodder is bought as road cargo.
  const dailyConsumption = dailyCarriedFoodReserveKg(caravan);
  const food = dailyConsumption * days * COIN_PER_KG_FOOD;
  const wear = days * COIN_PER_DAY_WEAR;
  return food + wear;
};

/**
 * Aggregate per-hex risk along a path into a single 0..1 expected
 * loss multiplier. Treat each hex as an independent ambush
 * trial; the caravan loses ~1.0 of cargo on a successful ambush,
 * so the expected loss multiplier is `1 - prod(1 - p_i)`.
 *
 * The first hex (caravan's origin) is excluded — you can't be
 * ambushed standing in your own market.
 */
export const expectedRisk = (
  banditDensity: ReadonlyMap<string, number>,
  path: readonly Hex[],
): number => {
  if (path.length <= 1) return 0;
  let pSurvive = 1;
  for (let i = 1; i < path.length; i++) {
    const h = path[i] as Hex;
    const raw = banditDensity.get(hexKey(h)) ?? 0;
    const p = Math.max(0, Math.min(1, raw));
    pSurvive *= 1 - p;
  }
  const loss = 1 - pSurvive;
  // Floating-point cleanup
  return Math.max(0, Math.min(1, loss));
};

// --- Cargo selection --------------------------------------------------------

interface OriginDestObservation {
  resource: ResourceId;
  originPrice: number;
  destPrice: number;
  spread: number;
}

const observedOriginAsk = (obs: PriceObservation): number =>
  obs.askPrice !== undefined && Number.isFinite(obs.askPrice) && obs.askPrice > 0
    ? obs.askPrice
    : obs.price;

const observedDestinationBid = (obs: PriceObservation): number =>
  obs.bidPrice !== undefined && Number.isFinite(obs.bidPrice) && obs.bidPrice > 0
    ? obs.bidPrice
    : obs.price;

export interface CargoPlanningConstraints {
  /**
   * Capacity to leave empty for known missing rations/fodder capacity. This is
   * not current cargo; it is free space the merchant should not fill with trade
   * goods because survival supplies still need it.
   */
  readonly reserveCapacityKg?: number;
  /** Cash available for buying cargo after keeping survival reserves. */
  readonly maxSpendCoin?: number;
  /**
   * When true, route evaluation also withholds the estimated trip operating
   * cost from cargo spend. This keeps live merchants liquid enough to replace
   * consumed rations/wear instead of turning every coin into speculative cargo.
   */
  readonly reserveTripOperatingCost?: boolean;
  /** Locally available stock at the origin market, by resource. */
  readonly originAvailableQuantity?: ReadonlyMap<ResourceId, Quantity>;
  /**
   * Per docs/15 §C22 + C19: a per-destination, per-resource volume cap on
   * how many units the caravan can EXPECT to sell at the destination's
   * bestBid. This is the destination market's residual bid depth surfaced
   * from `Settlement.market.bidDepth`. Without this cap the planner
   * assumes infinite absorbing demand and over-loads cargo that won't
   * clear when it arrives.
   *
   * Keyed by `hexKey(destinationHex)` then by resource. Absent entries are
   * treated as unlimited (back-compat for fixtures that don't thread the
   * book through).
   */
  readonly destinationBidDepth?: ReadonlyMap<string, ReadonlyMap<ResourceId, Quantity>>;
}

const observationsForRoute = (
  origin: Hex,
  destination: Hex,
  knownPrices: Caravan['priceBook'],
): OriginDestObservation[] => {
  const out: OriginDestObservation[] = [];
  const originKey = hexKey(origin);
  const destKey = hexKey(destination);
  for (const [resource, perHex] of knownPrices) {
    const originObs = perHex.get(originKey);
    const destObs = perHex.get(destKey);
    if (originObs === undefined || destObs === undefined) continue;
    const o = observedOriginAsk(originObs);
    const d = observedDestinationBid(destObs);
    const spread = d - o;
    if (spread <= 0) continue;
    out.push({ resource, originPrice: o, destPrice: d, spread });
  }
  return out;
};

const observationsByDestination = (
  origin: Hex,
  knownPrices: Caravan['priceBook'],
): Map<string, OriginDestObservation[]> => {
  const out = new Map<string, OriginDestObservation[]>();
  const originKey = hexKey(origin);
  for (const [resource, perHex] of knownPrices) {
    const originObs = perHex.get(originKey);
    if (originObs === undefined) continue;
    const originPrice = observedOriginAsk(originObs);
    for (const [destKey, destObs] of perHex) {
      if (destKey === originKey) continue;
      const destPrice = observedDestinationBid(destObs);
      const spread = destPrice - originPrice;
      if (spread <= 0) continue;
      const obs = {
        resource,
        originPrice,
        destPrice,
        spread,
      };
      const existing = out.get(destKey);
      if (existing === undefined) out.set(destKey, [obs]);
      else existing.push(obs);
    }
  }
  return out;
};

/**
 * Greedy capacity packer: sort observations by spread-per-kg
 * (effectively the per-kg margin), then load each in turn until
 * we run out of capacity. This matches what a merchant actually
 * does — silver before grain when both have spreads.
 *
 * Returns the cargo plan and the total spread it captures (before
 * subtracting travel/risk/tolls).
 */
const planCargo = (
  caravan: Caravan,
  observations: readonly OriginDestObservation[],
  constraints: CargoPlanningConstraints = {},
  destinationKey?: string,
): { cargo: Map<ResourceId, Quantity>; grossSpread: number } => {
  const cargo = new Map<ResourceId, Quantity>();
  if (observations.length === 0) return { cargo, grossSpread: 0 };

  const reservedKg = Math.max(0, constraints.reserveCapacityKg ?? 0);
  const capacityKg = Math.max(0, totalCarryKg(caravan) - totalCargoWeightKg(caravan) - reservedKg);
  if (capacityKg <= 1e-9) return { cargo, grossSpread: 0 };

  // Per docs/15 §C22: cap each resource's planned qty at the destination's
  // residual bid depth so the caravan doesn't over-load cargo that won't
  // clear when it arrives. Falls back to "unlimited" when the book isn't
  // threaded through (fixture tests).
  const destBidDepth =
    destinationKey !== undefined ? constraints.destinationBidDepth?.get(destinationKey) : undefined;

  const ranked = observations
    .map((obs) => {
      const def = getResource(obs.resource);
      const wt = def.weightKgPerUnit > 0 ? def.weightKgPerUnit : 1;
      return { obs, weightKgPerUnit: wt, marginPerKg: obs.spread / wt };
    })
    .sort((a, b) => {
      if (b.marginPerKg !== a.marginPerKg) return b.marginPerKg - a.marginPerKg;
      // Stable secondary sort by resource id keeps determinism.
      return String(a.obs.resource).localeCompare(String(b.obs.resource));
    });

  let remainingKg = capacityKg;
  let remainingSpend = Math.max(0, constraints.maxSpendCoin ?? Number.POSITIVE_INFINITY);
  let grossSpread = 0;
  for (const r of ranked) {
    if (remainingKg <= 0) break;
    if (remainingSpend <= 1e-9) break;
    const maxUnitsByCapacity = remainingKg / r.weightKgPerUnit;
    const availability = constraints.originAvailableQuantity;
    const maxUnitsByAvailability =
      availability === undefined
        ? Number.POSITIVE_INFINITY
        : (availability.get(r.obs.resource) ?? 0);
    const maxUnitsBySpend =
      r.obs.originPrice > 0 ? remainingSpend / r.obs.originPrice : Number.POSITIVE_INFINITY;
    const maxUnitsByDestDepth =
      destBidDepth === undefined
        ? Number.POSITIVE_INFINITY
        : (destBidDepth.get(r.obs.resource) ?? Number.POSITIVE_INFINITY);
    const qty = Math.min(
      maxUnitsByCapacity,
      maxUnitsByAvailability,
      maxUnitsBySpend,
      maxUnitsByDestDepth,
    );
    if (qty <= 1e-9) continue;
    cargo.set(r.obs.resource, qty);
    grossSpread += r.obs.spread * qty;
    remainingKg -= qty * r.weightKgPerUnit;
    remainingSpend -= qty * r.obs.originPrice;
  }
  return { cargo, grossSpread };
};

// --- expectedProfit (route-level helper) ------------------------------------

export interface ExpectedProfitResult {
  profit: number;
  cargo: ReadonlyMap<ResourceId, Quantity>;
}

/**
 * Convenience wrapper exposing the gross spread - travel cost
 * computation independently of the candidate-evaluation loop.
 * Risk and tolls are not included here — the full evaluation in
 * `planCaravanRoute` adds those.
 */
export const expectedProfit = (
  caravan: Caravan,
  route: { from: Position; to: Position },
  knownPrices: Caravan['priceBook'],
  cargoCandidates: readonly ResourceId[],
  constraints: CargoPlanningConstraints = {},
): ExpectedProfitResult => {
  const allObs = observationsForRoute(route.from, route.to, knownPrices);
  const filtered =
    cargoCandidates.length === 0
      ? allObs
      : allObs.filter((o) => cargoCandidates.includes(o.resource));
  const { cargo, grossSpread } = planCargo(caravan, filtered, constraints, hexKey(route.to));
  const distance = hexDistance(route.from, route.to);
  const cost = travelCost(caravan, distance);
  return { profit: grossSpread - cost, cargo };
};

// --- Top-level plan ---------------------------------------------------------

export interface RoutePlan {
  destination: Position;
  destinationSettlement: SettlementId;
  cargoToCarry: ReadonlyMap<ResourceId, Quantity>;
  expectedProfit: number;
  expectedRiskLossMultiplier: number;
  estimatedDays: number;
  reason: string;
}

export interface CandidateSettlement {
  readonly id: SettlementId;
  readonly hex: Position;
  readonly tier: SettlementTier;
}

export interface PlanCaravanRouteInputs {
  readonly caravan: Caravan;
  readonly candidateSettlements: readonly CandidateSettlement[];
  readonly knownPrices: Caravan['priceBook'];
  readonly knownBanditDensity: ReadonlyMap<string, number>;
  readonly knownToll: (fromHex: Hex, toHex: Hex) => number;
  readonly rng: Rng;
  readonly ownerPreferences?: {
    preferOwnFamilyFlows?: boolean;
    familyHomeSettlement?: SettlementId;
  };
  readonly cargoConstraints?: CargoPlanningConstraints;
  readonly includeReason?: boolean;
  /**
   * Per docs/15 §C25: minimum **absolute** net profit (in coin) below
   * which a route is considered not worth running. Caravans currently
   * routinely fire 0%-margin trades because `netProfit > 0` is the only
   * bar — any spread, however tiny, looks attractive. Real merchants
   * have a profit floor (wages, opportunity cost of capital, depreciation
   * not fully captured by travelCost). Default 0 keeps back-compat with
   * fixtures that don't set the floor; callers in tick.ts set a sensible
   * floor.
   */
  readonly minNetProfitCoin?: number;
  /**
   * Per docs/15 §C25: minimum **fractional** net profit relative to
   * travel cost. `netProfit / travelCost >= minNetProfitFraction`. This
   * captures the "is this trip worth the time" intuition: a route with
   * net profit ≈ travel cost is "barely positive" and should be rejected
   * unless the absolute floor is loose. Default 0.
   */
  readonly minNetProfitFraction?: number;
}

/**
 * Straight-line hex path approximation, used for risk integration
 * when no real pathfinder result is provided. The planner doesn't
 * need a perfect path — only a representative sample of the hexes
 * it'll touch.
 */
export const approximatePath = (from: Hex, to: Hex): Hex[] => {
  if (hexEquals(from, to)) return [from];
  const path: Hex[] = [];
  const dq = to.q - from.q;
  const dr = to.r - from.r;
  const steps = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const q = Math.round(from.q + dq * t);
    const r = Math.round(from.r + dr * t);
    path.push({ q, r });
  }
  return path;
};

/**
 * Family caravans (docs/06 §"NPC caravan AI" last paragraph) accept a
 * profitability haircut to favor a destination tied to family flows
 * (e.g. moving family goods to the family's home market). This is a
 * floor on the "good enough vs. best" trade-off: as long as the
 * family destination clears at least this fraction of the best
 * profit, prefer it.
 */
const FAMILY_PREFERENCE_FLOOR_FRACTION = 0.5;

interface Evaluation {
  candidate: CandidateSettlement;
  cargo: Map<ResourceId, Quantity>;
  grossSpread: number;
  travelCostCoin: number;
  riskMultiplier: number;
  riskLossCoin: number;
  tollCoin: number;
  netProfit: number;
  distance: number;
}

const evaluateCandidate = (
  caravan: Caravan,
  origin: Hex,
  candidate: CandidateSettlement,
  inputs: PlanCaravanRouteInputs,
  observations: readonly OriginDestObservation[],
): Evaluation | null => {
  if (hexEquals(candidate.hex, origin)) return null;
  if (observations.length === 0) return null;
  const distance = hexDistance(origin, candidate.hex);
  const tripDays = estimateDays(distance);
  const durableObservations = observations.filter((obs) =>
    cargoCanSurviveTrip(obs.resource, tripDays),
  );
  const travelCostCoin = travelCost(caravan, distance);
  const constraints =
    inputs.cargoConstraints?.reserveTripOperatingCost === true &&
    inputs.cargoConstraints.maxSpendCoin !== undefined
      ? {
          ...inputs.cargoConstraints,
          maxSpendCoin: Math.max(0, inputs.cargoConstraints.maxSpendCoin - travelCostCoin),
        }
      : inputs.cargoConstraints;
  const { cargo, grossSpread } = planCargo(
    caravan,
    durableObservations,
    constraints,
    hexKey(candidate.hex),
  );
  if (grossSpread <= 0 || cargo.size === 0) return null;

  const riskMultiplier =
    inputs.knownBanditDensity.size === 0
      ? 0
      : expectedRisk(inputs.knownBanditDensity, approximatePath(origin, candidate.hex));
  const riskLossCoin = grossSpread * riskMultiplier;
  const tollCoin = inputs.knownToll(origin, candidate.hex);

  const netProfit = grossSpread - travelCostCoin - riskLossCoin - tollCoin;

  return {
    candidate,
    cargo,
    grossSpread,
    travelCostCoin,
    riskMultiplier,
    riskLossCoin,
    tollCoin,
    netProfit,
    distance,
  };
};

const compareEvaluations = (a: Evaluation, b: Evaluation): number => {
  if (b.netProfit !== a.netProfit) return b.netProfit - a.netProfit;
  // Stable tie-breaks: shorter trip first, then settlement id.
  if (a.distance !== b.distance) return a.distance - b.distance;
  return String(a.candidate.id).localeCompare(String(b.candidate.id));
};

const formatReason = (e: Evaluation): string => {
  const parts: string[] = [];
  parts.push(`spread=${e.grossSpread.toFixed(2)}`);
  parts.push(`travel=${e.travelCostCoin.toFixed(2)}`);
  if (e.riskLossCoin > 0) parts.push(`risk=${e.riskLossCoin.toFixed(2)}`);
  if (e.tollCoin > 0) parts.push(`tolls=${e.tollCoin.toFixed(2)}`);
  parts.push(`net=${e.netProfit.toFixed(2)}`);
  return `${String(e.candidate.id)} (${parts.join(', ')})`;
};

export const planCaravanRoute = (inputs: PlanCaravanRouteInputs): RoutePlan | null => {
  const origin = inputs.caravan.position;
  if (inputs.knownPrices.size === 0) return null;

  const observationsByDest = observationsByDestination(origin, inputs.knownPrices);
  if (observationsByDest.size === 0) return null;

  const minAbsProfit = Math.max(0, inputs.minNetProfitCoin ?? 0);
  const minFractionalProfit = Math.max(0, inputs.minNetProfitFraction ?? 0);

  const evaluations: Evaluation[] = [];
  for (const candidate of inputs.candidateSettlements) {
    const obs = observationsByDest.get(hexKey(candidate.hex));
    if (obs === undefined) continue;
    const ev = evaluateCandidate(inputs.caravan, origin, candidate, inputs, obs);
    if (ev === null) continue;
    // Per docs/15 §C25: require net profit ABOVE absolute and fractional
    // floors, not just positive. A 0.5%-margin route is not worth a
    // multi-week trip; the merchant would rather hold cargo / disband.
    if (ev.netProfit <= minAbsProfit) continue;
    if (
      minFractionalProfit > 0 &&
      ev.travelCostCoin > 0 &&
      ev.netProfit < ev.travelCostCoin * minFractionalProfit
    ) {
      continue;
    }
    evaluations.push(ev);
  }
  if (evaluations.length === 0) return null;

  // The rng is reserved for future stochastic tie-breaking; for v1 the
  // sort is deterministic and we drain a single number to keep the
  // RNG advance predictable.
  inputs.rng.next();

  evaluations.sort(compareEvaluations);
  let best = evaluations[0] as Evaluation;

  // Family preference override: if the family-home settlement is among
  // the candidates and clears the floor fraction of the best profit,
  // pick it instead. The merchant accepts a discount to keep the
  // family's logistics moving.
  const pref = inputs.ownerPreferences;
  if (pref?.preferOwnFamilyFlows && pref.familyHomeSettlement !== undefined) {
    const familyEval = evaluations.find((e) => e.candidate.id === pref.familyHomeSettlement);
    if (familyEval && familyEval.netProfit >= best.netProfit * FAMILY_PREFERENCE_FLOOR_FRACTION) {
      best = familyEval;
    }
  }

  return {
    destination: { q: best.candidate.hex.q, r: best.candidate.hex.r },
    destinationSettlement: best.candidate.id,
    cargoToCarry: best.cargo,
    expectedProfit: best.netProfit,
    expectedRiskLossMultiplier: best.riskMultiplier,
    estimatedDays: estimateDays(best.distance),
    reason: inputs.includeReason === false ? '' : formatReason(best),
  };
};
