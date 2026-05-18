/**
 * Per-day movement phase.
 *
 * Three sub-passes:
 *
 *  1. **Disband zombie caravans.** Any caravan whose health or crew
 *     hits 0 before moving is removed and a `caravan_disbanded`
 *     event fires. Per docs/15 §C28 insolvency alone is NOT a
 *     disband signal — that risks killing caravans in transient
 *     gaps. The natural failure chain is insolvent → can't buy
 *     rations → health depletes → zero_health disband fires here.
 *
 *  2. **Move every caravan.** Each caravan ticks through its
 *     movement engine (`tickCaravanMovement`); arrival and
 *     intermediate `caravan_moved` events fire, and trail wear is
 *     added to each hex the caravan steps onto.
 *
 *  3. **Move every news carrier.** News carriers walk per docs/13;
 *     their `arrived` flag flips in the movement engine, and the
 *     newsArrivalPhase later in the tick drains the arrived ones.
 *
 * Patrols are NOT moved here — the patrol phase handles its own
 * cyclic step + on-route wear.
 */

import { totalCrewCount } from '../caravan/caravan.js';
import { tickCaravanMovement } from '../caravan/movement.js';
import { tickCarrierWithGrid } from '../reputation/newsMovement.js';
import type { Day, CaravanId } from '../types.js';
import { hexEquals } from '../world/hex.js';
import type { Season } from '../world/terrain.js';
import {
  addRoadWear,
  caravanTrailWear,
  WEAR_PER_NEWS_CARRIER,
} from '../world/roadWear.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

export const movementPhase = (
  world: WorldState,
  season: Season,
  today: Day,
  events: TickEvent[],
): void => {
  // 1. Disband zombie caravans before moving.
  const disbanded: { readonly id: CaravanId; readonly reason: 'zero_health' | 'zero_crew' }[] = [];
  for (const [cId, c] of world.caravans) {
    if (c.health <= 0) disbanded.push({ id: cId, reason: 'zero_health' });
    else if (totalCrewCount(c) <= 0) disbanded.push({ id: cId, reason: 'zero_crew' });
  }
  for (const entry of disbanded) {
    const c = world.caravans.get(entry.id);
    if (c === undefined) continue;
    world.caravans.delete(entry.id);
    events.push({
      type: 'caravan_disbanded',
      caravan: entry.id,
      at: { q: c.position.q, r: c.position.r },
      reason: entry.reason,
    });
  }

  // 2. Move every caravan. Off-map caravans (docs/06 §"The 20-tick
  //    off-map sojourn") are conducting trade beyond the world edge —
  //    they don't move on the map and don't expose themselves to ambush
  //    until their sojourn timer expires. Rations and wages still tick
  //    via the consumption pass that runs for every caravan; only the
  //    spatial / movement piece is paused. When the sojourn ends the
  //    caravan re-emerges at its current (edge-hex) position and
  //    routes home to originSettlement.
  for (const [cId, c] of world.caravans) {
    if (c.offMapUntil !== undefined) {
      if (c.offMapUntil > today) continue;
      // Sojourn ended — re-emerge. Clear the flag, route home.
      delete (c as { offMapUntil?: Day }).offMapUntil;
      if (c.originSettlement !== undefined) {
        const home = world.settlements.get(c.originSettlement);
        if (home !== undefined) {
          c.destination = { q: home.anchor.q, r: home.anchor.r };
        }
      }
      // No event emitted for re-emergence by design; the caravan is
      // back on the map and the normal movement / arrival lifecycle
      // takes over from here.
    }
    let previousHex = { q: c.position.q, r: c.position.r };
    const result = tickCaravanMovement({ caravan: c, grid: world.grid, season, today });
    for (const e of result.events) {
      if (e.type === 'arrived') {
        events.push({
          type: 'caravan_arrived',
          caravan: cId,
          at: { q: c.position.q, r: c.position.r },
        });
      }
    }
    // Trail wear: each pack animal + crew member entering this hex
    // compacts the trail. A 50-mule + 12-crew caravan adds ~56 wear
    // per hex.
    const wearPerHex = caravanTrailWear(c);
    for (const moved of result.hexesMoved) {
      events.push({
        type: 'caravan_moved',
        caravan: cId,
        from: previousHex,
        to: { q: moved.q, r: moved.r },
      });
      previousHex = { q: moved.q, r: moved.r };
      addRoadWear(world, moved, wearPerHex);
    }
  }

  // 3. Move every news carrier. Arrival → reputation update is
  //    handled later in newsArrivalPhase.
  if (world.newsCarriers !== undefined) {
    for (const [id, carrier] of world.newsCarriers) {
      if (carrier.arrived) continue;
      const before = { q: carrier.position.q, r: carrier.position.r };
      const next = tickCarrierWithGrid({ carrier, grid: world.grid, season, today });
      world.newsCarriers.set(id, next);
      if (!hexEquals(before, next.position)) {
        addRoadWear(world, next.position, WEAR_PER_NEWS_CARRIER);
      }
    }
  }
};
