/**
 * Settlement abandonment phase.
 *
 * Locked rule per docs/05 §"Growth and decay": when a settlement's
 * population reaches 0, it disappears next daily tick. Buildings
 * vanish with the settlement object; catchment hexes return to
 * wilderness (ownerActor cleared); urban hexes also clear their
 * owner AND have their terrain converted to `ruin` (the abandoned
 * town is now physically a ruin, potentially re-discoverable later
 * as a hidden feature). Stockpile actors survive on `world.actors`
 * with whatever goods they had at the moment of abandonment.
 *
 * Runs daily so the settlement disappears the moment pop hits 0,
 * not at the year boundary.
 */

import type { Settlement } from '../world/settlement.js';
import type { Day } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

export const abandonmentPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  void _today;
  const toRemove: Settlement[] = [];
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) toRemove.push(settlement);
  }
  for (const settlement of toRemove) {
    for (const c of settlement.catchmentHexes) {
      const t = world.grid.get(c);
      if (t !== undefined) t.ownerActor = null;
    }
    for (const u of settlement.urbanHexes) {
      const t = world.grid.get(u);
      if (t !== undefined) {
        t.ownerActor = null;
        if (t.terrain === 'urban') t.terrain = 'ruin';
      }
    }
    world.settlements.delete(settlement.id);
    events.push({ type: 'settlement_abandoned', settlement: settlement.id });
  }
};
