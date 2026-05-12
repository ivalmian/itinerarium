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
 * may change by several hexes. We append the emitted movement path to a
 * per-sprite visual queue and drain that queue from the app ticker so units
 * glide rather than jump.
 */

import { Container, FederatedPointerEvent, Graphics, Sprite } from 'pixi.js';
import type { CaravanId, ActorId } from '../../src/sim/types.js';
import type { Caravan } from '../../src/sim/caravan/caravan.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry } from '../art/index.js';

const SPRITE_PX = 20;
const POINT_EPSILON = 1e-6;
const MAX_VISUAL_PATH_POINTS = 320;
const MAX_VISUAL_HEX_ADVANCE_PER_FRAME = 2;
const DEFAULT_VISUAL_DURATION_MS = 160;

export interface CaravansLayer {
  readonly container: Container;
  /** Snap previous→current positions; called once per sim tick. */
  syncTick(
    world: WorldState,
    pathPerCaravan?: ReadonlyMap<CaravanId, readonly { q: number; r: number }[]>,
    hexSize?: number,
    visualDurationMs?: number,
  ): void;
  /** Advance queued visual paths by elapsed wall-clock time. */
  advanceVisual(world: WorldState, deltaMs: number, hexSize: number): void;
  setHighlight(id: CaravanId | null): void;
}

interface Entry {
  readonly id: CaravanId;
  readonly sprite: Sprite;
  readonly badge: Graphics;
  readonly halo: Graphics;
  displayQ: number;
  displayR: number;
  prevQ: number;
  prevR: number;
  curQ: number;
  curR: number;
  ownerColor: number;
  visualHexesPerMs: number;
  path?: { q: number; r: number }[];
}

interface Point {
  readonly q: number;
  readonly r: number;
}

const samePoint = (a: Point, b: Point): boolean =>
  Math.abs(a.q - b.q) < POINT_EPSILON && Math.abs(a.r - b.r) < POINT_EPSILON;

const distanceSq = (a: Point, b: Point): number => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return dq * dq + dr * dr;
};

const hexDistanceFloat = (a: Point, b: Point): number => {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
};

const pathDistance = (path: readonly Point[] | undefined): number => {
  if (path === undefined || path.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += hexDistanceFloat(path[i] as Point, path[i + 1] as Point);
  }
  return total;
};

const distanceToSegmentSq = (p: Point, a: Point, b: Point): number => {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  const lenSq = dq * dq + dr * dr;
  if (lenSq <= POINT_EPSILON) return distanceSq(p, a);
  const rawT = ((p.q - a.q) * dq + (p.r - a.r) * dr) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  return distanceSq(p, { q: a.q + dq * t, r: a.r + dr * t });
};

const appendPoint = (path: Point[], point: Point): void => {
  const last = path[path.length - 1];
  if (last !== undefined && samePoint(last, point)) return;
  path.push({ q: point.q, r: point.r });
};

const remainingPathFromDisplay = (
  display: Point,
  currentPath: readonly Point[] | undefined,
): Point[] => {
  if (currentPath === undefined || currentPath.length < 2) {
    return [{ q: display.q, r: display.r }];
  }

  let bestSegment = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < currentPath.length - 1; i++) {
    const a = currentPath[i] as Point;
    const b = currentPath[i + 1] as Point;
    const d = distanceToSegmentSq(display, a, b);
    if (d < bestDistance) {
      bestDistance = d;
      bestSegment = i;
    }
  }

  const out: Point[] = [{ q: display.q, r: display.r }];
  for (let i = bestSegment + 1; i < currentPath.length; i++) {
    appendPoint(out, currentPath[i] as Point);
  }
  return out;
};

const clampVisualPath = (path: Point[]): Point[] => {
  if (path.length <= MAX_VISUAL_PATH_POINTS) return path;
  // Preserve both the current display point and the authoritative sim tail.
  // Dropping the head makes sprites pop to far-future route points at high
  // sim speeds; sampling keeps the catch-up path continuous.
  const out: Point[] = [];
  const lastIndex = path.length - 1;
  const maxIndex = MAX_VISUAL_PATH_POINTS - 1;
  for (let i = 0; i < MAX_VISUAL_PATH_POINTS; i++) {
    const sourceIndex = i === maxIndex ? lastIndex : Math.floor((i * lastIndex) / maxIndex);
    appendPoint(out, path[sourceIndex] as Point);
  }
  return out;
};

const advancePath = (
  path: readonly Point[] | undefined,
  maxHexes: number,
): { readonly point: Point; readonly path: Point[] } | null => {
  if (path === undefined || path.length === 0) return null;
  const start = path[0] as Point;
  if (path.length < 2 || maxHexes <= POINT_EPSILON) {
    return {
      point: { q: start.q, r: start.r },
      path: path.map((p) => ({ q: p.q, r: p.r })),
    };
  }

  let cursor: Point = { q: start.q, r: start.r };
  let remaining = maxHexes;
  for (let i = 1; i < path.length; i++) {
    const next = path[i] as Point;
    const segment = hexDistanceFloat(cursor, next);
    if (segment <= POINT_EPSILON) {
      cursor = { q: next.q, r: next.r };
      continue;
    }
    if (remaining + POINT_EPSILON < segment) {
      const t = remaining / segment;
      const point = {
        q: cursor.q + (next.q - cursor.q) * t,
        r: cursor.r + (next.r - cursor.r) * t,
      };
      return {
        point,
        path: [{ q: point.q, r: point.r }, ...path.slice(i).map((p) => ({ q: p.q, r: p.r }))],
      };
    }
    remaining -= segment;
    cursor = { q: next.q, r: next.r };
  }

  return {
    point: cursor,
    path: [
      { q: cursor.q, r: cursor.r },
      { q: cursor.q, r: cursor.r },
    ],
  };
};

