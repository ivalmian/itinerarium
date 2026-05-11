/**
 * Sub-hex building markers.
 *
 * For every building in every settlement we draw a small icon on the
 * building's hex. Multiple buildings share a hex frequently — a settlement's
 * urban anchor often hosts mill + bakery + smithy together. To keep the layer
 * legible:
 *
 *   - Buildings are bucketed by (hex, buildingId). One icon per bucket.
 *   - When a bucket has count > 1 we add a small "×N" subscript next to the
 *     icon.
 *   - Buildings of *different* kinds on the same hex are arrayed in a small
 *     ring around the hex center (deterministic angle by buildingId hash) so
 *     they don't perfectly overlap.
 *
 * Icons are intentionally subtle (~3-4 px, alpha ≈ 0.7) per the task spec —
 * settlement glyphs and roads are the primary visual layer; buildings are a
 * legible-on-zoom-in detail.
 *
 * Per docs/05 §"Building catalog (v1)" we cover the production + storage
 * catalog. Civic / military / infrastructure buildings (forum, walls,
 * barracks, aqueducts, road segments) get a generic civic-mark fallback so
 * they're at least visible without dominating.
 *
 * Rebuild policy: app.ts rebuilds the layer from scratch on first paint and
 * whenever a tick produces a `building_completed` event (per task spec §3:
 * "v1 simple approach: rebuild the layer from scratch each tick that has a
 * building_completed event in the result").
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { BuildingId } from '../../src/sim/types.js';
import type { Settlement } from '../../src/sim/world/settlement.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexEquals, hexKey, type Hex } from '../../src/sim/world/hex.js';
import { hexToPixel } from './coords.js';

export interface BuildingsLayer {
  readonly container: Container;
  rebuild(world: WorldState, hexSize: number): void;
}

export const createBuildingsLayer = (): BuildingsLayer => {
  const container = new Container();
  container.label = 'buildings';
  container.eventMode = 'none'; // informational; clicks land on settlements
  const iconPool: Graphics[] = [];
  const labelPool: Text[] = [];
  const activeIcons: Graphics[] = [];
  const activeLabels: Text[] = [];

  const acquireIcon = (): Graphics => {
    const g = iconPool.pop() ?? new Graphics();
    if (g.parent === null) container.addChild(g);
    g.clear();
    g.alpha = ICON_ALPHA;
    g.visible = true;
    activeIcons.push(g);
    return g;
  };

  const acquireLabel = (): Text => {
    const t = labelPool.pop() ?? new Text({
      text: '',
      style: {
        fontSize: 7,
        fill: 0x111111,
        fontFamily: 'monospace',
      },
    });
    if (t.parent === null) container.addChild(t);
    t.visible = true;
    t.alpha = 0.85;
    activeLabels.push(t);
    return t;
  };

  const releaseActive = (): void => {
    for (const g of activeIcons) {
      g.clear();
      g.visible = false;
      iconPool.push(g);
    }
    activeIcons.length = 0;
    for (const t of activeLabels) {
      t.visible = false;
      labelPool.push(t);
    }
    activeLabels.length = 0;
  };

  const trimPools = (): void => {
    const iconKeep = Math.max(64, activeIcons.length);
    while (iconPool.length > iconKeep) {
      const g = iconPool.pop()!;
      container.removeChild(g);
      g.destroy();
    }

    const labelKeep = Math.max(16, activeLabels.length);
    while (labelPool.length > labelKeep) {
      const t = labelPool.pop()!;
      container.removeChild(t);
      t.destroy();
    }
  };

  const rebuild = (world: WorldState, hexSize: number): void => {
    releaseActive();
    for (const s of world.settlements.values()) {
      drawSettlementBuildings(s, hexSize, acquireIcon, acquireLabel);
    }
    trimPools();
  };

  return { container, rebuild };
};

interface Bucket {
  readonly hex: Hex;
  readonly buildingId: BuildingId;
  count: number;
}

const drawSettlementBuildings = (
  s: Settlement,
  hexSize: number,
  acquireIcon: () => Graphics,
  acquireLabel: () => Text,
): void => {
  if (s.buildings.length === 0) return;

  // Bucket (hex, buildingId).
  const buckets = new Map<string, Bucket>();
  for (const b of s.buildings) {
    const k = `${hexKey(b.hex)}|${String(b.buildingId)}`;
    const existing = buckets.get(k);
    if (existing === undefined) {
      buckets.set(k, { hex: b.hex, buildingId: b.buildingId, count: 1 });
    } else {
      existing.count += 1;
    }
  }

  // Group buckets by hex so we can spread different building kinds on a small
  // ring when more than one kind lives on the hex.
  const byHex = new Map<string, Bucket[]>();
  for (const bucket of buckets.values()) {
    const k = hexKey(bucket.hex);
    let list = byHex.get(k);
    if (list === undefined) {
      list = [];
      byHex.set(k, list);
    }
    list.push(bucket);
  }

  for (const [, list] of byHex) {
    const center = hexToPixel(list[0]!.hex, hexSize);
    if (list.length === 1) {
      drawBuildingIcon(list[0]!, center.x, center.y, hexSize, acquireIcon, acquireLabel);
    } else {
      // Sort for stable angle assignment (deterministic across rebuilds).
      const sorted = list.slice().sort((a, b) => String(a.buildingId).localeCompare(String(b.buildingId)));
      const ringR = hexSize * 0.35;
      for (let i = 0; i < sorted.length; i++) {
        const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
        const x = center.x + Math.cos(angle) * ringR;
        const y = center.y + Math.sin(angle) * ringR;
        drawBuildingIcon(sorted[i]!, x, y, hexSize, acquireIcon, acquireLabel);
      }
    }
  }
};

const ICON_ALPHA = 0.72;
const ICON_SCALE = 1.0; // base size; individual icons set their own pixel sizes

const drawBuildingIcon = (
  bucket: Bucket,
  x: number,
  y: number,
  _hexSize: number,
  acquireIcon: () => Graphics,
  acquireLabel: () => Text,
): void => {
  const id = String(bucket.buildingId);
  const g = acquireIcon();
  g.position.set(x, y);
  drawIconShape(g, id);

  if (bucket.count > 1) {
    const t = acquireLabel();
    t.text = `×${bucket.count}`;
    t.position.set(x + 3.5, y - 4.5);
  }
};

/**
 * Per-building-kind glyph. All glyphs are drawn centered on the origin and
 * are ≤ ~4 px in radius; the caller positions the Graphics. Colors are
 * picked to read against typical terrain tints (greens, browns, golds) without
 * being garish.
 */
