/**
 * Caravan sprite layer — SVG-driven.
 *
 * Each caravan renders as a Sprite of viewer/art/units/caravan.svg (trade
 * caravan: merchant + pack mules + amphora). A small faction-colored dot
 * sits underneath the sprite so different merchant houses are still
 * distinguishable at a glance (the dot reads even when the sprite itself
 * is too small to inspect at low zoom).
 *
 * docs/16-viewer §"Caravan rendering": each tick the caravan's `position`
 * may change. We interpolate the on-screen position between the previous
 * and current hex over the tick interval so units glide rather than jump.
 * The interpolation factor is driven by the app's ticker via
 * setInterpolationT().
 */

import { Container, FederatedPointerEvent, Graphics, Sprite } from 'pixi.js';
import type { CaravanId, ActorId } from '../../src/sim/types.js';
import type { Caravan } from '../../src/sim/caravan/caravan.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry } from '../art/index.js';

const SPRITE_PX = 20;

export interface CaravansLayer {
  readonly container: Container;
  /** Snap previous→current positions; called once per sim tick. */
  syncTick(
    world: WorldState,
    pathPerCaravan?: ReadonlyMap<CaravanId, readonly { q: number; r: number }[]>,
  ): void;
  /** Update interpolated screen positions. t in [0, 1]. */
  setInterpolationT(world: WorldState, t: number, hexSize: number): void;
  setHighlight(id: CaravanId | null): void;
}

interface Entry {
  readonly id: CaravanId;
  readonly sprite: Sprite;
  readonly badge: Graphics;
  readonly halo: Graphics;
  prevQ: number;
  prevR: number;
  curQ: number;
  curR: number;
  ownerColor: number;
  path?: { q: number; r: number }[];
}

const factionColor = (owner: ActorId): number => {
  const s = String(owner);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
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
  art: ArtRegistry,
  onSelect: (id: CaravanId) => void,
): CaravansLayer => {
  const container = new Container();
  container.label = 'caravans';
  const entries = new Map<CaravanId, Entry>();
  let highlightedId: CaravanId | null = null;

  const ensureEntry = (c: Caravan): Entry => {
    let e = entries.get(c.id);
    if (e === undefined) {
      const halo = new Graphics();
      halo.eventMode = 'none';
      halo.visible = false;
      container.addChild(halo);
      const badge = new Graphics();
      badge.eventMode = 'none';
      container.addChild(badge);
      const sprite = new Sprite(art.unit('caravan'));
      sprite.anchor.set(0.5, 0.5);
      sprite.width = SPRITE_PX;
      sprite.height = SPRITE_PX;
      sprite.eventMode = 'static';
      sprite.cursor = 'pointer';
      sprite.on('pointerdown', (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        onSelect(c.id);
      });
      sprite.hitArea = { contains: (x: number, y: number) => x * x + y * y <= 100 };
      container.addChild(sprite);
      e = {
        id: c.id,
        sprite,
        badge,
        halo,
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

  const syncTick = (
    world: WorldState,
    pathPerCaravan?: ReadonlyMap<CaravanId, readonly { q: number; r: number }[]>,
  ): void => {
    const seen = new Set<CaravanId>();
    for (const c of world.caravans.values()) {
      seen.add(c.id);
      const e = ensureEntry(c);
      const sourcePath = pathPerCaravan?.get(c.id);
      if (sourcePath !== undefined && sourcePath.length > 0) {
        e.path = sourcePath.map((h) => ({ q: h.q, r: h.r }));
      } else {
        e.path = [
          { q: e.curQ, r: e.curR },
          { q: c.position.q, r: c.position.r },
        ];
      }
      e.prevQ = e.curQ;
      e.prevR = e.curR;
      e.curQ = c.position.q;
      e.curR = c.position.r;
      e.ownerColor = factionColor(c.ownerActor);
    }
    for (const [id, e] of entries) {
      if (!seen.has(id)) {
        container.removeChild(e.sprite);
        container.removeChild(e.badge);
        container.removeChild(e.halo);
        e.sprite.destroy();
        e.badge.destroy();
        e.halo.destroy();
        entries.delete(id);
      }
    }
  };

  const setInterpolationT = (world: WorldState, t: number, hexSize: number): void => {
    const tt = Math.max(0, Math.min(1, t));
    for (const c of world.caravans.values()) {
      const e = entries.get(c.id);
      if (e === undefined) continue;
      let q = e.curQ;
      let r = e.curR;
      const path = e.path;
      if (path !== undefined && path.length >= 2) {
        const segments = path.length - 1;
        const local = tt * segments;
        const i = Math.min(segments - 1, Math.floor(local));
        const segT = local - i;
        const a = path[i] as { q: number; r: number };
        const b = path[i + 1] as { q: number; r: number };
        q = a.q + (b.q - a.q) * segT;
        r = a.r + (b.r - a.r) * segT;
      }
      const px = hexToPixel({ q, r }, hexSize);
      e.sprite.position.set(px.x, px.y);
      // Owner-color badge sits just above the caravan (small disc that
      // reads at every zoom level).
      e.badge.clear();
      e.badge.circle(0, -SPRITE_PX * 0.55, 2.2).fill({ color: e.ownerColor }).stroke({ color: 0x111111, width: 0.4 });
      e.badge.position.set(px.x, px.y);
      const isHi = e.id === highlightedId;
      e.halo.visible = isHi;
      if (isHi) {
        e.halo.clear();
        e.halo.circle(0, 0, SPRITE_PX * 0.7).stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 });
        e.halo.position.set(px.x, px.y);
      }
    }
  };

  const setHighlight = (id: CaravanId | null): void => {
    highlightedId = id;
  };

  return { container, syncTick, setInterpolationT, setHighlight };
};
