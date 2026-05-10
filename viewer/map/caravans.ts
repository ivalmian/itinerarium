/**
 * Caravan sprite layer.
 *
 * One small circle per caravan. Color is derived from the owner ActorId via
 * a stable hash so each family / merchant house keeps its color across ticks.
 *
 * docs/16-viewer §"Caravan rendering": each tick, the caravan's `position`
 * may change. We interpolate the on-screen position between the previous and
 * current hex over the tick interval so dots glide rather than jump. The
 * interpolation factor is driven by the app's ticker via setInterpolationT().
 */

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import type { CaravanId, ActorId } from '../../src/sim/types.js';
import type { Caravan } from '../../src/sim/caravan/caravan.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';

export interface CaravansLayer {
  readonly container: Container;
  /** Snap previous→current positions; called once per sim tick. */
  syncTick(world: WorldState): void;
  /** Update interpolated screen positions. t in [0, 1]. */
  setInterpolationT(world: WorldState, t: number, hexSize: number): void;
  setHighlight(id: CaravanId | null): void;
}

interface Entry {
  readonly id: CaravanId;
  readonly graphic: Graphics;
  prevQ: number;
  prevR: number;
  curQ: number;
  curR: number;
  ownerColor: number;
}

const factionColor = (owner: ActorId): number => {
  // FNV-1a-ish hash so identically-prefixed owner ids fan out across the
  // hue wheel.
  const s = String(owner);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Shape into HSL → RGB. Saturated mid-light hue.
  const hue = (h >>> 0) % 360;
  return hslToHex(hue, 0.55, 0.55);
};

const hslToHex = (h: number, s: number, l: number): number => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return (
    (Math.round((r + m) * 255) << 16) |
    (Math.round((g + m) * 255) << 8) |
    Math.round((b + m) * 255)
  );
};

export const createCaravansLayer = (
  onSelect: (id: CaravanId) => void,
): CaravansLayer => {
  const container = new Container();
  container.label = 'caravans';
  const entries = new Map<CaravanId, Entry>();
  let highlightedId: CaravanId | null = null;

  const ensureEntry = (c: Caravan): Entry => {
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
      e = {
        id: c.id,
        graphic: g,
        prevQ: c.position.q,
        prevR: c.position.r,
        curQ: c.position.q,
        curR: c.position.r,
        ownerColor: factionColor(c.ownerActor),
      };
      entries.set(c.id, e);
    }
    return e;
  };

  const syncTick = (world: WorldState): void => {
    const seen = new Set<CaravanId>();
    for (const c of world.caravans.values()) {
      seen.add(c.id);
      const e = ensureEntry(c);
      e.prevQ = e.curQ;
      e.prevR = e.curR;
      e.curQ = c.position.q;
      e.curR = c.position.r;
      e.ownerColor = factionColor(c.ownerActor);
    }
    for (const [id, e] of entries) {
      if (!seen.has(id)) {
        container.removeChild(e.graphic);
        e.graphic.destroy();
        entries.delete(id);
      }
    }
  };

  const setInterpolationT = (world: WorldState, t: number, hexSize: number): void => {
    const tt = Math.max(0, Math.min(1, t));
    for (const c of world.caravans.values()) {
      const e = entries.get(c.id);
      if (e === undefined) continue;
      const q = e.prevQ + (e.curQ - e.prevQ) * tt;
      const r = e.prevR + (e.curR - e.prevR) * tt;
      const px = hexToPixel({ q, r }, hexSize);
      e.graphic.position.set(px.x, px.y);
      drawCaravan(e.graphic, e.ownerColor, e.id === highlightedId);
    }
  };

  const setHighlight = (id: CaravanId | null): void => {
    highlightedId = id;
  };

  return { container, syncTick, setInterpolationT, setHighlight };
};

const drawCaravan = (g: Graphics, color: number, highlighted: boolean): void => {
  g.clear();
  g.circle(0, 0, 4).fill({ color }).stroke({ color: 0x000000, width: 0.6 });
  if (highlighted) {
    g.circle(0, 0, 6).stroke({ color: 0xffffff, width: 1.5 });
  }
};
