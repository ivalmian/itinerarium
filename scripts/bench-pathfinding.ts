import { performance } from 'node:perf_hooks';

import { createGrid } from '../src/sim/world/grid.js';
import { hex, hexKey, type Hex } from '../src/sim/world/hex.js';
import {
  findPathJs,
  findPathWasm,
  LADEN_MULE_PROFILE,
} from '../src/sim/world/pathfinding.js';
import type { HexTile, Terrain } from '../src/sim/world/terrain.js';

const SIDE = Number(process.env.PATH_BENCH_SIDE ?? 96);
const ROUTE_COUNT = Number(process.env.PATH_BENCH_ROUTES ?? 300);
const LOOPS = Number(process.env.PATH_BENCH_LOOPS ?? 12);
const SEASON = 'summer';
const LOAD = 1;

const terrainAt = (q: number, r: number): Terrain => {
  const code = Math.abs((q * 17 + r * 31 + q * r) % 17);
  if (code === 0) return 'hills';
  if (code === 1) return 'forest';
  if (code === 2) return 'dense_forest';
  if (code === 3) return 'marsh';
  if (code === 4) return 'desert';
  return 'plains';
};

const tile = (q: number, r: number): HexTile => ({
  terrain: terrainAt(q, r),
  climate: 'temperate',
  elevation: 0,
  hasRiver: false,
  road: q === r || q === Math.floor(SIDE / 2) || r === Math.floor(SIDE / 2) ? 'roman' : 'none',
  roadWear: 0,
  ownerActor: null,
});

const grid = createGrid();
for (let q = 0; q < SIDE; q++) {
  for (let r = 0; r < SIDE; r++) {
    grid.set(hex(q, r), tile(q, r));
  }
}

const routes: readonly (readonly [Hex, Hex])[] = Array.from({ length: ROUTE_COUNT }, (_, i) => {
  const start = hex((i * 37) % SIDE, (i * 19) % SIDE);
  const goal = hex(SIDE - 1 - ((i * 29) % SIDE), SIDE - 1 - ((i * 43) % SIDE));
  return [start, goal] as const;
});

const costTable = LADEN_MULE_PROFILE.pathfindingCostTable?.(SEASON, LOAD);
if (costTable === undefined) throw new Error('LADEN_MULE_PROFILE is missing a Wasm cost table');

const pathSignature = (path: readonly Hex[]): string => path.map(hexKey).join(';');

for (const [start, goal] of routes) {
  const js = findPathJs(grid, start, goal, LADEN_MULE_PROFILE, SEASON, LOAD);
  const wasm = findPathWasm(grid, start, goal, costTable);
  if (wasm === undefined) throw new Error(`Wasm path overflowed for ${hexKey(start)} -> ${hexKey(goal)}`);
  if (js.totalCost !== wasm.totalCost || pathSignature(js.path) !== pathSignature(wasm.path)) {
    throw new Error(
      `Path mismatch for ${hexKey(start)} -> ${hexKey(goal)}: js=${js.totalCost} wasm=${wasm.totalCost}`,
    );
  }
}

const bench = (
  label: string,
  run: (start: Hex, goal: Hex) => { readonly path: readonly Hex[]; readonly totalCost: number },
): { readonly elapsedMs: number; readonly checksum: number } => {
  let checksum = 0;
  const started = performance.now();
  for (let loop = 0; loop < LOOPS; loop++) {
    for (const [start, goal] of routes) {
      const result = run(start, goal);
      checksum += result.path.length;
      checksum += Number.isFinite(result.totalCost) ? result.totalCost : 0;
    }
  }
  const elapsedMs = performance.now() - started;
  console.log(`${label}: ${elapsedMs.toFixed(2)}ms checksum=${checksum.toFixed(3)}`);
  return { elapsedMs, checksum };
};

bench('js-a-star', (start, goal) => findPathJs(grid, start, goal, LADEN_MULE_PROFILE, SEASON, LOAD));
bench('as-wasm-a-star', (start, goal) => {
  const result = findPathWasm(grid, start, goal, costTable);
  if (result === undefined) throw new Error('Wasm path overflowed during benchmark');
  return result;
});
