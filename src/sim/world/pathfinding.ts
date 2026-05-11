/**
 * A* pathfinding on the hex grid.
 *
 * Used by caravans, migration columns, news carriers, and patrols. The cost
 * model is a MovementProfile: a function over (terrain, road, season,
 * loadFraction) that returns MP cost per hex (or Infinity if impassable).
 *
 * Reference movement table: docs/06-caravans.md.
 *
 * The heuristic is hexDistance × MIN_STEP_COST, where MIN_STEP_COST is the
 * cheapest possible per-hex cost across all profiles defined here (Roman
 * road, light load, summer, plains). Keeping the heuristic admissible is
 * what makes A* return optimal paths; if a future profile cheats the floor
 * lower than 1, drop MIN_STEP_COST accordingly.
 */

import { HEX_DIRECTIONS, hexDistance } from './hex.js';
import type { Hex } from './hex.js';
import type { HexGrid } from './grid.js';
import type { RoadGrade, Season, Terrain } from './terrain.js';

export interface MovementProfile {
  /**
   * Cost in movement points to ENTER the given hex.
   * Returns Infinity if entering is impossible (lake, closed pass, etc.).
   *
   * @param loadFraction 0..1; share of carry capacity in use. Heavier loads
   *   move slower on rough terrain.
   */
  costFor(terrain: Terrain, road: RoadGrade, season: Season, loadFraction: number): number;
}

