/**
 * Demographic pyramid module: stratified population pools with
 * birth, death, and aging dynamics.
 *
 * See docs/04-population.md.
 */

export type { Sex, CharacterClass } from './types.js';
export { SEXES, CHARACTER_CLASSES } from './types.js';

export type { AgeBand, CohortKey, PopulationPool } from './cohort.js';
export {
  AGE_BANDS,
  ageBandIndex,
  agedKey,
  emptyPool,
  isFertileAgeBand,
  poolFromMap,
} from './cohort.js';

export type { VitalRates } from './vitalRates.js';
export { ROMAN_VITAL_RATES, tickDaily, tickYearly } from './vitalRates.js';

export type {
  ActiveInfection,
  DiseaseDef,
  EndemicResult,
  EpidemicTriggerResult,
  InfectionTickResult,
  SettlementHealth,
  TransmitResult,
} from './disease.js';
export {
  DISEASES,
  applyEndemicMortality,
  createSettlementHealth,
  declareQuarantine,
  isQuarantined,
  maybeTriggerEpidemic,
  tickInfection,
  transmitFromCaravan,
} from './disease.js';
