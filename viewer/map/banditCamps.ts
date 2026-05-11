/**
 * Bandit camp glyphs — painterly-vector tent + campfire + skull totem,
 * rasterized from viewer/art/units/bandit_camp.svg at startup. Camps that
 * move via `move_camp` snap to the new hex each tick (interpolation can
 * land later if the visual jump is jarring).
 */

import { Container, FederatedPointerEvent, Graphics, Sprite } from 'pixi.js';
import type { BanditCampId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry } from '../art/index.js';

const SPRITE_PX = 18;
const HIGHLIGHT_R = 11;

export interface BanditCampsLayer {
  readonly container: Container;
  sync(world: WorldState, hexSize: number): void;
  setHighlight(id: BanditCampId | null): void;
}

interface Entry {
  readonly id: BanditCampId;
  readonly sprite: Sprite;
  readonly halo: Graphics;
}

export const createBanditCampsLayer = (
  art: ArtRegistry,
  onSelect: (id: BanditCampId) => void,
): BanditCampsLayer => {
  const container = new Container();
  container.label = 'banditCamps';
  const entries = new Map<BanditCampId, Entry>();
  let highlightedId: BanditCampId | null = null;

  const sync = (world: WorldState, hexSize: number): void => {
    const seen = new Set<BanditCampId>();
    const camps = world.banditCamps ?? new Map();
    for (const c of camps.values()) {
      seen.add(c.id);
      let e = entries.get(c.id);
      if (e === undefined) {
        const halo = new Graphics();
        halo.eventMode = 'none';
        halo.visible = false;
        container.addChild(halo);
        const sprite = new Sprite(art.unit('bandit_camp'));
        sprite.anchor.set(0.5, 0.5);
        sprite.width = SPRITE_PX;
        sprite.height = SPRITE_PX;
        sprite.eventMode = 'static';
        sprite.cursor = 'pointer';
        sprite.on('pointerdown', (ev: FederatedPointerEvent) => {
          ev.stopPropagation();
          onSelect(c.id);
        });
        sprite.hitArea = { contains: (x: number, y: number) => x * x + y * y <= 64 };
        container.addChild(sprite);
        e = { id: c.id, sprite, halo };
        entries.set(c.id, e);
      }
      const px = hexToPixel(c.hex, hexSize);
      e.sprite.position.set(px.x, px.y);
      e.halo.position.set(px.x, px.y);
      const isHi = c.id === highlightedId;
      e.halo.visible = isHi;
      if (isHi) {
        e.halo.clear();
        e.halo.circle(0, 0, HIGHLIGHT_R).stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 });
      }
    }
    for (const [id, e] of entries) {
      if (!seen.has(id)) {
        container.removeChild(e.sprite);
        container.removeChild(e.halo);
        e.sprite.destroy();
        e.halo.destroy();
        entries.delete(id);
      }
    }
  };

  const setHighlight = (id: BanditCampId | null): void => {
    highlightedId = id;
  };

  return { container, sync, setHighlight };
};
