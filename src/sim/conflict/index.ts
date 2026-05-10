/**
 * Conflict module: the shared battle resolver and the patrol state machine.
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

export type {
  CreatePatrolInput,
  DefaultPatrolRouteInput,
  KnownBanditCampOnRoute,
  KnownCaravanOnRoute,
  KnownFriendlySettlementHex,
  Patrol,
  PatrolEvent,
  PatrolEventDetail,
  PatrolEventType,
  PatrolKind,
  PatrolTickInputs,
  PatrolTickResult,
  PendingBattleTarget,
} from './patrol.js';
export { createPatrol, defaultPatrolRoute, tickPatrol } from './patrol.js';
