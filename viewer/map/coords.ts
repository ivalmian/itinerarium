/**
 * Axial (q, r) → screen pixel conversion for pointy-top hexes.
 *
 * Reference: https://www.redblobgames.com/grids/hexagons/
 *
 * Pointy-top layout. The hex "size" is the radius from center to corner. With
 * size = R the hex's width is sqrt(3) * R and height is 2 * R.
 *
 * docs/01-simulation-frame.md fixes 1 hex = 1 km. This module is purely about
 * pixel layout for the viewer; the world treats q/r as kilometres directly.
 */

import type { Hex } from '../../src/sim/world/hex.js';

export interface Pixel {
  readonly x: number;
  readonly y: number;
}

const SQRT3 = Math.sqrt(3);

/** Default hex radius in pixels at zoom = 1. */
export const DEFAULT_HEX_SIZE = 8;

export const hexToPixel = (h: Hex, size: number): Pixel => ({
  x: size * (SQRT3 * h.q + (SQRT3 / 2) * h.r),
  y: size * (1.5 * h.r),
});

/** Inverse of hexToPixel; useful for picking a hex from a click. Rounds via cube. */
export const pixelToHex = (p: Pixel, size: number): Hex => {
  const q = ((SQRT3 / 3) * p.x - (1 / 3) * p.y) / size;
  const r = ((2 / 3) * p.y) / size;
  return cubeRoundAxial(q, r);
};

const cubeRoundAxial = (qf: number, rf: number): Hex => {
  const xf = qf;
  const zf = rf;
  const yf = -xf - zf;
  let rx = Math.round(xf);
  let ry = Math.round(yf);
  let rz = Math.round(zf);
  const dx = Math.abs(rx - xf);
  const dy = Math.abs(ry - yf);
  const dz = Math.abs(rz - zf);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
};

/** Width and height of a single pointy-top hex at the given size. */
export const hexDimensions = (size: number): { width: number; height: number } => ({
  width: SQRT3 * size,
  height: 2 * size,
});
