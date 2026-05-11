/**
 * Deterministic seeded RNG.
 *
 * The simulation must be deterministic given a seed (see docs/01-simulation-frame.md
 * and docs/07-geography.md). All randomness flows through a Rng — never through
 * Math.random(). Different subsystems should branch their RNG via `derive` so
 * that adding randomness to one part of the sim doesn't perturb another.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability p (clamped to [0, 1]). */
  chance(p: number): boolean;
  /** Sample the count from `n` Bernoulli trials with success probability `p`. */
  countBelow(n: number, p: number): number;
  /** Pick one element uniformly. Throws on empty input. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /**
   * Derive a child RNG with a sub-stream label. The same `(parent seed, label)`
   * pair always produces the same child stream, regardless of how many calls
   * the parent made between forks.
   */
  derive(label: string): Rng;
}

const RNG_WIDTH = 256;
const RNG_CHUNKS = 6;
const RNG_DIGITS = 52;
const RNG_START_DENOM = RNG_WIDTH ** RNG_CHUNKS;
const RNG_SIGNIFICANCE = 2 ** RNG_DIGITS;
const RNG_OVERFLOW = RNG_SIGNIFICANCE * 2;
const RNG_MASK = RNG_WIDTH - 1;

const rngToString = (a: readonly number[]): string => String.fromCharCode.apply(0, a as number[]);

const mixKey = (seed: string, key: number[]): string => {
  let smear = 0;
  let j = 0;
  while (j < seed.length) {
    const slot = RNG_MASK & j;
    smear ^= (key[slot] ?? 0) * 19;
    key[slot] = RNG_MASK & (smear + seed.charCodeAt(j++));
  }
  return rngToString(key);
};

class SeedrandomRng implements Rng {
  readonly #seed: string;
  readonly #s: number[] = [];
  #i = 0;
  #j = 0;

  constructor(seed: string) {
    this.#seed = seed;
    const key: number[] = [];
    mixKey(seed, key);
    this.#initArc4(key);
  }

  #initArc4(key: readonly number[]): void {
    const s = this.#s;
    let keylen = key.length;
    let j = 0;
    if (keylen === 0) keylen = 1;
    for (let i = 0; i < RNG_WIDTH; i++) {
      s[i] = i;
    }
    for (let i = 0; i < RNG_WIDTH; i++) {
      const t = s[i] as number;
      j = RNG_MASK & (j + (key[i % keylen] ?? 0) + t);
      s[i] = s[j] as number;
      s[j] = t;
    }
    this.#g(RNG_WIDTH);
  }

  #g(count: number): number {
    let t = 0;
    let r = 0;
    let i = this.#i;
    let j = this.#j;
    const s = this.#s;
    while (count > 0) {
      count--;
      t = s[(i = RNG_MASK & (i + 1))] as number;
      j = RNG_MASK & (j + t);
      const sj = s[j] as number;
      s[i] = sj;
      s[j] = t;
      r = r * RNG_WIDTH + (s[RNG_MASK & (sj + t)] as number);
    }
    this.#i = i;
    this.#j = j;
    return r;
  }

  next(): number {
    let n = this.#g(RNG_CHUNKS);
    let d = RNG_START_DENOM;
    let x = 0;
    while (n < RNG_SIGNIFICANCE) {
      n = (n + x) * RNG_WIDTH;
      d *= RNG_WIDTH;
      x = this.#g(1);
    }
    while (n >= RNG_OVERFLOW) {
      n /= 2;
      d /= 2;
      x >>>= 1;
    }
    return (n + x) / d;
  }

  int(min: number, max: number): number {
    if (max < min) throw new Error(`int: max (${max}) < min (${min})`);
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min: number, max: number): number {
    if (max < min) throw new Error(`float: max (${max}) < min (${min})`);
    return this.next() * (max - min) + min;
  }

  chance(p: number): boolean {
    const clamped = Math.max(0, Math.min(1, p));
    return this.next() < clamped;
  }

  countBelow(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    const trials = Math.floor(n);
    if (trials <= 0) return 0;
    let remaining = trials;
    let count = 0;
    while (remaining > 0) {
      remaining--;
      if (this.next() < p) count++;
    }
    return count;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick: empty list');
    const i = this.int(0, items.length - 1);
    // Safe: i is in [0, length - 1].
    return items[i] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  derive(label: string): Rng {
    return new SeedrandomRng(`${this.#seed}|${label}`);
  }
}

export const createRng = (seed: string): Rng => new SeedrandomRng(seed);
