import { describe, expect, it } from 'vitest';
import {
  HEX_DIRECTIONS,
  hex,
  hexAdd,
  hexDistance,
  hexEquals,
  hexKey,
  hexNeighbor,
  hexNeighbors,
  hexSubtract,
  hexesWithinRange,
  parseHexKey,
} from './hex.js';

describe('hex', () => {
  describe('hexEquals', () => {
    it('is true for identical coordinates', () => {
      expect(hexEquals(hex(2, -3), hex(2, -3))).toBe(true);
    });
    it('is false for different coordinates', () => {
      expect(hexEquals(hex(2, -3), hex(2, 3))).toBe(false);
      expect(hexEquals(hex(0, 0), hex(1, 0))).toBe(false);
    });
  });

  describe('hexAdd / hexSubtract', () => {
    it('adds component-wise', () => {
      expect(hexAdd(hex(1, 2), hex(3, -1))).toEqual(hex(4, 1));
    });
    it('subtracts component-wise', () => {
      expect(hexSubtract(hex(1, 2), hex(3, -1))).toEqual(hex(-2, 3));
    });
  });

  describe('hexDistance', () => {
    it('is 0 from a hex to itself', () => {
      expect(hexDistance(hex(0, 0), hex(0, 0))).toBe(0);
      expect(hexDistance(hex(5, -3), hex(5, -3))).toBe(0);
    });
    it('is 1 between any two adjacent hexes', () => {
      const center = hex(0, 0);
      for (const dir of HEX_DIRECTIONS) {
        expect(hexDistance(center, hexAdd(center, dir))).toBe(1);
      }
    });
    it('matches manual cases', () => {
      // (0,0) to (3,0): 3 east steps
      expect(hexDistance(hex(0, 0), hex(3, 0))).toBe(3);
      // (0,0) to (-2, 2): 2 south-west steps
      expect(hexDistance(hex(0, 0), hex(-2, 2))).toBe(2);
      // (0,0) to (3, -3): mixed steps
      expect(hexDistance(hex(0, 0), hex(3, -3))).toBe(3);
    });
    it('is symmetric', () => {
      expect(hexDistance(hex(2, 5), hex(-1, -3))).toBe(hexDistance(hex(-1, -3), hex(2, 5)));
    });
    it('satisfies the triangle inequality on a sample', () => {
      const a = hex(0, 0);
      const b = hex(3, -1);
      const c = hex(-2, 4);
      expect(hexDistance(a, c)).toBeLessThanOrEqual(hexDistance(a, b) + hexDistance(b, c));
    });
  });

  describe('hexNeighbor / hexNeighbors', () => {
    it('returns the six unique neighbors', () => {
      const ns = hexNeighbors(hex(0, 0));
      expect(ns).toHaveLength(6);
      const keys = new Set(ns.map(hexKey));
      expect(keys.size).toBe(6);
    });
    it('every neighbor is at distance 1', () => {
      for (const n of hexNeighbors(hex(4, -2))) {
        expect(hexDistance(hex(4, -2), n)).toBe(1);
      }
    });
    it('hexNeighbor wraps the direction index', () => {
      expect(hexNeighbor(hex(0, 0), 0)).toEqual(hexNeighbor(hex(0, 0), 6));
      expect(hexNeighbor(hex(0, 0), -1)).toEqual(hexNeighbor(hex(0, 0), 5));
    });
  });

  describe('hexesWithinRange', () => {
    it('returns just the center for radius 0', () => {
      const out = hexesWithinRange(hex(2, 3), 0);
      expect(out).toEqual([hex(2, 3)]);
    });
    it('returns 1 + 6 hexes for radius 1', () => {
      expect(hexesWithinRange(hex(0, 0), 1)).toHaveLength(7);
    });
    it('returns 1 + 6 + 12 = 19 hexes for radius 2', () => {
      expect(hexesWithinRange(hex(0, 0), 2)).toHaveLength(19);
    });
    it('returns 1 + 6 + 12 + 18 = 37 hexes for radius 3', () => {
      expect(hexesWithinRange(hex(0, 0), 3)).toHaveLength(37);
    });
    it('every hex is within `radius` of center', () => {
      const r = 4;
      for (const h of hexesWithinRange(hex(1, -1), r)) {
        expect(hexDistance(hex(1, -1), h)).toBeLessThanOrEqual(r);
      }
    });
    it('returns empty for negative radius', () => {
      expect(hexesWithinRange(hex(0, 0), -1)).toEqual([]);
    });
  });

  describe('hexKey / parseHexKey', () => {
    it('round-trips', () => {
      const cases = [hex(0, 0), hex(5, -3), hex(-12, 7), hex(100000, -50000)];
      for (const c of cases) {
        expect(parseHexKey(hexKey(c))).toEqual(c);
      }
    });
    it('throws on invalid keys', () => {
      expect(() => parseHexKey('bad')).toThrow();
    });
  });
});