export interface PathResult {
  /** Hexes from start to goal inclusive; empty if unreachable. */
  path: readonly Hex[];
  /** Sum of step costs into each hex after the start; Infinity if unreachable. */
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Movement profiles
// ---------------------------------------------------------------------------

const ABSOLUTELY_IMPASSABLE: ReadonlySet<Terrain> = new Set<Terrain>(['lake']);

const isMountainPassClosed = (t: Terrain, season: Season): boolean =>
  t === 'mountains' && season === 'winter';

const isMarshFlooded = (t: Terrain, season: Season): boolean =>
  t === 'marsh' && season === 'spring';

/** Base cost for a pack-animal caravan walking the given terrain off-road. */
const muleBaseCost = (t: Terrain): number => {
  switch (t) {
    case 'plains':
    case 'fertile_valley':
    case 'urban':
    case 'steppe':
      return 2.5;
    case 'hills':
      return 3.5;
    case 'desert':
      return 3.5;
    case 'forest':
      return 4;
    case 'dense_forest':
      return 6;
    case 'marsh':
      return 5;
    case 'mountains':
      return 8;
    case 'river':
      return 5;
    case 'ruin':
      return 3;
    case 'lake':
      return Infinity;
  }
};

const ROAD_DISCOUNT: Record<RoadGrade, number> = {
  none: 1,
  dirt: 0.5,
  roman: 0.4,
};

const OFF_ROAD_COST_MULTIPLIER = 2;

/**
 * Pack-mule caravan. Costs are calibrated so loadFraction=1 (fully laden)
 * matches the docs/06 reference: 1 MP/hex on Roman road = 25 km/day. Lighter
 * loads pay a small discount, mostly off-road where weight matters most.
 */
export const LADEN_MULE_PROFILE: MovementProfile = {
  costFor(terrain, road, season, loadFraction) {
    if (ABSOLUTELY_IMPASSABLE.has(terrain)) return Infinity;
    if (isMountainPassClosed(terrain, season)) return Infinity;
    if (isMarshFlooded(terrain, season)) return Infinity;
    const base = muleBaseCost(terrain);
    if (!Number.isFinite(base)) return Infinity;
    const loadDiscount = 1 - 0.1 * (1 - loadFraction);
    if (road === 'roman') return 1 * loadDiscount;
    if (road === 'dirt') return 1.25 * loadDiscount;
    // Off-road: terrain-dependent and more load-sensitive.
    const offRoadLoad = 1 - 0.25 * (1 - loadFraction);
    return base * ROAD_DISCOUNT.none * OFF_ROAD_COST_MULTIPLIER * offRoadLoad;
  },
};

/**
 * Heavy ox-drawn wagon, road-bound. ~12 km/day laden on Roman road per
 * docs/06; wagons can't take rough terrain at all.
 */
export const HEAVY_WAGON_PROFILE: MovementProfile = {
  costFor(terrain, road, season, loadFraction) {
    if (ABSOLUTELY_IMPASSABLE.has(terrain)) return Infinity;
    if (isMountainPassClosed(terrain, season)) return Infinity;
    if (isMarshFlooded(terrain, season)) return Infinity;
    if (terrain === 'mountains') return Infinity;
    if (road === 'none') {
      // Wagons can creep through urban / ruin hexes (paved courtyards, old
      // streets) without a graded road; everywhere else off-road is dead.
      if (terrain !== 'urban' && terrain !== 'ruin') return Infinity;
      return (4 - 0.5 * (1 - loadFraction)) * OFF_ROAD_COST_MULTIPLIER;
    }
    const loadDiscount = 1 - 0.15 * (1 - loadFraction);
    if (road === 'roman') return 2 * loadDiscount;
    return 3 * loadDiscount;
  },
};

/** Express courier with horse relays — ~150 km/day on Roman road. */
export const COURIER_PROFILE: MovementProfile = {
  costFor(terrain, road, season, loadFraction) {
    if (ABSOLUTELY_IMPASSABLE.has(terrain)) return Infinity;
    if (isMountainPassClosed(terrain, season)) return Infinity;
    if (isMarshFlooded(terrain, season)) return Infinity;
    const base = muleBaseCost(terrain);
    if (!Number.isFinite(base)) return Infinity;
    // 6x faster than a laden mule on a Roman road, hardly affected by load.
    const loadFactor = 1 + 0.05 * loadFraction;
    if (road === 'roman') return (1 / 6) * loadFactor;
    if (road === 'dirt') return (1 / 3) * loadFactor;
    return ((base * OFF_ROAD_COST_MULTIPLIER) / 5) * loadFactor;
  },
};

// Cheapest possible step cost across the profiles above. Used as the
// admissibility floor for the A* heuristic. Lowering this keeps the
// heuristic admissible; raising it would risk returning sub-optimal paths.
const MIN_STEP_COST = 1 / 6;

const COORD_KEY_OFFSET = 32768;
const COORD_KEY_STRIDE = 65536;

const coordKey = (q: number, r: number): number =>
  (q + COORD_KEY_OFFSET) * COORD_KEY_STRIDE + (r + COORD_KEY_OFFSET);

const coordQ = (key: number): number => Math.floor(key / COORD_KEY_STRIDE) - COORD_KEY_OFFSET;
const coordR = (key: number): number => (key % COORD_KEY_STRIDE) - COORD_KEY_OFFSET;

const hexDistanceAt = (aq: number, ar: number, bq: number, br: number): number => {
  const dq = aq - bq;
  const dr = ar - br;
  const ds = -dq - dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
};

// ---------------------------------------------------------------------------
// Min-heap (binary heap) for A* open set
// ---------------------------------------------------------------------------

class MinHeap {
  private readonly keys: number[] = [];
  private readonly priorities: number[] = [];
  private readonly seqs: number[] = [];
  private length = 0;

  clear(): void {
    this.length = 0;
    this.keys.length = 0;
    this.priorities.length = 0;
    this.seqs.length = 0;
  }

  size(): number {
    return this.length;
  }

  push(key: number, priority: number, seq: number): void {
    let i = this.length++;
    this.keys[i] = key;
    this.priorities[i] = priority;
    this.seqs[i] = seq;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): number | undefined {
    if (this.length === 0) return undefined;
    const top = this.keys[0] as number;
    this.length--;
    if (this.length > 0) {
      this.keys[0] = this.keys[this.length] as number;
      this.priorities[0] = this.priorities[this.length] as number;
      this.seqs[0] = this.seqs[this.length] as number;
      this.sinkDown(0);
    }
    this.keys.length = this.length;
    this.priorities.length = this.length;
    this.seqs.length = this.length;
    return top;
  }

