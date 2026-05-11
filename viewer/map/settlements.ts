/**
 * Settlement glyph layer — tier-aware SVG sprites with same-hex stacking.
 *
 * Per docs/16-viewer §"Settlement glyph sizing" we still scale gently with
 * population, but the shape itself encodes the tier via the painterly-vector
 * SVG in viewer/art/settlements/<tier>.svg:
 *
 *   - Hamlet     : a single round wattle-and-daub hut.
 *   - Village    : 2-3 houses around a central one, well + garden plots.
 *   - Town       : ~5 houses + central market hall + bell tower.
 *   - Small city : walled compound with gate towers + temple + bath.
 *   - Large city : massive wall + multiple towers + grand temple + basilica
 *                  + plaza column.
 *
 * Per docs/05 §"Same-hex coexistence" multiple settlements may share a hex
 * (e.g. a pagus and its dependent hamlets). We group by anchor hex; if a hex
 * holds N settlements we offset them around a small ring so each glyph is
 * individually visible and clickable. With N ≥ 7 we shrink the per-glyph
 * radius and add a "+N" badge above the cluster.
 *
 * Each glyph is a Pixi Sprite. Click events stop propagation so the
 * background pan handler doesn't see them.
 */

import { Container, FederatedPointerEvent, Graphics, Sprite, Text } from 'pixi.js';
import {
  type Settlement,
  type SettlementTier,
  typicalPopForTier,
} from '../../src/sim/world/settlement.js';
import type { SettlementId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexKey } from '../../src/sim/world/hex.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry } from '../art/index.js';

/** Pixel diameter of each tier's glyph at population = typicalPop. We
 *  scale slightly up/down from there via a log10 population factor. */
const BASE_PX: Record<SettlementTier, number> = {
  hamlet: 14,
  village: 18,
  town: 24,
  small_city: 32,
  large_city: 40,
};

export const settlementGlyphRadius = (tier: SettlementTier, population: number): number => {
  const typical = typicalPopForTier(tier);
  const safePop = Number.isFinite(population) && population > 0 ? population : 1;
  const factor = 1 + 0.15 * Math.log10(safePop / typical);
  return (BASE_PX[tier] * Math.max(0.7, factor)) / 2;
};

export interface SettlementsLayer {
  readonly container: Container;
  sync(world: WorldState, hexSize: number): void;
  setHighlight(id: SettlementId | null): void;
}

interface Entry {
  readonly id: SettlementId;
  readonly sprite: Sprite;
  readonly halo: Graphics;
}

export const createSettlementsLayer = (
  art: ArtRegistry,
  onSelect: (id: SettlementId) => void,
): SettlementsLayer => {
  const container = new Container();
  container.label = 'settlements';
  container.eventMode = 'passive';
  const entries = new Map<SettlementId, Entry>();
  const badges = new Map<string, Text>();
  let highlightedId: SettlementId | null = null;

  const sync = (world: WorldState, hexSize: number): void => {
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
      const shrink = list.length >= 7 ? 0.65 : 1.0;

      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        seen.add(s.id);
        let entry = entries.get(s.id);
        if (entry === undefined) {
          entry = makeEntry(s, art, onSelect);
          container.addChild(entry.halo);
          container.addChild(entry.sprite);
          entries.set(s.id, entry);
        } else {
          // Tier may have changed (settlement grew or shrank).
          entry.sprite.texture = art.settlement(s.tier);
        }
        const off = offsets[i]!;
        const r = settlementGlyphRadius(s.tier, s.population.total()) * shrink;
        entry.sprite.width = r * 2;
        entry.sprite.height = r * 2;
        entry.sprite.position.set(center.x + off.x, center.y + off.y);
        const isHi = s.id === highlightedId;
        entry.halo.visible = isHi;
        if (isHi) {
          entry.halo.clear();
          entry.halo.circle(0, 0, r + 2).stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 });
          entry.halo.position.set(center.x + off.x, center.y + off.y);
        }
        // Hit area stays a generous circle so small hamlets remain clickable.
        const hr = Math.max(r, 6);
        entry.sprite.hitArea = { contains: (x: number, y: number) => x * x + y * y <= hr * hr };
      }

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
        badge.position.set(center.x - badge.width / 2, center.y - hexSize * 0.85);
      }
    }

    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        container.removeChild(entry.sprite);
        container.removeChild(entry.halo);
        entry.sprite.destroy();
        entry.halo.destroy();
        entries.delete(id);
      }
    }
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
  s: Settlement,
  art: ArtRegistry,
  onSelect: (id: SettlementId) => void,
): Entry => {
  const sprite = new Sprite(art.settlement(s.tier));
  sprite.anchor.set(0.5, 0.5);
  sprite.eventMode = 'static';
  sprite.cursor = 'pointer';
  sprite.on('pointerdown', (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onSelect(s.id);
  });
  const halo = new Graphics();
  halo.eventMode = 'none';
  halo.visible = false;
  return { id: s.id, sprite, halo };
};

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
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    out.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return out;
};
