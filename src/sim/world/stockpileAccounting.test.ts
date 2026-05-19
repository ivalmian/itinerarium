/**
 * Stockpile mass-balance invariant.
 *
 * For every (settlement, resource), the change in stockpile from one
 * tick to the next must equal the recorded net flow:
 *
 *   stock(t) - stock(t-1)
 *     == (production_today + imports_today)
 *      - (consumption_today + exports_today)
 *
 * If this identity breaks, the viewer's flow columns are under-counting
 * an inflow source (or over-counting an outflow), and the stockpile is
 * being fed from somewhere we don't track. That's a real correctness
 * bug — the analyst dashboards lie about where the goods come from.
 *
 * The `recentProduction / recentConsumption / recentImports /
 * recentExports` counters in `Settlement.market` are exponentially
 * decayed by `RECENT_FLOW_DECAY_FACTOR = exp(-1/30) ≈ 0.967` once per
 * tick (in `ageRecentFlowsPhase`, the FIRST phase of each tick). To
 * recover the day's gross flow contribution we invert the decay:
 *
 *   gross_today = counter_today - (counter_yesterday × DECAY)
 *
 * Then the invariant becomes:
 *
 *   stock(t) - stock(t-1) ≈ Σ_r gross_today(produced + imported
 *                              - consumed - exported)
 *
 * Originally lived in `scripts/debug-stockpile-accounting.ts` as a
 * one-shot audit during the C30 per-settlement-inventory rewrite.
 * Promoted to a vitest invariant so we catch regressions on every CI
 * run rather than relying on someone remembering to invoke the script.
 */

import { describe, expect, it } from 'vitest';

import { generateTerrain } from '../../procgen/terrain.js';
import { siteSettlements } from '../../procgen/settlements.js';
import { seedWorld } from '../../procgen/seed.js';
import { seedCaravans } from '../../procgen/seedCaravans.js';
import { tick } from '../tick.js';
import { createRng } from '../rng.js';
import { resourceId, type ResourceId, type SettlementId } from '../types.js';
import { RECENT_FLOW_DECAY_FACTOR } from '../phases/ageRecentFlows.js';

interface FlowSnapshot {
  prod: number;
  cons: number;
  imp: number;
  exp: number;
}

const flowSnapshotFor = (
  world: ReturnType<typeof seedWorld>,
  sId: SettlementId,
  r: ResourceId,
): FlowSnapshot => {
  const s = world.settlements.get(sId);
  if (s === undefined) return { prod: 0, cons: 0, imp: 0, exp: 0 };
  return {
    prod: s.market.recentProduction.get(r) ?? 0,
    cons: s.market.recentConsumption.get(r) ?? 0,
    imp: s.market.recentImports.get(r) ?? 0,
    exp: s.market.recentExports.get(r) ?? 0,
  };
};

const settlementStockAt = (
  world: ReturnType<typeof seedWorld>,
  sId: SettlementId,
  r: ResourceId,
): number => {
  // Per docs/15 §C30: sum only the slice physically AT this settlement,
  // not the actor's full cross-settlement total. The flow counters are
  // per-settlement so the audit must be too.
  let total = 0;
  const s = world.settlements.get(sId);
  if (s === undefined) return 0;
  for (const ownerId of s.stockpileOwners) {
    const a = world.actors.get(ownerId);
    if (a === undefined) continue;
    total += a.stockpile.get(sId)?.get(r) ?? 0;
  }
  return total;
};

describe('stockpile mass balance invariant', () => {
  it('flow counters fully account for stockpile changes over a 30-day burn-in (grain at largest city)', () => {
    // Small watchdog-sized world — enough for real production + caravan
    // flows to fire, small enough that a 30-day run stays under a few
    // seconds in CI.
    const grid = generateTerrain({
      seed: 'stockpile-audit|terrain',
      widthHexes: 60,
      heightHexes: 60,
    });
    const sites = siteSettlements({
      seed: 'stockpile-audit|sites',
      grid,
      cityCount: 2,
      townCount: 4,
      villageCount: 20,
      hamletCount: 10,
    });
    const world = seedWorld({ seed: 'stockpile-audit|world', grid, settlementSites: sites });
    seedCaravans({ seed: 'stockpile-audit|caravans', world });

    const cities = [...world.settlements.values()]
      .filter((s) => s.tier === 'small_city' || s.tier === 'large_city')
      .sort((a, b) => b.population.total() - a.population.total());
    expect(cities.length).toBeGreaterThan(0);
    const city = cities[0]!;
    const grain = resourceId('food.grain');

    const DAYS = 30;
    const rng = createRng('stockpile-audit|tick');

    let prevStock = settlementStockAt(world, city.id, grain);
    let prevFlow = flowSnapshotFor(world, city.id, grain);
    let cumStockDelta = 0;
    let cumFlowDelta = 0;
    let largestSingleDayGap = 0;

    for (let i = 0; i < DAYS; i++) {
      tick({ world, rng: rng.derive(`day-${i}`) });
      const stock = settlementStockAt(world, city.id, grain);
      const flow = flowSnapshotFor(world, city.id, grain);

      const dStock = stock - prevStock;
      // counter_today reflects yesterday's value × DECAY + today's gross
      // contribution. So gross_today = counter_today − counter_yesterday × DECAY.
      const prodToday = flow.prod - prevFlow.prod * RECENT_FLOW_DECAY_FACTOR;
      const consToday = flow.cons - prevFlow.cons * RECENT_FLOW_DECAY_FACTOR;
      const impToday = flow.imp - prevFlow.imp * RECENT_FLOW_DECAY_FACTOR;
      const expToday = flow.exp - prevFlow.exp * RECENT_FLOW_DECAY_FACTOR;
      const flowDelta = prodToday + impToday - consToday - expToday;

      cumStockDelta += dStock;
      cumFlowDelta += flowDelta;
      const dailyGap = Math.abs(dStock - flowDelta);
      if (dailyGap > largestSingleDayGap) largestSingleDayGap = dailyGap;

      prevStock = stock;
      prevFlow = flow;
    }

    const cumGap = Math.abs(cumStockDelta - cumFlowDelta);
    const stockChangeMagnitude = Math.max(1, Math.abs(cumStockDelta));
    const gapFraction = cumGap / stockChangeMagnitude;

    // Tolerances calibrated against an empirical run of the same world
    // shape (see scripts/debug-stockpile-accounting.ts history): cumulative
    // gap on a healthy run sits around 0.1% of stock change. We allow up
    // to 1% to absorb float-rounding + the decay-inversion error. Anything
    // bigger means a flow column is genuinely missing inflow / outflow.
    expect(gapFraction).toBeLessThan(0.01);

    // A single-day gap larger than the city's daily consumption is a
    // sign that a recipe fired without recording its consumption (or
    // a caravan delivered without recording its import). Tolerance is
    // generous (5,000 modii/day for the largest city) — a real bug
    // would show single-day gaps in the tens of thousands.
    expect(largestSingleDayGap).toBeLessThan(5000);
  });
});
