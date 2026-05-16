/**
 * In-process equivalent of `scripts/audit-resource-graph.ts`. Asserts
 * that every resource in the catalog either (a) has a producing recipe,
 * is a Tier-0 raw material, or is an off-map-only producer, AND (b) is
 * consumed by at least one recipe input or one of the known demand
 * hooks (institutional procurement / subsistence / status / etc.).
 *
 * If this test starts failing, run `npm run audit` for a friendly
 * report and fix the resource/recipe wiring (or update the allow-lists
 * in this file with a comment explaining why).
 */

import { describe, expect, it } from 'vitest';

import { allRecipes } from '../production/recipes.js';
import { allResources } from './catalog.js';
import type { ResourceId } from '../types.js';

const isServiceResource = (id: string): boolean => id.startsWith('service.');

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

const OFF_MAP_ONLY_PRODUCERS = new Set<string>([
  'exotic.spices',
  'exotic.silk',
  'exotic.incense',
  'exotic.dyes',
  'people.slave',
  'people.migrants',
]);

const KNOWN_DEMAND_HOOKS = new Set<string>([
  // Subsistence + comfort food.
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
  // Subsistence salt + fuel + shelter.
  'mineral.salt',
  'material.wood',
  'material.charcoal',
  'material.lumber',
  'material.cut_stone',
  'material.brick_tile',
  'material.pottery',
  'material.amphora',
  // Goods consumed by households / institutions.
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
  // Caravan transport capital.
  'livestock.equines',
  // Status good — no recipe input.
  'metal.gold',
  // Refined metals are intermediate stock pulled by smithing inputs.
  'metal.silver',
  'metal.lead',
  'metal.bronze',
  'metal.iron',
]);

describe('resource graph audit', () => {
  it('every non-service, non-tier0 resource has a producing recipe or is off-map-only', () => {
    const producerRecipesForResource = new Map<ResourceId, string[]>();
    for (const r of allRecipes()) {
      for (const out of r.outputs.keys()) {
        let arr = producerRecipesForResource.get(out);
        if (arr === undefined) {
          arr = [];
          producerRecipesForResource.set(out, arr);
        }
        arr.push(String(r.id));
      }
    }

    const orphans: string[] = [];
    for (const r of allResources()) {
      const idStr = String(r.id);
      if (isServiceResource(idStr)) continue;
      if (producerRecipesForResource.has(r.id)) continue;
      if (TIER0_RAW_MATERIALS.has(idStr)) continue;
      if (OFF_MAP_ONLY_PRODUCERS.has(idStr)) continue;
      orphans.push(idStr);
    }
    expect(orphans).toEqual([]);
  });

  it('every non-service resource has a recipe consumer or a demand hook', () => {
    const consumerRecipesForResource = new Map<ResourceId, string[]>();
    for (const r of allRecipes()) {
      for (const inp of r.inputs.keys()) {
        let arr = consumerRecipesForResource.get(inp);
        if (arr === undefined) {
          arr = [];
          consumerRecipesForResource.set(inp, arr);
        }
        arr.push(String(r.id));
      }
    }

    const orphans: string[] = [];
    for (const r of allResources()) {
      const idStr = String(r.id);
      if (isServiceResource(idStr)) continue;
      if (consumerRecipesForResource.has(r.id)) continue;
      if (KNOWN_DEMAND_HOOKS.has(idStr)) continue;
      orphans.push(idStr);
    }
    expect(orphans).toEqual([]);
  });

  it('every recipe input/output references a known resource', () => {
    const knownIds = new Set(allResources().map((r) => String(r.id)));
    const unknown: string[] = [];
    for (const r of allRecipes()) {
      for (const inp of r.inputs.keys()) {
        if (!knownIds.has(String(inp))) {
          unknown.push(`${String(r.id)} input ${String(inp)}`);
        }
      }
      for (const out of r.outputs.keys()) {
        if (!knownIds.has(String(out))) {
          unknown.push(`${String(r.id)} output ${String(out)}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
