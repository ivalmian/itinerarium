/**
 * Patrol sprite layer. Renders `world.patrols` (provincial garrison,
 * city watch, family guards, caravan escorts) with the `patrol` glyph,
 * keyed by patrol id and tinted by owner-actor for faction colour.
 *
 * Patrols walk a cyclic route at one hex per tick (per docs/12), so
 * interpolation just needs to glide the sprite from the previous hex
 * to the current hex over the current tick window.
 *
 * docs/15 §C32: every moving sim entity must have a visible glyph.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry } from '../art/index.js';
import { createMoverLayer, type MoverLayer, type MoverView } from './movers.js';

export type PatrolsLayer = MoverLayer;

export const createPatrolsLayer = (
  art: ArtRegistry,
  onSelect?: (id: string) => void,
): PatrolsLayer => {
  return createMoverLayer(art, {
    unitKind: 'patrol',
    getMovers: function* (world: WorldState): Iterable<MoverView> {
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
