/**
 * Per-actor grain delta on day 1 for the largest city, so we can see which
 * actor accumulates the silent inflow.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';
import { resourceId, type ActorId } from '../src/sim/types.ts';

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

const cities = [...world.settlements.values()]
  .filter((s) => s.tier === 'small_city' || s.tier === 'large_city')
  .sort((a, b) => b.population.total() - a.population.total());
const city = cities[0]!;
const grain = resourceId('food.grain');

const grainByActor: Map<ActorId, number> = new Map();
for (const ownerId of city.stockpileOwners) {
  const a = world.actors.get(ownerId);
  if (a === undefined) continue;
  grainByActor.set(ownerId, a.stockpile.get(grain) ?? 0);
}

const tickRng = createRng('watchdog|tick');
tick({ world, rng: tickRng.derive('day-0') });

console.log(`${city.name} (pop=${city.population.total()}, tier=${city.tier})`);
console.log(`Day 1 per-actor grain deltas:`);
console.log(`  ${'owner_id'.padEnd(14)} ${'kind'.padEnd(22)} ${'before'.padStart(10)} ${'after'.padStart(10)} ${'delta'.padStart(10)}`);
let totalBefore = 0, totalAfter = 0;
const rows: { id: string; kind: string; before: number; after: number; delta: number }[] = [];
for (const ownerId of city.stockpileOwners) {
  const a = world.actors.get(ownerId);
  if (a === undefined) continue;
  const before = grainByActor.get(ownerId) ?? 0;
  const after = a.stockpile.get(grain) ?? 0;
  totalBefore += before;
  totalAfter += after;
  if (Math.abs(after - before) > 0.5) {
    rows.push({ id: String(a.id), kind: a.kind, before, after, delta: after - before });
  }
}
rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(14)} ${r.kind.padEnd(22)} ${r.before.toFixed(0).padStart(10)} ${r.after.toFixed(0).padStart(10)} ${(r.delta >= 0 ? '+' : '') + r.delta.toFixed(0).padStart(9)}`,
  );
}
console.log(`\n  TOTAL: ${totalBefore.toFixed(0)} → ${totalAfter.toFixed(0)} (Δ ${(totalAfter - totalBefore >= 0 ? '+' : '') + (totalAfter - totalBefore).toFixed(0)})`);
console.log(`\nFlows recorded for day 1:`);
console.log(`  produced:  ${(city.market.recentProduction.get(grain) ?? 0).toFixed(0)}`);
console.log(`  consumed:  ${(city.market.recentConsumption.get(grain) ?? 0).toFixed(0)}`);
console.log(`  imports:   ${(city.market.recentImports.get(grain) ?? 0).toFixed(0)}`);
console.log(`  exports:   ${(city.market.recentExports.get(grain) ?? 0).toFixed(0)}`);
const recordedNet = (city.market.recentProduction.get(grain) ?? 0)
  + (city.market.recentImports.get(grain) ?? 0)
  - (city.market.recentConsumption.get(grain) ?? 0)
  - (city.market.recentExports.get(grain) ?? 0);
console.log(`  recorded net = ${recordedNet.toFixed(0)}`);
console.log(`  actual Δ     = ${(totalAfter - totalBefore).toFixed(0)}`);
console.log(`  unaccounted  = ${((totalAfter - totalBefore) - recordedNet).toFixed(0)}`);

// Also: do any of these owners live in OTHER settlements? (Patricians can own
// villages they don't live in, but the city is still their homeSettlement.)
console.log(`\nOwner homeSettlement check (any not = city?):`);
for (const ownerId of city.stockpileOwners) {
  const a = world.actors.get(ownerId);
  if (a === undefined) continue;
  if (a.homeSettlement !== city.id) {
    console.log(`  ${String(a.id)} (${a.kind}) home=${String(a.homeSettlement)} — NOT this city`);
  }
}
console.log('(otherwise all owners home to this city)');
