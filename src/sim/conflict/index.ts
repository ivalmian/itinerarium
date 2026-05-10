/**
 * Conflict module: the shared battle resolver.
 *
 * See docs/12-bandits-and-conflict.md.
 */

export type {
  BattleOpts,
  BattleResult,
  BattleSurvivor,
  CasualtyRecord,
  CombatUnit,
  Posture,
  SurvivorFate,
} from './battle.js';
export { campaignerUnit, resolveBattle } from './battle.js';
