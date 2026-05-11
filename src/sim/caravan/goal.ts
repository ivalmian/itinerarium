/**
 * GoalStack model for goal-bearing units (caravans, patrols, news
 * carriers, migration columns). Per docs/15 §C18 + docs/06
 * §"Goal-bearing units" + docs/10 Decision 26.
 *
 * Each unit carries an ordered stack of persistent goals. The
 * per-tick AI looks at the TOP of the stack, advances it; when the
 * top goal completes, it pops and falls through to the next. This
 * lets an NPC trader say "haul wine to City B, then trade there,
 * then return home with grain" as a single 30-day intent rather
 * than re-planning every tick.
 *
 * Goals are immutable values; advancement returns a NEW stack (or
 * the same one) so the WorldState snapshot serializes cleanly.
 */

import type { CaravanId, Position, ResourceId, SettlementId } from '../types.js';

export type Goal =
  | { readonly type: 'move_to'; readonly hex: Position }
  | {
      readonly type: 'trade_at';
      readonly settlement: SettlementId;
      /** Optional: target resources to acquire. Empty = sell whatever, buy whatever's profitable. */
      readonly buy?: readonly ResourceId[];
      readonly sell?: readonly ResourceId[];
    }
  | {
      readonly type: 'escort';
      readonly target: CaravanId;
      readonly maxDistanceHexes: number;
    }
  | {
      readonly type: 'patrol';
      readonly route: readonly Position[];
      readonly cyclesRemaining: number;
    }
  | {
      readonly type: 'return_home';
      readonly home: Position;
    }
  | {
      readonly type: 'flee_to';
      readonly safe: Position;
    };

/**
 * Lightweight check: has this unit completed the goal at the top of
 * its stack? Caravan-style goals use the unit's position; trade goals
 * compare to the settlement anchor; escort uses the target's last
 * known position (caller passes it in).
 */
export const isGoalComplete = (
  goal: Goal,
  unitPos: Position,
  context: { readonly settlementAnchorByCity?: ReadonlyMap<SettlementId, Position> },
): boolean => {
  switch (goal.type) {
    case 'move_to':
      return goal.hex.q === unitPos.q && goal.hex.r === unitPos.r;
    case 'return_home':
    case 'flee_to': {
      const target = goal.type === 'return_home' ? goal.home : goal.safe;
      return target.q === unitPos.q && target.r === unitPos.r;
    }
    case 'trade_at': {
      const anchor = context.settlementAnchorByCity?.get(goal.settlement);
      if (anchor === undefined) return false;
      return anchor.q === unitPos.q && anchor.r === unitPos.r;
    }
    case 'escort':
      // Completion is decided by the patrol/escort engine; treat as never
      // auto-complete (the engine pops it explicitly when assignment ends).
      return false;
    case 'patrol':
      return goal.cyclesRemaining <= 0;
  }
};

/**
 * Pop the top goal off a stack and return the resulting array. Returns
 * the SAME array (with last element removed) for callers that mutate
 * in place; for value-style updates pass a copy.
 */
export const popGoal = (stack: Goal[]): Goal[] => {
  if (stack.length === 0) return stack;
  stack.pop();
  return stack;
};

/** Push a new goal onto the top of the stack. */
export const pushGoal = (stack: Goal[], goal: Goal): Goal[] => {
  stack.push(goal);
  return stack;
};

/** Read the top goal without modifying the stack. */
export const peekGoal = (stack: readonly Goal[]): Goal | undefined => {
  return stack[stack.length - 1];
};
