/**
 * Viewer entrypoint — bootstraps the session-configuration splash screen,
 * then runs pre-burn-in, then boots the PixiJS viewer.
 *
 * Boot order:
 *   1. Show the splash (`viewer/ui/splash.ts`) with form controls for seed,
 *      map size, settlement counts, and burn-in years. Defaults come from
 *      `VIEWER_DEFAULTS` in viewer/app.ts.
 *   2. On Start: hide the form, swap to a progress overlay, build the world,
 *      and run `tick({ world, rng })` for `burninYears × 365` days. The loop
 *      yields to the event loop every BURNIN_YIELD_EVERY ticks so the UI
 *      stays responsive and the progress bar can update.
 *   3. Destroy the splash, then call `bootViewer({ preBuiltWorld: world })`.
 *
 * For headless smoke tests or any caller that wants to skip the splash, set
 * `?autostart=1` in the URL — the page will boot with the defaults and zero
 * burn-in, behavior identical to the pre-splash entrypoint. Any of the
 * SplashConfig fields can also be overridden via query string, e.g.
 *   ?autostart=1&seed=abc&mapWidth=40&mapHeight=40&burninYears=0
 *
 * No top-level await: Vite serves this as an ES module, so the boot is just
 * an async function we kick off. Errors are surfaced into the page so the
 * dev server doesn't silently render a blank canvas.
 */

import { bootViewer, buildViewerWorld, VIEWER_DEFAULTS } from './app.js';
import { tick } from '../src/sim/tick.js';
import { createRng } from '../src/sim/rng.js';
import { createSplash, type SplashConfig } from './ui/splash.js';

/**
 * How many sim ticks to run between event-loop yields. The progress bar
 * lives on a non-modal overlay shown after the splash is dismissed, and
 * we want it to update visibly even on the first tick — so yield often.
 * Sub-millisecond ticks make this cheap.
 */
const BURNIN_YIELD_EVERY = 5;

const showError = (err: unknown): void => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  // eslint-disable-next-line no-console
  console.error('Viewer boot failed:', err);
  const host = document.body;
  const div = document.createElement('pre');
  div.style.cssText =
    'position:fixed;inset:0;background:#1f1b15;color:#e9e2d2;padding:24px;font-family:ui-monospace,monospace;white-space:pre-wrap;overflow:auto;z-index:1000;';
  div.textContent = `Viewer boot failed:\n\n${msg}`;
  host.appendChild(div);
};

const sleep0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const runBurnin = async (
  world: import('../src/procgen/seed.js').WorldState,
  seed: string,
  totalDays: number,
  onProgress: (current: number, total: number) => void,
): Promise<void> => {
  onProgress(0, totalDays);
  // Yield before the first tick so the caller's overlay actually paints
  // before we start churning ticks (otherwise the synchronous burn-in
  // loop blocks the browser's first paint and the user sees nothing
  // change for the first batch of days).
  await sleep0();
  if (totalDays <= 0) return;
  for (let i = 0; i < totalDays; i++) {
    const today = world.day;
    const rng = createRng(`${seed}|tick-${today}`);
    tick({ world, rng });
    if ((i + 1) % BURNIN_YIELD_EVERY === 0 || i === totalDays - 1) {
      onProgress(i + 1, totalDays);
      // Yield to the event loop so the progress bar repaints.
      await sleep0();
    }
  }
};

type MutableSplashConfig = { -readonly [K in keyof SplashConfig]?: SplashConfig[K] };

const parseUrlOverrides = (params: URLSearchParams): MutableSplashConfig => {
  const out: MutableSplashConfig = {};
  const seed = params.get('seed');
  if (seed !== null && seed !== '') out.seed = seed;
  const numeric: Array<keyof Omit<SplashConfig, 'seed'>> = [
    'mapWidth',
    'mapHeight',
    'cityCount',
    'townCount',
    'villageCount',
    'hamletCount',
    'burninYears',
  ];
  for (const key of numeric) {
    const raw = params.get(key);
    if (raw === null) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = Math.floor(n);
  }
  return out;
};

const startSession = async (config: SplashConfig): Promise<void> => {
  const totalDays = Math.max(0, config.burninYears) * 365;
  const world = buildViewerWorld({
    seed: config.seed,
    mapWidth: config.mapWidth,
    mapHeight: config.mapHeight,
    cityCount: config.cityCount,
    townCount: config.townCount,
    villageCount: config.villageCount,
    hamletCount: config.hamletCount,
  });

  // The splash is showing a progress bar; update via the controls returned
  // from createSplash. Closure capture happens in the caller below.
  await runBurnin(world, config.seed, totalDays, currentOnProgress);

  const viewer = await bootViewer({
    seed: config.seed,
    mapWidth: config.mapWidth,
    mapHeight: config.mapHeight,
    cityCount: config.cityCount,
    townCount: config.townCount,
    villageCount: config.villageCount,
    hamletCount: config.hamletCount,
    preBuiltWorld: world,
  });
  (window as unknown as { __viewer?: unknown }).__viewer = viewer;
};

