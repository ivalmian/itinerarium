/**
 * Main viewer app: PixiJS Application + sim ticking + sidebar wiring.
 *
 * Boot order (docs/16-viewer §"Functionality"):
 *   1. generateTerrain → siteSettlements → seedWorld → seedCaravans
 *   2. Spin up the PIXI Application, add hex map / settlements / caravans /
 *      bandit camps layers under a single world Container that owns the
 *      pan/zoom transform.
 *   3. Hook up the sidebar: time controls, resource panel, event log.
 *   4. Start the tick scheduler. `state.speed` is the multiplier label
 *      (1×, 4×, 16×, 64×, 256×); ticks per real second = speed × 0.25.
 *      (capped at one tick per requestAnimationFrame so we never block the
 *      renderer).
 *
 * The sim is single-threaded for v1. At 80×80 it's well under the per-tick
 * budget; if we scale to the full 500×500 grid we'll move it to a Web Worker
 * (CLAUDE.md tech-stack note).
 */

import { Application, Container, FederatedPointerEvent, Graphics } from 'pixi.js';

import { generateTerrain } from '../src/procgen/terrain.js';
import { siteSettlements } from '../src/procgen/settlements.js';
import { seedWorld, type WorldState } from '../src/procgen/seed.js';
import { seedCaravans } from '../src/procgen/seedCaravans.js';
import { tick, type TickEvent } from '../src/sim/tick.js';
import { createRng } from '../src/sim/rng.js';
import type { ResourceId } from '../src/sim/types.js';

import { createHexMap, type HexMap } from './map/hexMap.js';
import { createRiverLayer } from './map/rivers.js';
import { createRoadLayer } from './map/roads.js';
import { createCatchmentLayer, type CatchmentLayer } from './map/catchment.js';
import { createBuildingsLayer, type BuildingsLayer } from './map/buildings.js';
import { createSettlementsLayer, type SettlementsLayer } from './map/settlements.js';
import { createCaravansLayer, type CaravansLayer } from './map/caravans.js';
import { createBanditCampsLayer, type BanditCampsLayer } from './map/banditCamps.js';
import { applyOverlay } from './map/overlays.js';
import { DEFAULT_HEX_SIZE, hexToPixel, pixelToHex } from './map/coords.js';
import { loadArt, type ArtRegistry } from './art/index.js';

import {
  createViewerState,
  onSelectionChange,
  setSelection,
  SPEED_LADDER,
  speedToTicksPerSecond,
  type ViewerState,
} from './state/viewerState.js';
import {
  clearHistory,
  createViewerHistory,
  recordEvents,
  recordTick,
  type ViewerHistory,
} from './state/history.js';
import { createSidebar, type Sidebar } from './ui/sidebar.js';
import { createFactionScreen, type FactionScreen } from './ui/factionScreen.js';

export interface ViewerApp {
  destroy(): void;
  /** Forced tick advance — exposed for the smoke test. */
  step(): { events: readonly TickEvent[] };
  readonly world: WorldState;
  readonly state: ViewerState;
  /** PIXI app — exposed for browser-console debugging / smoke tests. */
  readonly app: Application;
  /** The world's pan/zoom container — exposed for debug controls. */
  readonly worldRoot: Container;
}

export interface BootOpts {
  readonly seed?: string;
  readonly mapWidth?: number;
  readonly mapHeight?: number;
  readonly cityCount?: number;
  readonly townCount?: number;
  readonly villageCount?: number;
  readonly hamletCount?: number;
  readonly mapHostId?: string;
  readonly sidebarHostId?: string;
  /**
   * Optional pre-built world. When provided, `bootViewer` skips its initial
   * world build and wires the UI directly against this world. The Reset
   * button still re-seeds a fresh world using the rest of the opts. Use this
   * to hand over a world that has already been burned in off-screen.
   */
  readonly preBuiltWorld?: WorldState;
}

export const VIEWER_DEFAULTS: Required<Omit<BootOpts, 'seed' | 'mapHostId' | 'sidebarHostId' | 'preBuiltWorld'>> & {
  seed: string;
  mapHostId: string;
  sidebarHostId: string;
} = {
  seed: 'viewer',
  mapWidth: 80,
  mapHeight: 80,
  cityCount: 3,
  townCount: 8,
  villageCount: 30,
  hamletCount: 24,
  mapHostId: 'map-container',
  sidebarHostId: 'sidebar',
};

