/**
 * Tally per-year activity counts from a 10-year burn-in:
 * trades, caravan trips, banditry incidents, patrol engagements.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';

async function main(): Promise<void> {
  const seed = 'watchdog';
  const grid = generateTerrain({ seed: `${seed}|terrain`, widthHexes: 80, heightHexes: 80 });
  const sites = siteSettlements({
    seed: `${seed}|sites`,
    grid,
    cityCount: 3,
    townCount: 8,
    villageCount: 60,
    hamletCount: 30,
  });
  const world = seedWorld({ seed: `${seed}|world`, grid, settlementSites: sites });
  seedCaravans({ seed: `${seed}|caravans`, world });

  const tickRng = createRng(`${seed}|tick`);
  const days = 3650;

  // Per-year buckets.
  const yearBuckets: Record<number, Record<string, number>> = {};
  const ensure = (year: number, key: string): void => {
    yearBuckets[year] = yearBuckets[year] ?? {};
    const bucket = yearBuckets[year];
    if (bucket !== undefined) bucket[key] = (bucket[key] ?? 0) + 1;
  };

  for (let i = 0; i < days; i++) {
    const year = Math.floor(i / 365) + 1;
    const result = tick({ world, rng: tickRng.derive(`day-${i}`) });
    for (const e of result.events) {
      ensure(year, e.type);
    }
  }

  console.log('year,recipe_ran,caravan_moved,caravan_arrived,market_cleared,cohort_deaths,epidemic_started,caravan_robbed');
  for (let y = 1; y <= 10; y++) {
    const b = yearBuckets[y] ?? {};
    console.log(
      `${y},${b.recipe_ran ?? 0},${b.caravan_moved ?? 0},${b.caravan_arrived ?? 0},${b.market_cleared ?? 0},${b.cohort_deaths ?? 0},${b.epidemic_started ?? 0},${b.caravan_robbed ?? 0}`,
    );
  }
  console.log('\nFinal world state:');
  console.log(`  caravans alive: ${world.caravans.size}`);
  console.log(`  bandit camps in world.banditCamps: ${world.banditCamps?.size ?? 0}`);
  console.log(`  patrols in world.patrols: ${world.patrols?.size ?? 0}`);
  console.log(`  news carriers: ${world.newsCarriers?.size ?? 0}`);
}
main();
