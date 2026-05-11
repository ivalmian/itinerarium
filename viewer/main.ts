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
 * How many sim ticks to run between event-loop yields. At 80×80 a single
 * tick is sub-millisecond; batching keeps the throughput high while still
 * giving the browser enough idle slots to repaint the progress bar.
 */
const BURNIN_YIELD_EVERY = 30;

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
      // Wire progress reporting to the live splash controls.
      currentOnProgress = (current, total): void => {
        splash.showProgress(current, total);
      };
      // Switch the splash UI into progress mode immediately.
      splash.showProgress(0, Math.max(0, config.burninYears) * 365);
      void (async (): Promise<void> => {
        try {
          await startSession(config);
          splash.destroy();
        } catch (e) {
          splash.showError(e instanceof Error ? e.message : String(e));
          showError(e);
        }
      })();
    },
  });
  splash.show();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void start());
} else {
  void start();
}
