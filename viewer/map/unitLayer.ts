/**
 * Unified moving-sprite layer — used by every kind of moving entity in
 * the viewer: caravans (merchant, villager, tax, edge-hub), patrols,
 * news carriers, and bandit raid parties.
 *
 * Per docs/16-viewer §"Unit rendering": every visible moving entity
 * follows the same animation contract — a faction-colored badge sits
 * under the sprite, position interpolates smoothly between sim ticks
 * over the tick interval, and a halo highlights the selected entity.
 * Previously caravans had this code (`viewer/map/caravans.ts`) while
 * patrols + news carriers + bandit parties had a simpler stripped-down
 * version (`movers.ts`) that didn't scale visual duration to the tick
 * interval — patrols jumped instead of gliding. This module is the
 * single canonical implementation; the per-unit-type layer files are
 * thin wrappers that just thread an `UnitKind` + a `getEntities`
 * callback through.
 *
 * The animation engine supports two modes:
 *
 *   1. **Path-driven** (caravans): the sim emits the explicit hex path
 *      the unit walked during the day; the sprite follows it segment-
 *      by-segment so multi-hex moves look like continuous travel along
 *      a route.
 *   2. **Straight-line fallback** (patrols, news carriers, bandit
 *      parties): when no explicit path is provided, the layer
 *      interpolates straight from the previous display position to the
 *      new world position. Visually indistinguishable from path mode
 *      for one-hex-per-day movers; for fast movers it's a straight
 *      slide rather than a curved trace, which is fine since these
 *      units don't have planned route data anyway.
 */

import { Container, FederatedPointerEvent, Graphics, Sprite } from 'pixi.js';
import type { Position } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry, UnitKind } from '../art/index.js';

const POINT_EPSILON = 1e-6;
const MAX_VISUAL_PATH_POINTS = 320;
const MAX_VISUAL_HEX_ADVANCE_PER_FRAME = 2;
/** Fallback visual-duration for the paused / no-sim-tick case. */
const DEFAULT_VISUAL_DURATION_MS = 160;

/**
 * The minimal view of a movable sim entity. The unit layer only reads
 * these fields; the wrapper file maps the underlying sim type (Caravan
 * / Patrol / NewsCarrier / BanditParty) into this shape.
 */
export interface UnitView {
  readonly id: string;
  readonly position: Position;
  /**
   * Faction-color key. Hashed to a hue; same string ⇒ same colour.
   * Typically the owning actor's id. Optional — falls back to `id`.
   */
  readonly ownerKey?: string;
  /**
   * Per-unit glyph override — used by the caravan wrapper to pick
   * `villager_caravan` for villager-prefixed caravan ids. Optional;
   * the layer's `defaultUnitKind` is used when this is omitted.
   */
  readonly unitKind?: UnitKind;
}

export interface UnitLayerOpts {
  /** Default art kind used for entities that don't override `unitKind`. */
  readonly defaultUnitKind: UnitKind;
  /** Pull the live entity list out of the world on each `syncTick`. */
  readonly getEntities: (world: WorldState) => Iterable<UnitView>;
  /**
   * Sprite size in pixels at default zoom. Caravans use 20; patrols /
   * news carriers / bandit parties use 18. Tunable per layer.
   */
  readonly spritePx?: number;
  /** Optional click handler. Receives the entity id. */
  readonly onSelect?: (id: string) => void;
  /**
   * Should this layer support a selectable highlight halo? Caravans use
   * this for the "selected caravan" affordance; the others currently
   * don't (no UI flow to select them). Default `false`.
   */
  readonly enableHighlight?: boolean;
}

export interface UnitLayer {
  readonly container: Container;
  /**
   * Snap previous→current positions; called once per sim tick.
   *
   * @param pathPerEntity Optional map of entity-id → planned hex path
   *   that the unit walked during the tick. When provided, the sprite
   *   animates segment-by-segment along the path. When omitted, the
   *   sprite interpolates straight-line from the previous display
   *   position to the new world position.
   * @param visualDurationMs How long the visual interpolation should
   *   take. The caller should pass the sim's current tick interval
   *   (e.g. `caravanVisualDurationMs(state)`) so motion fills the
   *   whole interval; defaults to the paused-state fallback.
   */
  syncTick(
    world: WorldState,
    pathPerEntity?: ReadonlyMap<string, readonly { q: number; r: number }[]>,
    hexSize?: number,
    visualDurationMs?: number,
  ): void;
  /** Advance interpolation by elapsed wall-clock time (per render frame). */
  advanceVisual(world: WorldState, deltaMs: number, hexSize: number): void;
  /** Highlight a specific entity (or `null` to clear). No-op if `enableHighlight` is false. */
  setHighlight(id: string | null): void;
}

// --- Geometry helpers (path-following interpolation) ----------------------

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

// --- Faction-color hashing -------------------------------------------------

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

// --- Entry state -----------------------------------------------------------

interface Entry {
  readonly id: string;
  readonly sprite: Sprite;
  readonly badge: Graphics;
  readonly halo: Graphics;
  /** What unit-kind glyph this entry currently renders. Re-textured if it changes. */
  unitKind: UnitKind;
  displayQ: number;
  displayR: number;
  curQ: number;
  curR: number;
  ownerColor: number;
  visualHexesPerMs: number;
  path?: Point[];
}

