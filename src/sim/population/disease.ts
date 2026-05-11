/**
 * Disease module: endemic background mortality + stochastic epidemic events.
 *
 * Per docs/04 §"Disease (in v1, locked)":
 *   - Endemic background mortality folded into baseline cohort mortality,
 *     modulated by climate (malaria worse in marshes) and density (worse in
 *     cities). Folded *here* — caller decides whether to apply alongside
 *     vital-rate mortality or in lieu of part of it.
 *   - Epidemic events: smallpox-, typhus-, and bubonic-plague-analogs.
 *     Spawn stochastically in high-density hexes, propagate via caravans
 *     (the same propagation mindset as news in docs/13), kill cohorts at
 *     disease-specific per-day rates, and may confer survivor immunity.
 *   - Defenses: settlements can declare a quarantine refusing caravans for
 *     N days. The quarantine itself is a per-day flag here; the caller
 *     enforces by checking `isQuarantined` before applying caravan-mediated
 *     transmission.
 *
 * Numbers are first-pass calibration tunable from this file.
 */

import type { Rng } from '../rng.js';
import type { Day } from '../types.js';
import type { Climate, Terrain } from '../world/terrain.js';
import { AGE_BANDS, type AgeBand, type CohortKey, type PopulationPool } from './cohort.js';
import type { CharacterClass } from './types.js';

// ---------------------------------------------------------------------------
// Disease catalog.
// ---------------------------------------------------------------------------

export interface DiseaseDef {
  /** Short identifier; used as a stable key for serialization. */
  readonly id: string;
  readonly name: string;
  /** Per-day chance an active case infects another susceptible person, in (0, 1). Coarse "force of infection". */
  readonly baseTransmissionPerDay: number;
  /** How many days the disease runs in a settlement before active cases recover or die out. */
  readonly durationDays: number;
  /** Per-day mortality fraction during illness, by age band. Missing entries default to 0. */
  readonly mortalityByAge: Partial<Record<AgeBand, number>>;
  /** Optional additive multiplier per class (e.g. slaves harder hit by typhus). */
  readonly mortalityByClass?: Partial<Record<CharacterClass, number>>;
  /** Survivors gain lifelong immunity (e.g. smallpox). */
  readonly immunityInSurvivors: boolean;
}

const SMALLPOX: DiseaseDef = {
  id: 'smallpox-analog',
  name: 'Smallpox',
  baseTransmissionPerDay: 0.18,
  durationDays: 21,
  mortalityByAge: {
    '0-4': 0.05,
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
    '55-59': 0.024,
    '60-64': 0.03,
    '65-69': 0.035,
    '70-74': 0.04,
    '75-79': 0.045,
    '80+': 0.05,
  },
  immunityInSurvivors: true,
};

const TYPHUS: DiseaseDef = {
  id: 'typhus-analog',
  name: 'Typhus',
  baseTransmissionPerDay: 0.12,
  durationDays: 18,
  mortalityByAge: {
    '0-4': 0.03,
    '5-9': 0.02,
    '10-14': 0.018,
    '15-19': 0.018,
    '20-24': 0.02,
    '25-29': 0.02,
    '30-34': 0.022,
    '35-39': 0.024,
    '40-44': 0.026,
    '45-49': 0.028,
    '50-54': 0.032,
    '55-59': 0.036,
    '60-64': 0.04,
    '65-69': 0.045,
    '70-74': 0.05,
    '75-79': 0.055,
    '80+': 0.06,
  },
  mortalityByClass: {
    slave: 1.4,
  },
  immunityInSurvivors: false,
};

const PLAGUE: DiseaseDef = {
  id: 'plague-analog',
  name: 'Bubonic Plague',
  baseTransmissionPerDay: 0.22,
  durationDays: 28,
  mortalityByAge: {
    '0-4': 0.09,
    '5-9': 0.08,
    '10-14': 0.075,
    '15-19': 0.07,
    '20-24': 0.07,
    '25-29': 0.07,
    '30-34': 0.07,
    '35-39': 0.072,
    '40-44': 0.075,
    '45-49': 0.08,
    '50-54': 0.085,
    '55-59': 0.09,
    '60-64': 0.1,
    '65-69': 0.11,
    '70-74': 0.12,
    '75-79': 0.13,
    '80+': 0.14,
  },
  immunityInSurvivors: false,
};

