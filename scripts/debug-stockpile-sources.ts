/**
 * Audit where city stockpile mass comes from.
 *
 * Procedure:
 *   1. Seed a world identical to the watchdog burn-in (80x80, 3 cities).
 *   2. Snapshot per-settlement, per-resource aggregate stocks at day 0
 *      (just from procgen seed grants).
 *   3. Run N days of ticks, then snapshot again.
 *   4. For each settlement, print the top-mass resources with:
 *      - seed stock
 *      - delta (= produced + imported - consumed - exported - spoiled)
 *      - days-of-consumption equivalent
 *
 * Run with: `npx tsx scripts/debug-stockpile-sources.ts [days]`
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';
import { resourceId, type ResourceId, type SettlementId } from '../src/sim/types.ts';

const days = Number(process.argv[2] ?? 365);
const topN = Number(process.argv[3] ?? 8);

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

const settlementStockpile = (sId: SettlementId): Map<ResourceId, number> => {
  // Per docs/15 §C30: each owner has a slice keyed by SettlementId; sum only
  // the slice physically at THIS settlement.
  const out = new Map<ResourceId, number>();
  const s = world.settlements.get(sId);
  if (s === undefined) return out;
  for (const ownerId of s.stockpileOwners) {
    const a = world.actors.get(ownerId);
    if (a === undefined) continue;
    const slice = a.stockpile.get(sId);
    if (slice === undefined) continue;
    for (const [r, q] of slice) {
      if (q <= 0) continue;
      out.set(r, (out.get(r) ?? 0) + q);
    }
  }
  return out;
};

const snapshot = (): Map<SettlementId, Map<ResourceId, number>> => {
  const out = new Map<SettlementId, Map<ResourceId, number>>();
  for (const s of world.settlements.values()) {
    out.set(s.id, settlementStockpile(s.id));
  }
  return out;
};

const seed = snapshot();

const tickRng = createRng('watchdog|tick');
for (let i = 0; i < days; i++) {
  tick({ world, rng: tickRng.derive(`day-${i}`) });
}

const final = snapshot();

const cities = [...world.settlements.values()]
  .filter((s) => s.tier === 'small_city' || s.tier === 'large_city')
  .sort((a, b) => b.population.total() - a.population.total());

const summarize = (name: string, sId: SettlementId, pop: number): void => {
  const seedStock = seed.get(sId) ?? new Map();
  const finalStock = final.get(sId) ?? new Map();
  const allRes = new Set<ResourceId>([...seedStock.keys(), ...finalStock.keys()]);
  const rows: { r: string; seedQ: number; finalQ: number; delta: number }[] = [];
  for (const r of allRes) {
    const s0 = seedStock.get(r) ?? 0;
    const sN = finalStock.get(r) ?? 0;
    rows.push({ r: String(r), seedQ: s0, finalQ: sN, delta: sN - s0 });
  }
  rows.sort((a, b) => b.finalQ - a.finalQ);
  console.log(`\n${name} (pop=${pop}, tier=${world.settlements.get(sId)?.tier}):`);
  console.log(`  ${'resource'.padEnd(28)} ${'seed'.padStart(12)} ${'+delta'.padStart(14)} ${'=final'.padStart(14)}`);
  for (let i = 0; i < Math.min(topN, rows.length); i++) {
    const row = rows[i]!;
    const d = row.delta >= 0 ? `+${Math.round(row.delta).toString()}` : Math.round(row.delta).toString();
    console.log(
      `  ${row.r.padEnd(28)} ${Math.round(row.seedQ).toString().padStart(12)} ${d.padStart(14)} ${Math.round(row.finalQ).toString().padStart(14)}`,
    );
  }
};

console.log(`burn-in: ${days} days on watchdog seed (80x80, 3 cities)`);
console.log(`day-${days} world: settlements=${world.settlements.size}, actors=${world.actors.size}\n`);

for (const c of cities.slice(0, 3)) {
  summarize(c.name, c.id, c.population.total());
}

// Also pick one village + one hamlet for comparison.
const villages = [...world.settlements.values()]
  .filter((s) => s.tier === 'village')
  .sort((a, b) => b.population.total() - a.population.total());
const hamlets = [...world.settlements.values()]
  .filter((s) => s.tier === 'hamlet')
  .sort((a, b) => b.population.total() - a.population.total());
if (villages.length > 0) summarize(villages[0]!.name, villages[0]!.id, villages[0]!.population.total());
if (hamlets.length > 0) summarize(hamlets[0]!.name, hamlets[0]!.id, hamlets[0]!.population.total());

console.log('\nLegend: seed = procgen grants at day 0; delta = production+imports-consumption-exports-spoilage over the burn-in.');
