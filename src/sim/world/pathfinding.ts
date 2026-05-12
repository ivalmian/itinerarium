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

import type { Hex } from './hex.js';
import type { HexGrid } from './grid.js';
import { TERRAIN_TYPES, type RoadGrade, type Season, type Terrain } from './terrain.js';
import * as wasmPathfinding from '../../wasm/pathfinding.js';

export interface MovementProfile {
  /**
   * Cost in movement points to ENTER the given hex.
   * Returns Infinity if entering is impossible (lake, closed pass, etc.).
   *
   * @param loadFraction 0..1; share of carry capacity in use. Heavier loads
   *   move slower on rough terrain.
   */
  costFor(terrain: Terrain, road: RoadGrade, season: Season, loadFraction: number): number;
  /**
   * Optional fast-path table used by the AssemblyScript A* implementation.
   * The table is ordered by terrain-major, road-minor entries matching
   * `terrainRoadCostIndex`.
   */
  pathfindingCostTable?(season: Season, loadFraction: number): ArrayLike<number>;
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

const ROAD_GRADES = ['none', 'dirt', 'roman'] as const satisfies readonly RoadGrade[];
const ROAD_COUNT = ROAD_GRADES.length;
const TERRAIN_ROAD_COST_COUNT = 13 * ROAD_COUNT;

const COORD_KEY_OFFSET = 32768;

const coordKey = (q: number, r: number): number =>
  (((q + COORD_KEY_OFFSET) << 16) | (r + COORD_KEY_OFFSET)) >>> 0;

const coordQ = (key: number): number => (key >>> 16) - COORD_KEY_OFFSET;
const coordR = (key: number): number => (key & 0xffff) - COORD_KEY_OFFSET;

const hexDistanceAt = (aq: number, ar: number, bq: number, br: number): number => {
  const dq = aq - bq;
  const dr = ar - br;
  const ds = -dq - dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
};

const roadCostIndex = (road: RoadGrade): number => {
  switch (road) {
    case 'none':
      return 0;
    case 'dirt':
      return 1;
    case 'roman':
      return 2;
  }
};

const terrainRoadCostIndex = (terrain: Terrain, road: RoadGrade): number => {
  const roadIndex = roadCostIndex(road);
  switch (terrain) {
    case 'plains':
      return roadIndex;
    case 'fertile_valley':
      return ROAD_COUNT + roadIndex;
    case 'hills':
      return ROAD_COUNT * 2 + roadIndex;
    case 'mountains':
      return ROAD_COUNT * 3 + roadIndex;
    case 'forest':
      return ROAD_COUNT * 4 + roadIndex;
    case 'dense_forest':
      return ROAD_COUNT * 5 + roadIndex;
    case 'marsh':
      return ROAD_COUNT * 6 + roadIndex;
    case 'desert':
      return ROAD_COUNT * 7 + roadIndex;
    case 'steppe':
      return ROAD_COUNT * 8 + roadIndex;
    case 'river':
      return ROAD_COUNT * 9 + roadIndex;
    case 'lake':
      return ROAD_COUNT * 10 + roadIndex;
    case 'urban':
      return ROAD_COUNT * 11 + roadIndex;
    case 'ruin':
      return ROAD_COUNT * 12 + roadIndex;
  }
};

export const profileWithPathfindingCostTable = <T extends MovementProfile>(profile: T): T => {
  if (profile.pathfindingCostTable !== undefined) return profile;
  const cache = new Map<string, Float64Array>();
  Object.defineProperty(profile, 'pathfindingCostTable', {
    enumerable: false,
    value(season: Season, loadFraction: number): ArrayLike<number> {
      const key = `${season}|${loadFraction}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const table = new Float64Array(TERRAIN_ROAD_COST_COUNT);
      for (const terrain of TERRAIN_TYPES) {
        for (const road of ROAD_GRADES) {
          table[terrainRoadCostIndex(terrain, road)] = profile.costFor(
            terrain,
            road,
            season,
            loadFraction,
          );
        }
      }
      cache.set(key, table);
      return table;
    },
  });
  return profile;
};

profileWithPathfindingCostTable(LADEN_MULE_PROFILE);
profileWithPathfindingCostTable(HEAVY_WAGON_PROFILE);
profileWithPathfindingCostTable(COURIER_PROFILE);

// ---------------------------------------------------------------------------
// Min-heap (binary heap) for A* open set
// ---------------------------------------------------------------------------

class MinHeap {
  private keys = new Int32Array(1024);
  private priorities = new Float64Array(1024);
  private seqs = new Uint32Array(1024);
  private length = 0;

  clear(): void {
    this.length = 0;
  }

  size(): number {
    return this.length;
  }

  push(key: number, priority: number, seq: number): void {
    this.ensureCapacity(this.length + 1);
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
    const top = this.keys[0];
    this.length--;
    if (this.length > 0) {
      this.keys[0] = this.keys[this.length] as number;
      this.priorities[0] = this.priorities[this.length] as number;
      this.seqs[0] = this.seqs[this.length] as number;
      this.sinkDown(0);
    }
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

  private ensureCapacity(size: number): void {
    if (this.keys.length >= size) return;
    const capacity = Math.max(size, this.keys.length * 2);
    const keys = new Int32Array(capacity);
    keys.set(this.keys.subarray(0, this.length));
    this.keys = keys;
    const priorities = new Float64Array(capacity);
    priorities.set(this.priorities.subarray(0, this.length));
    this.priorities = priorities;
    const seqs = new Uint32Array(capacity);
    seqs.set(this.seqs.subarray(0, this.length));
    this.seqs = seqs;
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
  readonly open = new MinHeap();
  readonly stepCostCache = new Array<number>(TERRAIN_ROAD_COST_COUNT);
  private gScore = new Float64Array(0);
  private cameFrom = new Int32Array(0);
  private gScoreStamp = new Uint32Array(0);
  private closedStamp = new Uint32Array(0);
  private searchId = 0;

  reset(size: number): void {
    this.ensureCapacity(size);
    this.searchId++;
    if (this.searchId === 0xffffffff) {
      this.gScoreStamp.fill(0);
      this.closedStamp.fill(0);
      this.searchId = 1;
    }
    this.open.clear();
    this.stepCostCache.fill(Number.NaN);
  }

  hasClosed(index: number): boolean {
    return this.closedStamp[index] === this.searchId;
  }

  close(index: number): void {
    this.closedStamp[index] = this.searchId;
  }

  getScore(index: number): number | undefined {
    return this.gScoreStamp[index] === this.searchId ? this.gScore[index] : undefined;
  }

  setScore(index: number, score: number): void {
    this.gScoreStamp[index] = this.searchId;
    this.gScore[index] = score;
  }

  setCameFrom(index: number, previousIndex: number): void {
    this.cameFrom[index] = previousIndex;
  }

  previousIndex(index: number): number {
    return this.cameFrom[index] as number;
  }

  private ensureCapacity(size: number): void {
    if (this.gScore.length >= size) return;
    const capacity = Math.max(size, this.gScore.length * 2, 1024);
    this.gScore = new Float64Array(capacity);
    this.cameFrom = new Int32Array(capacity);
    this.gScoreStamp = new Uint32Array(capacity);
    this.closedStamp = new Uint32Array(capacity);
  }
}

const pathWorkspace = new PathWorkspace();

// ---------------------------------------------------------------------------
// AssemblyScript A* bridge
// ---------------------------------------------------------------------------

interface PackedGridForPathfinding {
  readonly coordKeys: Uint32Array;
  readonly neighborStarts: Int32Array;
  readonly neighborIndices: Int32Array;
  readonly edgeCount: number;
  readonly tileCount: number;
  readonly gridVersion: number;
  readonly revision: number;
  terrainRoadCodes: Uint8Array;
}

const packedGrids = new WeakMap<HexGrid, PackedGridForPathfinding>();
let packedRevision = 0;
let loadedPackedGrid: PackedGridForPathfinding | undefined;
let loadedPackedRevision = -1;

const wasmPathfindingDisabled = (): boolean =>
  typeof process !== 'undefined' && process.env.ECOGAME_DISABLE_WASM_PATHFINDING === '1';

const packGridForPathfinding = (grid: HexGrid): PackedGridForPathfinding => {
  const existing = packedGrids.get(grid);
  const tileCount = grid.size();
  if (existing !== undefined && existing.tileCount === tileCount) {
    if (existing.gridVersion === grid.tileVersion) return existing;
    const terrainRoadCodes = terrainRoadCodesFor(grid);
    const updated: PackedGridForPathfinding = {
      ...existing,
      terrainRoadCodes,
      gridVersion: grid.tileVersion,
      revision: ++packedRevision,
    };
    packedGrids.set(grid, updated);
    return updated;
  }

  const coordKeys = Uint32Array.from(grid.coordKeysByIndex);
  const neighborStarts = new Int32Array(tileCount + 1);
  let edgeCount = 0;
  for (let i = 0; i < tileCount; i++) {
    neighborStarts[i] = edgeCount;
    edgeCount += grid.neighborIndicesByIndex[i]?.length ?? 0;
  }
  neighborStarts[tileCount] = edgeCount;
  const neighborIndices = new Int32Array(edgeCount);
  let cursor = 0;
  for (let i = 0; i < tileCount; i++) {
    const neighbors = grid.neighborIndicesByIndex[i] ?? [];
    for (let j = 0; j < neighbors.length; j++) {
      neighborIndices[cursor++] = neighbors[j] as number;
    }
  }

  const packed: PackedGridForPathfinding = {
    coordKeys,
    neighborStarts,
    neighborIndices,
    edgeCount,
    tileCount,
    gridVersion: grid.tileVersion,
    revision: ++packedRevision,
    terrainRoadCodes: terrainRoadCodesFor(grid),
  };
  packedGrids.set(grid, packed);
  return packed;
};

const terrainRoadCodesFor = (grid: HexGrid): Uint8Array => {
  const out = new Uint8Array(grid.size());
  const tiles = grid.tilesByIndex;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    if (tile === undefined) continue;
    out[i] = terrainRoadCostIndex(tile.terrain, tile.road);
  }
  return out;
};

const loadPackedGridIntoWasm = (
  packed: PackedGridForPathfinding,
  costTable: ArrayLike<number>,
): void => {
  wasmPathfinding.ensureCapacity(packed.tileCount, packed.edgeCount, packed.tileCount);
  const memory = wasmPathfinding.memory;
  const needsGridLoad =
    loadedPackedGrid !== packed || loadedPackedRevision !== packed.revision;
  if (needsGridLoad) {
    new Uint32Array(memory.buffer, wasmPathfinding.coordKeysPtr(), packed.tileCount).set(
      packed.coordKeys,
    );
    new Uint8Array(memory.buffer, wasmPathfinding.terrainRoadCodesPtr(), packed.tileCount).set(
      packed.terrainRoadCodes,
    );
    new Int32Array(memory.buffer, wasmPathfinding.neighborStartsPtr(), packed.tileCount + 1).set(
      packed.neighborStarts,
    );
    new Int32Array(memory.buffer, wasmPathfinding.neighborIndicesPtr(), packed.edgeCount).set(
      packed.neighborIndices,
    );
    loadedPackedGrid = packed;
    loadedPackedRevision = packed.revision;
  }
  new Float64Array(memory.buffer, wasmPathfinding.costTablePtr(), TERRAIN_ROAD_COST_COUNT).set(
    costTable,
  );
};

export const findPathWasm = (
  grid: HexGrid,
  start: Hex,
  goal: Hex,
  costTable: ArrayLike<number>,
): PathResult | undefined => {
  const startIndex = grid.coordIndex.get(coordKey(start.q, start.r));
  const goalIndex = grid.coordIndex.get(coordKey(goal.q, goal.r));
  if (startIndex === undefined || goalIndex === undefined) {
    return { path: [], totalCost: Infinity };
  }
  if (costTable.length !== TERRAIN_ROAD_COST_COUNT) return undefined;
  const packed = packGridForPathfinding(grid);
  loadPackedGridIntoWasm(packed, costTable);
  const pathLength = wasmPathfinding.findPath(
    packed.tileCount,
    startIndex,
    goalIndex,
    goal.q,
    goal.r,
    packed.tileCount,
  );
  if (pathLength === -2) return undefined;
  if (pathLength <= 0) return { path: [], totalCost: Infinity };
  const indexes = new Int32Array(
    wasmPathfinding.memory.buffer,
    wasmPathfinding.outPathPtr(),
    pathLength,
  );
  const path: Hex[] = new Array<Hex>(pathLength);
  for (let i = 0; i < pathLength; i++) {
    const key = packed.coordKeys[indexes[i] as number] as number;
    path[i] = { q: coordQ(key), r: coordR(key) };
  }
  return { path, totalCost: wasmPathfinding.lastTotalCost() };
};

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
  const directDistance = hexDistanceAt(start.q, start.r, goal.q, goal.r);
  if (directDistance === 0) {
    return grid.hasAt(start.q, start.r)
      ? { path: [start], totalCost: 0 }
      : { path: [], totalCost: Infinity };
  }
  if (directDistance === 1) {
    if (!grid.hasAt(start.q, start.r)) return { path: [], totalCost: Infinity };
    const goalTile = grid.getAt(goal.q, goal.r);
    if (goalTile === undefined) return { path: [], totalCost: Infinity };
    const stepCost = profile.costFor(goalTile.terrain, goalTile.road, season, loadFraction);
    return Number.isFinite(stepCost)
      ? { path: [start, goal], totalCost: stepCost }
      : { path: [], totalCost: Infinity };
  }
  const costTable = profile.pathfindingCostTable?.(season, loadFraction);
  if (!wasmPathfindingDisabled() && costTable !== undefined) {
    const wasmResult = findPathWasm(grid, start, goal, costTable);
    if (wasmResult !== undefined) return wasmResult;
  }
  return findPathJs(grid, start, goal, profile, season, loadFraction);
};

export const findPathJs = (
  grid: HexGrid,
  start: Hex,
  goal: Hex,
  profile: MovementProfile,
  season: Season,
  loadFraction: number,
): PathResult => {
  const startKey = coordKey(start.q, start.r);
  const goalKey = coordKey(goal.q, goal.r);
  const coordIndex = grid.coordIndex;
  const startIndex = coordIndex.get(startKey);
  const goalIndex = coordIndex.get(goalKey);
  if (startIndex === undefined || goalIndex === undefined) {
    return { path: [], totalCost: Infinity };
  }
  const goalQ = goal.q;
  const goalR = goal.r;
  const coordKeysByIndex = grid.coordKeysByIndex;
  const tilesByIndex = grid.tilesByIndex;
  const neighborIndicesByIndex = grid.neighborIndicesByIndex;
  if (start.q === goal.q && start.r === goal.r) {
    return { path: [start], totalCost: 0 };
  }
  const startDistance = hexDistanceAt(start.q, start.r, goalQ, goalR);
  if (startDistance === 1) {
    const tile = tilesByIndex[goalIndex];
    if (tile === undefined) return { path: [], totalCost: Infinity };
    const stepCost = profile.costFor(tile.terrain, tile.road, season, loadFraction);
    return Number.isFinite(stepCost)
      ? { path: [start, goal], totalCost: stepCost }
      : { path: [], totalCost: Infinity };
  }

  pathWorkspace.reset(grid.size());
  const { open, stepCostCache } = pathWorkspace;
  let seq = 0;

  pathWorkspace.setScore(startIndex, 0);
  pathWorkspace.setCameFrom(startIndex, -1);
  open.push(startIndex, startDistance * MIN_STEP_COST, seq++);

  while (open.size() > 0) {
    const currentIndex = open.pop() as number;
    if (pathWorkspace.hasClosed(currentIndex)) continue;
    pathWorkspace.close(currentIndex);

    if (currentIndex === goalIndex) {
      return reconstruct(
        pathWorkspace,
        coordKeysByIndex,
        goalIndex,
        pathWorkspace.getScore(goalIndex) ?? Infinity,
      );
    }

    const currentG = pathWorkspace.getScore(currentIndex) ?? Infinity;

    const neighborIndices = neighborIndicesByIndex[currentIndex] ?? [];
    for (let directionIndex = 0; directionIndex < neighborIndices.length; directionIndex++) {
      const nIndex = neighborIndices[directionIndex] as number;
      if (pathWorkspace.hasClosed(nIndex)) continue;
      const tile = tilesByIndex[nIndex];
      if (tile === undefined) continue;
      const costIndex = terrainRoadCostIndex(tile.terrain, tile.road);
      let stepCost = stepCostCache[costIndex] as number;
      if (Number.isNaN(stepCost)) {
        stepCost = profile.costFor(tile.terrain, tile.road, season, loadFraction);
        stepCostCache[costIndex] = stepCost;
      }
      if (!Number.isFinite(stepCost)) continue;
      const tentative = currentG + stepCost;
      const existing = pathWorkspace.getScore(nIndex);
      if (existing !== undefined && tentative >= existing) continue;
      pathWorkspace.setScore(nIndex, tentative);
      pathWorkspace.setCameFrom(nIndex, currentIndex);
      const nKey = coordKeysByIndex[nIndex] as number;
      const nq = coordQ(nKey);
      const nr = coordR(nKey);
      const f = tentative + hexDistanceAt(nq, nr, goalQ, goalR) * MIN_STEP_COST;
      open.push(nIndex, f, seq++);
    }
  }

  return { path: [], totalCost: Infinity };
};

const reconstruct = (
  workspace: PathWorkspace,
  coordKeysByIndex: readonly number[],
  goalIndex: number,
  totalCost: number,
): PathResult => {
  const pathIndexes: number[] = [goalIndex];
  let currentIndex = goalIndex;
  for (;;) {
    const prev = workspace.previousIndex(currentIndex);
    if (prev < 0) break;
    pathIndexes.push(prev);
    currentIndex = prev;
  }
  const path: Hex[] = [];
  for (let i = pathIndexes.length - 1; i >= 0; i--) {
    const key = coordKeysByIndex[pathIndexes[i] as number] as number;
    path.push({ q: coordQ(key), r: coordR(key) });
  }
  return { path, totalCost };
};
