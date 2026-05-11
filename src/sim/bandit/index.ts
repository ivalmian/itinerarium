/**
 * Bandit module: bandit camps and their per-day decision heuristics.
 *
 * See docs/12-bandits-and-conflict.md.
 */

export type {
  BanditCamp,
  CampAction,
  CampDecisionInputs,
  CampSize,
  CreateCampInput,
} from './camp.js';
export {
  applyBanditCasualties,
  campAsCombatUnit,
  campSize,
  createCamp,
  decideCampAction,
  recruit,
} from './camp.js';
