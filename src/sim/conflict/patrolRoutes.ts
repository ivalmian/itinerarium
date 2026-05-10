/**
 * Road-aware patrol route generator.
 *
 * Replaces the naive `defaultPatrolRoute` (anchor + urban hexes in input
 * order) used as a placeholder while the road network was in flight. With
 * roads now landed (T25), patrols can walk meaningful loops along the
 * actual road graph: garrisons travel the Roman arterials, city watch
 * stays on local dirt streets, family guards work private estate paths.
 *
 * Algorithm:
 *   1. BFS outward from the settlement anchor over hexes whose road grade
 *      matches the caller's preference (`roman`, `dirt`, or `any` =
 *      passable land).
 *   2. From the BFS frontier, pick a small number of representative
 *      "outer" waypoints — hexes near the requested radius, spread out by
 *      direction so the patrol covers several arms of the road network
 *      rather than walking the same spoke repeatedly.
 *   3. Stitch a cyclic loop: anchor → waypoint A → waypoint B → ... →
 *      anchor, with each segment routed by `findPath` so the result hugs
 *      the existing road network.
 *   4. If we can't find any valid waypoints (no nearby roads, or BFS
 *      yielded nothing), fall back to `defaultPatrolRoute`.
 *
 * Determinism: BFS visits neighbours in the canonical HEX_DIRECTIONS
 * order (defined in `world/hex.ts`); waypoints are picked in deterministic
 * order from the BFS frontier sorted by `hexKey`. Same inputs → same
 * route every time.
 */

import { findPath, type MovementProfile } from '../world/pathfinding.js';
import type { HexGrid } from '../world/grid.js';
import { hexEquals, hexKey, hexNeighbors, type Hex } from '../world/hex.js';
import { isPassable, type RoadGrade, type Season, type Terrain } from '../world/terrain.js';
import type { Settlement } from '../world/settlement.js';
import { defaultPatrolRoute } from './patrol.js';

export type RoadGradePreference = 'roman' | 'dirt' | 'any';

export interface PatrolRouteOpts {
  readonly basedAt: Settlement;
  readonly grid: HexGrid;
  readonly radiusHexes: number;
  readonly preferRoadGrade: RoadGradePreference;
}

const FIXED_SEASON: Season = 'summer';

const acceptsHex = (road: RoadGrade, terrain: Terrain, pref: RoadGradePreference): boolean => {
  if (!isPassable(terrain, FIXED_SEASON)) return false;
  switch (pref) {
    case 'roman':
      return road === 'roman';
    case 'dirt':
      return road === 'dirt' || road === 'roman';
    case 'any':
      return true;
  }
};

/**
 * BFS along acceptable hexes from the anchor; returns visited hexes paired
 * with their hop-distance from the anchor. Bounded by `maxHops` so it stays
 * cheap on large maps.
 */
const bfsOutward = (
  grid: HexGrid,
  anchor: Hex,
  maxHops: number,
  pref: RoadGradePreference,
): Map<string, { hex: Hex; dist: number }> => {
  const visited = new Map<string, { hex: Hex; dist: number }>();
  const queue: { hex: Hex; dist: number }[] = [];
  visited.set(hexKey(anchor), { hex: anchor, dist: 0 });
  queue.push({ hex: anchor, dist: 0 });
  while (queue.length > 0) {
    const { hex: cur, dist } = queue.shift() as { hex: Hex; dist: number };
    if (dist >= maxHops) continue;
    for (const n of hexNeighbors(cur)) {
      const k = hexKey(n);
      if (visited.has(k)) continue;
      const t = grid.get(n);
      if (t === undefined) continue;
      if (!acceptsHex(t.road, t.terrain, pref)) continue;
      visited.set(k, { hex: n, dist: dist + 1 });
      queue.push({ hex: n, dist: dist + 1 });
    }
  }
  return visited;
};

/**
 * Pick up to `count` waypoints from the BFS frontier. Aim for hexes near
 * `radiusHexes` from the anchor, but spread by *direction* (atan2 angle)
 * so the loop covers different arms of the road network rather than three
 * waypoints on the same spoke.
 */
