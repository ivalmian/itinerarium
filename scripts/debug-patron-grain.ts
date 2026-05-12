/**
 * For each patrician_family actor at the largest city, dump:
 *   - which settlements list them as a stockpile owner
 *   - their total grain pool
 *   - the per-day production credit at each village (recentProduction)
 *
 * The hypothesis: village client-farms run under the patron's actor;
 * recipe firing credits the VILLAGE'S recentProduction but the output
 * lands in the PATRON's single shared stockpile pool. The city sees the
 * patron as a stockpile owner and reports the full pool as if it were
 * physically in the city.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';
import { resourceId } from '../src/sim/types.ts';

const DAYS = Number(process.argv[2] ?? 365);

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

const tickRng = createRng('watchdog|tick');
for (let i = 0; i < DAYS; i++) {
  tick({ world, rng: tickRng.derive(`day-${i}`) });
}

const grain = resourceId('food.grain');

const cities = [...world.settlements.values()]
  .filter((s) => s.tier === 'small_city' || s.tier === 'large_city')
  .sort((a, b) => b.population.total() - a.population.total());
const city = cities[0]!;

console.log(`After ${DAYS} days — ${city.name} (${city.tier}, pop=${city.population.total()})`);

// Settlement-aggregate grain (the viewer's "Stock" column).
let citySettAgg = 0;
for (const ownerId of city.stockpileOwners) {
  const a = world.actors.get(ownerId);
  if (a === undefined) continue;
  citySettAgg += a.stockpile.get(grain) ?? 0;
}
console.log(`  viewer-displayed city stockpile (sum of all owners): ${citySettAgg.toFixed(0)} grain\n`);

// Per-patrician breakdown.
const patricians = city.stockpileOwners
  .map((id) => world.actors.get(id))
  .filter((a): a is NonNullable<typeof a> => a !== undefined && a.kind === 'patrician_family');

console.log(`  ${patricians.length} patrician families home here.\n`);

for (const p of patricians) {
  const ownInv = p.stockpile.get(grain) ?? 0;
  // Find every settlement that lists this actor as a stockpile owner.
  const memberOf: string[] = [];
  for (const s of world.settlements.values()) {
    if (s.stockpileOwners.includes(p.id)) memberOf.push(`${s.name} (${s.tier})`);
  }
  console.log(`  ${String(p.id)} (${p.name})`);
  console.log(`    grain pool: ${ownInv.toFixed(0)} modii`);
  console.log(`    listed as stockpile owner of ${memberOf.length} settlements:`);
  for (const m of memberOf.slice(0, 10)) console.log(`      - ${m}`);
  if (memberOf.length > 10) console.log(`      ... and ${memberOf.length - 10} more`);
  console.log();
}

// Sanity: same patrician's pool counted in N settlement aggregates means
// summing settlement-aggregates double-counts.
let worldSettAgg = 0;
for (const s of world.settlements.values()) {
  for (const ownerId of s.stockpileOwners) {
    const a = world.actors.get(ownerId);
    if (a === undefined) continue;
    worldSettAgg += a.stockpile.get(grain) ?? 0;
  }
}
let worldActorAgg = 0;
for (const a of world.actors.values()) {
  worldActorAgg += a.stockpile.get(grain) ?? 0;
}
console.log(`Sanity check world-wide:`);
console.log(`  Σ over all settlements (sum-of-owners): ${worldSettAgg.toFixed(0)}`);
console.log(`  Σ over all actors (each counted once):  ${worldActorAgg.toFixed(0)}`);
console.log(`  inflation ratio:                         ${(worldSettAgg / Math.max(1, worldActorAgg)).toFixed(2)}x`);