const CARAVAN_MIN_VISUAL_TICK_MS = 160;

interface BuildResult {
  world: WorldState;
  hexMap: HexMap;
  catchmentLayer: CatchmentLayer;
  buildingsLayer: BuildingsLayer;
  roadLayer: { refresh: (grid: WorldState['grid']) => void };
  settlementsLayer: SettlementsLayer;
  caravansLayer: CaravansLayer;
  banditCampsLayer: BanditCampsLayer;
  worldRoot: Container;
}

export interface BuildWorldOpts {
  readonly seed: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly cityCount: number;
  readonly townCount: number;
  readonly villageCount: number;
  readonly hamletCount: number;
}

/**
 * Build a fresh `WorldState` from the given session opts. Exported so the
 * splash screen can build the world up front and run pre-burn-in ticks
 * before handing the world to `bootViewer({ preBuiltWorld })`.
 */
export const buildViewerWorld = (opts: BuildWorldOpts): WorldState => {
  const grid = generateTerrain({
    seed: `${opts.seed}|terrain`,
    widthHexes: opts.mapWidth,
    heightHexes: opts.mapHeight,
  });
  const sites = siteSettlements({
    seed: `${opts.seed}|sites`,
    grid,
    cityCount: opts.cityCount,
    townCount: opts.townCount,
    villageCount: opts.villageCount,
    hamletCount: opts.hamletCount,
  });
  const world = seedWorld({
    seed: `${opts.seed}|world`,
    grid,
    settlementSites: sites,
  });
  seedCaravans({ seed: `${opts.seed}|caravans`, world });
  return world;
};

const buildWorldFromOpts = (
  opts: Required<Omit<BootOpts, 'preBuiltWorld'>>,
  state: ViewerState,
): { world: WorldState } => {
  const world = buildViewerWorld(opts);
  state.ticksThisRun = 0;
  return { world };
};

const buildLayers = (
  app: Application,
  world: WorldState,
  hexSize: number,
  state: ViewerState,
  art: ArtRegistry,
): BuildResult => {
  const worldRoot = new Container();
  worldRoot.label = 'world';
  worldRoot.eventMode = 'static';
  app.stage.addChild(worldRoot);

  const hexMap = createHexMap(world.grid, hexSize, art, world.settlements.values());
  worldRoot.addChild(hexMap.container);

  // Catchment shading sits just above terrain, below all line-art (rivers,
  // roads, biome edges via the hexMap's own children) so it reads as a
  // background tint for "this land belongs to settlement X." Per task spec
  // §"Tech notes": terrain → catchment → biome edges → roads → rivers →
  // buildings → settlements → caravans → bandit camps. The biome edges live
  // inside hexMap.container; we nest catchment between hexMap and the rest.
  const catchmentLayer = createCatchmentLayer();
  worldRoot.addChild(catchmentLayer.container);

  // Rivers draw above terrain + biome-edges, but BELOW roads so a future
  // bridge tile can sit on top of the river crossing (docs/16-viewer).
  const riverLayer = createRiverLayer(world.grid, hexSize, art);
  worldRoot.addChild(riverLayer.container);

  // Roads sit between rivers and entities — visible over the hex fill,
  // but caravans / settlements / camps draw on top.
  const roadLayer = createRoadLayer(world.grid, hexSize, art);
  worldRoot.addChild(roadLayer.container);

  // Sub-hex building markers — between roads and settlement glyphs so the
  // settlement's own "house cluster" silhouette visually anchors them.
  const buildingsLayer = createBuildingsLayer(art);
  worldRoot.addChild(buildingsLayer.container);

  const settlementsLayer = createSettlementsLayer(art, (id) => {
    setSelection(state, { kind: 'settlement', id });
  });
  worldRoot.addChild(settlementsLayer.container);

  const caravansLayer = createCaravansLayer(art, (id) => {
    setSelection(state, { kind: 'caravan', id });
  });
  worldRoot.addChild(caravansLayer.container);

  const banditCampsLayer = createBanditCampsLayer(art, (id) => {
    setSelection(state, { kind: 'bandit_camp', id });
  });
  worldRoot.addChild(banditCampsLayer.container);

  // Initial sync.
  catchmentLayer.rebuild(world, hexSize);
  buildingsLayer.rebuild(world, hexSize);
  settlementsLayer.sync(world, hexSize);
  caravansLayer.syncTick(world, undefined, hexSize);
  caravansLayer.setInterpolationT(world, 1, hexSize);
  banditCampsLayer.sync(world, hexSize);

  // Center the world initially.
  const cx = (hexMap.bounds.minX + hexMap.bounds.maxX) / 2;
  const cy = (hexMap.bounds.minY + hexMap.bounds.maxY) / 2;
  worldRoot.position.set(app.renderer.width / 2 - cx, app.renderer.height / 2 - cy);

  return {
    world,
    hexMap,
    catchmentLayer,
    buildingsLayer,
    roadLayer,
    settlementsLayer,
    caravansLayer,
    banditCampsLayer,
    worldRoot,
  };
};

