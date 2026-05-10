/**
 * Migration carriers — people relocating to a known better destination.
 *
 * Per docs/04 §"Mortality, migration, banditry": "when wants are unmet
 * locally and conditions are better elsewhere (and the news has reached
 * them), pools drain toward better places. This is itself a caravan — they
 * walk, eat on the way, and arrive smaller than they left."
 *
 * Pillar 1 ("no hidden hands"): people do NOT flee toward unknown
 * destinations. The caller is responsible for assembling
 * `knownBetterDestinations` from what news has actually reached this
 * settlement (T18 news carriers). If the list is empty, no migration —
 * even at extreme severity. People who don't know better will starve in
 * place; that is the design.
 *
 * Movement: a column of refugees walks at ~15 hex/day (slower than caravans;
 * people carrying everything they own, mixed-age party). Daily rations
 * follow the docs/04 subsistence baseline of 0.4 kg grain-equivalent per
 * adult per day, with children at 0.5× and elders at 0.8× (matching the
 * subsistence consumption table in docs/04).
 *
 * Pathfinding: straight-line cube-coord lerp for now, matching the news
 * carrier convention. T33 will swap to A* when integrated.
 */

import type { Rng } from '../rng.js';
import type { Day, SettlementId } from '../types.js';
import { hex, hexDistance, type Hex } from '../world/hex.js';
import type { Season } from '../world/terrain.js';
import type { Settlement } from '../world/settlement.js';
import { AGE_BANDS, agedKey, type AgeBand, type CohortKey } from './cohort.js';

// ---------------------------------------------------------------------------
// CohortCounts: a Map<CohortKey, number>-shaped collection that uses a
// stable string key internally so that lookups with freshly-constructed
// CohortKey objects behave the same as lookups with cached ones.
// ---------------------------------------------------------------------------

const KEY_INTERN: Map<string, CohortKey> = new Map();
const internKey = (k: CohortKey): CohortKey => {
  const s = agedKey(k);
  const existing = KEY_INTERN.get(s);
  if (existing !== undefined) return existing;
  const frozen: CohortKey = Object.freeze({ age: k.age, sex: k.sex, class: k.class });
  KEY_INTERN.set(s, frozen);
  return frozen;
};

export interface CohortCounts {
  get(key: CohortKey): number | undefined;
  set(key: CohortKey, value: number): void;
  has(key: CohortKey): boolean;
  delete(key: CohortKey): boolean;
  readonly size: number;
  values(): IterableIterator<number>;
  keys(): IterableIterator<CohortKey>;
  entries(): IterableIterator<[CohortKey, number]>;
  [Symbol.iterator](): IterableIterator<[CohortKey, number]>;
}

class CohortCountsMap implements CohortCounts {
  readonly #data = new Map<string, number>();

  constructor(initial?: Iterable<readonly [CohortKey, number]>) {
    if (initial !== undefined) {
      for (const [k, v] of initial) {
        if (v === 0) continue;
        this.#data.set(agedKey(k), v);
      }
    }
  }

  get(key: CohortKey): number | undefined {
    return this.#data.get(agedKey(key));
  }

  set(key: CohortKey, value: number): void {
    const k = agedKey(key);
    if (value === 0) {
      this.#data.delete(k);
      return;
    }
    this.#data.set(k, value);
  }

  has(key: CohortKey): boolean {
    return this.#data.has(agedKey(key));
  }

  delete(key: CohortKey): boolean {
    return this.#data.delete(agedKey(key));
  }

  get size(): number {
    return this.#data.size;
  }

