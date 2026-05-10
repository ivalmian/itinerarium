/**
 * Main viewer app: PixiJS Application + sim ticking + sidebar wiring.
 *
 * Boot order (docs/16-viewer §"Functionality"):
 *   1. generateTerrain → siteSettlements → seedWorld → seedCaravans
 *   2. Spin up the PIXI Application, add hex map / settlements / caravans /
 *      bandit camps layers under a single world Container that owns the
 *      pan/zoom transform.
 *   3. Hook up the sidebar: time controls, resource panel, event log.
 *   4. Start the tick scheduler. `state.speed` ticks per simulated second
 *      (capped at one tick per requestAnimationFrame so we never block the
 *      renderer).
 *
 * The sim is single-threaded for v1. At 80×80 it's well under the per-tick
 * budget; if we scale to the full 500×500 grid we'll move it to a Web Worker
 * (CLAUDE.md tech-stack note).
 */

import { Application, Container, FederatedPointerEvent } from 'pixi.js';

import { generateTerrain } from '../src/procgen/terrain.js';
import { siteSettlements } from '../src/procgen/settlements.js';
import { seedWorld, type WorldState } from '../src/procgen/seed.js';
import { seedCaravans } from '../src/procgen/seedCaravans.js';
import { tick, type TickEvent } from '../src/sim/tick.js';
import { createRng } from '../src/sim/rng.js';
import type { ResourceId } from '../src/sim/types.js';

import { createHexMap, type HexMap } from './map/hexMap.js';
import { createSettlementsLayer, type SettlementsLayer } from './map/settlements.js';
import { createCaravansLayer, type CaravansLayer } from './map/caravans.js';
import { createBanditCampsLayer, type BanditCampsLayer } from './map/banditCamps.js';
import { applyOverlay } from './map/overlays.js';
import { DEFAULT_HEX_SIZE } from './map/coords.js';

import { createViewerState, setSelection, SPEED_LADDER, type ViewerState } from './state/viewerState.js';
import { createSidebar, type Sidebar } from './ui/sidebar.js';

export interface ViewerApp {
  destroy(): void;
  /** Forced tick advance — exposed for the smoke test. */
  step(): { events: readonly TickEvent[] };
  readonly world: WorldState;
  readonly state: ViewerState;
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
}