  private less(a: number, b: number): boolean {
    const aPriority = this.priorities[a] as number;
    const bPriority = this.priorities[b] as number;
    if (aPriority !== bPriority) return aPriority < bPriority;
    return (this.seqs[a] as number) < (this.seqs[b] as number);
  }

  private swap(a: number, b: number): void {
    const key = this.keys[a] as number;
    const priority = this.priorities[a] as number;
    const seq = this.seqs[a] as number;
    this.keys[a] = this.keys[b] as number;
    this.priorities[a] = this.priorities[b] as number;
    this.seqs[a] = this.seqs[b] as number;
    this.keys[b] = key;
    this.priorities[b] = priority;
    this.seqs[b] = seq;
  }

  private sinkDown(i: number): void {
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < this.length && this.less(left, smallest)) {
        smallest = left;
      }
      if (right < this.length && this.less(right, smallest)) {
        smallest = right;
      }
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }
}

class PathWorkspace {
  readonly gScore = new Map<number, number>();
  readonly cameFrom = new Map<number, number>();
  readonly closed = new Set<number>();
  readonly open = new MinHeap();

  reset(): void {
    this.gScore.clear();
    this.cameFrom.clear();
    this.closed.clear();
    this.open.clear();
  }
}

const pathWorkspace = new PathWorkspace();

// ---------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------

export const findPath = (
  grid: HexGrid,
  start: Hex,
  goal: Hex,
  profile: MovementProfile,
  season: Season,
  loadFraction: number,
): PathResult => {
  if (!grid.hasAt(start.q, start.r) || !grid.hasAt(goal.q, goal.r)) {
    return { path: [], totalCost: Infinity };
  }
  const startKey = coordKey(start.q, start.r);
  const goalKey = coordKey(goal.q, goal.r);
  if (start.q === goal.q && start.r === goal.r) {
    return { path: [start], totalCost: 0 };
  }

  pathWorkspace.reset();
  const { gScore, cameFrom, closed, open } = pathWorkspace;
  let seq = 0;

  gScore.set(startKey, 0);
  open.push(startKey, hexDistance(start, goal) * MIN_STEP_COST, seq++);

  while (open.size() > 0) {
    const currentKey = open.pop() as number;
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);

    if (currentKey === goalKey) {
      return reconstruct(cameFrom, goalKey, gScore.get(goalKey) ?? Infinity);
    }

    const currentQ = coordQ(currentKey);
    const currentR = coordR(currentKey);
    const currentG = gScore.get(currentKey) ?? Infinity;

    for (const dir of HEX_DIRECTIONS) {
      const nq = currentQ + dir.q;
      const nr = currentR + dir.r;
      const nKey = coordKey(nq, nr);
      if (closed.has(nKey)) continue;
      const tile = grid.getAt(nq, nr);
      if (tile === undefined) continue;
      const stepCost = profile.costFor(tile.terrain, tile.road, season, loadFraction);
      if (!Number.isFinite(stepCost)) continue;
      const tentative = currentG + stepCost;
      const existing = gScore.get(nKey);
      if (existing !== undefined && tentative >= existing) continue;
      gScore.set(nKey, tentative);
      cameFrom.set(nKey, currentKey);
      const f = tentative + hexDistanceAt(nq, nr, goal.q, goal.r) * MIN_STEP_COST;
      open.push(nKey, f, seq++);
    }
  }

  return { path: [], totalCost: Infinity };
};

const reconstruct = (
  cameFrom: ReadonlyMap<number, number>,
  goalKey: number,
  totalCost: number,
): PathResult => {
  const pathKeys: number[] = [goalKey];
  let currentKey = goalKey;
  for (;;) {
    const prev = cameFrom.get(currentKey);
    if (prev === undefined) break;
    pathKeys.push(prev);
    currentKey = prev;
  }
  const path: Hex[] = [];
  for (let i = pathKeys.length - 1; i >= 0; i--) {
    const key = pathKeys[i] as number;
    path.push({ q: coordQ(key), r: coordR(key) });
  }
  return { path, totalCost };
};
