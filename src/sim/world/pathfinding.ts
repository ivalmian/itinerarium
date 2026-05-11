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
    return base * ROAD_DISCOUNT.none * offRoadLoad;
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
      return 4 - 0.5 * (1 - loadFraction);
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
    return (base / 5) * loadFactor;
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

// ---------------------------------------------------------------------------
// Min-heap (binary heap) for A* open set
// ---------------------------------------------------------------------------

interface HeapEntry {
  readonly key: number;
  readonly hex: Hex;
  readonly priority: number;
  // Tie-breaker: insertion order. Keeps results deterministic when multiple
  // entries share an f-score (otherwise heap-internal ordering varies).
  readonly seq: number;
}

class MinHeap {
  private readonly data: HeapEntry[] = [];

  size(): number {
    return this.data.length;
  }

  push(entry: HeapEntry): void {
    this.data.push(entry);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0] as HeapEntry;
    const last = this.data.pop() as HeapEntry;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private less(a: HeapEntry, b: HeapEntry): boolean {
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.seq < b.seq;
  }

  private bubbleUp(i: number): void {
    const item = this.data[i] as HeapEntry;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = this.data[parent] as HeapEntry;
      if (this.less(item, p)) {
        this.data[i] = p;
        i = parent;
      } else {
        break;
      }
    }
    this.data[i] = item;
  }

  private sinkDown(i: number): void {
    const item = this.data[i] as HeapEntry;
    const n = this.data.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      let smallestEntry = item;
      if (left < n) {
        const l = this.data[left] as HeapEntry;
        if (this.less(l, smallestEntry)) {
          smallest = left;
          smallestEntry = l;
        }
      }
      if (right < n) {
        const r = this.data[right] as HeapEntry;
        if (this.less(r, smallestEntry)) {
          smallest = right;
          smallestEntry = r;
        }
      }
      if (smallest === i) break;
      this.data[i] = smallestEntry;
      i = smallest;
    }
    this.data[i] = item;
  }
}

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

  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, Hex>();
  const closed = new Set<number>();
  const open = new MinHeap();
  let seq = 0;

  gScore.set(startKey, 0);
  open.push({
    key: startKey,
    hex: start,
    priority: hexDistance(start, goal) * MIN_STEP_COST,
    seq: seq++,
  });

  while (open.size() > 0) {
    const current = open.pop() as HeapEntry;
    if (closed.has(current.key)) continue;
    closed.add(current.key);

    if (current.key === goalKey) {
      return reconstruct(cameFrom, goal, gScore.get(goalKey) ?? Infinity);
    }

    const currentHex = current.hex;
    const currentG = gScore.get(current.key) ?? Infinity;

    for (const dir of HEX_DIRECTIONS) {
      const nq = currentHex.q + dir.q;
      const nr = currentHex.r + dir.r;
      const nKey = coordKey(nq, nr);
      if (closed.has(nKey)) continue;
      const tile = grid.getAt(nq, nr);
      if (tile === undefined) continue;
      const stepCost = profile.costFor(tile.terrain, tile.road, season, loadFraction);
      if (!Number.isFinite(stepCost)) continue;
      const tentative = currentG + stepCost;
      const existing = gScore.get(nKey);
      if (existing !== undefined && tentative >= existing) continue;
      const neighbor = { q: nq, r: nr };
      gScore.set(nKey, tentative);
      cameFrom.set(nKey, currentHex);
      const f = tentative + hexDistance(neighbor, goal) * MIN_STEP_COST;
      open.push({ key: nKey, hex: neighbor, priority: f, seq: seq++ });
    }
  }

  return { path: [], totalCost: Infinity };
};

const reconstruct = (
  cameFrom: ReadonlyMap<number, Hex>,
  goal: Hex,
  totalCost: number,
): PathResult => {
  const path: Hex[] = [goal];
  let current: Hex | undefined = goal;
  for (;;) {
    const key = coordKey(current.q, current.r);
    const prev = cameFrom.get(key);
    if (prev === undefined) break;
    path.push(prev);
    current = prev;
  }
  path.reverse();
  return { path, totalCost };
};