const drawIconShape = (g: Graphics, id: string): void => {
  const s = ICON_SCALE;
  switch (id) {
    case 'farm': {
      // Wheat-sheaf hint: short golden vertical stalks fanning slightly.
      const stalk = 0xd9b84a;
      g.moveTo(-2 * s, 2 * s).lineTo(-1.5 * s, -2 * s).stroke({ color: stalk, width: 0.9 });
      g.moveTo(0, 2 * s).lineTo(0, -2.3 * s).stroke({ color: stalk, width: 0.9 });
      g.moveTo(2 * s, 2 * s).lineTo(1.5 * s, -2 * s).stroke({ color: stalk, width: 0.9 });
      // Tie band.
      g.moveTo(-2 * s, 1 * s).lineTo(2 * s, 1 * s).stroke({ color: 0x6a4d1c, width: 0.8 });
      return;
    }
    case 'pasture': {
      // Three small light-grey rounded blobs (sheep) clustered.
      const wool = 0xe6e0d2;
      g.circle(-1.5 * s, 0.5 * s, 1.2 * s).fill({ color: wool });
      g.circle(1.4 * s, 0.6 * s, 1.2 * s).fill({ color: wool });
      g.circle(0, -1 * s, 1.2 * s).fill({ color: wool });
      return;
    }
    case 'mine': {
      // Black pick-axe X.
      const c = 0x111111;
      g.moveTo(-2.5 * s, -2.5 * s).lineTo(2.5 * s, 2.5 * s).stroke({ color: c, width: 1.1 });
      g.moveTo(-2.5 * s, 2.5 * s).lineTo(2.5 * s, -2.5 * s).stroke({ color: c, width: 1.1 });
      return;
    }
    case 'quarry': {
      // Stone block: small grey square.
      g.rect(-2 * s, -2 * s, 4 * s, 4 * s).fill({ color: 0x8a8079 }).stroke({ color: 0x4d4742, width: 0.6 });
      return;
    }
    case 'forester_camp': {
      // Tiny conifer.
      const trunk = 0x5a3a1a;
      const needles = 0x2f5a2a;
      g.moveTo(0, -3 * s).lineTo(-2 * s, 2 * s).lineTo(2 * s, 2 * s).closePath().fill({ color: needles });
      g.rect(-0.5 * s, 2 * s, 1 * s, 1.5 * s).fill({ color: trunk });
      return;
    }
    case 'sawmill': {
      // Brown plank with a saw-tooth top edge.
      const wood = 0x8b6230;
      g.rect(-2.5 * s, -0.5 * s, 5 * s, 2 * s).fill({ color: wood });
      g.moveTo(-2.5 * s, -0.5 * s)
        .lineTo(-1.5 * s, -2 * s)
        .lineTo(-0.5 * s, -0.5 * s)
        .lineTo(0.5 * s, -2 * s)
        .lineTo(1.5 * s, -0.5 * s)
        .lineTo(2.5 * s, -2 * s)
        .stroke({ color: 0x4a3618, width: 0.7 });
      return;
    }
    case 'mill': {
      // Watermill wheel: outer circle + 4 spokes + axle.
      g.circle(0, 0, 3 * s).stroke({ color: 0x4a3618, width: 0.8 });
      g.moveTo(-3 * s, 0).lineTo(3 * s, 0).stroke({ color: 0x4a3618, width: 0.5 });
      g.moveTo(0, -3 * s).lineTo(0, 3 * s).stroke({ color: 0x4a3618, width: 0.5 });
      g.circle(0, 0, 0.7 * s).fill({ color: 0x4a3618 });
      return;
    }
    case 'bakery': {
      drawFlame(g, 0xd96c2a, 0xf2c46a);
      return;
    }
    case 'bloomery': {
      drawFlame(g, 0xb84a16, 0xffae3a);
      return;
    }
    case 'kiln':
    case 'pottery':
    case 'charcoal_kiln': {
      // Column of smoke: stacked circles fading upward.
      const smoke = 0x7a7066;
      g.circle(0, 2 * s, 1.4 * s).fill({ color: smoke, alpha: 0.9 });
      g.circle(-0.5 * s, 0.2 * s, 1.2 * s).fill({ color: smoke, alpha: 0.7 });
      g.circle(0.6 * s, -1.6 * s, 1.0 * s).fill({ color: smoke, alpha: 0.5 });
      return;
    }
    case 'granary':
    case 'warehouse': {
      // Sack: rounded-bottom trapezoid with a tied neck.
      const sack = id === 'granary' ? 0xc9a45c : 0x9a7d4f;
      g.moveTo(-2 * s, -1.5 * s)
        .lineTo(2 * s, -1.5 * s)
        .lineTo(2.5 * s, 2 * s)
        .lineTo(-2.5 * s, 2 * s)
        .closePath()
        .fill({ color: sack });
      // Tied neck (small rectangle pinch at top).
      g.rect(-0.8 * s, -2.5 * s, 1.6 * s, 1 * s).fill({ color: 0x4a3618 });
      return;
    }
    case 'cistern': {
      // Blue water pool with a stone rim.
      g.circle(0, 0, 2.4 * s).fill({ color: 0x3b6a8c }).stroke({ color: 0x4a3a2a, width: 0.7 });
      return;
    }
    case 'smithy': {
      // Hammer: small head + handle.
      g.rect(-2.5 * s, -2 * s, 3 * s, 1.5 * s).fill({ color: 0x4a4a52 });
      g.moveTo(0, -1 * s).lineTo(2.5 * s, 2 * s).stroke({ color: 0x6a4a26, width: 1.2 });
      return;
    }
    case 'weaver_workshop':
    case 'tailor_shop': {
      // Spool of thread: small horizontal bobbin.
      g.rect(-2.2 * s, -1.5 * s, 4.4 * s, 3 * s).fill({ color: 0xb38a3d });
      g.moveTo(-2.2 * s, -0.6 * s).lineTo(2.2 * s, -0.6 * s).stroke({ color: 0xeed6a6, width: 0.5 });
      g.moveTo(-2.2 * s, 0.6 * s).lineTo(2.2 * s, 0.6 * s).stroke({ color: 0xeed6a6, width: 0.5 });
      return;
    }
    case 'winery':
    case 'oil_press': {
      // Amphora silhouette.
      const c = id === 'winery' ? 0x7a2a3a : 0x4a6a2a;
      g.moveTo(-1.5 * s, -2.5 * s).lineTo(-2 * s, 0).lineTo(-1 * s, 2.5 * s).lineTo(1 * s, 2.5 * s).lineTo(2 * s, 0).lineTo(1.5 * s, -2.5 * s).closePath().fill({ color: c });
      // Handles.
      g.moveTo(-1.5 * s, -2 * s).lineTo(-2.5 * s, -1 * s).stroke({ color: c, width: 0.7 });
      g.moveTo(1.5 * s, -2 * s).lineTo(2.5 * s, -1 * s).stroke({ color: c, width: 0.7 });
      return;
    }
    case 'dairy': {
      // Milk jug: small white pitcher.
      g.rect(-1.6 * s, -1 * s, 3.2 * s, 3 * s).fill({ color: 0xf2eedb }).stroke({ color: 0x4a3a2a, width: 0.5 });
      g.moveTo(1.6 * s, -1 * s).lineTo(2.4 * s, 0).lineTo(1.6 * s, 0.5 * s).fill({ color: 0xf2eedb }).stroke({ color: 0x4a3a2a, width: 0.5 });
      return;
    }
    case 'tannery': {
      // Stretched hide: brown irregular quad.
      g.moveTo(-2.5 * s, -1.5 * s)
        .lineTo(2 * s, -2 * s)
        .lineTo(2.5 * s, 2 * s)
        .lineTo(-2 * s, 1.5 * s)
        .closePath()
        .fill({ color: 0x7a5a3a });
      return;
    }
    case 'fishery': {
      // Small fish silhouette.
      g.moveTo(-2.5 * s, 0)
        .lineTo(0, -1.4 * s)
        .lineTo(2 * s, 0)
        .lineTo(0, 1.4 * s)
        .closePath()
        .fill({ color: 0x4a6a8a });
      g.moveTo(2 * s, 0).lineTo(3 * s, -1 * s).lineTo(3 * s, 1 * s).closePath().fill({ color: 0x4a6a8a });
      return;
    }
    case 'vineyard': {
      // Grape cluster: 4 small purple dots.
      const grape = 0x6a3a8a;
      g.circle(-1 * s, -0.5 * s, 0.9 * s).fill({ color: grape });
      g.circle(1 * s, -0.5 * s, 0.9 * s).fill({ color: grape });
      g.circle(0, 0.6 * s, 0.9 * s).fill({ color: grape });
      g.circle(0, -1.6 * s, 0.7 * s).fill({ color: grape });
      return;
    }
    case 'olive_grove': {
      // Olive: green oval.
      g.circle(0, 0, 2 * s).fill({ color: 0x6a8a3a });
      g.circle(-0.7 * s, -0.5 * s, 0.5 * s).fill({ color: 0xb6c474, alpha: 0.7 });
      return;
    }
    case 'orchard': {
      // Round-topped tree.
      g.circle(0, -0.5 * s, 2 * s).fill({ color: 0x4a7a3a });
      g.rect(-0.4 * s, 1 * s, 0.8 * s, 1.5 * s).fill({ color: 0x5a3a1a });
      return;
    }
    case 'cart_wright': {
      // Wheel: circle + spokes.
      g.circle(0, 0, 2.5 * s).stroke({ color: 0x4a3618, width: 0.8 });
      g.moveTo(-2.5 * s, 0).lineTo(2.5 * s, 0).stroke({ color: 0x4a3618, width: 0.5 });
      g.moveTo(0, -2.5 * s).lineTo(0, 2.5 * s).stroke({ color: 0x4a3618, width: 0.5 });
      return;
    }
    case 'mint': {
      // Coin: gold disc with a dot.
      g.circle(0, 0, 2.2 * s).fill({ color: 0xd9b84a }).stroke({ color: 0x6a4d1c, width: 0.5 });
      g.circle(0, 0, 0.5 * s).fill({ color: 0x6a4d1c });
      return;
    }
    case 'temple': {
      // Tiny pediment: triangle on a base.
      const c = 0xe8d9b5;
      g.moveTo(-2.5 * s, -0.5 * s).lineTo(0, -2.5 * s).lineTo(2.5 * s, -0.5 * s).closePath().fill({ color: c });
      g.rect(-2.5 * s, -0.5 * s, 5 * s, 2.5 * s).fill({ color: c }).stroke({ color: 0x4a3a2a, width: 0.4 });
      return;
    }
    case 'forum_market': {
      // Open square with central dot.
      g.rect(-2.5 * s, -2.5 * s, 5 * s, 5 * s).stroke({ color: 0x6a4a26, width: 0.7 });
      g.circle(0, 0, 0.7 * s).fill({ color: 0x6a4a26 });
      return;
    }
    case 'walls':
    case 'barracks':
    case 'aqueduct_segment':
    case 'road_segment': {
      // Civic/military fallback: small grey square so they're visible but
      // don't visually compete with productive workshops.
      g.rect(-1.5 * s, -1.5 * s, 3 * s, 3 * s).fill({ color: 0x6a625a, alpha: 0.6 });
      return;
    }
    default: {
      // Unknown building kinds: a tiny neutral dot. Forces nothing to break
      // if a future catalog entry slips through before we update this map.
      g.circle(0, 0, 1.4 * s).fill({ color: 0x6a625a });
      return;
    }
  }
};

const drawFlame = (g: Graphics, base: number, tip: number): void => {
  // Simple flame: tear-drop polygon, base + tip color.
  g.moveTo(0, -3).lineTo(1.6, 0).lineTo(1.2, 2).lineTo(0, 3).lineTo(-1.2, 2).lineTo(-1.6, 0).closePath().fill({ color: base });
  g.moveTo(0, -2).lineTo(0.8, 0).lineTo(0, 1).lineTo(-0.8, 0).closePath().fill({ color: tip });
};

// Helper exported for tests if needed in future. (Currently unused by tests
// but keeps a stable surface for future smoke tests.)
export const sameHex = hexEquals;
