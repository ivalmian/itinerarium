import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';

describe('rng', () => {
  describe('determinism', () => {
    it('produces the same sequence from the same seed', () => {
      const a = createRng('seed-a');
      const b = createRng('seed-a');
      const seqA = Array.from({ length: 100 }, () => a.next());
      const seqB = Array.from({ length: 100 }, () => b.next());
      expect(seqA).toEqual(seqB);
    });

    it('produces different sequences for different seeds', () => {
      const a = createRng('seed-a');
      const b = createRng('seed-b');
      const seqA = Array.from({ length: 100 }, () => a.next());
      const seqB = Array.from({ length: 100 }, () => b.next());
      expect(seqA).not.toEqual(seqB);
    });
  });

  describe('next', () => {
    it('returns values in [0, 1)', () => {
      const r = createRng('next-range');
      for (let i = 0; i < 1000; i++) {
        const v = r.next();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
  });

  describe('int', () => {
    it('returns values in [min, max] inclusive', () => {
      const r = createRng('int-range');
      const seen = new Set<number>();
      for (let i = 0; i < 5000; i++) {
        const v = r.int(3, 7);
        expect(v).toBeGreaterThanOrEqual(3);
        expect(v).toBeLessThanOrEqual(7);
        expect(Number.isInteger(v)).toBe(true);
        seen.add(v);
      }
      expect(seen).toEqual(new Set([3, 4, 5, 6, 7]));
    });

    it('handles min === max', () => {
      const r = createRng('int-eq');
      for (let i = 0; i < 10; i++) {
        expect(r.int(5, 5)).toBe(5);
      }
    });

    it('throws when max < min', () => {
      const r = createRng('int-bad');
      expect(() => r.int(5, 3)).toThrow();
    });
  });

  describe('float', () => {
    it('returns values in [min, max)', () => {
      const r = createRng('float-range');
      for (let i = 0; i < 1000; i++) {
        const v = r.float(-2, 5);
        expect(v).toBeGreaterThanOrEqual(-2);
        expect(v).toBeLessThan(5);
      }
    });

    it('throws when max < min', () => {
      const r = createRng('float-bad');
      expect(() => r.float(5, 3)).toThrow();
    });
  });

  describe('chance', () => {
    it('always false at p=0 and always true at p=1', () => {
      const r = createRng('chance-corners');
      for (let i = 0; i < 100; i++) {
        expect(r.chance(0)).toBe(false);
        expect(r.chance(1)).toBe(true);
      }
    });

    it('clamps out-of-range p', () => {
      const r = createRng('chance-clamp');
      for (let i = 0; i < 100; i++) {
        expect(r.chance(-1)).toBe(false);
        expect(r.chance(2)).toBe(true);
      }
    });

    it('approximates expected frequency for p=0.3', () => {
      const r = createRng('chance-0.3');
      let trues = 0;
      const N = 10000;
      for (let i = 0; i < N; i++) {
        if (r.chance(0.3)) trues++;
      }
      // Expect roughly 30%; allow 3% slack.
      expect(trues / N).toBeGreaterThan(0.27);
      expect(trues / N).toBeLessThan(0.33);
    });
  });

  describe('pick', () => {
    it('returns one of the input items', () => {
      const r = createRng('pick');
      const items = ['a', 'b', 'c'] as const;
      for (let i = 0; i < 100; i++) {
        expect(items).toContain(r.pick(items));
      }
    });

    it('throws on empty list', () => {
      const r = createRng('pick-empty');
      expect(() => r.pick([])).toThrow();
    });
  });

  describe('shuffle', () => {
    it('produces a permutation', () => {
      const r = createRng('shuffle');
      const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const out = r.shuffle(items);
      expect(out).toHaveLength(items.length);
      expect(out.slice().sort((a, b) => a - b)).toEqual(items);
    });

    it('does not mutate input', () => {
      const r = createRng('shuffle-nomut');
      const items = [1, 2, 3, 4, 5];
      const before = items.slice();
      r.shuffle(items);
      expect(items).toEqual(before);
    });

    it('is deterministic for the same seed', () => {
      const a = createRng('shuffle-det');
      const b = createRng('shuffle-det');
      const items = [1, 2, 3, 4, 5, 6, 7, 8];
      expect(a.shuffle(items)).toEqual(b.shuffle(items));
    });
  });

  describe('derive', () => {
    it('produces the same child stream regardless of parent calls between forks', () => {
      // This is the load-bearing property: adding a roll to one subsystem
      // doesn't perturb another subsystem's stream.
      const a = createRng('parent');
      const aChild = a.derive('child');

      const b = createRng('parent');
      // Burn some calls on b before forking.
      for (let i = 0; i < 50; i++) b.next();
      const bChild = b.derive('child');

      const seqA = Array.from({ length: 50 }, () => aChild.next());
      const seqB = Array.from({ length: 50 }, () => bChild.next());
      expect(seqA).toEqual(seqB);
    });

    it('different labels produce different streams', () => {
      const parent = createRng('parent');
      const c1 = parent.derive('label-1');
      const c2 = parent.derive('label-2');
      const s1 = Array.from({ length: 30 }, () => c1.next());
      const s2 = Array.from({ length: 30 }, () => c2.next());
      expect(s1).not.toEqual(s2);
    });
  });
});
