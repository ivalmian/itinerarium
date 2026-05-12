/**
 * Sub-hex building markers, rasterized from viewer/art/buildings/*.svg.
 *
 * For every building in every settlement we draw a small sprite on the
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
 * Rebuild policy: app.ts rebuilds the layer from scratch on first paint and
 * whenever a tick produces a `building_completed` event.
 */

import { Container, Sprite, Text, Texture } from 'pixi.js';
import type { BuildingId } from '../../src/sim/types.js';
import type { Settlement } from '../../src/sim/world/settlement.js';
import type { WorldState } from '../../src/procgen/seed.js';
import { hexKey, type Hex } from '../../src/sim/world/hex.js';
import { hexToPixel } from './coords.js';
import type { ArtRegistry } from '../art/index.js';

const ICON_PX = 7;
const ICON_ALPHA = 0.92;

/**
 * Stable zIndex hash for a building id. Pixi orders siblings by `zIndex`
 * when `sortableChildren = true`; without a stable order, pooled sprites
 * get re-attached in pool-pop (LIFO) order, which makes the foreground /
 * background pairing of buildings on a shared hex flip every rebuild.
 */
const buildingZIndex = (id: BuildingId): number => {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export interface BuildingsLayer {
  readonly container: Container;
  rebuild(world: WorldState, hexSize: number): void;
}

export const createBuildingsLayer = (art: ArtRegistry): BuildingsLayer => {
  const container = new Container();
  container.label = 'buildings';
  container.eventMode = 'none';
  // Enable z-ordering so sibling building sprites on a shared hex never
  // flip front/back across rebuilds — each sprite picks up a stable
  // zIndex from its buildingId hash in `drawBuildingIcon`.
  container.sortableChildren = true;
  const spritePool: Sprite[] = [];
  const labelPool: Text[] = [];
  const activeSprites: Sprite[] = [];
  const activeLabels: Text[] = [];

  const acquireSprite = (tex: Texture, zIndex: number): Sprite => {
    const s = spritePool.pop() ?? new Sprite();
    if (s.parent === null) container.addChild(s);
    s.texture = tex;
    s.anchor.set(0.5, 0.5);
    s.width = ICON_PX;
    s.height = ICON_PX;
    s.alpha = ICON_ALPHA;
    s.visible = true;
    s.zIndex = zIndex;
    activeSprites.push(s);
    return s;
  };

  const acquireLabel = (): Text => {
    const t = labelPool.pop() ?? new Text({
      text: '',
      style: { fontSize: 7, fill: 0x111111, fontFamily: 'monospace' },
    });
    if (t.parent === null) container.addChild(t);
    t.visible = true;
    t.alpha = 0.85;
    // Labels always render above their icons regardless of icon zIndex
    // hash. The constant is well above any 32-bit hash.
    t.zIndex = 0x1_0000_0000;
    activeLabels.push(t);
    return t;
  };

  const releaseActive = (): void => {
    for (const s of activeSprites) {
      s.visible = false;
      spritePool.push(s);
    }
    activeSprites.length = 0;
    for (const t of activeLabels) {
      t.visible = false;
      labelPool.push(t);
    }
    activeLabels.length = 0;
  };

  const trimPools = (): void => {
    const spriteKeep = Math.max(64, activeSprites.length);
    while (spritePool.length > spriteKeep) {
      const s = spritePool.pop()!;
      container.removeChild(s);
      s.destroy();
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
      drawSettlementBuildings(s, hexSize, art, acquireSprite, acquireLabel);
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
  art: ArtRegistry,
  acquireSprite: (tex: Texture, zIndex: number) => Sprite,
  acquireLabel: () => Text,
): void => {
  if (s.buildings.length === 0) return;

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
    // Sort buckets by buildingId for a deterministic ring layout. The
    // z-order is independent (it comes from the buildingId hash) so the
    // sprites themselves don't flip front/back across rebuilds even as
    // pooled Sprite instances get reused in LIFO order.
    const sorted = list
      .slice()
      .sort((a, b) => String(a.buildingId).localeCompare(String(b.buildingId)));
    if (sorted.length === 1) {
      drawBuildingIcon(sorted[0]!, center.x, center.y, art, acquireSprite, acquireLabel);
    } else {
      const ringR = hexSize * 0.32;
      for (let i = 0; i < sorted.length; i++) {
        const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
        const x = center.x + Math.cos(angle) * ringR;
        const y = center.y + Math.sin(angle) * ringR;
        drawBuildingIcon(sorted[i]!, x, y, art, acquireSprite, acquireLabel);
      }
    }
  }
};

const drawBuildingIcon = (
  bucket: Bucket,
  x: number,
  y: number,
  art: ArtRegistry,
  acquireSprite: (tex: Texture, zIndex: number) => Sprite,
  acquireLabel: () => Text,
): void => {
  const tex = art.building(bucket.buildingId);
  const s = acquireSprite(tex, buildingZIndex(bucket.buildingId));
  s.position.set(x, y);

  if (bucket.count > 1) {
    const t = acquireLabel();
    t.text = `×${bucket.count}`;
    t.position.set(x + 3, y - 4);
  }
};