export const DISEASES: ReadonlyMap<string, DiseaseDef> = new Map<string, DiseaseDef>([
  [SMALLPOX.id, SMALLPOX],
  [TYPHUS.id, TYPHUS],
  [PLAGUE.id, PLAGUE],
]);

const DISEASE_LIST: readonly DiseaseDef[] = [SMALLPOX, TYPHUS, PLAGUE];

// ---------------------------------------------------------------------------
// Per-settlement health record.
// ---------------------------------------------------------------------------

export interface ActiveInfection {
  readonly startDay: Day;
  /** Active case count; ticks down as people recover or die. */
  activeCases: number;
}

export interface SettlementHealth {
  /** Disease id → active infection record. Cleared when activeCases hits 0 or duration expires. */
  readonly infections: Map<string, ActiveInfection>;
  /** Disease id → cumulative immune count. Only populated for diseases that confer survivor immunity. */
  readonly immune: Map<string, number>;
  /** First day on which the settlement is once again open to caravans; undefined = no quarantine. */
  quarantineUntilDay?: Day;
}

export const createSettlementHealth = (): SettlementHealth => ({
  infections: new Map(),
  immune: new Map(),
});

// ---------------------------------------------------------------------------
// Endemic background mortality.
// ---------------------------------------------------------------------------

/**
 * Annual baseline endemic-disease mortality (deaths/1000/year) before
 * climate/terrain modulation. Values are smaller than the docs/04 vital
 * rates because the vital rates already include endemic disease — this
 * function isolates only the *climate-and-terrain-modulated* slice that a
 * caller can use to differentiate plague-prone marshes from healthy hills.
 */
const ENDEMIC_BASELINE_PER1000_PER_YEAR_BY_BAND: Record<AgeBand, number> = {
  '0-4': 25,
  '5-9': 6,
  '10-14': 4,
  '15-19': 3,
  '20-24': 3,
  '25-29': 3,
  '30-34': 3,
  '35-39': 3.5,
  '40-44': 4,
  '45-49': 4.5,
  '50-54': 5.5,
  '55-59': 6.5,
  '60-64': 9,
  '65-69': 12,
  '70-74': 15,
  '75-79': 19,
  '80+': 25,
};

const climateEndemicMultiplier = (c: Climate): number => {
  switch (c) {
    case 'mediterranean':
      return 1;
    case 'temperate':
      return 1;
    case 'continental':
      return 0.95;
    case 'arid':
      return 0.85;
    case 'alpine':
      return 0.75;
  }
};

const terrainEndemicMultiplier = (t: Terrain): number => {
  switch (t) {
    case 'marsh':
      return 2.5;
    case 'urban':
      return 1.6;
    case 'river':
      return 1.15;
    case 'fertile_valley':
      return 1.1;
    case 'plains':
      return 1;
    case 'hills':
      return 0.9;
    case 'forest':
      return 0.95;
    case 'dense_forest':
      return 1;
    case 'steppe':
      return 0.9;
    case 'desert':
      return 0.95;
    case 'mountains':
      return 0.7;
    case 'lake':
      return 0.8;
    case 'ruin':
      return 1.1;
  }
};

const slaveEndemicMultiplier: Partial<Record<CharacterClass, number>> = {
  slave: 1.3,
};

const sampleBinomial = (n: number, p: number, rng: Rng): number => {
  return rng.countBelow(n, p);
};

export interface EndemicResult {
  readonly deaths: number;
}

export const applyEndemicMortality = (
  pool: PopulationPool,
  climate: Climate,
  terrain: Terrain,
  rng: Rng,
  _today: Day,
): EndemicResult => {
  if (pool.total() === 0) return { deaths: 0 };
  const climateMul = climateEndemicMultiplier(climate);
  const terrainMul = terrainEndemicMultiplier(terrain);
  let totalDeaths = 0;
  pool.forEachCohort((key, count) => {
    if (count <= 0) return;
    const annualPer1000 = ENDEMIC_BASELINE_PER1000_PER_YEAR_BY_BAND[key.age];
    const classMul = slaveEndemicMultiplier[key.class] ?? 1;
    const dailyP = (annualPer1000 / 1000 / 365) * climateMul * terrainMul * classMul;
    if (dailyP <= 0) return;
    const deaths = sampleBinomial(count, dailyP, rng);
    if (deaths > 0) {
      pool.set(key, count - deaths);
      totalDeaths += deaths;
    }
  });
  return { deaths: totalDeaths };
};

// ---------------------------------------------------------------------------
// Epidemic spawn, infection tick, caravan-mediated transmission.
// ---------------------------------------------------------------------------

