const MIN_STEP_COST: f64 = 1.0 / 6.0;
const COORD_KEY_OFFSET: i32 = 32768;
const TERRAIN_ROAD_COST_COUNT: i32 = 39;

let coordKeysBuffer = new ArrayBuffer(0);
let terrainRoadCodesBuffer = new ArrayBuffer(0);
let neighborStartsBuffer = new ArrayBuffer(0);
let neighborIndicesBuffer = new ArrayBuffer(0);
let costTableBuffer = new ArrayBuffer(0);
let outPathBuffer = new ArrayBuffer(0);

let gScoreBuffer = new ArrayBuffer(0);
let cameFromBuffer = new ArrayBuffer(0);
let gScoreStampBuffer = new ArrayBuffer(0);
let closedStampBuffer = new ArrayBuffer(0);

let heapKeysBuffer = new ArrayBuffer(0);
let heapPrioritiesBuffer = new ArrayBuffer(0);
let heapSeqsBuffer = new ArrayBuffer(0);
let heapLength: i32 = 0;
let heapCapacity: i32 = 0;
let heapOverflow = false;

let searchId: u32 = 0;
let lastCost: f64 = Infinity;

function nextCapacity(current: i32, required: i32): i32 {
  let capacity = current > 0 ? current : 1024;
  while (capacity < required) capacity <<= 1;
  return capacity;
}

function ensureBuffer(buffer: ArrayBuffer, requiredBytes: i32): ArrayBuffer {
  if (buffer.byteLength >= requiredBytes) return buffer;
  return new ArrayBuffer(nextCapacity(buffer.byteLength, requiredBytes));
}

export function ensureCapacity(tileCount: i32, edgeCount: i32, pathCapacity: i32): void {
  coordKeysBuffer = ensureBuffer(coordKeysBuffer, tileCount << 2);
  terrainRoadCodesBuffer = ensureBuffer(terrainRoadCodesBuffer, tileCount);
  neighborStartsBuffer = ensureBuffer(neighborStartsBuffer, (tileCount + 1) << 2);
  neighborIndicesBuffer = ensureBuffer(neighborIndicesBuffer, edgeCount << 2);
  costTableBuffer = ensureBuffer(costTableBuffer, TERRAIN_ROAD_COST_COUNT << 3);
  outPathBuffer = ensureBuffer(outPathBuffer, pathCapacity << 2);

  gScoreBuffer = ensureBuffer(gScoreBuffer, tileCount << 3);
  cameFromBuffer = ensureBuffer(cameFromBuffer, tileCount << 2);
  gScoreStampBuffer = ensureBuffer(gScoreStampBuffer, tileCount << 2);
  closedStampBuffer = ensureBuffer(closedStampBuffer, tileCount << 2);

  heapCapacity = edgeCount + 1;
  if (heapCapacity < 1024) heapCapacity = 1024;
  heapKeysBuffer = ensureBuffer(heapKeysBuffer, heapCapacity << 2);
  heapPrioritiesBuffer = ensureBuffer(heapPrioritiesBuffer, heapCapacity << 3);
  heapSeqsBuffer = ensureBuffer(heapSeqsBuffer, heapCapacity << 2);
}

export function coordKeysPtr(): usize {
  return changetype<usize>(coordKeysBuffer);
}

export function terrainRoadCodesPtr(): usize {
  return changetype<usize>(terrainRoadCodesBuffer);
}

export function neighborStartsPtr(): usize {
  return changetype<usize>(neighborStartsBuffer);
}

export function neighborIndicesPtr(): usize {
  return changetype<usize>(neighborIndicesBuffer);
}

export function costTablePtr(): usize {
  return changetype<usize>(costTableBuffer);
}

export function outPathPtr(): usize {
  return changetype<usize>(outPathBuffer);
}

export function lastTotalCost(): f64 {
  return lastCost;
}

function coordQ(key: u32): i32 {
  return <i32>(key >>> 16) - COORD_KEY_OFFSET;
}

function coordR(key: u32): i32 {
  return <i32>(key & 0xffff) - COORD_KEY_OFFSET;
}

function absI32(value: i32): i32 {
  return value < 0 ? -value : value;
}

