/**
 * Settlement glyph layer.
 *
 * One PIXI.Graphics circle per settlement, colored by tier and sized by
 * log10(population). Population can change every tick, so we resize on each
 * sync(). Settlements are clickable — click events are forwarded via the
 * onSelect callback.
 *
 * docs/16-viewer §"Settlement glyph sizing":
 *   r = baseR + log10(max(1, pop)) * scaleR    (baseR=4, scaleR=6)
 */

import { Container, FederatedPointerEvent, Graphics } from 'pixi.js';
import type { Settlement, SettlementTier } from '../../src/sim/world/settlement.js';
import type { SettlementId } from '../../src/sim/types.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexToPixel } from './coords.js';

const TIER_COLOR: Record<SettlementTier, number> = {
  hamlet: 0xc4a06a,
  village: 0xa07a45,
  town: 0x6a4a26,
  small_city: 0xd2a44b,
  large_city: 0xf0c66c,
};

const BASE_R = 4;
const SCALE_R = 6;

export const settlementRadiusPx = (population: number): number =>
  BASE_R + Math.log10(Math.max(1, population)) * SCALE_R;

export interface SettlementsLayer {
  readonly container: Container;
  /** Reposition + resize all glyphs based on current world state. */
  sync(world: WorldState, hexSize: number): void;
  /** Highlight (or un-highlight) a particular settlement. */
  setHighlight(id: SettlementId | null): void;
}

interface Entry {
  readonly id: SettlementId;
  readonly graphic: Graphics;
  readonly tier: SettlementTier;
}

export const createSettlementsLayer = (
  onSelect: (id: SettlementId) => void,
): SettlementsLayer => {
  const container = new Container();
  container.label = 'settlements';
  container.eventMode = 'passive';
  const entries = new Map<SettlementId, Entry>();
  let highlightedId: SettlementId | null = null;

  const sync = (world: WorldState, hexSize: number): void => {
    // Add new entries; resize / reposition existing ones.
    const seen = new Set<SettlementId>();
    for (const s of world.settlements.values()) {
      seen.add(s.id);
      let entry = entries.get(s.id);
      if (entry === undefined) {
        entry = makeEntry(s, onSelect);
        container.addChild(entry.graphic);
        entries.set(s.id, entry);
      }
      const pop = s.population.total();
      const r = settlementRadiusPx(pop);
      const px = hexToPixel(s.anchor, hexSize);
      drawGlyph(entry.graphic, r, TIER_COLOR[s.tier], s.id === highlightedId, s.tier);
      entry.graphic.position.set(px.x, px.y);
    }
    // Remove deleted entries.
    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        container.removeChild(entry.graphic);
        entry.graphic.destroy();
        entries.delete(id);
      }
    }
  };

  const setHighlight = (id: SettlementId | null): void => {
    highlightedId = id;
  };

  return { container, sync, setHighlight };
};

const makeEntry = (s: Settlement, onSelect: (id: SettlementId) => void): Entry => {
  const g = new Graphics();
  g.eventMode = 'static';
  g.cursor = 'pointer';
  g.on('pointerdown', (e: FederatedPointerEvent) => {
    e.stopPropagation();
    onSelect(s.id);
  });
  return { id: s.id, graphic: g, tier: s.tier };
};

const drawGlyph = (
  g: Graphics,
  radius: number,
  color: number,
  highlighted: boolean,
  tier: SettlementTier,
): void => {
  g.clear();
  g.circle(0, 0, radius).fill({ color });
  // Large cities get an outline always; selected anything gets bright accent.
  if (highlighted) {
    g.circle(0, 0, radius + 2).stroke({ color: 0xffffff, width: 2 });
  } else if (tier === 'large_city') {
    g.circle(0, 0, radius + 1).stroke({ color: 0x000000, width: 1 });
  } else {
    g.circle(0, 0, radius).stroke({ color: 0x000000, width: 0.5 });
  }
  // Hit area is the bigger of the radius or 6px so small hamlets stay clickable.
  g.hitArea = { contains: (x: number, y: number) => x * x + y * y <= Math.max(radius, 6) ** 2 };
};
