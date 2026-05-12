/**
 * News-carrier sprite layer. Renders `world.newsCarriers` — refugees /
 * escaped survivors / messengers carrying a reputation update from where
 * it occurred toward an inhabited destination. Per docs/13 reputation
 * propagates at human-walk speed, not instantly; the sprite makes that
 * physically visible.
 *
 * docs/15 §C32: every moving sim entity must have a visible glyph.
 */

import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry } from '../art/index.js';
import { createMoverLayer, type MoverLayer, type MoverView } from './movers.js';

export type NewsCarriersLayer = MoverLayer;

export const createNewsCarriersLayer = (
  art: ArtRegistry,
  onSelect?: (id: string) => void,
): NewsCarriersLayer => {
  return createMoverLayer(art, {
    unitKind: 'news_carrier',
    getMovers: function* (world: WorldState): Iterable<MoverView> {
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
