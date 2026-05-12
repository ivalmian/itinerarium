/**
 * Reconciliation audit: does
 *
 *   stock(t) - stock(0) == ∫ (produced + imported - consumed - exported) dt
 *
 * actually hold? If not, the flow columns in the UI under-count an
 * inflow source (or over-count an outflow), and the stockpile is being
 * fed from somewhere the viewer doesn't see.
 *
 * We instrument every tick by directly summing the actor stockpile
 * deltas, then compare against the per-tick increments of the rolling
 * flow counters. Because the rolling counter has exponential decay
 * mixed in, we work in DELTAS: each tick we read the counter, predict
 * what the decay would have left it at (val × DECAY), and the residual
 * vs current is the day's recorded gross flow.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { actorTotalStock } from '../src/sim/politics/actor.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';
import { resourceId, type ResourceId, type SettlementId } from '../src/sim/types.ts';

const DAYS = Number(process.argv[2] ?? 90);

const grid = generateTerrain({ seed: 'watchdog|terrain', widthHexes: 80, heightHexes: 80 });
const sites = siteSettlements({
  seed: 'watchdog|sites',
  grid,
  cityCount: 3,
  townCount: 8,
  villageCount: 60,
  hamletCount: 30,
});
const world = seedWorld({ seed: 'watchdog|world', grid, settlementSites: sites });
seedCaravans({ seed: 'watchdog|caravans', world });

// Pick the largest city.
const cities = [...world.settlements.values()]
  .filter((s) => s.tier === 'small_city' || s.tier === 'large_city')
  .sort((a, b) => b.population.total() - a.population.total());
if (cities.length === 0) {
  throw new Error('no city');
}
const city = cities[0]!;
const grain = resourceId('food.grain');

const DECAY = Math.exp(-1 / 30);

const settlementStock = (sId: SettlementId, r: ResourceId): number => {
  // Per docs/15 §C30: sum only the slice physically here, not the actor's
  // full cross-settlement total.
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

let prevStock = settlementStock(city.id, grain);
let prevProd = city.market.recentProduction.get(grain) ?? 0;
let prevCons = city.market.recentConsumption.get(grain) ?? 0;
let prevImp = city.market.recentImports.get(grain) ?? 0;
let prevExp = city.market.recentExports.get(grain) ?? 0;

let cumStockDelta = 0;
let cumFlowDelta = 0;

console.log(`audit: ${city.name} pop=${city.population.total()} tier=${city.tier}`);
console.log(`day,    stock,   Δstock,    prod,    cons,   imp,   exp,  flowΔ,   gap (Δstock - flowΔ),     cumGap`);
console.log(`0,${prevStock.toFixed(0)}`);

const tickRng = createRng('watchdog|tick');
for (let i = 0; i < DAYS; i++) {
  tick({ world, rng: tickRng.derive(`day-${i}`) });
  const stock = settlementStock(city.id, grain);
  const dStock = stock - prevStock;
  // The rolling counter is decayed by DECAY at the START of the tick (before
  // new bumps), so today's net added quantity = counter_today − counter_yesterday × DECAY.
  const prodToday = (city.market.recentProduction.get(grain) ?? 0) - prevProd * DECAY;
  const consToday = (city.market.recentConsumption.get(grain) ?? 0) - prevCons * DECAY;
  const impToday = (city.market.recentImports.get(grain) ?? 0) - prevImp * DECAY;
  const expToday = (city.market.recentExports.get(grain) ?? 0) - prevExp * DECAY;
  const flowDelta = prodToday + impToday - consToday - expToday;
  const gap = dStock - flowDelta;
  cumStockDelta += dStock;
  cumFlowDelta += flowDelta;
  if (i < 30 || i % 30 === 0 || i >= DAYS - 5) {
    console.log(
      [
        String(i + 1).padStart(4),
        stock.toFixed(0).padStart(12),
        dStock.toFixed(0).padStart(8),
        prodToday.toFixed(0).padStart(8),
        consToday.toFixed(0).padStart(8),
        impToday.toFixed(0).padStart(5),
        expToday.toFixed(0).padStart(5),
        flowDelta.toFixed(0).padStart(8),
        gap.toFixed(0).padStart(10),
        (cumStockDelta - cumFlowDelta).toFixed(0).padStart(12),
      ].join(', '),
    );
  }
  prevStock = stock;
  prevProd = city.market.recentProduction.get(grain) ?? 0;
  prevCons = city.market.recentConsumption.get(grain) ?? 0;
  prevImp = city.market.recentImports.get(grain) ?? 0;
  prevExp = city.market.recentExports.get(grain) ?? 0;
}

console.log(`\nSummary over ${DAYS} days:`);
console.log(`  stock delta:     ${cumStockDelta.toFixed(0)} (initial=${(prevStock - cumStockDelta).toFixed(0)} → final=${prevStock.toFixed(0)})`);
console.log(`  flow accounting: ${cumFlowDelta.toFixed(0)}`);
console.log(`  unexplained gap: ${(cumStockDelta - cumFlowDelta).toFixed(0)}`);
console.log(`  gap fraction:    ${((cumStockDelta - cumFlowDelta) / Math.max(1, cumStockDelta) * 100).toFixed(1)}% of stock change`);
