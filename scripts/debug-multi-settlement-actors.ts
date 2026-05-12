/**
 * For each actor kind, count how many settlements list each actor of that
 * kind as a stockpile owner. Anything > 1 means that kind's stockpile is
 * over-counted in the per-settlement aggregate.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';

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

const settlementCountByActor = new Map<string, number>();
for (const s of world.settlements.values()) {
  for (const ownerId of s.stockpileOwners) {
    settlementCountByActor.set(String(ownerId), (settlementCountByActor.get(String(ownerId)) ?? 0) + 1);
  }
}

const byKind = new Map<string, { actors: number; multiActors: number; maxSettlements: number; sumSettlements: number }>();
for (const actor of world.actors.values()) {
  const n = settlementCountByActor.get(String(actor.id)) ?? 0;
  let agg = byKind.get(actor.kind);
  if (agg === undefined) {
    agg = { actors: 0, multiActors: 0, maxSettlements: 0, sumSettlements: 0 };
    byKind.set(actor.kind, agg);
  }
  agg.actors += 1;
  agg.sumSettlements += n;
  if (n > 1) agg.multiActors += 1;
  if (n > agg.maxSettlements) agg.maxSettlements = n;
}

console.log(`Per-actor-kind settlement registrations:\n`);
console.log(`  ${'kind'.padEnd(25)} ${'actors'.padStart(8)} ${'multi'.padStart(8)} ${'max'.padStart(6)} ${'avg'.padStart(6)}`);
for (const [kind, agg] of [...byKind.entries()].sort((a, b) => b[1].maxSettlements - a[1].maxSettlements)) {
  const avg = agg.sumSettlements / Math.max(1, agg.actors);
  console.log(
    `  ${kind.padEnd(25)} ${String(agg.actors).padStart(8)} ${String(agg.multiActors).padStart(8)} ${String(agg.maxSettlements).padStart(6)} ${avg.toFixed(1).padStart(6)}`,
  );
}
