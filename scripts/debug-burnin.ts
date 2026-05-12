/**
 * Quick debug: run burn-in for N days and dump per-settlement-tier
 * population + per-resource stockpile aggregates so we can see WHERE
 * the collapse is happening.
 */
import { runBurnIn } from '../src/burnin/runner.ts';
import { actorTotalStock } from '../src/sim/politics/actor.ts';
import { resourceId } from '../src/sim/types.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const days = Number(args[0] ?? 365);

  // Use smaller world for quick iteration but same settings.
  await runBurnIn({
    seed: 'debug',
    mapWidth: 60,
    mapHeight: 60,
    cityCount: 2,
    townCount: 5,
    villageCount: 30,
    hamletCount: 15,
    years: 0,
    daysOverride: days,
    invariantCheckEvery: 'month',
    snapshotEvery: 'never',
    outDir: '/tmp/debug-burn',
    silent: true,
    yieldEveryDays: 1000,
  });

  // The runner doesn't expose world; we re-create + tick to inspect.
  const { generateTerrain } = await import('../src/procgen/terrain.ts');
  const { siteSettlements } = await import('../src/procgen/settlements.ts');
  const { seedWorld } = await import('../src/procgen/seed.ts');
  const { seedCaravans } = await import('../src/procgen/seedCaravans.ts');
  const { tick } = await import('../src/sim/tick.ts');
  const { createRng } = await import('../src/sim/rng.ts');

  const grid = generateTerrain({
    seed: 'debug|terrain',
    widthHexes: 60,
    heightHexes: 60,
  });
  const sites = siteSettlements({
    seed: 'debug|sites',
    grid,
    cityCount: 2,
    townCount: 5,
    villageCount: 30,
    hamletCount: 15,
  });
  const world = seedWorld({ seed: 'debug|world', grid, settlementSites: sites });
  seedCaravans({ seed: 'debug|caravans', world });

  const tickRng = createRng('debug|tick');

  const grain = resourceId('food.grain');
  const bread = resourceId('food.bread');
  const flour = resourceId('food.flour');
  const wood = resourceId('material.wood');
  const tools = resourceId('goods.tools');

  const sumStockpile = (resourceLookup: ReturnType<typeof resourceId>): number => {
    let total = 0;
    for (const a of world.actors.values()) {
      total += actorTotalStock(a, resourceLookup);
    }
    return total;
  };

  const popByTier = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of world.settlements.values()) {
      out[s.tier] = (out[s.tier] ?? 0) + s.population.total();
    }
    return out;
  };

  console.log('day,total_pop,hamlet_pop,village_pop,town_pop,small_city_pop,large_city_pop,grain,bread,flour,wood,tools');
  const dump = (day: number): void => {
    const tiers = popByTier();
    let total = 0;
    for (const t of ['hamlet', 'village', 'town', 'small_city', 'large_city']) {
      total += tiers[t] ?? 0;
    }
    console.log(
      `${day},${total},${tiers.hamlet ?? 0},${tiers.village ?? 0},${tiers.town ?? 0},${tiers.small_city ?? 0},${tiers.large_city ?? 0},` +
        `${sumStockpile(grain).toFixed(0)},${sumStockpile(bread).toFixed(0)},${sumStockpile(flour).toFixed(0)},${sumStockpile(wood).toFixed(0)},${sumStockpile(tools).toFixed(0)}`,
    );
  };

  dump(0);
  for (let i = 0; i < days; i++) {
    tick({ world, rng: tickRng.derive(`day-${i}`) });
    if ((i + 1) % 30 === 0) dump(i + 1);
  }
}
main();
