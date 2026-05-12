import { readFileSync, writeFileSync } from 'node:fs';

const wasmPath = new URL('../src/wasm/pathfinding.kernel.wasm', import.meta.url);
const outputPath = new URL('../src/wasm/pathfinding.ts', import.meta.url);
const base64 = readFileSync(wasmPath).toString('base64');

writeFileSync(
  outputPath,
  `const WASM_BASE64 = '${base64}';

const bytesFromBase64 = (base64: string): Uint8Array => {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

interface PathfindingWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  ensureCapacity(tileCount: number, edgeCount: number, pathCapacity: number): void;
  coordKeysPtr(): number;
  terrainRoadCodesPtr(): number;
  neighborStartsPtr(): number;
  neighborIndicesPtr(): number;
  costTablePtr(): number;
  outPathPtr(): number;
  lastTotalCost(): number;
  findPath(
    tileCount: number,
    startIndex: number,
    goalIndex: number,
    goalQ: number,
    goalR: number,
    pathCapacity: number,
  ): number;
}

const moduleBytes = bytesFromBase64(WASM_BASE64);
const moduleBuffer = new ArrayBuffer(moduleBytes.byteLength);
new Uint8Array(moduleBuffer).set(moduleBytes);
const wasmModule = new WebAssembly.Module(moduleBuffer);
const wasmInstance = new WebAssembly.Instance(wasmModule, {
  env: {
    abort(): never {
      throw new Error('AssemblyScript pathfinding aborted');
    },
  },
});
const wasm = wasmInstance.exports as PathfindingWasmExports;

export const memory = wasm.memory;
export const ensureCapacity = wasm.ensureCapacity;
export const coordKeysPtr = wasm.coordKeysPtr;
export const terrainRoadCodesPtr = wasm.terrainRoadCodesPtr;
export const neighborStartsPtr = wasm.neighborStartsPtr;
export const neighborIndicesPtr = wasm.neighborIndicesPtr;
export const costTablePtr = wasm.costTablePtr;
export const outPathPtr = wasm.outPathPtr;
export const lastTotalCost = wasm.lastTotalCost;
export const findPath = wasm.findPath;
`,
);
