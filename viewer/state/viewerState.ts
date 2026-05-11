/**
 * Mutable viewer state — a single object the rest of the viewer reads from.
 *
 * No reactive framework: panels poll their relevant slice once per tick (or on
 * an explicit selection change). Selection is the only thing routed via a
 * subscriber list because the panels redraw on demand independently of the
 * sim loop.
 */

import type {
  BanditCampId,
  CaravanId,
  FactionId,
  SettlementId,
} from '../../src/sim/types.js';
import type { Hex } from '../../src/sim/world/hex.js';

/**
 * Speed is the multiplier shown in the UI (1×, 4×, 16×, 64×, 256×). The
 * actual ticks-per-second is `speed × TICKS_PER_SECOND_AT_1X`, so 1× now
 * runs at 0.25 ticks/sec (a slow observation pace) and 256× recovers the
 * 64 ticks/sec top speed the old 64× used to hit.
 */
export type Speed = 0 | 1 | 4 | 16 | 64 | 256;
export const SPEED_LADDER: readonly Speed[] = [1, 4, 16, 64, 256] as const;
export const TICKS_PER_SECOND_AT_1X = 0.25;
export const speedToTicksPerSecond = (s: Speed): number => s * TICKS_PER_SECOND_AT_1X;

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
  | { readonly kind: 'bandit_camp'; readonly id: BanditCampId }
  | { readonly kind: 'hex'; readonly hex: Hex }
  | { readonly kind: 'faction'; readonly id: FactionId };

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
  speed: 1,
  lastNonZeroSpeed: 1,
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
