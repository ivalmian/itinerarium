#!/usr/bin/env tsx
/**
 * Audit the resource-recipe-demand graph for orphans.
 *
 * Per docs/02 §"Producer / consumer column" + the Phase-6 acceptance
 * criteria in the realism-pass plan: every resource in the catalog
 * should have at least one producing recipe (or be a designated raw
 * material with an extraction recipe) AND at least one consumer —
 * a recipe that uses it as input, an institutional procurement line,
 * or a subsistence/comfort/status demand wired through the schedule
 * builder.
 *
 * Output: lists of resources with no producer, no consumer, and any
 * recipe inputs/outputs referencing unknown resources.
 *
 * Run with: `npx tsx scripts/audit-resource-graph.ts`
 *
 * The script does NOT fix orphans automatically — flagging them is the
 * point. Update the resource/recipe catalogs or the procurement table
 * in scheduleBuilder.ts as appropriate.
 */

import { allResources } from '../src/sim/resources/catalog.js';
import { allRecipes } from '../src/sim/production/recipes.js';
import type { ResourceId } from '../src/sim/types.js';

const isServiceResource = (id: string): boolean => id.startsWith('service.');

// --- Build producer + consumer indices from the recipe catalog ------------

const producerRecipesForResource = new Map<ResourceId, string[]>();
const consumerRecipesForResource = new Map<ResourceId, string[]>();

for (const r of allRecipes()) {
  for (const out of r.outputs.keys()) {
    let arr = producerRecipesForResource.get(out);
    if (arr === undefined) {
      arr = [];
      producerRecipesForResource.set(out, arr);
    }
    arr.push(String(r.id));
  }
  for (const inp of r.inputs.keys()) {
    let arr = consumerRecipesForResource.get(inp);
    if (arr === undefined) {
      arr = [];
      consumerRecipesForResource.set(inp, arr);
    }
    arr.push(String(r.id));
  }
}

// --- Reference demand-side: hard-coded against the institutional + ---------
// --- subsistence wiring in scheduleBuilder.ts. We don't import the module
// --- directly here to keep this script side-effect-light; the canonical
// --- demand-source list lives there. Add a resource to KNOWN_DEMAND_HOOKS
// --- when wiring it through a new path.

// Resources that legitimately have NO on-map producing recipe because
// they enter the world via off-map imports (edgeHub) or by special
// mechanisms (slave capture, migration). Documented in docs/02
// §"Tier 2b — Exotic imports" and §"Tier 2c — People as cargo".
const OFF_MAP_ONLY_PRODUCERS = new Set<string>([
  'exotic.spices',
  'exotic.silk',
  'exotic.incense',
  'exotic.dyes',
  'people.slave',
  'people.migrants',
]);

const KNOWN_DEMAND_HOOKS = new Set<string>([
  // Direct subsistence: food + salt + fuel + shelter + clothing.
  'food.grain',
  'food.bread',
  'food.legumes',
  'food.flour',
  'food.cheese',
  'food.salted_fish',
  'food.salted_meat',
  'food.milk',
  'food.fish',
  'food.game',
  'food.olive_oil',
  'food.wine',
  'food.olives',
  'food.grapes',
  'mineral.salt',
  'material.wood',
  'material.charcoal',
  'material.lumber',
  'material.cut_stone',
  'material.brick_tile',
  'material.pottery',
  'material.amphora',
  'material.cloth' as never,
  'goods.cloth',
  'goods.clothing',
  'goods.tools',
  'goods.furniture',
  'goods.luxury_textiles',
  'goods.coin',
  'goods.cart',
  // Weapon archetypes (procurement: scheduleBuilder INSTITUTIONAL_PROCUREMENT_BY_BUILDING).
  'goods.gladius',
  'goods.hasta',
  'goods.pilum',
  'goods.dagger',
  'goods.bow',
  'goods.arrow',
  'goods.sling',
  'goods.sling_bullet',
  'goods.helmet',
  'goods.body_armor',
  'goods.shield',
  // Exotics — status/comfort demand from elite households.
  'exotic.spices',
  'exotic.silk',
  'exotic.incense',
  'exotic.dyes',
  // People-as-cargo (slaves are bid for by patrician estates etc.).
  'people.slave',
  'people.migrants',
  // Caravan transport capital — equines pulled from owner stockpile at
  // assembly time (src/sim/phases/caravan.ts MERCHANT_CARAVAN_EQUINES_RESOURCE).
  'livestock.equines',
  // Status good — patrician/governor luxury demand, no recipe input.
  'metal.gold',
  // Refined metals are intermediate stock pulled by smithing inputs;
  // include them explicitly so they're tagged as legitimately consumed.
  'metal.silver',
  'metal.lead',
  'metal.bronze',
  'metal.iron',
]);