// Set inside `start()` once the splash exists so `startSession` can report
// progress without threading the controls through every helper.
let currentOnProgress: (current: number, total: number) => void = () => {
  // no-op until the splash is mounted.
};

const start = async (): Promise<void> => {
  const params = new URLSearchParams(window.location.search);
  const autostart = params.get('autostart') === '1';
  const overrides = parseUrlOverrides(params);

  const defaults: SplashConfig = {
    seed: overrides.seed ?? VIEWER_DEFAULTS.seed,
    mapWidth: overrides.mapWidth ?? VIEWER_DEFAULTS.mapWidth,
    mapHeight: overrides.mapHeight ?? VIEWER_DEFAULTS.mapHeight,
    cityCount: overrides.cityCount ?? VIEWER_DEFAULTS.cityCount,
    townCount: overrides.townCount ?? VIEWER_DEFAULTS.townCount,
    villageCount: overrides.villageCount ?? VIEWER_DEFAULTS.villageCount,
    hamletCount: overrides.hamletCount ?? VIEWER_DEFAULTS.hamletCount,
    burninYears: overrides.burninYears ?? 2,
  };

  if (autostart) {
    // Skip the splash entirely. Smoke tests need a fast boot, so we default
    // to zero burn-in unless the URL explicitly sets `burninYears`.
    const autoConfig: SplashConfig = {
      ...defaults,
      burninYears: overrides.burninYears ?? 0,
    };
    try {
      await startSession(autoConfig);
    } catch (e) {
      showError(e);
    }
    return;
  }

  const splash = createSplash({
    host: document.body,
    defaults,
    onStart: (config) => {
      // Tear down the splash UI immediately so the user sees the screen
      // change the instant they click Start — burn-in runs against a
      // small floating progress overlay attached to the body, not the
      // splash card.
      splash.destroy();
      const overlay = createBurninOverlay(document.body);
      const totalDays = Math.max(0, config.burninYears) * 365;
      overlay.update(0, totalDays);
      currentOnProgress = (current, total): void => {
        overlay.update(current, total);
      };
      void (async (): Promise<void> => {
        try {
          await startSession(config);
          overlay.destroy();
        } catch (e) {
          overlay.destroy();
          showError(e);
        }
      })();
    },
  });
  splash.show();
};

/**
 * Lightweight progress overlay shown *after* the splash card is gone, so
 * the user sees an immediate transition on Start. Sits in the corner of
 * the page so the (still-empty) map background can already paint
 * underneath. Replaced/destroyed once `bootViewer` resolves.
 */
interface BurninOverlay {
  update(current: number, total: number): void;
  destroy(): void;
}

const createBurninOverlay = (host: HTMLElement): BurninOverlay => {
  const root = document.createElement('div');
  root.className = 'burnin-overlay';
  root.style.cssText =
    'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:rgba(20,17,14,0.92);color:#e9e2d2;border:1px solid #3d3528;' +
    'padding:14px 22px;z-index:300;min-width:300px;font-family:inherit;' +
    'box-shadow:0 8px 32px rgba(0,0,0,0.6);';
  const label = document.createElement('div');
  label.style.cssText =
    'font-size:12px;color:#9b8f77;margin-bottom:8px;font-variant-numeric:tabular-nums;';
  label.textContent = 'Building world…';
  root.appendChild(label);
  const bar = document.createElement('div');
  bar.style.cssText =
    'width:100%;height:8px;background:#2a241c;border:1px solid #3d3528;overflow:hidden;';
  const inner = document.createElement('div');
  inner.style.cssText =
    'height:100%;background:#d2a44b;width:0%;transition:width 80ms linear;';
  bar.appendChild(inner);
  root.appendChild(bar);
  host.appendChild(root);
  return {
    update(current, total): void {
      if (total <= 0) {
        label.textContent = 'Building world…';
        inner.style.width = '100%';
        return;
      }
      const pct = Math.min(100, (current / total) * 100);
      label.textContent = `Burning in ${current}/${total} days…`;
      inner.style.width = `${pct.toFixed(1)}%`;
    },
    destroy(): void {
      root.remove();
    },
  };
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start());
} else {
  void start();
}
