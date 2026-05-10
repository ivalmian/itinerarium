/**
 * Settlement glyph layer — tier-aware shapes with same-hex stacking.
 *
 * Per docs/16-viewer §"Settlement glyph sizing" we still scale gently with
 * population, but the shape itself encodes the tier:
 *
 *   - Hamlet     : a single small house (peaked roof + body).
 *   - Village    : a cluster of 2-3 houses with a slightly larger center.
 *   - Town       : ~5 houses around a central hall.
 *   - Small city : walled compound — circular wall + 3-4 inner houses + tower.
 *   - Large city : bigger walled compound + multiple towers + a forum dot.
 *
 * Per docs/05 §"Same-hex coexistence" multiple settlements may share a hex
 * (e.g. a pagus and its dependent hamlets). We group by anchor hex; if a hex
 * holds N settlements we offset them around a small ring so each glyph is
 * individually visible and clickable. With N ≥ 7 we shrink the per-glyph
 * radius and add a "+N" badge above the cluster.
 *
 * Each glyph is a single PIXI.Graphics. Click events stop propagation so the
 * background pan handler doesn't see them. Hit testing uses an axis-aligned
 * bounding circle around the glyph's drawn position.
 */

import { Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import {
  type Settlement,
  type SettlementTier,
  typicalPopForTier,
} from '../../src/sim/world/settlement.js';
import type { SettlementId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexKey } from '../../src/sim/world/hex.js';
import { hexToPixel } from './coords.js';

const TIER_COLOR: Record<SettlementTier, number> = {
  hamlet: 0xc4a06a,
  village: 0xa07a45,
  town: 0x6a4a26,
  small_city: 0xd2a44b,
  large_city: 0xf0c66c,
};

// Wall outline color per tier — browns for villages, gray for towns, gold for
// big cities. (Hamlets/villages have no wall but the outline still tints
// the glyph stroke for a coherent palette.)
const WALL_COLOR: Record<SettlementTier, number> = {
  hamlet: 0x6a4a26,
  village: 0x6a4a26,
  town: 0x4a4a52,
  small_city: 0x6a4a26,
  large_city: 0xb8862c,
};

const BASE_R: Record<SettlementTier, number> = {
  hamlet: 5,
  village: 7,
  town: 10,
  small_city: 14,
  large_city: 18,
};

/**
 * Population-scaling helper.
 *
 *   r = baseR * (1 + 0.2 * log10(max(1, pop / typicalPop)))
 *
 * Modest scaling so a 200-pop village isn't dwarfed by a 30k city. Negative
 * arguments to log10 (a tier with pop below typical) gently shrinks but never
 * to less than 60% of base.
 */
export const settlementGlyphRadius = (tier: SettlementTier, population: number): number => {
  const typical = typicalPopForTier(tier);
  const safePop = Number.isFinite(population) && population > 0 ? population : 1;
  const factor = 1 + 0.2 * Math.log10(safePop / typical);
  return BASE_R[tier] * Math.max(0.6, factor);
};

export interface SettlementsLayer {
  readonly container: Container;
  /** Reposition + redraw all glyphs based on current world state. */
  sync(world: WorldState, hexSize: number): void;
  /** Highlight (or un-highlight) a particular settlement. */
  setHighlight(id: SettlementId | null): void;
}

interface Entry {
  readonly id: SettlementId;
  readonly graphic: Graphics;
}

export const createSettlementsLayer = (
  onSelect: (id: SettlementId) => void,
): SettlementsLayer => {
  const container = new Container();
  container.label = 'settlements';
  container.eventMode = 'passive';
  const entries = new Map<SettlementId, Entry>();
  // Per-hex "+N" badges for big stacks. Keyed by hex key.
  const badges = new Map<string, Text>();
  let highlightedId: SettlementId | null = null;

  const sync = (world: WorldState, hexSize: number): void => {
    // Bucket settlements by anchor hex so we can offset stacks deterministically.
    const byHex = new Map<string, Settlement[]>();
    for (const s of world.settlements.values()) {
      const k = hexKey(s.anchor);
      let list = byHex.get(k);
      if (list === undefined) {
        list = [];
        byHex.set(k, list);
      }
      list.push(s);
    }
    // Stable order within a hex: largest population first, then settlement id
    // for ties — keeps the "primary" settlement at the conventional position
    // (center for solo, leftmost for pairs, top of the ring for 3+).
    for (const list of byHex.values()) {
      list.sort((a, b) => {
        const da = b.population.total() - a.population.total();
        if (da !== 0) return da;
        return String(a.id).localeCompare(String(b.id));
      });
    }

    const seen = new Set<SettlementId>();
    const seenBadges = new Set<string>();
    for (const [k, list] of byHex) {
      const center = hexToPixel(list[0]!.anchor, hexSize);
      const offsets = computeStackOffsets(list.length, hexSize);
      // Shrink each glyph proportionally if the stack is large.
      const shrink = list.length >= 7 ? 0.65 : 1.0;

      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        seen.add(s.id);
        let entry = entries.get(s.id);
        if (entry === undefined) {
          entry = makeEntry(s.id, onSelect);
          container.addChild(entry.graphic);
          entries.set(s.id, entry);
        }
        const off = offsets[i]!;
        const r = settlementGlyphRadius(s.tier, s.population.total()) * shrink;
        drawGlyph(entry.graphic, s.tier, r, s.id === highlightedId);
        entry.graphic.position.set(center.x + off.x, center.y + off.y);
      }

      // Big-stack "+N" badge above the cluster.
      if (list.length >= 7) {
        seenBadges.add(k);
        let badge = badges.get(k);
        const text = `+${list.length}`;
        if (badge === undefined) {
          badge = new Text({
            text,
            style: { fontSize: 9, fill: 0xffffff, fontFamily: 'monospace' },
          });
          badge.eventMode = 'none';
          container.addChild(badge);
          badges.set(k, badge);
        } else if (badge.text !== text) {
          badge.text = text;
        }
        // Position above the ring center.
        badge.position.set(center.x - badge.width / 2, center.y - hexSize * 0.85);
      }
    }

    // Prune deleted settlements.
    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        container.removeChild(entry.graphic);
        entry.graphic.destroy();
        entries.delete(id);
      }
    }
    // Prune stale badges (hex either lost a settlement or stack dropped < 7).
    for (const [k, badge] of badges) {
      if (!seenBadges.has(k)) {
        container.removeChild(badge);
        badge.destroy();
        badges.delete(k);
      }
    }
  };

  const setHighlight = (id: SettlementId | null): void => {
    highlightedId = id;
  };

  return { container, sync, setHighlight };
};

