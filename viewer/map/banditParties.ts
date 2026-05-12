/**
 * Bandit-party sprite layer. Per docs/15 §C32: every camp-originated
 * bandit action (raid, fence, recruit, migrate, bribe) spawns a
 * movable party that physically walks to its target and back. The
 * existing `bandit_raid` art glyph (a raiding band) renders that
 * party on the map.
 *
 * Movement is one hex per day; the generic mover layer handles smooth
 * interpolation between ticks.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry } from '../art/index.js';
import { createMoverLayer, type MoverLayer, type MoverView } from './movers.js';

export type BanditPartiesLayer = MoverLayer;

export const createBanditPartiesLayer = (
  art: ArtRegistry,
  onSelect?: (id: string) => void,
): BanditPartiesLayer => {
  return createMoverLayer(art, {
    unitKind: 'bandit_raid',
    getMovers: function* (world: WorldState): Iterable<MoverView> {
      if (world.banditParties === undefined) return;
      for (const p of world.banditParties.values()) {
        if (p.banditCount <= 0) continue;
        if (p.phase === 'done') continue;
        yield {
          id: String(p.id),
          position: p.position,
          ownerKey: String(p.ownerActor),
        };
      }
    },
    ...(onSelect !== undefined ? { onSelect } : {}),
  });
};