const DEFAULTS: Required<Omit<BootOpts, 'seed' | 'mapHostId' | 'sidebarHostId'>> & {
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

interface BuildResult {
  world: WorldState;
  hexMap: HexMap;
  settlementsLayer: SettlementsLayer;
  caravansLayer: CaravansLayer;
  banditCampsLayer: BanditCampsLayer;
  worldRoot: Container;
}

const buildWorld = (
  opts: Required<BootOpts>,
  state: ViewerState,
): { world: WorldState } => {
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
  state.ticksThisRun = 0;
  return { world };
};

const buildLayers = (
  app: Application,
  world: WorldState,
  hexSize: number,
  state: ViewerState,
): BuildResult => {
  const worldRoot = new Container();
  worldRoot.label = 'world';
  worldRoot.eventMode = 'static';
  app.stage.addChild(worldRoot);

  const hexMap = createHexMap(world.grid, hexSize);
  worldRoot.addChild(hexMap.container);

  const settlementsLayer = createSettlementsLayer((id) => {
    setSelection(state, { kind: 'settlement', id });
  });
  worldRoot.addChild(settlementsLayer.container);

  const caravansLayer = createCaravansLayer((id) => {
    setSelection(state, { kind: 'caravan', id });
  });
  worldRoot.addChild(caravansLayer.container);

  const banditCampsLayer = createBanditCampsLayer((id) => {
    setSelection(state, { kind: 'bandit_camp', id });
  });
  worldRoot.addChild(banditCampsLayer.container);

  // Initial sync.
  settlementsLayer.sync(world, hexSize);
  caravansLayer.syncTick(world);
  caravansLayer.setInterpolationT(world, 1, hexSize);
  banditCampsLayer.sync(world, hexSize);

  // Center the world initially.
  const cx = (hexMap.bounds.minX + hexMap.bounds.maxX) / 2;
  const cy = (hexMap.bounds.minY + hexMap.bounds.maxY) / 2;
  worldRoot.position.set(app.renderer.width / 2 - cx, app.renderer.height / 2 - cy);

  return { world, hexMap, settlementsLayer, caravansLayer, banditCampsLayer, worldRoot };
};

const wirePanZoom = (app: Application, worldRoot: Container, onBackgroundClick: () => void): void => {
  const stage = app.stage;
  stage.eventMode = 'static';
  stage.hitArea = app.screen;
  let dragging = false;
  let pressMoved = false;
  let last: { x: number; y: number } | null = null;

  stage.on('pointerdown', (e: FederatedPointerEvent) => {
    dragging = true;
    pressMoved = false;
    last = { x: e.global.x, y: e.global.y };
  });

  stage.on('pointermove', (e: FederatedPointerEvent) => {
    if (!dragging || last === null) return;
    const dx = e.global.x - last.x;
    const dy = e.global.y - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) pressMoved = true;
    worldRoot.position.x += dx;
    worldRoot.position.y += dy;
    last = { x: e.global.x, y: e.global.y };
  });

  const endDrag = (): void => {
    if (dragging && !pressMoved) {
      // It was a click on background.
      onBackgroundClick();
    }
    dragging = false;
    last = null;
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
  const merged: Required<BootOpts> = {
    seed: opts.seed ?? DEFAULTS.seed,
    mapWidth: opts.mapWidth ?? DEFAULTS.mapWidth,
    mapHeight: opts.mapHeight ?? DEFAULTS.mapHeight,
    cityCount: opts.cityCount ?? DEFAULTS.cityCount,
    townCount: opts.townCount ?? DEFAULTS.townCount,
    villageCount: opts.villageCount ?? DEFAULTS.villageCount,
    hamletCount: opts.hamletCount ?? DEFAULTS.hamletCount,
    mapHostId: opts.mapHostId ?? DEFAULTS.mapHostId,
    sidebarHostId: opts.sidebarHostId ?? DEFAULTS.sidebarHostId,
  };

  const mapHost = document.getElementById(merged.mapHostId);
  const sidebarHost = document.getElementById(merged.sidebarHostId);
  if (mapHost === null || sidebarHost === null) {
    throw new Error(`Viewer: missing #${merged.mapHostId} or #${merged.sidebarHostId}`);
  }

  const state = createViewerState();
  let { world } = buildWorld(merged, state);

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
  let layers = buildLayers(app, world, hexSize, state);

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

  const reset = (): void => {
    // Tear down old layers.
    app.stage.removeChild(layers.worldRoot);
    layers.worldRoot.destroy({ children: true });
    const fresh = buildWorld(merged, state);
    world = fresh.world;
    layers = buildLayers(app, world, hexSize, state);
    sidebar.eventLog.clear();
    setSelection(state, { kind: 'none' });
  };

  sidebar = createSidebar({
    host: sidebarHost,
    state,
    onPlayPause,
    onSpeedCycle,
    onReset: reset,
  });

  // Wire pan / zoom and the background-click deselect.
  wirePanZoom(app, layers.worldRoot, () => setSelection(state, { kind: 'none' }));

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
  };

  // --- Tick scheduler --------------------------------------------------------
  let lastTickWallMs = performance.now();

  const advanceOneTick = (): readonly TickEvent[] => {
    const today = world.day;
    const rng = createRng(`${merged.seed}|tick-${today}`);
    const result = tick({ world, rng });
    state.ticksThisRun += 1;

    // Sync caravan layer's prev/cur for interpolation.
    layers.caravansLayer.syncTick(world);

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
    if (state.overlay !== 'none') {
      applyOverlay(world, layers.hexMap, state.overlay);
    }
    refreshHighlights();

    lastTickWallMs = performance.now();
    return result.events;
  };

  // Initial UI render so totals are populated before the first tick fires.
  sidebar.update(world, []);
  refreshHighlights();

  // PIXI ticker drives both interpolation and tick scheduling.
  app.ticker.add(() => {
    if (!state.paused && state.speed > 0) {
      const tickIntervalMs = 1000 / state.speed;
      const now = performance.now();
      if (now - lastTickWallMs >= tickIntervalMs) {
        advanceOneTick();
      }
    }
    // Caravan interpolation: t=0 right after a tick, t=1 right before next.
    if (!state.paused && state.speed > 0) {
      const tickIntervalMs = 1000 / state.speed;
      const elapsed = performance.now() - lastTickWallMs;
      const t = Math.max(0, Math.min(1, elapsed / tickIntervalMs));
      layers.caravansLayer.setInterpolationT(world, t, hexSize);
    } else {
      layers.caravansLayer.setInterpolationT(world, 1, hexSize);
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
  };
};
