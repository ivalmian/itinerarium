/**
 * News-carrier sprite layer — thin wrapper around the unified
 * `unitLayer`. Renders `world.newsCarriers` — refugees / escaped
 * survivors / messengers carrying a reputation update from where it
 * occurred toward an inhabited destination. Per docs/13 reputation
 * propagates at human-walk speed, not instantly; the sprite makes that
 * physically visible.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry } from '../art/index.js';
import { createUnitLayer, type UnitLayer, type UnitView } from './unitLayer.js';

export type NewsCarriersLayer = UnitLayer;

export const createNewsCarriersLayer = (
  art: ArtRegistry,
  onSelect?: (id: string) => void,
): NewsCarriersLayer => {
  return createUnitLayer(art, {
    defaultUnitKind: 'news_carrier',
    getEntities: function* (world: WorldState): Iterable<UnitView> {
      if (world.newsCarriers === undefined) return;
      for (const carrier of world.newsCarriers.values()) {
        if (carrier.arrived) continue;
        yield {
          id: carrier.id,
          position: carrier.position,
          // News carriers don't have a stable owner actor; key the colour
          // by the carrier's id so each refugee has a consistent badge.
          ownerKey: carrier.id,
        };
      }
    },
    ...(onSelect !== undefined ? { onSelect } : {}),
  });
};