  *values(): IterableIterator<number> {
    for (const v of this.#data.values()) yield v;
  }

  *keys(): IterableIterator<CohortKey> {
    for (const k of this.#data.keys()) {
      const parsed = parseAgedKey(k);
      yield parsed;
    }
  }

  *entries(): IterableIterator<[CohortKey, number]> {
    for (const [k, v] of this.#data) {
      yield [parseAgedKey(k), v];
    }
  }

  [Symbol.iterator](): IterableIterator<[CohortKey, number]> {
    return this.entries();
  }
}

const parseAgedKey = (s: string): CohortKey => {
  const [age, sex, cls] = s.split('|');
  if (!age || !sex || !cls) throw new Error(`Bad aged key: ${s}`);
  return internKey({
    age: age as CohortKey['age'],
    sex: sex as CohortKey['sex'],
    class: cls as CohortKey['class'],
  });
};

export const createCohortCounts = (
  initial?: Iterable<readonly [CohortKey, number]>,
): CohortCounts => new CohortCountsMap(initial);

// ---------------------------------------------------------------------------
// Reasons & known-destination type.
// ---------------------------------------------------------------------------

export type MigrationReason = 'famine' | 'unrest' | 'plague' | 'opportunity';

/**
 * A destination this settlement *knows about* (i.e. news has reached them
 * with positive reports). The caller — typically a settlement-tick handler
 * that consumes arriving news carriers (T18) — assembles this list. An
 * empty list means no migration occurs, no matter how desperate.
 */
export interface KnownDestination {
  readonly id: SettlementId;
  readonly positionHex: Hex;
  /** 0..1: how good the conditions there sound according to current news. */
  readonly estimatedConditionsScore: number;
}

// ---------------------------------------------------------------------------
// Decision: who leaves and where.
// ---------------------------------------------------------------------------

export interface MigrationDecision {
  readonly fromSettlement: SettlementId;
  readonly toSettlement: SettlementId;
  /** Cohort → number leaving (always ≤ pool[cohort]). */
  readonly cohorts: CohortCounts;
  readonly reason: MigrationReason;
}

export interface DecideEmigrationInputs {
  readonly settlement: Settlement;
  /** 0..1 unmet-want severity computed by the market clearing diagnostics. */
  readonly unmetWantSeverity: number;
  readonly reason: MigrationReason;
  readonly knownBetterDestinations: readonly KnownDestination[];
  readonly rng: Rng;
}

/** Severity below this threshold yields no migration (the discomfort is bearable). */
const SEVERITY_THRESHOLD = 0.15;

/** Maximum fraction of any cohort to drain per decision (avoid emptying a cohort in one tick). */
const MAX_COHORT_DRAIN_FRACTION = 0.5;

/**
 * Per-age relative pull weight. Famine drains young adults preferentially
 * (they're the most mobile, the most valuable laborers, and the ones a
 * destination will hire); plague drains broadly because the threat itself
 * is age-blind. These are profile shapes, not absolute fractions.
 */
const AGE_PROFILE_FAMINE: Record<AgeBand, number> = {
  '0-4': 0.05,
  '5-9': 0.1,
  '10-14': 0.15,
  '15-19': 0.6,
  '20-24': 1,
  '25-29': 1,
  '30-34': 0.9,
  '35-39': 0.8,
  '40-44': 0.6,
  '45-49': 0.4,
  '50-54': 0.25,
  '55-59': 0.18,
  '60-64': 0.12,
  '65-69': 0.07,
  '70-74': 0.04,
  '75-79': 0.02,
  '80+': 0.01,
};

const AGE_PROFILE_PLAGUE: Record<AgeBand, number> = {
  '0-4': 0.7,
  '5-9': 0.8,
  '10-14': 0.85,
  '15-19': 0.9,
  '20-24': 1,
  '25-29': 1,
  '30-34': 1,
  '35-39': 0.95,
  '40-44': 0.9,
  '45-49': 0.85,
  '50-54': 0.8,
  '55-59': 0.75,
  '60-64': 0.7,
  '65-69': 0.65,
  '70-74': 0.6,
  '75-79': 0.5,
  '80+': 0.4,
};

const AGE_PROFILE_UNREST: Record<AgeBand, number> = {
  '0-4': 0.2,
  '5-9': 0.3,
  '10-14': 0.4,
  '15-19': 0.7,
  '20-24': 1,
  '25-29': 1,
  '30-34': 0.95,
  '35-39': 0.85,
  '40-44': 0.7,
  '45-49': 0.5,
  '50-54': 0.35,
  '55-59': 0.25,
  '60-64': 0.18,
  '65-69': 0.12,
  '70-74': 0.08,
  '75-79': 0.05,
  '80+': 0.03,
};

const AGE_PROFILE_OPPORTUNITY: Record<AgeBand, number> = {
  '0-4': 0.05,
  '5-9': 0.05,
  '10-14': 0.1,
  '15-19': 0.4,
  '20-24': 1,
  '25-29': 0.95,
  '30-34': 0.7,
  '35-39': 0.5,
  '40-44': 0.3,
  '45-49': 0.2,
  '50-54': 0.1,
  '55-59': 0.05,
  '60-64': 0.03,
  '65-69': 0.02,
  '70-74': 0.01,
  '75-79': 0.005,
  '80+': 0.002,
};

const ageProfileFor = (reason: MigrationReason): Record<AgeBand, number> => {
  switch (reason) {
    case 'famine':
      return AGE_PROFILE_FAMINE;
    case 'plague':
      return AGE_PROFILE_PLAGUE;
    case 'unrest':
      return AGE_PROFILE_UNREST;
    case 'opportunity':
      return AGE_PROFILE_OPPORTUNITY;
  }
};

const sampleBinomial = (n: number, p: number, rng: Rng): number => {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (rng.next() < p) k++;
  }
  return k;
};