/**
 * Per-day per-settlement epidemic-spawn probability. Calibrated so a small
 * settlement (low density) almost never has a spontaneous outbreak, while a
 * dense city (~20k+ people in a hex) sees one occasionally over a year.
 *
 * The functional form: p_per_day = baseRate * (density / referenceDensity).
 * referenceDensity ~= 5,000 people/hex (a small town); baseRate is a small
 * per-day chance.
 */
const EPIDEMIC_SPAWN_BASE_RATE_PER_DAY = 1 / 5_000;
const EPIDEMIC_SPAWN_REFERENCE_DENSITY = 5_000;

const climateSpawnMultiplier = (c: Climate): number => {
  switch (c) {
    case 'mediterranean':
      return 1.1;
    case 'temperate':
      return 1;
    case 'continental':
      return 0.95;
    case 'arid':
      return 0.9;
    case 'alpine':
      return 0.8;
  }
};

export interface EpidemicTriggerResult {
  readonly triggered: DiseaseDef | null;
}

export const maybeTriggerEpidemic = (
  health: SettlementHealth,
  pool: PopulationPool,
  density: number,
  climate: Climate,
  rng: Rng,
  today: Day,
): EpidemicTriggerResult => {
  if (pool.total() === 0) return { triggered: null };
  if (health.infections.size >= DISEASE_LIST.length) return { triggered: null };
  const densityFactor = Math.max(0, density) / EPIDEMIC_SPAWN_REFERENCE_DENSITY;
  const p = EPIDEMIC_SPAWN_BASE_RATE_PER_DAY * densityFactor * climateSpawnMultiplier(climate);
  if (rng.next() >= p) return { triggered: null };
  const candidates: DiseaseDef[] = [];
  for (const d of DISEASE_LIST) {
    if (!health.infections.has(d.id)) candidates.push(d);
  }
  if (candidates.length === 0) return { triggered: null };
  // Picking among candidates uses the same RNG; deterministic.
  const idx = Math.floor(rng.next() * candidates.length);
  const chosen = candidates[Math.min(idx, candidates.length - 1)];
  if (!chosen) return { triggered: null };
  // Seed an outbreak with a small starter case count.
  const seedCases = Math.max(1, Math.floor(Math.min(50, pool.total() * 0.001)));
  health.infections.set(chosen.id, { startDay: today, activeCases: seedCases });
  return { triggered: chosen };
};

export interface InfectionTickResult {
  readonly deaths: number;
  readonly recovered: number;
}

const ageBandWeight = (pool: PopulationPool): Map<AgeBand, number> => {
  const weights = new Map<AgeBand, number>();
  for (const a of AGE_BANDS) {
    weights.set(a, pool.totalByAgeBand(a));
  }
  return weights;
};

const allocateDeathsAcrossPool = (
  pool: PopulationPool,
  disease: DiseaseDef,
  activeCases: number,
  rng: Rng,
): number => {
  // For each age band, determine how many of the activeCases land there
  // (proportional to that band's share of the population), then apply the
  // per-day mortality fraction as a Bernoulli per active case.
  const total = pool.total();
  if (total === 0 || activeCases === 0) return 0;
  const bandWeights = ageBandWeight(pool);
  let totalDeaths = 0;
  let remaining = activeCases;
  let remainingPop = total;
  // Iterate bands deterministically.
  for (const band of AGE_BANDS) {
    if (remaining <= 0) break;
    const bandPop = bandWeights.get(band) ?? 0;
    if (bandPop === 0 || remainingPop <= 0) continue;
    const isLast = band === '80+';
    const allocated = isLast ? remaining : sampleBinomial(remaining, bandPop / remainingPop, rng);
    remaining -= allocated;
    remainingPop -= bandPop;
    if (allocated <= 0) continue;
    const baseMortality = disease.mortalityByAge[band] ?? 0;
    if (baseMortality <= 0) continue;
    // Distribute this band's allocated cases across (sex, class) again
    // proportional to share — this lets per-class multipliers (e.g. slaves)
    // bite. We build a per-(sex,class) snapshot for this band first.
    const subBuckets: Array<readonly [CohortKey, number]> = [];
    let subTotal = 0;
    pool.forEachCohort((key, n) => {
      if (key.age !== band || n <= 0) return;
      subBuckets.push([key, n]);
      subTotal += n;
    });
    if (subTotal === 0) continue;
    let subRemaining = allocated;
    for (let i = 0; i < subBuckets.length; i++) {
      if (subRemaining <= 0) break;
      const entry = subBuckets[i];
      if (!entry) continue;
      const [key, n] = entry;
      const isLastSub = i === subBuckets.length - 1;
      const subAllocated = isLastSub
        ? subRemaining
        : sampleBinomial(subRemaining, n / subTotal, rng);
      subRemaining -= subAllocated;
      if (subAllocated <= 0) continue;
      const classMul = disease.mortalityByClass?.[key.class] ?? 1;
      const mortality = Math.min(1, baseMortality * classMul);
      const deathsHere = Math.min(n, sampleBinomial(subAllocated, mortality, rng));
      if (deathsHere > 0) {
        pool.set(key, n - deathsHere);
        totalDeaths += deathsHere;
      }
    }
  }
  return totalDeaths;
};

