/**
 * Patrol sprite layer — thin wrapper around the unified `unitLayer`.
 * Renders `world.patrols` (provincial garrison, city watch, family
 * guards, caravan escorts) with the `patrol` glyph. Movement
 * interpolation + faction badge logic come from the shared layer.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry } from '../art/index.js';
import { createUnitLayer, type UnitLayer, type UnitView } from './unitLayer.js';

export type PatrolsLayer = UnitLayer;

export const createPatrolsLayer = (
  art: ArtRegistry,
  onSelect?: (id: string) => void,
): PatrolsLayer => {
  return createUnitLayer(art, {
    defaultUnitKind: 'patrol',
    enableHighlight: true,
    getEntities: function* (world: WorldState): Iterable<UnitView> {
      if (world.patrols === undefined) return;
      for (const p of world.patrols.values()) {
        if (p.unit.count <= 0) continue;
        yield {
          id: p.id,
          position: p.position,
          ownerKey: String(p.ownerActor),
        };
      }
    },
    ...(onSelect !== undefined ? { onSelect } : {}),
  });
};