const pickBestDestination = (
  destinations: readonly KnownDestination[],
): KnownDestination | null => {
  if (destinations.length === 0) return null;
  let best: KnownDestination | null = null;
  for (const d of destinations) {
    if (best === null || d.estimatedConditionsScore > best.estimatedConditionsScore) {
      best = d;
    }
  }
  return best;
};

export const decideEmigration = (input: DecideEmigrationInputs): MigrationDecision | null => {
  // Pillar-1 knowledge gate: no destinations known → no migration.
  if (input.knownBetterDestinations.length === 0) return null;
  if (input.unmetWantSeverity < SEVERITY_THRESHOLD) return null;
  const dest = pickBestDestination(input.knownBetterDestinations);
  if (dest === null) return null;

  const profile = ageProfileFor(input.reason);
  // Severity scales the overall outflow. Cap at MAX_COHORT_DRAIN_FRACTION so
  // we never empty a cohort completely in one tick.
  const severityScale = Math.min(1, Math.max(0, input.unmetWantSeverity));

  const cohorts = createCohortCounts();
  let total = 0;
  // Iterate the settlement's pool deterministically by walking age bands so
  // the RNG draw order is stable across runs.
  // For each cohort, draw a binomial with p = profile * severity * MAX_DRAIN.
  // Slaves don't migrate (they're property; cf. docs/04 §"Class structure").
  for (const a of AGE_BANDS) {
    const profileWeight = profile[a];
    if (profileWeight <= 0) continue;
    const p = severityScale * MAX_COHORT_DRAIN_FRACTION * profileWeight;
    if (p <= 0) continue;
    for (const [key, count] of input.settlement.population.cohorts()) {
      if (key.age !== a) continue;
      if (key.class === 'slave') continue;
      if (count <= 0) continue;
      const leavers = sampleBinomial(count, Math.min(1, p), input.rng);
      if (leavers > 0) {
        cohorts.set(key, leavers);
        total += leavers;
      }
    }
  }

  if (total === 0) return null;
  return {
    fromSettlement: input.settlement.id,
    toSettlement: dest.id,
    cohorts,
    reason: input.reason,
  };
};

// ---------------------------------------------------------------------------
// Migration column lifecycle.
// ---------------------------------------------------------------------------

export interface MigrationColumn {
  readonly id: string;
  readonly origin: SettlementId;
  readonly destination: SettlementId;
  readonly destinationHex: Hex;
  position: Hex;
  readonly cohorts: CohortCounts;
  rationsKg: number;
  daysOnRoad: number;
  readonly reason: MigrationReason;
}

export interface CreateMigrationColumnInput {
  readonly id: string;
  readonly decision: MigrationDecision;
  readonly originHex: Hex;
  readonly destinationHex: Hex;
  readonly initialRationsKg: number;
}

export const createMigrationColumn = (input: CreateMigrationColumnInput): MigrationColumn => {
  if (input.id.length === 0) {
    throw new Error('MigrationColumn id must be non-empty');
  }
  if (input.initialRationsKg < 0 || !Number.isFinite(input.initialRationsKg)) {
    throw new Error(`initialRationsKg must be non-negative finite, got ${input.initialRationsKg}`);
  }
  return {
    id: input.id,
    origin: input.decision.fromSettlement,
    destination: input.decision.toSettlement,
    destinationHex: input.destinationHex,
    position: input.originHex,
    cohorts: createCohortCounts(input.decision.cohorts),
    rationsKg: input.initialRationsKg,
    daysOnRoad: 0,
    reason: input.decision.reason,
  };
};

// ---------------------------------------------------------------------------
// Movement & ration accounting.
// ---------------------------------------------------------------------------

/** Refugee column hexes/day baseline (slower than a caravan; mixed-age party with belongings). */
const COLUMN_SPEED_PER_DAY = 15;

/** Subsistence baseline from docs/04 §"Consumption per adult per day". */
const ADULT_RATIONS_KG_PER_DAY = 0.4;
const CHILD_RATIONS_FACTOR = 0.5;
const ELDER_RATIONS_FACTOR = 0.8;

const CHILD_AGE_BANDS: ReadonlySet<AgeBand> = new Set(['0-4', '5-9', '10-14']);
const ELDER_AGE_BANDS: ReadonlySet<AgeBand> = new Set(['60-64', '65-69', '70-74', '75-79', '80+']);

const adultEquivalent = (band: AgeBand): number => {
  if (CHILD_AGE_BANDS.has(band)) return CHILD_RATIONS_FACTOR;
  if (ELDER_AGE_BANDS.has(band)) return ELDER_RATIONS_FACTOR;
  return 1;
};

const totalAdultEquivalents = (cohorts: CohortCounts): number => {
  let total = 0;
  for (const [key, n] of cohorts) total += n * adultEquivalent(key.age);
  return total;
};

