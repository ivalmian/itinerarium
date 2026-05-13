/**
 * Daily road-wear maintenance phase.
 *
 * Per docs/06 §"Trail wear → emergent dirt roads": every non-Roman
 * hex's `roadWear` counter decays a little each day; when wear on a
 * `none` hex exceeds the upgrade threshold the hex promotes to
 * `dirt`; sustained low wear on a `dirt` hex demotes it back to
 * `none`. Roman roads are exempt (handled separately by the
 * road-maintenance phase).
 *
 * Decay rate scales with local road density: an isolated dirt stub
 * decays slowly, a busy junction's parallel dirt branches decay
 * faster because traffic competes between them.
 *
 * Iterates every tile in the grid; the per-tile work is one subtract
 * + a couple of branches, so at 6,400 hexes (80×80) the phase
 * completes in <0.1 ms.
 */

import type { Day } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';
import {
  countRoadNeighbors,
  DIRT_DOWNGRADE_THRESHOLD,
  DIRT_ROAD_DECAY_PER_DAY,
  DIRT_UPGRADE_THRESHOLD,
  WEAR_DECAY_PER_DAY,
} from '../world/roadWear.js';

export const trailWearTickPhase = (
  world: WorldState,
  events: TickEvent[],
  _today?: Day,
): void => {
  void _today;
  for (const [h, tile] of world.grid.tiles()) {
    if (tile.road === 'roman') continue;
    let wear = tile.roadWear ?? 0;
    if (wear > 0) {
      // Dirt-road decay scales exponentially with the number of road
      // neighbors (any grade): 2^(n-2) × DIRT_ROAD_DECAY_PER_DAY.
      // Isolated dirt stubs (n=0..1) persist with minimal traffic;
      // dense crossroads (n=3+) are fragile because parallel routes
      // compete and dirt-grade sections at a busy junction get
      // superseded. See docs/06.
      let decay: number;
      if (tile.road === 'dirt') {
        const n = countRoadNeighbors(world.grid, h);
        decay = DIRT_ROAD_DECAY_PER_DAY * Math.pow(2, n - 2);
      } else {
        decay = WEAR_DECAY_PER_DAY;
      }
      wear = Math.max(0, wear - decay);
      tile.roadWear = wear;
    }
    if (tile.road === 'none' && wear >= DIRT_UPGRADE_THRESHOLD) {
      // Skip impassable terrain — no road can be there.
      const t = tile.terrain;
      if (t === 'lake' || t === 'river' || t === 'mountains') continue;
      tile.road = 'dirt';
      world.grid.markTileChanged(h);
      events.push({ type: 'road_upgraded', hex: { q: h.q, r: h.r }, toGrade: 'dirt' });
    } else if (tile.road === 'dirt' && wear < DIRT_DOWNGRADE_THRESHOLD) {
      tile.road = 'none';
      tile.roadWear = 0;
      world.grid.markTileChanged(h);
      events.push({ type: 'road_downgraded', hex: { q: h.q, r: h.r }, fromGrade: 'dirt' });
    }
  }
};
