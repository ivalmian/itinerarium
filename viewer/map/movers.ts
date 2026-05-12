/**
 * Generic mover-layer factory — renders a list of small moving units
 * (patrols, news carriers, bandit raid parties, future migration columns)
 * as sprites at their `position`, with optional smooth interpolation
 * between ticks.
 *
 * For caravans we have a richer dedicated layer (`caravans.ts`) that
 * handles long planned paths + cargo. Everything else moves at most one
 * hex per day, so the simpler "snap toward target during a single tick
 * window" treatment is enough.
 *
 * docs/16-viewer §"Unit rendering": every moving sim entity should have
 * a visible glyph; per CLAUDE.md no hidden hands — if the sim ticks a
 * patrol the player has to be able to see it.
 */

import { Container, FederatedPointerEvent, Graphics, Sprite } from 'pixi.js';
import type { Position } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry, UnitKind } from '../art/index.js';

const SPRITE_PX = 18;
const DEFAULT_VISUAL_DURATION_MS = 200;
const POINT_EPSILON = 1e-6;

export interface MoverView {
  readonly id: string;
  readonly position: Position;
  /** Optional — used to pick a faction badge colour. */
  readonly ownerKey?: string;
}

export interface MoverLayerOpts {
  /** Art kind to render every mover as. */
  readonly unitKind: UnitKind;
  /** Per-frame: pull the live list of movers from the world. */
  readonly getMovers: (world: WorldState) => Iterable<MoverView>;
  /** Optional click handler — receives the mover id. */
  readonly onSelect?: (id: string) => void;
}

export interface MoverLayer {
  readonly container: Container;
  /** Snap previous→current positions; called once per sim tick. */
  syncTick(world: WorldState, hexSize: number, visualDurationMs?: number): void;
  /** Advance interpolation by elapsed wall-clock time. */
  advanceVisual(world: WorldState, deltaMs: number, hexSize: number): void;
}

interface Entry {
  readonly id: string;
  readonly sprite: Sprite;
  readonly badge: Graphics;
  displayQ: number;
  displayR: number;
  fromQ: number;
  fromR: number;
  toQ: number;
  toR: number;
  ownerColor: number;
  /** Hexes per ms during the current segment, computed from sim-tick distance. */
  hexesPerMs: number;
}

const factionColor = (key: string): number => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
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
    (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)
  );
};

export const createMoverLayer = (art: ArtRegistry, opts: MoverLayerOpts): MoverLayer => {
  const container = new Container();
  container.label = `movers-${opts.unitKind}`;
  const entries = new Map<string, Entry>();

  const ensureEntry = (m: MoverView): Entry => {
    let e = entries.get(m.id);
    if (e === undefined) {
      const badge = new Graphics();
      badge.eventMode = 'none';
      container.addChild(badge);
      const sprite = new Sprite(art.unit(opts.unitKind));
      sprite.anchor.set(0.5, 0.5);
      sprite.width = SPRITE_PX;
      sprite.height = SPRITE_PX;
      sprite.eventMode = opts.onSelect !== undefined ? 'static' : 'none';
      if (opts.onSelect !== undefined) {
        sprite.cursor = 'pointer';
        sprite.on('pointerdown', (ev: FederatedPointerEvent) => {
          ev.stopPropagation();
          opts.onSelect?.(m.id);
        });
        sprite.hitArea = { contains: (x: number, y: number) => x * x + y * y <= 90 };
      }
      container.addChild(sprite);
      e = {
        id: m.id,
        sprite,
        badge,
        displayQ: m.position.q,
        displayR: m.position.r,
        fromQ: m.position.q,
        fromR: m.position.r,
        toQ: m.position.q,
        toR: m.position.r,
        ownerColor: factionColor(m.ownerKey ?? m.id),
        hexesPerMs: 0,
      };
      entries.set(m.id, e);
    }
    return e;
  };

  const drawAt = (e: Entry, q: number, r: number, hexSize: number): void => {
    e.displayQ = q;
    e.displayR = r;
    const px = hexToPixel({ q, r }, hexSize);
    e.sprite.position.set(px.x, px.y);
    e.badge.clear();
    e.badge
      .circle(0, -SPRITE_PX * 0.55, 2)
      .fill({ color: e.ownerColor })
      .stroke({ color: 0x111111, width: 0.4 });
    e.badge.position.set(px.x, px.y);
  };

  const syncTick = (
    world: WorldState,
    hexSize: number,
    visualDurationMs: number = DEFAULT_VISUAL_DURATION_MS,
  ): void => {
    const seen = new Set<string>();
    for (const m of opts.getMovers(world)) {
      seen.add(m.id);
      const isNew = !entries.has(m.id);
      const e = ensureEntry(m);
      // Start the visual segment from where the sprite currently is so
      // continuous catchup feels smooth, not jumpy.
      e.fromQ = e.displayQ;
      e.fromR = e.displayR;
      e.toQ = m.position.q;
      e.toR = m.position.r;
      const dq = e.toQ - e.fromQ;
      const dr = e.toR - e.fromR;
      const distance = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
      e.hexesPerMs = distance > POINT_EPSILON ? distance / Math.max(1, visualDurationMs) : 0;
      e.ownerColor = factionColor(m.ownerKey ?? m.id);
      if (isNew) drawAt(e, m.position.q, m.position.r, hexSize);
    }
    for (const [id, e] of entries) {
      if (seen.has(id)) continue;
      container.removeChild(e.sprite);
      container.removeChild(e.badge);
      e.sprite.destroy();
      e.badge.destroy();
      entries.delete(id);
    }
  };

  const advanceVisual = (world: WorldState, deltaMs: number, hexSize: number): void => {
    void world;
    const elapsed = Math.max(0, deltaMs);
    for (const e of entries.values()) {
      if (e.hexesPerMs <= 0) {
        drawAt(e, e.toQ, e.toR, hexSize);
        continue;
      }
      const dq = e.toQ - e.displayQ;
      const dr = e.toR - e.displayR;
      const remaining = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
      if (remaining <= POINT_EPSILON) {
        drawAt(e, e.toQ, e.toR, hexSize);
        e.hexesPerMs = 0;
        continue;
      }
      const advance = Math.min(remaining, e.hexesPerMs * elapsed);
      const t = advance / remaining;
      const q = e.displayQ + dq * t;
      const r = e.displayR + dr * t;
      drawAt(e, q, r, hexSize);
      if (advance >= remaining - POINT_EPSILON) e.hexesPerMs = 0;
    }
  };

  return { container, syncTick, advanceVisual };
};