const makeEntry = (
  id: SettlementId,
  onSelect: (id: SettlementId) => void,
): Entry => {
  const g = new Graphics();
  g.eventMode = 'static';
  g.cursor = 'pointer';
  g.on('pointerdown', (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onSelect(id);
  });
  return { id, graphic: g };
};

/**
 * Place N glyphs around the hex center.
 *   N=1: dead center.
 *   N=2: side-by-side, ±hexSize × 0.25 horizontally.
 *   N=3-6: small ring of radius hexSize × 0.3 with even angular spacing.
 *   N≥7: same ring but shrunk glyphs (handled by the caller).
 */
const computeStackOffsets = (
  n: number,
  hexSize: number,
): readonly { x: number; y: number }[] => {
  if (n <= 0) return [];
  if (n === 1) return [{ x: 0, y: 0 }];
  if (n === 2) {
    const dx = hexSize * 0.25;
    return [
      { x: -dx, y: 0 },
      { x: dx, y: 0 },
    ];
  }
  const r = hexSize * 0.3;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2; // start at top
    out.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return out;
};

/**
 * Draw a tier-appropriate settlement glyph centered on the origin. The
 * caller is responsible for setting `graphic.position`. Hit area is the
 * bounding circle of radius `r` so small hamlets remain easy to click.
 */