const extendVisualPath = (
  display: Point,
  currentPath: readonly Point[] | undefined,
  nextPath: readonly Point[] | undefined,
  fallbackDestination: Point,
): Point[] => {
  const out = remainingPathFromDisplay(display, currentPath);
  if (nextPath !== undefined && nextPath.length >= 2) {
    for (const point of nextPath) appendPoint(out, point);
  } else {
    appendPoint(out, fallbackDestination);
  }
  return clampVisualPath(out);
};

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
    (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)
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
      // Per docs/15 §C31: villager caravans (id prefix `villager-`) use a
      // dedicated peasant-farmer-with-handcart glyph so they're visually
      // distinct from long-haul merchant trains.
      const unitKind = String(c.id).startsWith('villager-') ? 'villager_caravan' : 'caravan';
      const sprite = new Sprite(art.unit(unitKind));
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
        displayQ: c.position.q,
        displayR: c.position.r,
        ownerColor: factionColor(c.ownerActor),
        visualHexesPerMs: 0,
      };
      entries.set(c.id, e);
    }
    return e;
  };

  const drawEntryAt = (e: Entry, q: number, r: number, hexSize: number): void => {
    e.displayQ = q;
    e.displayR = r;
    const px = hexToPixel({ q, r }, hexSize);
    e.sprite.position.set(px.x, px.y);
    // Owner-color badge sits just above the caravan (small disc that
    // reads at every zoom level).
    e.badge.clear();
    e.badge
      .circle(0, -SPRITE_PX * 0.55, 2.2)
      .fill({ color: e.ownerColor })
      .stroke({ color: 0x111111, width: 0.4 });
    e.badge.position.set(px.x, px.y);
    const isHi = e.id === highlightedId;
    e.halo.visible = isHi;
    if (isHi) {
      e.halo.clear();
      e.halo.circle(0, 0, SPRITE_PX * 0.7).stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 });
      e.halo.position.set(px.x, px.y);
    }
  };

  const syncTick = (
    world: WorldState,
    pathPerCaravan?: ReadonlyMap<CaravanId, readonly { q: number; r: number }[]>,
    hexSize?: number,
    visualDurationMs = DEFAULT_VISUAL_DURATION_MS,
  ): void => {
    const seen = new Set<CaravanId>();
    for (const c of world.caravans.values()) {
      seen.add(c.id);
      const isNew = !entries.has(c.id);
      const e = ensureEntry(c);
      const sourcePath = pathPerCaravan?.get(c.id);
      const sourceDistance =
        sourcePath !== undefined && sourcePath.length >= 2
          ? pathDistance(sourcePath)
          : hexDistanceFloat({ q: e.curQ, r: e.curR }, c.position);
      if (isNew) {
        e.path = [
          { q: c.position.q, r: c.position.r },
          { q: c.position.q, r: c.position.r },
        ];
        e.visualHexesPerMs = 0;
      } else {
        e.path = extendVisualPath({ q: e.displayQ, r: e.displayR }, e.path, sourcePath, c.position);
        if (sourceDistance > POINT_EPSILON) {
          e.visualHexesPerMs = sourceDistance / Math.max(1, visualDurationMs);
        }
      }
      e.prevQ = e.curQ;
      e.prevR = e.curR;
      e.curQ = c.position.q;
      e.curR = c.position.r;
      e.ownerColor = factionColor(c.ownerActor);
      if (isNew && hexSize !== undefined) {
        drawEntryAt(e, c.position.q, c.position.r, hexSize);
      }
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

  const advanceVisual = (world: WorldState, deltaMs: number, hexSize: number): void => {
    const elapsed = Math.max(0, deltaMs);
    for (const c of world.caravans.values()) {
      const e = entries.get(c.id);
      if (e === undefined) continue;
      let q = e.displayQ;
      let r = e.displayR;
      const remaining = pathDistance(e.path);
      if (remaining > POINT_EPSILON && e.visualHexesPerMs > 0) {
        const maxAdvance = Math.min(
          remaining,
          MAX_VISUAL_HEX_ADVANCE_PER_FRAME,
          e.visualHexesPerMs * elapsed,
        );
        const advanced = advancePath(e.path, maxAdvance);
        if (advanced !== null) {
          q = advanced.point.q;
          r = advanced.point.r;
          e.path = advanced.path;
        }
      } else {
        q = e.curQ;
        r = e.curR;
        e.path = [
          { q, r },
          { q, r },
        ];
        e.visualHexesPerMs = 0;
      }
      drawEntryAt(e, q, r, hexSize);
    }
  };

  const setHighlight = (id: CaravanId | null): void => {
    highlightedId = id;
  };

  return { container, syncTick, advanceVisual, setHighlight };
};
