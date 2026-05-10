/**
 * Catchment shading layer.
 *
 * For every settlement, draws a faint hex-shaped fill on each catchment hex,
 * tinted by the settlement's tier color. Adjacent settlements' catchments may
 * overlap; we draw them all (additive blend) so overlap visually deepens.
 *
 * Per docs/05 §"Catchment" + §"Ownership of catchment hexes": catchment hexes
 * are real, owned land — the shading communicates which fields/forests/mines
 * belong to which settlement. Per docs/05 §"Same-hex coexistence" two
 * neighboring settlements may share fringes, so the additive blend matters.
 *
 * Z-order (per task spec): terrain → CATCHMENT → biome edges → roads → rivers
 * → buildings → settlements → caravans → bandit camps. Wired by app.ts. We
 * actually sit just above terrain fills but below the biome-edge strips that
 * live inside the hexMap container; since both biome edges and catchment are
 * faint visual hints, the order biome-edges-on-top works fine: catchment is
 * the very faint full-hex tint, biome edges are crisp boundary strips.
 *
 * Rebuild policy: the layer is fully cleared and re-rendered when invoked
 * by app.ts. App.ts triggers a rebuild on first paint and whenever a tick
 * produces a `catchment_resized` event (see TickEvent in src/sim/tick.ts).
 */

import { Container, Graphics } from 'pixi.js';
import type { Settlement, SettlementTier } from '../../src/sim/world/settlement.js';
import type { WorldState } from '../../src/procgen/seed.js';
import type { Hex } from '../../src/sim/world/hex.js';
import { hexToPixel } from './coords.js';

const TIER_COLOR: Record<SettlementTier, number> = {
  hamlet: 0xc4a06a,
  village: 0xa07a45,
  town: 0x6a4a26,
  small_city: 0xd2a44b,
  large_city: 0xf0c66c,
};

// Faint enough to sit comfortably under terrain features without dominating;
// overlaps deepen via additive draw.
const TIER_ALPHA: Record<SettlementTier, number> = {
  hamlet: 0.08,
  village: 0.10,
  town: 0.12,
  small_city: 0.13,
  large_city: 0.15,
};

export interface CatchmentLayer {
  readonly container: Container;
  /** Wipe and redraw all settlement catchments. Cheap enough for a few hundred settlements. */
  rebuild(world: WorldState, hexSize: number): void;
}

export const createCatchmentLayer = (): CatchmentLayer => {
  const container = new Container();
  container.label = 'catchment';
  // Catchment shading is informational chrome, not interactive.
  container.eventMode = 'none';

  const rebuild = (world: WorldState, hexSize: number): void => {
    // Tear down existing children. PIXI Containers are cheap to repopulate.
    for (const child of container.removeChildren()) {
      child.destroy();
    }
    for (const s of world.settlements.values()) {
      drawSettlementCatchment(container, s, hexSize);
    }
  };

  return { container, rebuild };
};

const drawSettlementCatchment = (container: Container, s: Settlement, hexSize: number): void => {
  if (s.catchmentHexes.length === 0) return;
  const color = TIER_COLOR[s.tier];
  const alpha = TIER_ALPHA[s.tier];
  // One Graphics per settlement (not per hex) keeps the display-object count
  // tractable even with thousands of catchment hexes worldwide.
  const g = new Graphics();
  for (const h of s.catchmentHexes) {
    appendHexPolygon(g, h, hexSize);
  }
  g.fill({ color, alpha });
  container.addChild(g);
};

const appendHexPolygon = (g: Graphics, h: Hex, hexSize: number): void => {
  const { x: cx, y: cy } = hexToPixel(h, hexSize);
  // Pointy-top corners at angles 30°, 90°, 150°, 210°, 270°, 330° — same
  // convention as hexMap.ts and roads.ts.
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push(cx + hexSize * Math.cos(angle), cy + hexSize * Math.sin(angle));
  }
  g.poly(pts);
};
