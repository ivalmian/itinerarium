/**
 * Tally per-year activity counts from a 10-year burn-in:
 * trades, caravan trips, banditry incidents, patrol engagements.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld, type WorldState } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';
import { AGE_BANDS, type AgeBand } from '../src/sim/population/cohort.ts';

/**
 * Sum population across all settlements, broken down by age band.
 * Used to verify demographic dynamics: aging shifts cohorts up bands,
 * tickDaily fires births into 0-4, elders die out of 80+ over time.
 */
const pyramidSnapshot = (world: WorldState): Record<AgeBand, number> => {
  const out = {} as Record<AgeBand, number>;
  for (const b of AGE_BANDS) out[b] = 0;
  for (const s of world.settlements.values()) {
    for (const b of AGE_BANDS) {
      out[b] += s.population.totalByAgeBand(b);
    }
  }
  return out;
};

const printPyramid = (label: string, p: Record<AgeBand, number>): void => {
  let total = 0;
  for (const b of AGE_BANDS) total += p[b];
  console.log(`\n--- Age pyramid: ${label} (total ${total.toLocaleString()}) ---`);
  for (const b of AGE_BANDS) {
    const n = p[b];
    const pct = total > 0 ? (n / total) * 100 : 0;
    const bar = '█'.repeat(Math.min(40, Math.round(pct * 2)));
    console.log(`  ${b.padStart(5, ' ')}: ${String(n).padStart(7, ' ')}  ${pct.toFixed(1).padStart(5, ' ')}%  ${bar}`);
  }
};

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

  // Snapshot the demographic pyramid at year boundaries 0, 1, 5, 10 so we
  // can verify the cohort machinery is actually doing aging + births +
  // deaths over time. Per docs/04 §"How the dynamics actually run".
  const pyramidSnapshots: { label: string; pyramid: Record<AgeBand, number> }[] = [];
  pyramidSnapshots.push({ label: 'Year 0 (procgen)', pyramid: pyramidSnapshot(world) });

  for (let i = 0; i < days; i++) {
    const year = Math.floor(i / 365) + 1;
    const result = tick({ world, rng: tickRng.derive(`day-${i}`) });
    for (const e of result.events) {
      ensure(year, e.type);
    }
    if (i === 365 - 1) pyramidSnapshots.push({ label: 'Year 1', pyramid: pyramidSnapshot(world) });
    if (i === 365 * 5 - 1) pyramidSnapshots.push({ label: 'Year 5', pyramid: pyramidSnapshot(world) });
    if (i === 365 * 10 - 1) pyramidSnapshots.push({ label: 'Year 10', pyramid: pyramidSnapshot(world) });
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

  // Demographic verification: are cohorts actually shifting + new births
  // appearing + elders dying out? Per docs/04 + the user-asked check.
  for (const snap of pyramidSnapshots) {
    printPyramid(snap.label, snap.pyramid);
  }
}
main();