const drawGlyph = (
  g: Graphics,
  tier: SettlementTier,
  r: number,
  highlighted: boolean,
): void => {
  g.clear();
  const fill = TIER_COLOR[tier];
  const wall = WALL_COLOR[tier];

  switch (tier) {
    case 'hamlet':
      drawHouse(g, 0, 0, r * 0.9, fill, wall);
      break;
    case 'village': {
      // Cluster of 3 houses; the centre one slightly larger.
      const small = r * 0.55;
      const big = r * 0.7;
      drawHouse(g, -r * 0.55, r * 0.25, small, fill, wall);
      drawHouse(g, r * 0.55, r * 0.25, small, fill, wall);
      drawHouse(g, 0, -r * 0.1, big, fill, wall);
      break;
    }
    case 'town': {
      // ~5 houses around a central hall (square with a small dome).
      const size = r * 0.4;
      const ring = r * 0.7;
      for (let i = 0; i < 5; i++) {
        const angle = (2 * Math.PI * i) / 5 - Math.PI / 2;
        const x = Math.cos(angle) * ring;
        const y = Math.sin(angle) * ring;
        drawHouse(g, x, y, size, fill, wall);
      }
      // Central hall: square + dome hint.
      const hallR = r * 0.45;
      g.rect(-hallR * 0.8, -hallR * 0.4, hallR * 1.6, hallR * 1.0).fill({ color: fill }).stroke({ color: wall, width: 0.8 });
      g.moveTo(-hallR * 0.8, -hallR * 0.4).quadraticCurveTo(0, -hallR * 1.2, hallR * 0.8, -hallR * 0.4).fill({ color: fill }).stroke({ color: wall, width: 0.8 });
      break;
    }
    case 'small_city': {
      // Circular wall + 3-4 inner houses + 1 tower.
      g.circle(0, 0, r).stroke({ color: wall, width: 1.5 });
      // Faint interior fill so the city reads as a "compound" not just an outline.
      g.circle(0, 0, r - 1).fill({ color: fill, alpha: 0.35 });
      // Inner houses.
      const houseR = r * 0.32;
      drawHouse(g, -r * 0.4, -r * 0.2, houseR, fill, wall);
      drawHouse(g, r * 0.4, -r * 0.2, houseR, fill, wall);
      drawHouse(g, 0, r * 0.4, houseR, fill, wall);
      // Tower: small cylinder with merlons hint.
      drawTower(g, 0, -r * 0.55, houseR * 0.55, wall, fill);
      break;
    }
    case 'large_city': {
      // Bigger walled compound + multiple towers + a forum dot.
      g.circle(0, 0, r).stroke({ color: wall, width: 2 });
      g.circle(0, 0, r - 1.2).fill({ color: fill, alpha: 0.4 });
      // 4 towers at cardinal-ish points on the wall.
      const towerR = r * 0.18;
      for (let i = 0; i < 4; i++) {
        const angle = (2 * Math.PI * i) / 4 + Math.PI / 4;
        drawTower(g, Math.cos(angle) * r * 0.95, Math.sin(angle) * r * 0.95, towerR, wall, fill);
      }
      // Inner houses scattered.
      const houseR = r * 0.22;
      drawHouse(g, -r * 0.35, r * 0.15, houseR, fill, wall);
      drawHouse(g, r * 0.35, r * 0.15, houseR, fill, wall);
      drawHouse(g, 0, -r * 0.35, houseR, fill, wall);
      // Forum dot in the center.
      g.circle(0, r * 0.05, r * 0.18).fill({ color: wall });
      break;
    }
  }

  // Highlight ring (selection accent) draws on top of everything.
  if (highlighted) {
    g.circle(0, 0, r + 2).stroke({ color: 0xffffff, width: 2 });
  }

  // Hit area is a circle of radius max(r, 6) so small hamlets stay clickable.
  const hr = Math.max(r, 6);
  g.hitArea = { contains: (x: number, y: number) => x * x + y * y <= hr * hr };
};

/**
 * Tiny house: rectangular body + triangular roof. Drawn centered at (cx, cy).
 * `r` is the bounding-box half-extent.
 */
const drawHouse = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  fill: number,
  stroke: number,
): void => {
  const w = r * 1.6;
  const h = r * 1.4;
  // Body.
  g.rect(cx - w / 2, cy - h / 2 + r * 0.3, w, h - r * 0.3).fill({ color: fill });
  // Roof.
  g.moveTo(cx - w / 2 - r * 0.1, cy - h / 2 + r * 0.3)
    .lineTo(cx, cy - h / 2 - r * 0.5)
    .lineTo(cx + w / 2 + r * 0.1, cy - h / 2 + r * 0.3)
    .closePath()
    .fill({ color: stroke });
  // Outline so the house remains visible against same-color terrain.
  g.rect(cx - w / 2, cy - h / 2 + r * 0.3, w, h - r * 0.3).stroke({ color: stroke, width: 0.5 });
};

/**
 * Tiny tower: vertical rectangle with a notched (merlon) top hint.
 */
const drawTower = (
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  fill: number,
  stroke: number,
): void => {
  const w = r * 1.2;
  const h = r * 2.4;
  g.rect(cx - w / 2, cy - h / 2, w, h).fill({ color: fill }).stroke({ color: fill, width: 0.6 });
  // Merlons: two small notches on top.
  g.rect(cx - w / 2, cy - h / 2 - r * 0.4, w * 0.35, r * 0.4).fill({ color: fill });
  g.rect(cx + w / 2 - w * 0.35, cy - h / 2 - r * 0.4, w * 0.35, r * 0.4).fill({ color: fill });
  // Use stroke to mute against bright walls only — keep it subtle so the
  // tower silhouette stays a single block of color from a distance.
  g.rect(cx - w / 2, cy - h / 2, w, h).stroke({ color: stroke, width: 0.4 });
};
