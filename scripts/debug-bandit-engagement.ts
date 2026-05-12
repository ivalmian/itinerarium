/**
 * Quick burn-in instrumentation: count bandit-party + patrol events
 * to see if pursuit / engagement actually fires on the watchdog seed.
 */
import { generateTerrain } from '../src/procgen/terrain.ts';
import { siteSettlements } from '../src/procgen/settlements.ts';
import { seedWorld } from '../src/procgen/seed.ts';
import { seedCaravans } from '../src/procgen/seedCaravans.ts';
import { tick } from '../src/sim/tick.ts';
import { createRng } from '../src/sim/rng.ts';

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

const counts = new Map<string, number>();
const tickRng = createRng('watchdog|tick');
for (let i = 0; i < DAYS; i++) {
  const r = tick({ world, rng: tickRng.derive(`day-${i}`) });
  for (const e of r.events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
}

const relevant = [
  'bandit_party_dispatched',
  'bandit_party_returned',
  'patrol_engaged',
  'patrol_dispatched',
  'settlement_raided',
  'caravan_robbed',
];
console.log(`After ${DAYS} days:`);
for (const k of relevant) {
  console.log(`  ${k.padEnd(28)} = ${counts.get(k) ?? 0}`);
}
console.log(
  `\n  active bandit parties: ${world.banditParties?.size ?? 0}, camps: ${world.banditCamps?.size ?? 0}, patrols: ${world.patrols?.size ?? 0}`,
);
