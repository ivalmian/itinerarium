/**
 * Demographics phase: per-day vital rates + endemic mortality +
 * epidemic incidence + active-infection tick for every settlement.
 *
 * Pulls together:
 *   - `tickDaily` on the cohort pyramid (births / aging / baseline
 *     mortality) per docs/04.
 *   - `applyEndemicMortality` for region-specific background death
 *     (malaria in marshes, cold in alpine highlands, etc.) per
 *     docs/04 §"Endemic mortality".
 *   - `maybeTriggerEpidemic` + `tickInfection` for outbreaks (the
 *     reason a single bad year of food shortage cascades into a
 *     2-year demographic collapse).
 *
 * Per-settlement `SettlementHealth` is kept in a module-scoped
 * `WeakMap` so a settlement's outbreak state survives across days
 * without lifting it into the public type surface. Settlements
 * dropped by abandonment lose their entry to garbage collection.
 */

import {
  applyEndemicMortality,
  createSettlementHealth,
  maybeTriggerEpidemic,
  ROMAN_VITAL_RATES,
  tickDaily,
  tickInfection,
  type SettlementHealth,
} from '../population/index.js';
import type { Rng } from '../rng.js';
import type { Day } from '../types.js';
import type { Settlement } from '../world/settlement.js';
import type { WorldState } from '../../procgen/seed.js';
import type { TickEvent, TickStats } from '../tick.js';

const settlementHealthMap: WeakMap<Settlement, SettlementHealth> = new WeakMap();

export const demographicsPhase = (
  world: WorldState,
  today: Day,
  rng: Rng,
  events: TickEvent[],
  stats: TickStats,
): void => {
  for (const settlement of world.settlements.values()) {
    if (settlement.population.total() === 0) continue;
    const rngLabel = `settle-${String(settlement.id)}`;
    // 1) Vital rates.
    tickDaily(settlement.population, ROMAN_VITAL_RATES, rng.derive(`${rngLabel}|vital`));

    // 2) Endemic mortality + epidemic.
    const tile = world.grid.get(settlement.anchor);
    if (tile === undefined) continue;
    const endemic = applyEndemicMortality(
      settlement.population,
      tile.climate,
      tile.terrain,
      rng.derive(`${rngLabel}|endemic`),
      today,
    );
    if (endemic.deaths > 0) {
      stats.baselineDeaths += endemic.deaths;
      events.push({
        type: 'cohort_deaths',
        settlement: settlement.id,
        deaths: endemic.deaths,
        cause: 'baseline',
      });
    }
    let health = settlementHealthMap.get(settlement);
    if (health === undefined) {
      health = createSettlementHealth();
      settlementHealthMap.set(settlement, health);
    }
    const density = settlement.population.total() / Math.max(1, settlement.urbanHexes.length);
    const trigger = maybeTriggerEpidemic(
      health,
      settlement.population,
      density,
      tile.climate,
      rng.derive(`${rngLabel}|epidemic-spawn`),
      today,
    );
    if (trigger.triggered !== null) {
      stats.epidemicsTriggered += 1;
      events.push({
        type: 'epidemic_started',
        settlement: settlement.id,
        disease: trigger.triggered.id,
      });
    }
    const infRes =
      health.infections.size === 0
        ? { deaths: 0, recovered: 0 }
        : tickInfection(health, settlement.population, rng.derive(`${rngLabel}|infection`), today);
    if (infRes.deaths > 0) {
      stats.diseaseDeaths += infRes.deaths;
      events.push({
        type: 'cohort_deaths',
        settlement: settlement.id,
        deaths: infRes.deaths,
        cause: 'disease',
      });
    }
  }
};