function hexDistanceAt(aq: i32, ar: i32, bq: i32, br: i32): f64 {
  const dq = aq - bq;
  const dr = ar - br;
  const ds = -dq - dr;
  return <f64>(absI32(dq) + absI32(dr) + absI32(ds)) / 2.0;
}

function gScorePtr(index: i32): usize {
  return changetype<usize>(gScoreBuffer) + (<usize>index << 3);
}

function cameFromPtr(index: i32): usize {
  return changetype<usize>(cameFromBuffer) + (<usize>index << 2);
}

function gScoreStampPtr(index: i32): usize {
  return changetype<usize>(gScoreStampBuffer) + (<usize>index << 2);
}

function closedStampPtr(index: i32): usize {
  return changetype<usize>(closedStampBuffer) + (<usize>index << 2);
}

function hasClosed(index: i32): bool {
  return load<u32>(closedStampPtr(index)) == searchId;
}

function closeIndex(index: i32): void {
  store<u32>(closedStampPtr(index), searchId);
}

function getScore(index: i32): f64 {
  return load<u32>(gScoreStampPtr(index)) == searchId ? load<f64>(gScorePtr(index)) : Infinity;
}

function setScore(index: i32, score: f64): void {
  store<u32>(gScoreStampPtr(index), searchId);
  store<f64>(gScorePtr(index), score);
}

function setCameFrom(index: i32, previousIndex: i32): void {
  store<i32>(cameFromPtr(index), previousIndex);
}

function heapKeyPtr(index: i32): usize {
  return changetype<usize>(heapKeysBuffer) + (<usize>index << 2);
}

function heapPriorityPtr(index: i32): usize {
  return changetype<usize>(heapPrioritiesBuffer) + (<usize>index << 3);
}

function heapSeqPtr(index: i32): usize {
  return changetype<usize>(heapSeqsBuffer) + (<usize>index << 2);
}

function heapLess(a: i32, b: i32): bool {
  const aPriority = load<f64>(heapPriorityPtr(a));
  const bPriority = load<f64>(heapPriorityPtr(b));
  if (aPriority != bPriority) return aPriority < bPriority;
  return load<u32>(heapSeqPtr(a)) < load<u32>(heapSeqPtr(b));
}

function heapSwap(a: i32, b: i32): void {
  const key = load<i32>(heapKeyPtr(a));
  const priority = load<f64>(heapPriorityPtr(a));
  const seq = load<u32>(heapSeqPtr(a));
  store<i32>(heapKeyPtr(a), load<i32>(heapKeyPtr(b)));
  store<f64>(heapPriorityPtr(a), load<f64>(heapPriorityPtr(b)));
  store<u32>(heapSeqPtr(a), load<u32>(heapSeqPtr(b)));
  store<i32>(heapKeyPtr(b), key);
  store<f64>(heapPriorityPtr(b), priority);
  store<u32>(heapSeqPtr(b), seq);
}

function heapPush(key: i32, priority: f64, seq: u32): void {
  if (heapLength >= heapCapacity) {
    heapOverflow = true;
    return;
  }
  let i = heapLength++;
  store<i32>(heapKeyPtr(i), key);
  store<f64>(heapPriorityPtr(i), priority);
  store<u32>(heapSeqPtr(i), seq);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapLess(i, parent)) break;
    heapSwap(i, parent);
    i = parent;
  }
}

function heapPop(): i32 {
  const top = load<i32>(heapKeyPtr(0));
  heapLength--;
  if (heapLength > 0) {
    store<i32>(heapKeyPtr(0), load<i32>(heapKeyPtr(heapLength)));
    store<f64>(heapPriorityPtr(0), load<f64>(heapPriorityPtr(heapLength)));
    store<u32>(heapSeqPtr(0), load<u32>(heapSeqPtr(heapLength)));
    let i: i32 = 0;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < heapLength && heapLess(left, smallest)) smallest = left;
      if (right < heapLength && heapLess(right, smallest)) smallest = right;
      if (smallest == i) break;
      heapSwap(i, smallest);
      i = smallest;
    }
  }
  return top;
}

