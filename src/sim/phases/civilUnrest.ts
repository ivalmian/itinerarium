/**
 * Civil unrest cascade phase (docs/15 §C16).
 *
 * When grain prices spike above `RIOT_PRICE_MULT × baseline` for a
 * sustained window, the cascade triggers:
 *
 *   1. **Riot** after `RIOT_PRICE_STREAK_DAYS` of sustained spike.
 *   2. **Governor edict** after `EDICT_TRIGGER_AFTER_RIOT_DAYS` of
 *      ongoing riot — caps grain at `EDICT_PRICE_CAP_MULT × baseline`
 *      via a forced clearing-price write so demand sources won't
 *      bid higher on the next tick.
 *   3. **Mob looting** if the edict's price cap is insufficient — the
 *      mob takes a fraction of patrician + city-corporation grain
 *      stockpiles, after `LOOTING_TRIGGER_AFTER_EDICT_DAYS` of edict
 *      with persistent spike.
 *
 * Each step relaxes the underlying scarcity constraint (more grain
 * onto the market or a lower price), so the cascade self-regulates.
 *
 * Per-settlement state lives in a module-local `unrest` record so
 * the streak / riot / edict timers persist across days without
 * leaking into the public `Settlement` type.
 */

import { getStockAt, removeStockAt } from '../politics/actor.js';
import { DEFAULT_GLOBAL_PRICES } from '../caravan/edgeHub.js';
import { resourceId, type Day, type ResourceId, type SettlementId } from '../types.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent } from '../tick.js';

/** Consecutive days of price ≥ RIOT_PRICE_MULT × baseline before riot. */
const RIOT_PRICE_STREAK_DAYS = 14;
const RIOT_PRICE_MULT = 5;
/** Days a riot persists before triggering an edict. */
const EDICT_TRIGGER_AFTER_RIOT_DAYS = 7;
/** Edict caps grain at this multiple of the baseline. */
const EDICT_PRICE_CAP_MULT = 3;
/** Days an edict can be in effect before mob looting fires. */
const LOOTING_TRIGGER_AFTER_EDICT_DAYS = 14;
/** Mob takes this fraction of patrician + city-corp grain stockpile. */
const LOOTING_FRACTION = 0.08;

interface UnrestState {
  readonly priceSpikeStreak: Map<string, number>;
  readonly riotDays: Map<SettlementId, number>;
  readonly edictDays: Map<SettlementId, number>;
  /**
   * Per docs/08 §"Edict price cap is a real CDA constraint": active
   * price caps keyed by `${settlement}|${resource}`. Queried by
   * tradePhase and passed as `maxPrice` to `clearMarket` so the CDA
   * itself enforces the cap (and surfaces real unmet demand at it).
   */
  readonly activeEdictCaps: Map<string, number>;
}

const unrest: UnrestState = {
  priceSpikeStreak: new Map(),
  riotDays: new Map(),
  edictDays: new Map(),
  activeEdictCaps: new Map(),
};

const edictKey = (settlement: SettlementId, resource: ResourceId): string =>
  `${String(settlement)}|${String(resource)}`;

/**
 * Returns the active price ceiling (integer coin / unit) on `resource`
 * at `settlement` if any edict is currently in force; otherwise null.
 * Called by `tradePhase` to pass `maxPrice` into `clearMarket`.
 */
export const edictPriceCapFor = (
  settlement: SettlementId,
  resource: ResourceId,
): number | null => unrest.activeEdictCaps.get(edictKey(settlement, resource)) ?? null;

/**
 * Test-only: reset edict state between unrelated runs. The normal
 * tick loop is module-stable; this just makes per-test isolation
 * possible without restarting the process.
 */
export const __resetCivilUnrestState = (): void => {
  unrest.priceSpikeStreak.clear();
  unrest.riotDays.clear();
  unrest.edictDays.clear();
  unrest.activeEdictCaps.clear();
};

export const civilUnrestPhase = (
  world: WorldState,
  _today: Day,
  events: TickEvent[],
): void => {
  void _today;
  const grainResource = resourceId('food.grain');
  const baseline = DEFAULT_GLOBAL_PRICES.get(grainResource) ?? 1.5;

  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const price = settlement.market.lastClearingPrice.get(grainResource) ?? 0;
    const streakKey = `${String(settlement.id)}|food.grain`;

    if (price >= baseline * RIOT_PRICE_MULT) {
      unrest.priceSpikeStreak.set(streakKey, (unrest.priceSpikeStreak.get(streakKey) ?? 0) + 1);
    } else {
      unrest.priceSpikeStreak.set(streakKey, 0);
    }

    const streak = unrest.priceSpikeStreak.get(streakKey) ?? 0;
    const inRiot = unrest.riotDays.has(settlement.id);
    const inEdict = unrest.edictDays.has(settlement.id);

    // Trigger riot.
    if (!inRiot && streak >= RIOT_PRICE_STREAK_DAYS) {
      unrest.riotDays.set(settlement.id, 0);
      events.push({
        type: 'riot',
        settlement: settlement.id,
        trigger: grainResource,
        priceMultipleOfBaseline: price / baseline,
      });
    }

    if (inRiot) {
      const days = (unrest.riotDays.get(settlement.id) ?? 0) + 1;
      unrest.riotDays.set(settlement.id, days);

      // Trigger edict after enough riot days.
      if (!inEdict && days >= EDICT_TRIGGER_AFTER_RIOT_DAYS) {
        unrest.edictDays.set(settlement.id, 0);
        // Per docs/08 §"Edict price cap is a real CDA constraint":
        // register the cap so tradePhase passes it to clearMarket as
        // a `maxPrice`. The CDA will clear at the cap, and unmet
        // demand at the cap reflects the genuine shortfall under
        // the political constraint (feeds the looting trigger).
        const cap = Math.max(1, Math.ceil(baseline * EDICT_PRICE_CAP_MULT));
        unrest.activeEdictCaps.set(edictKey(settlement.id, grainResource), cap);
        events.push({
          type: 'edict_issued',
          settlement: settlement.id,
          resource: grainResource,
          priceCap: cap,
        });
      }
    }

    if (inEdict) {
      const days = (unrest.edictDays.get(settlement.id) ?? 0) + 1;
      unrest.edictDays.set(settlement.id, days);

      if (days >= LOOTING_TRIGGER_AFTER_EDICT_DAYS && price > baseline * RIOT_PRICE_MULT) {
        // Mob loots grain from richest patricians + city corp.
        for (const oId of settlement.stockpileOwners) {
          const a = world.actors.get(oId);
          if (a === undefined) continue;
          if (a.kind !== 'patrician_family' && a.kind !== 'city_corporation') continue;
          const have = getStockAt(a, settlement.id, grainResource);
          if (have <= 0) continue;
          const looted = have * LOOTING_FRACTION;
          if (looted < 1) continue;
          removeStockAt(a, settlement.id, grainResource, looted);
          events.push({
            type: 'mob_looting',
            settlement: settlement.id,
            resource: grainResource,
            fromActor: a.id,
            looted,
          });
        }
        // Reset edict timer (governor re-issues + waits another window).
        unrest.edictDays.set(settlement.id, 0);
      }
    }

    // Cool-off: prices back to normal → end riot + edict.
    if (price < baseline * RIOT_PRICE_MULT && streak === 0) {
      unrest.riotDays.delete(settlement.id);
      unrest.edictDays.delete(settlement.id);
      unrest.activeEdictCaps.delete(edictKey(settlement.id, grainResource));
    }
  }
};
