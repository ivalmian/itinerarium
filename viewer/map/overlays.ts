/**
 * Heat-map overlays — tint hex cells based on derived per-hex scalars.
 *
 * Recomputed on each tick when an overlay is active. The scalar is normalized
 * across the visible grid and mapped to a viridis-ish ramp via tinting the
 * existing hex Graphics. Setting overlay='none' restores white tints.
 *
 * Five overlays per docs/16-viewer:
 *   - population density: catchment hexes around populous settlements
 *   - grain price: last clearing price at the nearest settlement
 *   - bandit threat: proximity to active camps (within 8 hex falloff)
 *   - patrol coverage: proximity to patrol positions (within 8 hex falloff)
 */

import { hexDistance, hexKey, type Hex } from '../../src/sim/world/hex.js';
import { resourceId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import type { HexMap } from './hexMap.js';
import type { OverlayKind } from '../state/viewerState.js';

const GRAIN = resourceId('food.grain');

export const applyOverlay = (
  world: WorldState,
  hexMap: HexMap,
  kind: OverlayKind,
): void => {
  if (kind === 'none') {
    hexMap.clearTints();
    return;
  }
  const scores = computeScores(world, kind);
  if (scores === null) {
    hexMap.clearTints();
    return;
  }
  const { values, max, min } = scores;
  if (max <= min) {
    hexMap.clearTints();
    return;
  }
  for (const [key, score] of values) {
    const t = (score - min) / (max - min);
    const tint = ramp(t, kind);
    const [qStr, rStr] = key.split(',');
    if (qStr === undefined || rStr === undefined) continue;
    hexMap.setTint({ q: Number(qStr), r: Number(rStr) }, tint);
  }
};

interface Scored {
  readonly values: Map<string, number>;
  readonly min: number;
  readonly max: number;
}

const computeScores = (world: WorldState, kind: OverlayKind): Scored | null => {
  const values = new Map<string, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const note = (h: Hex, v: number): void => {
    values.set(hexKey(h), v);
    if (v < min) min = v;
    if (v > max) max = v;
  };

  if (kind === 'population') {
    // Per-hex population density: each settlement contributes its total pop
    // distributed across its urban + catchment hexes.
    for (const s of world.settlements.values()) {
      const pop = s.population.total();
      const totalHexes = s.urbanHexes.length + s.catchmentHexes.length;
      if (totalHexes === 0) continue;
      const perHex = pop / totalHexes;
      // Urban hexes get 5× the per-hex density (concentrated city core).
      for (const h of s.urbanHexes) note(h, perHex * 5);
      for (const h of s.catchmentHexes) note(h, perHex);
    }
    return values.size === 0 ? null : { values, min, max };
  }

  if (kind === 'grain_price') {
    for (const s of world.settlements.values()) {
      const price = s.market.lastClearingPrice.get(GRAIN);
      if (price === undefined) continue;
      for (const h of s.urbanHexes) note(h, price);
      for (const h of s.catchmentHexes) note(h, price);
    }
    return values.size === 0 ? null : { values, min, max };
  }

  if (kind === 'bandit_threat') {
    const camps = world.banditCamps;
    if (camps === undefined || camps.size === 0) return null;
    // Score each grid hex by max(0, 8 - distance) summed over nearby camps,
    // weighted by camp size.
    for (const h of world.grid.hexes()) {
      let score = 0;
      for (const c of camps.values()) {
        const d = hexDistance(h, c.hex);
        if (d > 8) continue;
        score += (8 - d) * Math.max(1, c.banditCount);
      }
      if (score > 0) note(h, score);
    }
    return values.size === 0 ? null : { values, min, max };
  }

  if (kind === 'patrol_coverage') {
    const patrols = world.patrols;
    if (patrols === undefined || patrols.size === 0) return null;
    for (const h of world.grid.hexes()) {
      let score = 0;
      for (const p of patrols.values()) {
        const d = hexDistance(h, p.position);
        if (d > 8) continue;
        score += 8 - d;
      }
      if (score > 0) note(h, score);
    }
    return values.size === 0 ? null : { values, min, max };
  }

  return null;
};

/** Cheap viridis-ish ramp keyed by overlay kind for visual differentiation. */
const ramp = (t: number, kind: OverlayKind): number => {
  const tt = Math.max(0, Math.min(1, t));
  switch (kind) {
    case 'population':
      // Yellow → orange → red (heat).
      return lerpRgb(0xfff7c0, 0xb22222, tt);
    case 'grain_price':
      // Pale yellow (cheap) → deep red (expensive).
      return lerpRgb(0xfffacd, 0x8b0000, tt);
    case 'bandit_threat':
      // Pale gray → black-red.
      return lerpRgb(0xb0a0a0, 0x550000, tt);
    case 'patrol_coverage':
      // Pale blue → deep blue.
      return lerpRgb(0xcfe2ff, 0x143a72, tt);
    case 'none':
      return 0xffffff;
  }
};

const lerpRgb = (a: number, b: number, t: number): number => {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
};