// Tier-0 raw materials that "produce themselves" via extraction recipes
// (these all DO have extraction recipes, but the producer index above only
// picks up recipes whose .outputs map names them — extraction recipes that
// were absent or differently named would slip through). Keep the list in
// sync with docs/02 Tier-0.
const TIER0_RAW_MATERIALS = new Set<string>([
  'food.grain',
  'food.olives',
  'food.grapes',
  'food.fish',
  'food.game',
  'food.milk',
  'food.legumes',
  'livestock.sheep',
  'livestock.cattle',
  'livestock.pigs',
  'livestock.equines',
  'material.wood',
  'material.stone',
  'material.clay',
  'material.flax',
  'material.hides',
  'mineral.iron_ore',
  'mineral.copper_ore',
  'mineral.tin_ore',
  'mineral.lead_ore',
  'mineral.silver_ore',
  'mineral.gold_ore',
  'mineral.salt',
]);

// --- Run the audit --------------------------------------------------------

const orphansNoProducer: string[] = [];
const orphansNoConsumer: string[] = [];

for (const r of allResources()) {
  const idStr = String(r.id);
  // Services are not produced via recipes — they're capacity offered by buildings.
  if (isServiceResource(idStr)) continue;

  const hasProducer = producerRecipesForResource.has(r.id);
  const hasConsumerRecipe = consumerRecipesForResource.has(r.id);
  const hasDemandHook = KNOWN_DEMAND_HOOKS.has(idStr);

  if (!hasProducer && !TIER0_RAW_MATERIALS.has(idStr) && !OFF_MAP_ONLY_PRODUCERS.has(idStr)) {
    orphansNoProducer.push(idStr);
  }
  if (!hasConsumerRecipe && !hasDemandHook) {
    orphansNoConsumer.push(idStr);
  }
}

// Recipe-side: any inputs/outputs referencing unknown resources?
const knownResourceIds = new Set(allResources().map((r) => String(r.id)));
const unknownInputs: { recipe: string; resource: string }[] = [];
const unknownOutputs: { recipe: string; resource: string }[] = [];
for (const r of allRecipes()) {
  for (const inp of r.inputs.keys()) {
    if (!knownResourceIds.has(String(inp))) {
      unknownInputs.push({ recipe: String(r.id), resource: String(inp) });
    }
  }
  for (const out of r.outputs.keys()) {
    if (!knownResourceIds.has(String(out))) {
      unknownOutputs.push({ recipe: String(r.id), resource: String(out) });
    }
  }
}

// --- Report ---------------------------------------------------------------

let exitCode = 0;
const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

log('Resource-graph audit (scripts/audit-resource-graph.ts)');
log('======================================================');
log(`Resources: ${allResources().length}`);
log(`Recipes:   ${allRecipes().length}`);
log('');

if (orphansNoProducer.length === 0) {
  log('PASS: every non-service, non-tier0 resource has a producing recipe.');
} else {
  exitCode = 1;
  log(`FAIL: ${orphansNoProducer.length} resource(s) have no producing recipe AND are not flagged as tier-0 raw materials:`);
  for (const id of orphansNoProducer) log(`  - ${id}`);
}
log('');

if (orphansNoConsumer.length === 0) {
  log('PASS: every non-service resource has a consumer (recipe input or demand hook).');
} else {
  exitCode = 1;
  log(`FAIL: ${orphansNoConsumer.length} resource(s) have no recipe consumer and no demand-side hook:`);
  for (const id of orphansNoConsumer) log(`  - ${id}`);
  log('  (If intentionally unconsumed, add the resource to KNOWN_DEMAND_HOOKS in this script.)');
}
log('');

if (unknownInputs.length === 0 && unknownOutputs.length === 0) {
  log('PASS: every recipe input/output references a known resource.');
} else {
  exitCode = 1;
  for (const e of unknownInputs) log(`FAIL: recipe ${e.recipe} declares unknown input ${e.resource}`);
  for (const e of unknownOutputs) log(`FAIL: recipe ${e.recipe} declares unknown output ${e.resource}`);
}
log('');

process.exit(exitCode);
