/**
 * Per-settlement famine-pressure record.
 *
 * Kept as a module-local `WeakMap` keyed by the `Settlement` object
 * reference (not its id) so a fresh world built in a test starts
 * with empty pressure regardless of whether a previous test used
 * the same string id. The map survives across phases inside one
 * tick AND across ticks for the same `Settlement` instance.
 *
 * Used by:
 *   - the consumption phase (reads + writes — tracks consecutive
 *     shortage days)
 *   - the annual phase (writes — resets at year boundary so a
 *     bad-harvest year doesn't permanently haunt the settlement)
 *   - the patrol assignment heuristic (reads — patrol routes
 *     deprioritize famine-stricken hinterlands)
 *
 * Originally lived inline in `src/sim/tick.ts`; moved to a shared
 * world module so the consumption / annual / patrol phases can all
 * import it without circular references when each is extracted to
 * its own file.
 */

import type { Day } from '../types.js';
import type { Settlement } from './settlement.js';

export interface FaminePressureRecord {
  consecutiveShortageDays: number;
  lastShortageDay: Day;
}

export const faminePressure: WeakMap<Settlement, FaminePressureRecord> = new WeakMap();
