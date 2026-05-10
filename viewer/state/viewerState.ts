/**
 * Mutable viewer state — a single object the rest of the viewer reads from.
 *
 * No reactive framework: panels poll their relevant slice once per tick (or on
 * an explicit selection change). Selection is the only thing routed via a
 * subscriber list because the panels redraw on demand independently of the
 * sim loop.
 */

import type { BanditCampId, CaravanId, SettlementId } from '../../src/sim/types.js';

export type Speed = 0 | 1 | 4 | 16 | 64;
export const SPEED_LADDER: readonly Speed[] = [1, 4, 16, 64] as const;

export type OverlayKind =
  | 'none'
  | 'population'
  | 'grain_price'
  | 'bandit_threat'
  | 'patrol_coverage';

export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'settlement'; readonly id: SettlementId }
  | { readonly kind: 'caravan'; readonly id: CaravanId }
  | { readonly kind: 'bandit_camp'; readonly id: BanditCampId };

export interface ViewerState {
  speed: Speed;
  /** Current target speed when paused — pressing play resumes this speed. */
  lastNonZeroSpeed: Speed;
  paused: boolean;
  overlay: OverlayKind;
  selection: Selection;
  /** Sim ticks executed by the viewer (== world.day if not reset). */
  ticksThisRun: number;
}

export const createViewerState = (): ViewerState => ({
  speed: 16,
  lastNonZeroSpeed: 16,
  paused: false,
  overlay: 'none',
  selection: { kind: 'none' },
  ticksThisRun: 0,
});

type Listener = () => void;
const listeners = new Set<Listener>();

export const onSelectionChange = (cb: Listener): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const setSelection = (state: ViewerState, sel: Selection): void => {
  state.selection = sel;
  for (const l of listeners) l();
};
