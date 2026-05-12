/**
 * Caravan sprite layer — thin wrapper around the unified `unitLayer`
 * (docs/16-viewer §"Unit rendering"). Caravans use a slightly larger
 * sprite, support the path-data hand-off from the sim's caravan
 * movement events so they animate along the planned hex route, and
 * surface a click-to-select affordance + halo highlight for the
 * inspector.
 *
 * Per docs/15 §C31: villager caravans render with a dedicated peasant-
 * with-handcart glyph (`villager_caravan`) keyed off the `villager-` id
 * prefix; all other caravans use the merchant `caravan` glyph.
 */

import type { CaravanId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import type { ArtRegistry, UnitKind } from '../art/index.js';
import { createUnitLayer, type UnitLayer, type UnitView } from './unitLayer.js';

const CARAVAN_SPRITE_PX = 20;

export interface CaravansLayer {
  readonly container: UnitLayer['container'];
  syncTick(
    world: WorldState,
    pathPerCaravan?: ReadonlyMap<CaravanId, readonly { q: number; r: number }[]>,
    hexSize?: number,
    visualDurationMs?: number,
  ): void;
  advanceVisual(world: WorldState, deltaMs: number, hexSize: number): void;
  isIdle(): boolean;
  setHighlight(id: CaravanId | null): void;
}

const caravanUnitKind = (id: string): UnitKind =>
  id.startsWith('villager-') ? 'villager_caravan' : 'caravan';

export const createCaravansLayer = (
  art: ArtRegistry,
  onSelect: (id: CaravanId) => void,
): CaravansLayer => {
  const inner = createUnitLayer(art, {
    defaultUnitKind: 'caravan',
    spritePx: CARAVAN_SPRITE_PX,
    enableHighlight: true,
    onSelect: (id) => onSelect(id as CaravanId),
    getEntities: function* (world: WorldState): Iterable<UnitView> {
      for (const c of world.caravans.values()) {
        yield {
          id: String(c.id),
          position: c.position,
          ownerKey: String(c.ownerActor),
          unitKind: caravanUnitKind(String(c.id)),
        };
      }
    },
  });

  return {
    container: inner.container,
    syncTick: (world, pathPerCaravan, hexSize, visualDurationMs) => {
      // The unit-layer factory keys path entries by stringified id;
      // pathPerCaravan keys by branded CaravanId. The branded wrapper
      // unwraps to the same string at runtime, so passing it through
      // works structurally.
      inner.syncTick(
        world,
        pathPerCaravan as unknown as ReadonlyMap<string, readonly { q: number; r: number }[]>,
        hexSize,
        visualDurationMs,
      );
    },
    advanceVisual: (world, deltaMs, hexSize) => inner.advanceVisual(world, deltaMs, hexSize),
    isIdle: () => inner.isIdle(),
    setHighlight: (id) => inner.setHighlight(id === null ? null : String(id)),
  };
};