// --- Factory ---------------------------------------------------------------

export const createUnitLayer = (art: ArtRegistry, opts: UnitLayerOpts): UnitLayer => {
  const spritePx = opts.spritePx ?? 18;
  const enableHighlight = opts.enableHighlight ?? false;
  const container = new Container();
  container.label = `units-${opts.defaultUnitKind}`;
  const entries = new Map<string, Entry>();
  let highlightedId: string | null = null;

  const ensureEntry = (view: UnitView): Entry => {
    let e = entries.get(view.id);
    if (e !== undefined) return e;
    const halo = new Graphics();
    halo.eventMode = 'none';
    halo.visible = false;
    container.addChild(halo);
    const badge = new Graphics();
    badge.eventMode = 'none';
    container.addChild(badge);
    const unitKind = view.unitKind ?? opts.defaultUnitKind;
    const sprite = new Sprite(art.unit(unitKind));
    sprite.anchor.set(0.5, 0.5);
    sprite.width = spritePx;
    sprite.height = spritePx;
    if (opts.onSelect !== undefined) {
      sprite.eventMode = 'static';
      sprite.cursor = 'pointer';
      sprite.on('pointerdown', (ev: FederatedPointerEvent) => {
        ev.stopPropagation();
        opts.onSelect?.(view.id);
      });
      const r = spritePx * 0.5;
      sprite.hitArea = { contains: (x: number, y: number) => x * x + y * y <= r * r };
    } else {
      sprite.eventMode = 'none';
    }
    container.addChild(sprite);
    e = {
      id: view.id,
      sprite,
      badge,
      halo,
      unitKind,
      curQ: view.position.q,
      curR: view.position.r,
      displayQ: view.position.q,
      displayR: view.position.r,
      ownerColor: factionColor(view.ownerKey ?? view.id),
      visualHexesPerMs: 0,
    };
    entries.set(view.id, e);
    return e;
  };

  const drawAt = (e: Entry, q: number, r: number, hexSize: number): void => {
    e.displayQ = q;
    e.displayR = r;
    const px = hexToPixel({ q, r }, hexSize);
    e.sprite.position.set(px.x, px.y);
    e.badge.clear();
    e.badge
      .circle(0, -spritePx * 0.55, Math.max(1.8, spritePx * 0.11))
      .fill({ color: e.ownerColor })
      .stroke({ color: 0x111111, width: 0.4 });
    e.badge.position.set(px.x, px.y);
    const isHi = enableHighlight && e.id === highlightedId;
    e.halo.visible = isHi;
    if (isHi) {
      e.halo.clear();
      e.halo.circle(0, 0, spritePx * 0.7).stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 });
      e.halo.position.set(px.x, px.y);
    }
  };

  const syncTick = (
    world: WorldState,
    pathPerEntity?: ReadonlyMap<string, readonly { q: number; r: number }[]>,
    hexSize?: number,
    visualDurationMs: number = DEFAULT_VISUAL_DURATION_MS,
  ): void => {
    const seen = new Set<string>();
    for (const view of opts.getEntities(world)) {
      seen.add(view.id);
      const isNew = !entries.has(view.id);
      const e = ensureEntry(view);
      // Swap glyph if the entity's preferred unit kind changed (e.g.
      // viewer types unified across caravan sub-kinds).
      const wantedKind = view.unitKind ?? opts.defaultUnitKind;
      if (wantedKind !== e.unitKind) {
        e.sprite.texture = art.unit(wantedKind);
        e.unitKind = wantedKind;
      }
      const sourcePath = pathPerEntity?.get(view.id);
      const sourceDistance =
        sourcePath !== undefined && sourcePath.length >= 2
          ? pathDistance(sourcePath)
          : hexDistanceFloat({ q: e.curQ, r: e.curR }, view.position);
      if (isNew) {
        e.path = [
          { q: view.position.q, r: view.position.r },
          { q: view.position.q, r: view.position.r },
        ];
        e.visualHexesPerMs = 0;
      } else {
        e.path = extendVisualPath(
          { q: e.displayQ, r: e.displayR },
          e.path,
          sourcePath,
          view.position,
        );
        if (sourceDistance > POINT_EPSILON) {
          e.visualHexesPerMs = sourceDistance / Math.max(1, visualDurationMs);
        }
      }
      e.curQ = view.position.q;
      e.curR = view.position.r;
      e.ownerColor = factionColor(view.ownerKey ?? view.id);
      if (isNew && hexSize !== undefined) {
        drawAt(e, view.position.q, view.position.r, hexSize);
      }
    }
    for (const [id, e] of entries) {
      if (seen.has(id)) continue;
      container.removeChild(e.sprite);
      container.removeChild(e.badge);
      container.removeChild(e.halo);
      e.sprite.destroy();
      e.badge.destroy();
      e.halo.destroy();
      entries.delete(id);
    }
  };

  const advanceVisual = (world: WorldState, deltaMs: number, hexSize: number): void => {
    void world;
    const elapsed = Math.max(0, deltaMs);
    for (const e of entries.values()) {
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
      drawAt(e, q, r, hexSize);
    }
  };

  const setHighlight = (id: string | null): void => {
    if (!enableHighlight) return;
    highlightedId = id;
  };

  return { container, syncTick, advanceVisual, setHighlight };
};
