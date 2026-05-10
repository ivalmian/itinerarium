/**
 * Bandit camp glyphs — small black X marks on the wilderness hex.
 *
 * docs/16-viewer §"Bandit camp rendering": camps that move via `move_camp`
 * animate the same way as caravans. For now we just snap to the new hex on
 * each tick — interpolation can land later if the visual jump is jarring.
 */

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import type { BanditCampId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';

export interface BanditCampsLayer {
  readonly container: Container;
  sync(world: WorldState, hexSize: number): void;
  setHighlight(id: BanditCampId | null): void;
}

interface Entry {
  readonly id: BanditCampId;
  readonly graphic: Graphics;
}

export const createBanditCampsLayer = (
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
        const g = new Graphics();
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.on('pointerdown', (ev: FederatedPointerEvent) => {
          ev.stopPropagation();
          onSelect(c.id);
        });
        g.hitArea = { contains: (x: number, y: number) => x * x + y * y <= 64 };
        container.addChild(g);
        e = { id: c.id, graphic: g };
        entries.set(c.id, e);
      }
      const px = hexToPixel(c.hex, hexSize);
      drawX(e.graphic, c.id === highlightedId);
      e.graphic.position.set(px.x, px.y);
    }
    for (const [id, e] of entries) {
      if (!seen.has(id)) {
        container.removeChild(e.graphic);
        e.graphic.destroy();
        entries.delete(id);
      }
    }
  };

  const setHighlight = (id: BanditCampId | null): void => {
    highlightedId = id;
  };

  return { container, sync, setHighlight };
};

const drawX = (g: Graphics, highlighted: boolean): void => {
  g.clear();
  const size = 5;
  const color = highlighted ? 0xffffff : 0x000000;
  g.moveTo(-size, -size).lineTo(size, size).stroke({ color, width: 2 });
  g.moveTo(-size, size).lineTo(size, -size).stroke({ color, width: 2 });
  if (highlighted) {
    g.circle(0, 0, size + 2).stroke({ color: 0xffffff, width: 1 });
  }
};