/**
 * Per-day starvation mortality fraction when a person eats nothing. Real
 * starvation kills over weeks (~30-60 days), so a single missed day kills a
 * small fraction. Higher in young/old, lower in adults.
 */
const STARVATION_DAILY_MORTALITY_BY_BAND: Partial<Record<AgeBand, number>> = {
  '0-4': 0.04,
  '5-9': 0.025,
  '10-14': 0.015,
  '15-19': 0.012,
  '20-24': 0.012,
  '25-29': 0.012,
  '30-34': 0.012,
  '35-39': 0.013,
  '40-44': 0.014,
  '45-49': 0.016,
  '50-54': 0.02,
  '55-59': 0.025,
  '60-64': 0.03,
  '65-69': 0.035,
  '70-74': 0.045,
  '75-79': 0.055,
  '80+': 0.07,
};

interface CubeHex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const toCube = (h: Hex): CubeHex => ({ x: h.q, z: h.r, y: -h.q - h.r });
const fromCube = (c: CubeHex): Hex => hex(c.x, c.z);
const cubeRound = (c: CubeHex): CubeHex => {
  let rx = Math.round(c.x);
  let ry = Math.round(c.y);
  let rz = Math.round(c.z);
  const dx = Math.abs(rx - c.x);
  const dy = Math.abs(ry - c.y);
  const dz = Math.abs(rz - c.z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx, y: ry, z: rz };
};
const cubeLerp = (a: CubeHex, b: CubeHex, t: number): CubeHex => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

const stepToward = (from: Hex, to: Hex, speed: number): Hex => {
  const distance = hexDistance(from, to);
  if (distance === 0) return from;
  if (speed >= distance) return to;
  const t = speed / distance;
  return fromCube(cubeRound(cubeLerp(toCube(from), toCube(to), t)));
};

const seasonSpeedMultiplier = (season: Season): number => {
  switch (season) {
    case 'spring':
      return 0.9;
    case 'summer':
      return 1;
    case 'autumn':
      return 0.95;
    case 'winter':
      return 0.7;
  }
};

export interface MigrationTickInputs {
  readonly column: MigrationColumn;
  readonly season: Season;
  readonly today: Day;
  readonly rng: Rng;
}

export interface MigrationTickResult {
  readonly column: MigrationColumn;
  readonly arrived: boolean;
  readonly deathsEnRoute: CohortCounts;
  readonly rationsConsumed: number;
}

/**
 * A small per-person pantry the column should ideally arrive with. Callers
 * can use this to size initial rations: `(distance / speed + buffer) * AE *
 * 0.4 + persons * ARRIVAL_RATIONS_REMAINDER_KG_PER_PERSON`.
 */
export const ARRIVAL_RATIONS_REMAINDER_KG_PER_PERSON = 1;

export const tickMigration = (input: MigrationTickInputs): MigrationTickResult => {
  const { column, season, rng } = input;
  // Already arrived: no movement, no consumption.
  if (hexDistance(column.position, column.destinationHex) === 0) {
    return {
      column,
      arrived: true,
      deathsEnRoute: createCohortCounts(),
      rationsConsumed: 0,
    };
  }

  // Compute today's rations need.
  const adultEq = totalAdultEquivalents(column.cohorts);
  const requiredRations = adultEq * ADULT_RATIONS_KG_PER_DAY;
  const consumed = Math.min(column.rationsKg, requiredRations);
  const shortfall = Math.max(0, requiredRations - consumed);
  const shortfallFraction = requiredRations > 0 ? shortfall / requiredRations : 0;

  // Apply starvation deaths cohort-by-cohort.
  const deaths = createCohortCounts();
  if (shortfallFraction > 0) {
    for (const [key, n] of column.cohorts) {
      if (n <= 0) continue;
      const baseMortality = STARVATION_DAILY_MORTALITY_BY_BAND[key.age] ?? 0;
      const dailyP = baseMortality * shortfallFraction;
      if (dailyP <= 0) continue;
      const d = sampleBinomial(n, Math.min(1, dailyP), rng);
      if (d > 0) {
        deaths.set(key, d);
        column.cohorts.set(key, n - d);
      }
    }
  }

  column.rationsKg = Math.max(0, column.rationsKg - consumed);

  // Move at column-speed × season multiplier (rounded down to whole hexes).
  const speed = Math.max(1, Math.floor(COLUMN_SPEED_PER_DAY * seasonSpeedMultiplier(season)));
  column.position = stepToward(column.position, column.destinationHex, speed);
  column.daysOnRoad += 1;
  const arrived = hexDistance(column.position, column.destinationHex) === 0;

  return {
    column,
    arrived,
    deathsEnRoute: deaths,
    rationsConsumed: consumed,
  };
};