const wirePanZoom = (
  app: Application,
  worldRoot: Container,
  onBackgroundClick: (worldPoint: { x: number; y: number }) => void,
): void => {
  const stage = app.stage;
  stage.eventMode = 'static';
  stage.hitArea = app.screen;
  let dragging = false;
  let pressMoved = false;
  let last: { x: number; y: number } | null = null;
  let lastGlobal: { x: number; y: number } | null = null;

  stage.on('pointerdown', (e: FederatedPointerEvent) => {
    dragging = true;
    pressMoved = false;
    last = { x: e.global.x, y: e.global.y };
    lastGlobal = { x: e.global.x, y: e.global.y };
  });

  stage.on('pointermove', (e: FederatedPointerEvent) => {
    if (!dragging || last === null) return;
    const dx = e.global.x - last.x;
    const dy = e.global.y - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pressMoved = true;
    worldRoot.position.x += dx;
    worldRoot.position.y += dy;
    last = { x: e.global.x, y: e.global.y };
    lastGlobal = { x: e.global.x, y: e.global.y };
  });

  const endDrag = (): void => {
    if (dragging && !pressMoved && lastGlobal !== null) {
      // It was a click on background. Convert the click's stage-pixel
      // coordinate into the worldRoot's local frame so the caller can
      // pixel→hex it. Pixi's federated event already gives us screen-stage
      // coords; account for worldRoot's pan + zoom transform.
      const wx = (lastGlobal.x - worldRoot.position.x) / worldRoot.scale.x;
      const wy = (lastGlobal.y - worldRoot.position.y) / worldRoot.scale.y;
      onBackgroundClick({ x: wx, y: wy });
    }
    dragging = false;
    last = null;
    lastGlobal = null;
  };
  stage.on('pointerup', endDrag);
  stage.on('pointerupoutside', endDrag);

  // Wheel zoom — bound to canvas, not stage (Pixi v8 doesn't get wheel via federated events).
  app.canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.max(0.2, Math.min(6, worldRoot.scale.x * factor));
      const rect = app.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Zoom toward cursor.
      const wx = (px - worldRoot.position.x) / worldRoot.scale.x;
      const wy = (py - worldRoot.position.y) / worldRoot.scale.y;
      worldRoot.scale.set(newScale);
      worldRoot.position.x = px - wx * newScale;
      worldRoot.position.y = py - wy * newScale;
    },
    { passive: false },
  );
};