function resetSearch(): void {
  searchId++;
  if (searchId == 0xffffffff) {
    memory.fill(changetype<usize>(gScoreStampBuffer), 0, gScoreStampBuffer.byteLength);
    memory.fill(changetype<usize>(closedStampBuffer), 0, closedStampBuffer.byteLength);
    searchId = 1;
  }
  heapLength = 0;
  heapOverflow = false;
  lastCost = Infinity;
}

function reconstruct(goalIndex: i32, pathCapacity: i32): i32 {
  let length: i32 = 0;
  let current = goalIndex;
  const outPtr = changetype<usize>(outPathBuffer);
  while (current >= 0) {
    if (length >= pathCapacity) return -2;
    store<i32>(outPtr + (<usize>length << 2), current);
    length++;
    current = load<i32>(cameFromPtr(current));
  }
  let left: i32 = 0;
  let right = length - 1;
  while (left < right) {
    const leftPtr = outPtr + (<usize>left << 2);
    const rightPtr = outPtr + (<usize>right << 2);
    const tmp = load<i32>(leftPtr);
    store<i32>(leftPtr, load<i32>(rightPtr));
    store<i32>(rightPtr, tmp);
    left++;
    right--;
  }
  return length;
}

export function findPath(
  tileCount: i32,
  startIndex: i32,
  goalIndex: i32,
  goalQ: i32,
  goalR: i32,
  pathCapacity: i32,
): i32 {
  resetSearch();
  if (startIndex < 0 || startIndex >= tileCount) return -1;
  if (goalIndex < 0 || goalIndex >= tileCount) return -1;
  if (startIndex == goalIndex) {
    store<i32>(changetype<usize>(outPathBuffer), startIndex);
    lastCost = 0.0;
    return 1;
  }

  const coordKeysPtrBase = changetype<usize>(coordKeysBuffer);
  const startKey = load<u32>(coordKeysPtrBase + (<usize>startIndex << 2));
  const startDistance = hexDistanceAt(coordQ(startKey), coordR(startKey), goalQ, goalR);
  let seq: u32 = 0;
  setScore(startIndex, 0.0);
  setCameFrom(startIndex, -1);
  heapPush(startIndex, startDistance * MIN_STEP_COST, seq++);
  if (heapOverflow) return -2;

  const neighborStartsPtrBase = changetype<usize>(neighborStartsBuffer);
  const neighborIndicesPtrBase = changetype<usize>(neighborIndicesBuffer);
  const terrainRoadCodesPtrBase = changetype<usize>(terrainRoadCodesBuffer);
  const costTablePtrBase = changetype<usize>(costTableBuffer);

  while (heapLength > 0) {
    const currentIndex = heapPop();
    if (hasClosed(currentIndex)) continue;
    closeIndex(currentIndex);

    if (currentIndex == goalIndex) {
      lastCost = getScore(goalIndex);
      return reconstruct(goalIndex, pathCapacity);
    }

    const currentG = getScore(currentIndex);
    const begin = load<i32>(neighborStartsPtrBase + (<usize>currentIndex << 2));
    const end = load<i32>(neighborStartsPtrBase + (<usize>(currentIndex + 1) << 2));
    for (let edge = begin; edge < end; edge++) {
      const nIndex = load<i32>(neighborIndicesPtrBase + (<usize>edge << 2));
      if (hasClosed(nIndex)) continue;
      const costCode = <i32>load<u8>(terrainRoadCodesPtrBase + <usize>nIndex);
      const stepCost = load<f64>(costTablePtrBase + (<usize>costCode << 3));
      if (stepCost == Infinity) continue;
      const tentative = currentG + stepCost;
      const existing = getScore(nIndex);
      if (tentative >= existing) continue;
      setScore(nIndex, tentative);
      setCameFrom(nIndex, currentIndex);
      const nKey = load<u32>(coordKeysPtrBase + (<usize>nIndex << 2));
      const f = tentative + hexDistanceAt(coordQ(nKey), coordR(nKey), goalQ, goalR) * MIN_STEP_COST;
      heapPush(nIndex, f, seq++);
      if (heapOverflow) return -2;
    }
  }

  return -1;
}
