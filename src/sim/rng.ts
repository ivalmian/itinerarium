/**
 * Deterministic seeded RNG.
 *
 * The simulation must be deterministic given a seed (see docs/01-simulation-frame.md
 * and docs/07-geography.md). All randomness flows through a Rng — never through
 * Math.random(). Different subsystems should branch their RNG via `derive` so
 * that adding randomness to one part of the sim doesn't perturb another.
 */

import seedrandom from 'seedrandom';

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability p (clamped to [0, 1]). */
  chance(p: number): boolean;
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

class SeedrandomRng implements Rng {
  readonly #seed: string;
  readonly #prng: seedrandom.PRNG;

  constructor(seed: string) {
    this.#seed = seed;
    this.#prng = seedrandom(seed);
  }

  next(): number {
    return this.#prng();
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
