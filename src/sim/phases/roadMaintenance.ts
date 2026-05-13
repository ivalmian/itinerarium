/**
 * Quarterly Roman-road maintenance phase.
 *
 * Per docs/15 §C11: the governor's office pays a small per-Roman-hex
 * coin cost every quarter to keep its road network engineered + paved.
 * When the governor's treasury can't cover a hex this quarter, that
 * hex's `romanQuartersUnmaintained` counter increments; after 4
 * consecutive missed quarters (~1 year) the hex demotes to `dirt`
 * and starts accruing / decaying ordinary trail wear like any other
 * dirt road.
 *
 * Drained by the orchestrator on the quarterly cadence in tick.ts
 * (`(today + 1) % 91 === 0`).
 */

import type { Actor } from '../politics/actor.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

/** Per-Roman-hex coin cost per quarter (docs/15 §C11). 0.1 coin/hex/qtr
 *  ≈ 0.4/yr. With ~50–200 Roman hexes per province, that's 20–80
 *  coin/yr — trivial against the seeded 20–50k governor treasury. */
const ROMAN_HEX_COIN_PER_QUARTER = 0.1;
/** Quarters of missed maintenance before a Roman hex demotes to dirt. */
const MISSED_QUARTERS_TO_DOWNGRADE = 4;

export const roadMaintenancePhase = (world: WorldState, events: TickEvent[]): void => {
  let governor: Actor | undefined;
  for (const a of world.actors.values()) {
    if (a.kind === 'governor_office') {
      governor = a;
      break;
    }
  }
  if (governor === undefined) return;

  for (const [h, tile] of world.grid.tiles()) {
    if (tile.road !== 'roman') continue;
    if (governor.treasury >= ROMAN_HEX_COIN_PER_QUARTER) {
      governor.treasury -= ROMAN_HEX_COIN_PER_QUARTER;
      if (tile.romanQuartersUnmaintained !== undefined) {
        tile.romanQuartersUnmaintained = 0;
      }
    } else {
      const missed = (tile.romanQuartersUnmaintained ?? 0) + 1;
      tile.romanQuartersUnmaintained = missed;
      if (missed >= MISSED_QUARTERS_TO_DOWNGRADE) {
        // Demote to dirt; trail wear takes over from here. Start at
        // the upgrade threshold so daily decay doesn't reclaim it
        // instantly.
        tile.road = 'dirt';
        tile.roadWear = 100;
        tile.romanQuartersUnmaintained = 0;
        world.grid.markTileChanged(h);
        events.push({ type: 'road_unmaintained', hex: { q: h.q, r: h.r } });
      }
    }
  }
};
