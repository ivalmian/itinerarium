/**
 * Quarterly client-village → patron tribute phase.
 *
 * Per docs/15 §C29: each settlement with a `clientPatron` set has a
 * `free_village` actor (the steward) that pays a fraction of its
 * treasury to the patron each quarter. Replaces the older model where
 * the patron magically co-owned the village stockpile.
 *
 * Mechanics:
 *   - Runs every 90 days (driven by the day counter in `tick()`'s
 *     orchestrator).
 *   - For each settlement with `clientPatron`: find the village
 *     steward, compute tribute = `TRIBUTE_FRACTION × steward.treasury`,
 *     cap so the steward keeps at least `TRIBUTE_OPERATING_FLOOR` coin
 *     for next season's wages + fuel + tools, transfer the rest to the
 *     patron's treasury.
 *   - If the patron is gone (succession, disband), tribute is skipped
 *     for that village this season — no orphan coin sink.
 *
 * `TRIBUTE_FRACTION = 0.25` is below historical share-rent (~⅓ – ½)
 * because the village_household also pays plebeian wages; a higher
 * draw rate drains it to zero between seasons in burn-in.
 *
 * Emits a `tribute_paid` event per transfer for telemetry.
 */

import type { Actor } from '../politics/actor.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

const TRIBUTE_FRACTION = 0.25;
const TRIBUTE_OPERATING_FLOOR = 50;

export const tributePhase = (world: WorldState, events: TickEvent[]): void => {
  for (const settlement of world.settlements.values()) {
    const patronId = settlement.clientPatron;
    if (patronId === undefined) continue;
    const patron = world.actors.get(patronId);
    if (patron === undefined) continue;

    // The village steward is the `free_village` actor that homes
    // here. Per seedClientVillage it's pushed to stockpileOwners
    // first, so it's typically stockpileOwners[0]; we scan
    // explicitly to tolerate ordering changes.
    let steward: Actor | undefined;
    for (const ownerId of settlement.stockpileOwners) {
      const a = world.actors.get(ownerId);
      if (a === undefined) continue;
      if (a.kind === 'free_village' && a.homeSettlement === settlement.id) {
        steward = a;
        break;
      }
    }
    if (steward === undefined) continue;

    const spendable = Math.max(0, steward.treasury - TRIBUTE_OPERATING_FLOOR);
    if (spendable <= 0) continue;
    // Whole-coin tribute per docs/08 §"Integer-coin prices": no
    // fractional coin moves between treasuries. Round to nearest
    // integer; below-1-coin tributes don't fire.
    const tribute = Math.floor(spendable * TRIBUTE_FRACTION);
    if (tribute <= 0) continue;

    steward.treasury -= tribute;
    patron.treasury += tribute;
    events.push({
      type: 'tribute_paid',
      fromSettlement: settlement.id,
      fromActor: steward.id,
      toActor: patron.id,
      coin: tribute,
    });
  }
};
