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

  // Two CSVs side by side: economy + news/conflict. Easier to scan than one
  // wide row.
  console.log('=== Economy ===');
  console.log('year,recipe_ran,recipe_blocked,caravan_moved,caravan_arrived,market_cleared');
  for (let y = 1; y <= 10; y++) {
    const b = yearBuckets[y] ?? {};
    console.log(
      `${y},${b.recipe_ran ?? 0},${b.recipe_blocked ?? 0},${b.caravan_moved ?? 0},${b.caravan_arrived ?? 0},${b.market_cleared ?? 0}`,
    );
  }
  console.log('\n=== Population & disease ===');
  console.log('year,cohort_deaths,epidemic_started');
  for (let y = 1; y <= 10; y++) {
    const b = yearBuckets[y] ?? {};
    console.log(`${y},${b.cohort_deaths ?? 0},${b.epidemic_started ?? 0}`);
  }
  console.log('\n=== Conflict & politics ===');
  console.log(
    'year,caravan_robbed,settlement_raided,patrol_dispatched,patrol_engaged,bandit_recruited,fence_traded,news_carrier_spawned,news_carrier_arrived,reputation_updated,local_trade',
  );
  for (let y = 1; y <= 10; y++) {
    const b = yearBuckets[y] ?? {};
    console.log(
      `${y},${b.caravan_robbed ?? 0},${b.settlement_raided ?? 0},${b.patrol_dispatched ?? 0},${b.patrol_engaged ?? 0},${b.bandit_recruited ?? 0},${b.fence_traded ?? 0},${b.news_carrier_spawned ?? 0},${b.news_carrier_arrived ?? 0},${b.reputation_updated ?? 0},${b.local_trade ?? 0}`,
    );
  }
  console.log('\nFinal world state:');
  console.log(`  caravans alive: ${world.caravans.size}`);
  console.log(`  bandit camps in world.banditCamps: ${world.banditCamps?.size ?? 0}`);
  console.log(`  patrols in world.patrols: ${world.patrols?.size ?? 0}`);
  console.log(`  news carriers (in flight): ${world.newsCarriers?.size ?? 0}`);
  // Bandit-population summary: total bandit headcount across all camps.
  let totalBandits = 0;
  if (world.banditCamps !== undefined) {
    for (const c of world.banditCamps.values()) totalBandits += c.banditCount;
  }
  console.log(`  total bandits across camps: ${totalBandits}`);
  console.log(`  reputation entries stored: ${world.reputation.size()}`);
}
main();