export const tickInfection = (
  health: SettlementHealth,
  pool: PopulationPool,
  rng: Rng,
  today: Day,
): InfectionTickResult => {
  if (health.infections.size === 0) return { deaths: 0, recovered: 0 };
  let totalDeaths = 0;
  let totalRecovered = 0;
  // Snapshot keys so we can mutate during iteration.
  const ids = Array.from(health.infections.keys());
  for (const id of ids) {
    const inf = health.infections.get(id);
    const disease = DISEASES.get(id);
    if (!inf || !disease) continue;
    const elapsed = today - inf.startDay;
    if (elapsed >= disease.durationDays) {
      // Outbreak ends. Survivors of the active cohort either die today
      // (final wave) or recover. We treat any leftover active cases as
      // recovered (the infection has run its course and people who would
      // have died have done so on prior ticks). Per-disease, recoveries can
      // become immune.
      if (disease.immunityInSurvivors && inf.activeCases > 0) {
        const prior = health.immune.get(id) ?? 0;
        health.immune.set(id, prior + inf.activeCases);
      }
      totalRecovered += inf.activeCases;
      health.infections.delete(id);
      continue;
    }
    if (inf.activeCases <= 0) {
      // Burnt out before duration ended.
      health.infections.delete(id);
      continue;
    }
    // Apply per-day mortality across the pool, weighted by age share.
    const deaths = allocateDeathsAcrossPool(pool, disease, inf.activeCases, rng);
    totalDeaths += deaths;
    inf.activeCases -= deaths;
    if (inf.activeCases <= 0) {
      // Outbreak burned out from deaths alone; no immune accumulation.
      health.infections.delete(id);
    }
  }
  return { deaths: totalDeaths, recovered: totalRecovered };
};

// ---------------------------------------------------------------------------
// Caravan-mediated transmission.
// ---------------------------------------------------------------------------

/**
 * Per-arriving-caravan chance to seed the disease at the destination, given
 * the settlement is currently free of that disease. Calibrated so that a
 * single visiting infectious caravan has a moderate-but-not-certain chance
 * to start an outbreak — repeated exposure across many caravans makes
 * eventual transmission very likely.
 */
const CARAVAN_SEED_CHANCE_PER_DISEASE = 0.05;

export interface TransmitResult {
  readonly newInfections: readonly string[];
}

export const transmitFromCaravan = (
  health: SettlementHealth,
  caravanInfectiousFor: readonly string[],
  rng: Rng,
  today: Day,
): TransmitResult => {
  const out: string[] = [];
  for (const id of caravanInfectiousFor) {
    const disease = DISEASES.get(id);
    if (!disease) continue;
    if (health.infections.has(id)) continue;
    if (rng.next() < CARAVAN_SEED_CHANCE_PER_DISEASE) {
      health.infections.set(id, { startDay: today, activeCases: 1 });
      out.push(id);
    }
  }
  return { newInfections: out };
};

// ---------------------------------------------------------------------------
// Quarantine.
// ---------------------------------------------------------------------------

export const declareQuarantine = (health: SettlementHealth, untilDay: Day): void => {
  if (untilDay < 0) {
    throw new Error(`declareQuarantine: untilDay must be non-negative, got ${untilDay}`);
  }
  const current = health.quarantineUntilDay;
  if (current === undefined || untilDay > current) {
    health.quarantineUntilDay = untilDay;
  }
};

export const isQuarantined = (health: SettlementHealth, today: Day): boolean => {
  const until = health.quarantineUntilDay;
  if (until === undefined) return false;
  return today < until;
};
