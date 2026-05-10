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
import { dailyAnimalFodderKg, dailyCrewRationKg, totalCarryKg, type Caravan } from './caravan.js';

// --- Cost helpers -----------------------------------------------------------

/** Coin cost per kg of crew rations or fodder. Crude but consistent. */
const COIN_PER_KG_FOOD = 1;

/** Wear amortization: per-day fixed maintenance cost. */
const COIN_PER_DAY_WEAR = 0.5;

/** Assumed average pace when estimating trip duration (hexes/day). */
const ASSUMED_HEXES_PER_DAY = 18;

const estimateDays = (hexes: number): number => {
  if (hexes <= 0) return 0;
  return Math.max(1, Math.ceil(hexes / ASSUMED_HEXES_PER_DAY));
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
  const dailyConsumption = dailyCrewRationKg(caravan) + dailyAnimalFodderKg(caravan);
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

const observationsForRoute = (
  origin: Hex,
  destination: Hex,
  knownPrices: Caravan['priceBook'],
): OriginDestObservation[] => {
  const out: OriginDestObservation[] = [];
  const originKey = hexKey(origin);
  const destKey = hexKey(destination);
  for (const [resource, perHex] of knownPrices) {
    const o = perHex.get(originKey)?.price;
    const d = perHex.get(destKey)?.price;
    if (o === undefined || d === undefined) continue;
    const spread = d - o;
    if (spread <= 0) continue;
    out.push({ resource, originPrice: o, destPrice: d, spread });
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
): { cargo: Map<ResourceId, Quantity>; grossSpread: number } => {
  const cargo = new Map<ResourceId, Quantity>();
  if (observations.length === 0) return { cargo, grossSpread: 0 };

  const capacityKg = totalCarryKg(caravan);
  if (capacityKg <= 0) return { cargo, grossSpread: 0 };

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
  let grossSpread = 0;
  for (const r of ranked) {
    if (remainingKg <= 0) break;
    const maxUnitsByCapacity = Math.floor(remainingKg / r.weightKgPerUnit);
    if (maxUnitsByCapacity <= 0) continue;
    cargo.set(r.obs.resource, maxUnitsByCapacity);
    grossSpread += r.obs.spread * maxUnitsByCapacity;
    remainingKg -= maxUnitsByCapacity * r.weightKgPerUnit;
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
): ExpectedProfitResult => {
  const allObs = observationsForRoute(route.from, route.to, knownPrices);
  const filtered =
    cargoCandidates.length === 0
      ? allObs
      : allObs.filter((o) => cargoCandidates.includes(o.resource));
  const { cargo, grossSpread } = planCargo(caravan, filtered);
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
}

/**
 * Straight-line hex path approximation, used for risk integration
 * when no real pathfinder result is provided. The planner doesn't
 * need a perfect path — only a representative sample of the hexes
 * it'll touch.
 */
const approximatePath = (from: Hex, to: Hex): Hex[] => {
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
): Evaluation | null => {
  if (hexEquals(candidate.hex, origin)) return null;
  const obs = observationsForRoute(origin, candidate.hex, inputs.knownPrices);
  if (obs.length === 0) return null;
  const { cargo, grossSpread } = planCargo(caravan, obs);
  if (grossSpread <= 0 || cargo.size === 0) return null;

  const distance = hexDistance(origin, candidate.hex);
  const travelCostCoin = travelCost(caravan, distance);
  const path = approximatePath(origin, candidate.hex);
  const riskMultiplier = expectedRisk(inputs.knownBanditDensity, path);
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

  const evaluations: Evaluation[] = [];
  for (const candidate of inputs.candidateSettlements) {
    const ev = evaluateCandidate(inputs.caravan, origin, candidate, inputs);
    if (ev !== null && ev.netProfit > 0) {
      evaluations.push(ev);
    }
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
    reason: formatReason(best),
  };
};
