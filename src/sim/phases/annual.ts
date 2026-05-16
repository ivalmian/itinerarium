/**
 * Year-boundary annual phase.
 *
 * Two things happen once per simulated year:
 *
 *  1. Per-settlement vital rates (`tickYearly`) age the population
 *     pyramid by one year and reset famine pressure so a single bad
 *     harvest doesn't permanently haunt the settlement.
 *  2. Dynamic catchment recompute (docs/05 §"Dynamic catchment
 *     recompute"): if a settlement's population has drifted >25%
 *     from the baseline that sized its current catchment AND it's
 *     been >365 days since the last resize, claim or release hexes
 *     so the worked land matches the new tier.
 *
 * The orchestrator gates this on `(today + 1) % YEAR_DAYS === 0`
 * so it runs on the last day of each simulated year.
 */

import { tickYearly } from '../population/vitalRates.js';
import { tickAnnualAging } from '../people/registry.js';
import { actorId as _actorId } from '../types.js';
import { recomputeCatchment, shouldRecomputeCatchment } from '../world/settlement.js';
import type { Settlement } from '../world/settlement.js';
import type { ActorId, Day } from '../types.js';
import type { Rng } from '../rng.js';
import type { WorldState } from '../../procgen/seed.js';
import { faminePressure } from '../world/faminePressure.js';
import type { TickEvent } from '../tick.js';

/**
 * Pick the actor that should own newly-claimed catchment hexes
 * for `settlement`. Mirrors the procgen ownership rules (seed.ts
 * Phase 7): cities/towns prefer city_corporation → fallback to
 * first stockpile owner; villages/hamlets use first stockpile
 * owner. Returns `null` only if the settlement has no actors at
 * all (defensive — shouldn't happen on a real world).
 */
const pickCatchmentOwnerForSettlement = (
  world: WorldState,
  settlement: Settlement,
): ActorId | null => {
  for (const a of world.actors.values()) {
    if (a.kind === 'city_corporation' && a.homeSettlement === settlement.id) {
      return a.id;
    }
  }
  if (settlement.stockpileOwners.length > 0) {
    return settlement.stockpileOwners[0] ?? null;
  }
  return null;
};

void _actorId;

export const annualPhase = (
  world: WorldState,
  rng: Rng,
  today: Day,
  events: TickEvent[],
): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    tickYearly(settlement.population, rng.derive(`settle-${String(settlement.id)}`));
    // Reset famine pressure each year so a one-bad-harvest year
    // doesn't permanently haunt the settlement.
    faminePressure.set(settlement, { consecutiveShortageDays: 0, lastShortageDay: -1 });
  }
  // Per docs/04 §"Person registry for moving units": age every alive
  // Person by one year and apply baseline Roman-era mortality. The
  // registry is event-driven the rest of the year; this is the one
  // pass that touches every record.
  if (world.persons !== undefined && world.persons.size > 0) {
    const deaths = tickAnnualAging(world.persons, today + 1, rng.derive('persons-aging'));
    if (deaths > 0) {
      events.push({ type: 'persons_aged', deaths });
    }
  }
  // Dynamic catchment recompute (docs/05).
  for (const settlement of world.settlements.values()) {
    const pop = settlement.population.total();
    if (!shouldRecomputeCatchment(settlement, pop, today + 1)) continue;
    const owner = pickCatchmentOwnerForSettlement(world, settlement);
    const result = recomputeCatchment({
      settlement,
      currentPop: pop,
      today: today + 1,
      grid: world.grid,
      ownerActorForClaimed: owner,
      otherSettlements: world.settlements.values(),
    });
    if (result.resized) {
      events.push({
        type: 'catchment_resized',
        settlement: settlement.id,
        oldRadius: result.oldRadius,
        newRadius: result.newRadius,
        claimed: result.claimed.length,
        released: result.released.length,
      });
    }
  }
};
