/**
 * Pointy-top hexagonal grid using axial coordinates (q, r).
 *
 * 1 hex = 1 km in this game (see docs/01-simulation-frame.md).
 * Coordinates form a 2D triangular lattice; the third axial coordinate
 * is implicit: s = -q - r.
 *
 * References:
 *   https://www.redblobgames.com/grids/hexagons/
 */

export interface Hex {
  readonly q: number;
  readonly r: number;
}

export const hex = (q: number, r: number): Hex => ({ q, r });

/** The six neighbor directions in axial coordinates, starting east and going CCW. */
export const HEX_DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const hexEquals = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

export const hexAdd = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });

export const hexSubtract = (a: Hex, b: Hex): Hex => ({ q: a.q - b.q, r: a.r - b.r });

/** Distance in hex steps between two coordinates. */
export const hexDistance = (a: Hex, b: Hex): number => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
};

export const hexNeighbor = (h: Hex, direction: number): Hex => {
  const dir = HEX_DIRECTIONS[((direction % 6) + 6) % 6];
  // Safe: index is in [0, 5] after modulo above.
  return hexAdd(h, dir as Hex);
};

export const hexNeighbors = (h: Hex): Hex[] => HEX_DIRECTIONS.map((d) => hexAdd(h, d));

/**
 * All hexes within `radius` steps of `center` (inclusive).
 * Order: outward ring by ring, but unspecified within rings.
 */
export const hexesWithinRange = (center: Hex, radius: number): Hex[] => {
  if (radius < 0) return [];
  const out: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    const rMin = Math.max(-radius, -dq - radius);
    const rMax = Math.min(radius, -dq + radius);
    for (let dr = rMin; dr <= rMax; dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
};

/** A stable string key for use as a Map/Set key. */
export const hexKey = (h: Hex): string => `${h.q},${h.r}`;

export const parseHexKey = (key: string): Hex => {
  const [qStr, rStr] = key.split(',');
  if (qStr === undefined || rStr === undefined) {
    throw new Error(`Invalid hex key: ${key}`);
  }
  return { q: Number(qStr), r: Number(rStr) };
};