const pickWaypoints = (
  visited: ReadonlyMap<string, { hex: Hex; dist: number }>,
  anchor: Hex,
  radius: number,
  count: number,
): Hex[] => {
  // Convert to Cartesian for a stable angular sort.
  // Using axial-to-2d: x = q + r/2, y = r (close enough for a uniform spread).
  const cands: { hex: Hex; dist: number; angle: number }[] = [];
  for (const v of visited.values()) {
    if (v.dist === 0) continue;
    if (v.dist > radius) continue;
    const dq = v.hex.q - anchor.q;
    const dr = v.hex.r - anchor.r;
    const x = dq + dr / 2;
    const y = dr;
    cands.push({ hex: v.hex, dist: v.dist, angle: Math.atan2(y, x) });
  }
  if (cands.length === 0) return [];

  // Prefer the farthest candidates first (they cover the most map). Among
  // equal distances, deterministic by hexKey.
  cands.sort((a, b) => {
    if (a.dist !== b.dist) return b.dist - a.dist;
    const ka = hexKey(a.hex);
    const kb = hexKey(b.hex);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const picked: { hex: Hex; angle: number }[] = [];
  const minAngularSpread = (Math.PI * 2) / Math.max(2, count) - 0.01;
  for (const c of cands) {
    if (picked.length >= count) break;
    let ok = true;
    for (const p of picked) {
      let diff = Math.abs(c.angle - p.angle);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff < minAngularSpread) {
        ok = false;
        break;
      }
    }
    if (ok) picked.push({ hex: c.hex, angle: c.angle });
  }

  // Fall back: if angular filter rejected everything but the farthest,
  // accept additional waypoints by closer distance regardless of angle so
  // the patrol still has more than one stop.
  if (picked.length < Math.min(count, cands.length)) {
    for (const c of cands) {
      if (picked.length >= count) break;
      if (picked.some((p) => hexEquals(p.hex, c.hex))) continue;
      picked.push({ hex: c.hex, angle: c.angle });
    }
  }

  // Sort the picked waypoints by their angle so the patrol walks them in a
  // ring-like order rather than zigzagging across the network.
  picked.sort((a, b) => a.angle - b.angle);
  return picked.map((p) => p.hex);
};

const ROUTE_PROFILE: MovementProfile = {
  costFor(terrain: Terrain, road: RoadGrade, _season: Season, _loadFraction: number): number {
    if (!isPassable(terrain, FIXED_SEASON)) return Infinity;
    if (road === 'roman') return 1;
    if (road === 'dirt') return 1.3;
    switch (terrain) {
      case 'plains':
      case 'fertile_valley':
      case 'urban':
      case 'ruin':
      case 'coast':
      case 'steppe':
        return 2;
      case 'hills':
        return 3;
      case 'desert':
        return 3.5;
      case 'forest':
        return 3;
      case 'dense_forest':
        return 5;
      case 'river':
        return 4;
      case 'marsh':
        return 6;
      case 'mountains':
        return 6;
      case 'lake':
        return Infinity;
    }
  },
};

/**
 * Stitch a cyclic loop through the given waypoints, routing each segment
 * by A* under ROUTE_PROFILE. Drops duplicate intermediate hexes; the
 * anchor appears at start and end.
 */
const stitchLoop = (grid: HexGrid, anchor: Hex, waypoints: readonly Hex[]): Hex[] => {
  if (waypoints.length === 0) return [anchor];
  const out: Hex[] = [];
  const seen = new Set<string>();
  const pushUnique = (h: Hex): void => {
    const k = hexKey(h);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(h);
  };
  pushUnique(anchor);
  const order: Hex[] = [...waypoints, anchor];
  let cursor = anchor;
  for (const next of order) {
    const result = findPath(grid, cursor, next, ROUTE_PROFILE, FIXED_SEASON, 0);
    if (result.path.length === 0) {
      // Unreachable waypoint; skip it.
      continue;
    }
    // path[0] equals cursor, which is already in `out`; iterate from 1.
    for (let i = 1; i < result.path.length; i++) {
      const step = result.path[i] as Hex;
      pushUnique(step);
    }
    cursor = next;
  }
  // Ensure cyclic closure: if the last step isn't the anchor, append it.
  const last = out[out.length - 1];
  if (last === undefined || !hexEquals(last, anchor)) {
    out.push(anchor);
  } else if (out.length > 1 && hexEquals(last, anchor)) {
    // Already closed; nothing to do.
  }
  return out;
};

export const generateRoadPatrolRoute = (opts: PatrolRouteOpts): readonly Hex[] => {
  const { basedAt, grid, radiusHexes, preferRoadGrade } = opts;
  const anchor = basedAt.anchor;
  const radius = Math.max(1, Math.floor(radiusHexes));

  const visited = bfsOutward(grid, anchor, radius, preferRoadGrade);
  // Need at least one outer hex (BFS dist > 0) to build a meaningful route.
  let hasOuter = false;
  for (const v of visited.values()) {
    if (v.dist > 0) {
      hasOuter = true;
      break;
    }
  }
  if (!hasOuter) {
    // No nearby roads / passable terrain matching preference — fall back.
    return defaultPatrolRoute({
      anchor,
      urbanHexes: basedAt.urbanHexes,
    });
  }

  const waypoints = pickWaypoints(visited, anchor, radius, 3);
  if (waypoints.length === 0) {
    return defaultPatrolRoute({
      anchor,
      urbanHexes: basedAt.urbanHexes,
    });
  }
  return stitchLoop(grid, anchor, waypoints);
};

// ----- Convenience presets per docs/12 patrol kinds ------------------------

const GARRISON_RADIUS = 30;
const CITY_WATCH_RADIUS = 5;
const FAMILY_GUARD_RADIUS = 15;

export const routeForGarrisonPatrol = (basedAt: Settlement, grid: HexGrid): readonly Hex[] =>
  generateRoadPatrolRoute({
    basedAt,
    grid,
    radiusHexes: GARRISON_RADIUS,
    // 'any' covers passable terrain so the garrison still gets a real loop
    // even before procgen lays down Roman roads. Without this fallback, the
    // BFS finds nothing and patrols collapse to a tiny urban loop.
    preferRoadGrade: 'any',
  });

export const routeForCityWatch = (basedAt: Settlement, grid: HexGrid): readonly Hex[] =>
  generateRoadPatrolRoute({
    basedAt,
    grid,
    radiusHexes: CITY_WATCH_RADIUS,
    preferRoadGrade: 'any',
  });

export const routeForFamilyGuard = (basedAt: Settlement, grid: HexGrid): readonly Hex[] =>
  generateRoadPatrolRoute({
    basedAt,
    grid,
    radiusHexes: FAMILY_GUARD_RADIUS,
    preferRoadGrade: 'any',
  });
