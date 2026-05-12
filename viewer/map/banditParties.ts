/**
 * Bandit-party sprite layer — thin wrapper around the unified
 * `unitLayer`. Per docs/15 §C32: every camp-originated bandit action
 * (raid, fence, recruit, migrate, bribe) spawns a movable party that
 * physically walks to its target and back. The `bandit_raid` art
 * glyph renders that party on the map.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry } from '../art/index.js';
import { createUnitLayer, type UnitLayer, type UnitView } from './unitLayer.js';

export type BanditPartiesLayer = UnitLayer;

export const createBanditPartiesLayer = (
  art: ArtRegistry,
  onSelect?: (id: string) => void,
): BanditPartiesLayer => {
  return createUnitLayer(art, {
    defaultUnitKind: 'bandit_raid',
    enableHighlight: true,
    getEntities: function* (world: WorldState): Iterable<UnitView> {
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