export const bootViewer = async (opts: BootOpts = {}): Promise<ViewerApp> => {
  const merged: Required<Omit<BootOpts, 'preBuiltWorld'>> = {
    seed: opts.seed ?? VIEWER_DEFAULTS.seed,
    mapWidth: opts.mapWidth ?? VIEWER_DEFAULTS.mapWidth,
    mapHeight: opts.mapHeight ?? VIEWER_DEFAULTS.mapHeight,
    cityCount: opts.cityCount ?? VIEWER_DEFAULTS.cityCount,
    townCount: opts.townCount ?? VIEWER_DEFAULTS.townCount,
    villageCount: opts.villageCount ?? VIEWER_DEFAULTS.villageCount,
    hamletCount: opts.hamletCount ?? VIEWER_DEFAULTS.hamletCount,
    mapHostId: opts.mapHostId ?? VIEWER_DEFAULTS.mapHostId,
    sidebarHostId: opts.sidebarHostId ?? VIEWER_DEFAULTS.sidebarHostId,
  };

  const mapHost = document.getElementById(merged.mapHostId);
  const sidebarHost = document.getElementById(merged.sidebarHostId);
  if (mapHost === null || sidebarHost === null) {
    throw new Error(`Viewer: missing #${merged.mapHostId} or #${merged.sidebarHostId}`);
  }

  const state = createViewerState();
  const history: ViewerHistory = createViewerHistory();
  let world: WorldState;
  if (opts.preBuiltWorld !== undefined) {
    world = opts.preBuiltWorld;
    state.ticksThisRun = 0;
  } else {
    world = buildWorldFromOpts(merged, state).world;
  }

  const app = new Application();
  await app.init({
    width: mapHost.clientWidth,
    height: mapHost.clientHeight,
    backgroundColor: 0x0e0c09,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  mapHost.appendChild(app.canvas);

  const hexSize = DEFAULT_HEX_SIZE;
  // SVG art registry: rasterize every painterly-vector asset under
  // viewer/art/ to a Pixi Texture before building any layer. Done once
  // at boot; layer factories consume the registry by reference.
  const art = await loadArt();
  let layers = buildLayers(app, world, hexSize, state, art);

  let sidebar: Sidebar;
  const onPlayPause = (): void => {
    state.paused = !state.paused;
    if (!state.paused && state.speed === 0) state.speed = state.lastNonZeroSpeed;
    sidebar.timeControls.refresh();
  };
  const onSpeedCycle = (): void => {
    const i = SPEED_LADDER.indexOf(state.speed === 0 ? state.lastNonZeroSpeed : state.speed);
    const next = SPEED_LADDER[(i + 1) % SPEED_LADDER.length] ?? SPEED_LADDER[0];
    state.speed = next as (typeof SPEED_LADDER)[number];
    state.lastNonZeroSpeed = state.speed;
    state.paused = false;
    sidebar.timeControls.refresh();
  };

  // Scheduler clocks are reset together when the world is re-seeded.
  let lastTickWallMs = performance.now();
  let lastCaravanVisualSyncMs = lastTickWallMs;

  const reset = (): void => {
    // Tear down old layers.
    app.stage.removeChild(layers.worldRoot);
    layers.worldRoot.destroy({ children: true });
    const fresh = buildWorldFromOpts(merged, state);
    world = fresh.world;
    layers = buildLayers(app, world, hexSize, state, art);
    sidebar.eventLog.clear();
    clearHistory(history);
    setSelection(state, { kind: 'none' });
    lastTickWallMs = performance.now();
    lastCaravanVisualSyncMs = lastTickWallMs;
  };

  sidebar = createSidebar({
    host: sidebarHost,
    state,
    history,
    onPlayPause,
    onSpeedCycle,
    onReset: reset,
  });

  // Faction screen: modal popup mounted on document.body so it floats above
  // the entire viewer. It snapshots the world on open + refresh; close clears
  // the selection so subsequent panel renders don't get a phantom 'faction'
  // selection.
  const factionScreen: FactionScreen = createFactionScreen({
    host: document.body,
    state,
    getWorld: () => world,
    onClose: () => {
      // Only clear the selection if it still points at a faction (avoids
      // racing with a Selection change initiated elsewhere).
      if (state.selection.kind === 'faction') {
        setSelection(state, { kind: 'none' });
      }
    },
  });

  // Wire pan / zoom. Background clicks pick a hex from the click position
  // (so wilderness hexes become inspectable) instead of deselecting; clicks
  // off the grid (no tile under the cursor) clear the selection.
  wirePanZoom(app, layers.worldRoot, (worldPoint) => {
    const h = pixelToHex(worldPoint, hexSize);
    if (world.grid.has(h)) {
      setSelection(state, { kind: 'hex', hex: h });
    } else {
      setSelection(state, { kind: 'none' });
    }
  });

  // Heat-map dropdown.
  const overlaySelect = document.getElementById('overlay-select') as HTMLSelectElement | null;
  if (overlaySelect !== null) {
    overlaySelect.addEventListener('change', () => {
      state.overlay = overlaySelect.value as ViewerState['overlay'];
      applyOverlay(world, layers.hexMap, state.overlay);
    });
  }

  // Resize handling.
  const resize = (): void => {
    app.renderer.resize(mapHost.clientWidth, mapHost.clientHeight);
    if (app.stage.hitArea !== null) app.stage.hitArea = app.screen;
  };
  window.addEventListener('resize', resize);

  // Hex highlight overlay. Owned by app.ts so it survives layer rebuilds
  // implicitly via re-attachment in refreshHighlights below; the Graphics
  // itself is re-created on reset because the old worldRoot is destroyed
  // with children: true.
  let hexHighlight: Graphics = makeHexHighlight(hexSize);
  layers.worldRoot.addChild(hexHighlight);

  // Selection highlighting.
  const refreshHighlights = (): void => {
    layers.settlementsLayer.setHighlight(
      state.selection.kind === 'settlement' ? state.selection.id : null,
    );
    layers.caravansLayer.setHighlight(
      state.selection.kind === 'caravan' ? state.selection.id : null,
    );
    layers.banditCampsLayer.setHighlight(
      state.selection.kind === 'bandit_camp' ? state.selection.id : null,
    );
    // Re-create the outline if it was destroyed by a worldRoot tear-down.
    if (hexHighlight.destroyed) {
      hexHighlight = makeHexHighlight(hexSize);
    }
    if (hexHighlight.parent !== layers.worldRoot) {
      layers.worldRoot.addChild(hexHighlight);
    }
    if (state.selection.kind === 'hex') {
      const px = hexToPixel(state.selection.hex, hexSize);
      hexHighlight.position.set(px.x, px.y);
      hexHighlight.visible = true;
      // Keep it on top after sibling layers re-added themselves.
      layers.worldRoot.addChild(hexHighlight);
    } else {
      hexHighlight.visible = false;
    }
  };

  // --- Tick scheduler --------------------------------------------------------
  const advanceOneTick = (): readonly TickEvent[] => {
    const today = world.day;
    const rng = createRng(`${merged.seed}|tick-${today}`);
    const result = tick({ world, rng });
    state.ticksThisRun += 1;

    // Per-entity history: snapshot every settlement/caravan/camp and route
    // this tick's events into per-entity event buffers. Done before the
    // sidebar.update call so panels render against fresh history.
    recordTick(history, world);
    recordEvents(history, world.day, result.events);

    // Build per-caravan path from caravan_moved events so the layer
    // interpolates along the actual hex path (not a straight line that
    // visually cuts through lakes / mountains).
    const pathPerCaravan = new Map<string, { q: number; r: number }[]>();
    for (const ev of result.events) {
      if (ev.type !== 'caravan_moved') continue;
      let arr = pathPerCaravan.get(String(ev.caravan));
      if (arr === undefined) {
        arr = [{ q: ev.from.q, r: ev.from.r }];
        pathPerCaravan.set(String(ev.caravan), arr);
      }
      arr.push({ q: ev.to.q, r: ev.to.r });
    }

    // Sync caravan layer's prev/cur + polyline path for interpolation.
    // Cast through unknown so the branded CaravanId type lines up — the
    // map keys are CaravanId values (we just stringified them above).
    layers.caravansLayer.syncTick(
      world,
      pathPerCaravan as unknown as ReadonlyMap<
        import('../src/sim/types.js').CaravanId,
        readonly { q: number; r: number }[]
      >,
      hexSize,
    );

    // Aggregate recipe outputs from the events for the resource panel.
    const outputDelta = new Map<ResourceId, number>();
    for (const ev of result.events) {
      if (ev.type === 'recipe_ran') {
        // We don't know exact qty here without re-running the recipe; treat
        // each successful run as a unit and let the panel show "runs/day"
        // moving average instead of a precise tonnage.
        outputDelta.set(
          ev.recipe as unknown as ResourceId,
          (outputDelta.get(ev.recipe as unknown as ResourceId) ?? 0) + ev.fraction,
        );
      }
    }
    sidebar.resourcePanel.recordOutputs(outputDelta);

    sidebar.update(world, result.events);
    layers.settlementsLayer.sync(world, hexSize);
    layers.banditCampsLayer.sync(world, hexSize);

    // Rebuild building markers if a tick produced a building_completed event;
    // rebuild catchment shading on catchment_resized; rebuild road layer
    // on any road state change (trail wear upgrade/downgrade, road reset,
    // unmaintained Roman demote). v1 simple approach: wipe + redraw the
    // affected layer entirely on the tick an event lands. For 6,400 hexes
    // and 100s of settlements this is well under a frame.
    let needsBuildingsRebuild = false;
    let needsCatchmentRebuild = false;
    let needsRoadRebuild = false;
    for (const ev of result.events) {
      if (ev.type === 'building_completed' || ev.type === 'building_demolished') {
        needsBuildingsRebuild = true;
      } else if (ev.type === 'catchment_resized') {
        needsCatchmentRebuild = true;
      } else if (
        ev.type === 'road_upgraded' ||
        ev.type === 'road_downgraded' ||
        ev.type === 'road_unmaintained'
      ) {
        needsRoadRebuild = true;
      }
    }
    if (needsBuildingsRebuild) layers.buildingsLayer.rebuild(world, hexSize);
    if (needsCatchmentRebuild) layers.catchmentLayer.rebuild(world, hexSize);
    if (needsRoadRebuild) layers.roadLayer.refresh(world.grid);

    if (state.overlay !== 'none') {
      applyOverlay(world, layers.hexMap, state.overlay);
    }
    refreshHighlights();
    factionScreen.refresh(world);

    lastTickWallMs = performance.now();
    lastCaravanVisualSyncMs = lastTickWallMs;
    return result.events;
  };

  // Initial UI render so totals are populated before the first tick fires.
  // Also seed history with the day-0 snapshot so panels show "1 tick" of
  // data immediately rather than waiting for the first sim advance.
  recordTick(history, world);
  sidebar.update(world, []);
  refreshHighlights();

  // Re-render the selected-entity panels and the hex highlight whenever the
  // selection changes. Without this, paused-time clicks wouldn't update the
  // sidebar (sidebar.update only runs on a sim tick). Also drives the
  // faction-screen modal: opening when selection.kind === 'faction', closing
  // when the selection moves away (or to a different faction).
  onSelectionChange(() => {
    sidebar.update(world, []);
    refreshHighlights();
    if (state.selection.kind === 'faction') {
      factionScreen.openForFaction(state.selection.id);
    } else if (factionScreen.isOpen()) {
      factionScreen.close();
    }
  });

  // PIXI ticker drives both interpolation and tick scheduling.
  app.ticker.add(() => {
    const now = performance.now();
    const tickIntervalMs =
      !state.paused && state.speed > 0 ? 1000 / speedToTicksPerSecond(state.speed) : 0;
    const visualDurationMs =
      tickIntervalMs > 0
        ? Math.max(CARAVAN_MIN_VISUAL_TICK_MS, tickIntervalMs)
        : CARAVAN_MIN_VISUAL_TICK_MS;
    const visualT = Math.max(0, Math.min(1, (now - lastCaravanVisualSyncMs) / visualDurationMs));
    layers.caravansLayer.setInterpolationT(world, visualT, hexSize);
    if (!state.paused && state.speed > 0) {
      // Draw interpolation before advancing the sim. At high speeds, visual
      // interpolation is deliberately slower than sim time; the caravan layer
      // begins each new visual leg from the current rendered position.
      const elapsed = now - lastTickWallMs;
      if (elapsed >= tickIntervalMs) {
        advanceOneTick();
      }
    }
  });

  // Keyboard shortcuts.
  const helpOverlay = document.getElementById('help-overlay');
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      onPlayPause();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const i = SPEED_LADDER.indexOf(state.speed === 0 ? state.lastNonZeroSpeed : state.speed);
      const next = SPEED_LADDER[Math.min(SPEED_LADDER.length - 1, i + 1)] ?? state.speed;
      state.speed = next;
      state.lastNonZeroSpeed = state.speed;
      state.paused = false;
      sidebar.timeControls.refresh();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      const i = SPEED_LADDER.indexOf(state.speed === 0 ? state.lastNonZeroSpeed : state.speed);
      const next = SPEED_LADDER[Math.max(0, i - 1)] ?? state.speed;
      state.speed = next;
      state.lastNonZeroSpeed = state.speed;
      sidebar.timeControls.refresh();
    } else if (e.key === 'Escape') {
      setSelection(state, { kind: 'none' });
      refreshHighlights();
      if (helpOverlay !== null) helpOverlay.classList.remove('visible');
    } else if (e.key === '?') {
      if (helpOverlay !== null) helpOverlay.classList.toggle('visible');
    }
  });

  return {
    destroy: () => {
      window.removeEventListener('resize', resize);
      app.destroy(true);
    },
    step: () => ({ events: advanceOneTick() }),
    world,
    state,
    app,
    get worldRoot(): Container {
      return layers.worldRoot;
    },
  };
};

/**
 * Build a stroke-only hex outline ready to be positioned in worldRoot
 * space. We allocate a fresh Graphics so reset() can drop the old one
 * along with its parent worldRoot.
 */
const makeHexHighlight = (size: number): Graphics => {
  const g = new Graphics();
  g.eventMode = 'none';
  g.visible = false;
  const path: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    path.push(size * Math.cos(angle), size * Math.sin(angle));
  }
  g.poly(path).stroke({ color: 0xffffff, width: 1.5, alpha: 0.95 });
  return g;
};
