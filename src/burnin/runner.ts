/**
 * Burn-in runner — the headless stabilization driver.
 *
 * Reference: docs/07-geography.md "Phase 2 — Stabilization (burn-in)" and
 * docs/10-scope-and-questions.md (build plan §"burn-in"). Procgen places a
 * world; the runner ticks it forward N years without a player so caravans
 * find prices, demographics settle, bad procgen choices collapse, good ones
 * grow, and the resulting state is the world a player walks into.
 *
 * The runner is a pure library; the CLI thin wrapper (src/cli/burnin.ts)
 * just parses argv and calls runBurnIn(). This split keeps the runner
 * testable without spawning subprocesses.
 *
 * Determinism: every random source — procgen terrain, settlement siting,
 * world seeding, and per-tick subsystems — is derived from a single seed
 * via Rng.derive(). A repeated run with the same opts produces an identical
 * BurnInReport (modulo wall-clock time).
 *
 * Diagnostics:
 *   - invariantCheckEvery dictates how often we run the standard invariants
 *     library (T34) against the live world. Violations are appended to the
 *     report; 'fatal' severity aborts the run.
 *   - snapshotEvery dictates how often we serialize the world to a file
 *     (T36) so a long run can be inspected post-mortem. Snapshots are
 *     written into outDir as `snap-day-NNNNNN.json`.
 *   - A final `report.json` is always written into outDir summarizing the
 *     whole run.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateTerrain } from '../procgen/terrain.js';
import { siteSettlements } from '../procgen/settlements.js';
import { seedWorld, type WorldState } from '../procgen/seed.js';
import { seedCaravans } from '../procgen/seedCaravans.js';
import { tick, type TickEvent } from '../sim/tick.js';
import { createRng } from '../sim/rng.js';
import { serializeWorld, writeSnapshot } from '../sim/snapshot.js';
import {
  STANDARD_INVARIANTS,
  checkInvariants,
  summarizeForDay,
  type DailySummary,
  type InvariantViolation,
  type PreviousSummary,
} from './invariants.js';
import {
  createTimeSeriesInstrument,
  type TimeSeriesInstrument,
} from './instruments/timeSeriesCsv.js';
import type { Day } from '../sim/types.js';

// --- Public types -----------------------------------------------------------

export type InvariantFrequency = 'day' | 'week' | 'month';
export type SnapshotFrequency = 'never' | 'month' | 'year';

/**
 * Optional debug instruments. See docs/14 §"Standard runtime instruments" and
 * docs/15 §C15. Each entry adds a per-tick recording hook that flushes its
 * output to `outDir` when the run finishes.
 *
 * - `time-series`: per-(settlement, resource) CSV time series. Writes one
 *   `outDir/settlement-<id>-resource-<r>.csv` file per pair. Generates
 *   thousands of files on a realistic burn-in — intended for manual debug
 *   invocations only, NOT the watchdog.
 */
export type Instrument = 'time-series';

export interface BurnInOpts {
  readonly seed: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly cityCount: number;
  readonly townCount: number;
  readonly villageCount: number;
  readonly hamletCount: number;
  /** Burn-in length in years. Ignored when daysOverride is set. */
  readonly years: number;
  /** Test-only override: run for exactly this many days regardless of `years`. */
  readonly daysOverride?: number;
  readonly invariantCheckEvery: InvariantFrequency;
  readonly snapshotEvery: SnapshotFrequency;
  /** Where snapshots and report.json land. Empty string = no disk I/O. */
  readonly outDir: string;
  /** Suppress progress logging. Defaults to false. */
  readonly silent?: boolean;
  /**
   * Maximum world ticks per call before we yield to the event loop. Lets long
   * burn-ins remain interruptible. Defaults to 365 (one in-game year).
   */
  readonly yieldEveryDays?: number;
  /**
   * Optional debug instruments to record (docs/15 §C15). Each instrument
   * writes to `outDir`; passing instruments without an `outDir` set throws.
   * Default behavior (empty / undefined) writes nothing.
   */
  readonly instruments?: readonly Instrument[];
  /**
   * Per-CSV row cap for the `time-series` instrument. See
   * `DEFAULT_MAX_ROWS_PER_CSV` for the default. Exposed primarily for tests.
   */
  readonly timeSeriesMaxRowsPerCsv?: number;
}

export interface BurnInSummary {
  readonly totalSettlementsAtStart: number;
  readonly totalSettlementsAtEnd: number;
  readonly populationAtStart: number;
  readonly populationAtEnd: number;
  readonly caravansActiveAtEnd: number;
  readonly banditCampsAtEnd: number;
  readonly epidemicsTriggered: number;
  readonly famineDeaths: number;
  readonly diseaseDeaths: number;
  readonly baselineDeaths: number;
  readonly recipeRunsTotal: number;
  readonly marketsClearedTotal: number;
}

export interface DatedInvariantViolation extends InvariantViolation {
  readonly day: Day;
}

export interface BurnInReport {
  readonly opts: BurnInOpts;
  readonly finalDay: Day;
  readonly totalElapsedRealMs: number;
  readonly violations: readonly DatedInvariantViolation[];
  readonly dailySummaries: readonly DailySummary[];
  readonly summary: BurnInSummary;
  /** Snapshot file paths written, in order. Empty when outDir is ''. */
  readonly snapshotPaths: readonly string[];
}

// --- Helpers ----------------------------------------------------------------

const YEAR_DAYS = 365;
const MONTH_DAYS = 30;
const WEEK_DAYS = 7;

const dayInterval = (freq: InvariantFrequency | SnapshotFrequency): number | null => {
  switch (freq) {
    case 'day':
      return 1;
    case 'week':
      return WEEK_DAYS;
    case 'month':
      return MONTH_DAYS;
    case 'year':
      return YEAR_DAYS;
    case 'never':
      return null;
  }
};

const totalPopulation = (world: WorldState): number => {
  let total = 0;
  for (const s of world.settlements.values()) total += s.population.total();
  return total;
};

const padDay = (d: Day): string => String(d).padStart(6, '0');

// --- Main runner ------------------------------------------------------------

export const runBurnIn = async (opts: BurnInOpts): Promise<BurnInReport> => {
  const start = Date.now();

  // 1. Procgen the terrain.
  const grid = generateTerrain({
    seed: `${opts.seed}|terrain`,
    widthHexes: opts.mapWidth,
    heightHexes: opts.mapHeight,
  });

  // 2. Site settlements.
  const sites = siteSettlements({
    seed: `${opts.seed}|sites`,
    grid,
    cityCount: opts.cityCount,
    townCount: opts.townCount,
    villageCount: opts.villageCount,
    hamletCount: opts.hamletCount,
  });

  // 3. Seed the WorldState (governor, families, hamlets, hex ownership,
  //    starter production buildings).
  let world = seedWorld({
    seed: `${opts.seed}|world`,
    grid,
    settlementSites: sites,
  });

  // 3b. Seed initial NPC caravans so day-1 has commerce on the road.
  seedCaravans({ seed: `${opts.seed}|caravans`, world });

  // 4. Plan the run length.
  const totalDays = opts.daysOverride ?? Math.max(0, Math.floor(opts.years * YEAR_DAYS));
  const yieldEvery = Math.max(1, Math.floor(opts.yieldEveryDays ?? YEAR_DAYS));

  // 5. Prepare outDir.
  const wantOut = opts.outDir.length > 0;
  if (wantOut) {
    await mkdir(opts.outDir, { recursive: true });
  }

  // 5b. Configure optional debug instruments. The watchdog never enables
  //     these (a 100-settlement burn-in would write ~thousands of CSVs);
  //     they're for manual debug invocations.
  const instruments = opts.instruments ?? [];
  if (instruments.length > 0 && !wantOut) {
    throw new Error('runBurnIn: instruments requested but outDir is empty');
  }
  let timeSeriesInstrument: TimeSeriesInstrument | null = null;
  if (instruments.includes('time-series')) {
    timeSeriesInstrument = createTimeSeriesInstrument({
      outDir: opts.outDir,
      ...(opts.timeSeriesMaxRowsPerCsv !== undefined
        ? { maxRowsPerCsv: opts.timeSeriesMaxRowsPerCsv }
        : {}),
    });
  }

  const summaryAtStart: BurnInSummary = {
    totalSettlementsAtStart: world.settlements.size,
    totalSettlementsAtEnd: 0,
    populationAtStart: totalPopulation(world),
    populationAtEnd: 0,
    caravansActiveAtEnd: 0,
    banditCampsAtEnd: 0,
    epidemicsTriggered: 0,
    famineDeaths: 0,
    diseaseDeaths: 0,
    baselineDeaths: 0,
    recipeRunsTotal: 0,
    marketsClearedTotal: 0,
  };

  let summary: BurnInSummary = summaryAtStart;

  // Mutable accumulators we'll fold into `summary` at the end.
  let famineDeaths = 0;
  let diseaseDeaths = 0;
  let baselineDeaths = 0;
  let epidemicsTriggered = 0;
  let recipeRuns = 0;
  let marketsCleared = 0;

  const violations: DatedInvariantViolation[] = [];
  const dailySummaries: DailySummary[] = [];
  const snapshotPaths: string[] = [];

  const invInterval = dayInterval(opts.invariantCheckEvery);
  const snapInterval = dayInterval(opts.snapshotEvery);

  let previousSummary: PreviousSummary | undefined = undefined;

  // 6. Tick loop.
  let abortReason: string | null = null;
  for (let dayCount = 0; dayCount < totalDays; dayCount++) {
    const today = world.day;

    // Run a single day. Per-tick RNG seeds combine the run seed and the
    // day so a re-run with the same seed produces the same per-day stream.
    const rng = createRng(`${opts.seed}|tick-${today}`);
    const result = tick({ world, rng });
    world = result.world;

    // Accumulate event-derived stats.
    for (const e of result.events) {
      switch (e.type) {
        case 'recipe_ran':
          recipeRuns += 1;
          break;
        case 'market_cleared':
          marketsCleared += 1;
          break;
        case 'cohort_deaths':
          if (e.cause === 'famine') famineDeaths += e.deaths;
          else if (e.cause === 'disease') diseaseDeaths += e.deaths;
          else if (e.cause === 'baseline') baselineDeaths += e.deaths;
          break;
        case 'epidemic_started':
          epidemicsTriggered += 1;
          break;
        default:
          break;
      }
    }

    // Periodic invariant check on the day AFTER tick advances world.day.
    const checkDay = world.day - 1;
    if (invInterval !== null && checkDay % invInterval === 0) {
      const checkResults = checkInvariants(
        {
          world,
          day: checkDay,
          recentEvents: result.events as readonly TickEvent[],
          ...(previousSummary !== undefined ? { previousSummary } : {}),
        },
        STANDARD_INVARIANTS,
      );
      for (const v of checkResults) {
        violations.push({ ...v, day: checkDay });
      }
      const summaryThisDay = summarizeForDay(world, checkDay);
      dailySummaries.push(summaryThisDay);
      previousSummary = { day: checkDay, totalPop: summaryThisDay.totalPop };
      // Abort on fatal.
      const fatal = checkResults.find((v) => v.severity === 'fatal');
      if (fatal !== undefined) {
        abortReason = `fatal invariant ${fatal.invariant}: ${fatal.detail}`;
        break;
      }
      // Fail-fast on catastrophic population collapse — no point simulating
      // years 2-10 if year 1 already lost half the population. Threshold is
      // 50% of starting population (matches the watchdog's stability gate).
      const popNow = summaryThisDay.totalPop;
      const popStart = summaryAtStart.populationAtStart;
      if (popStart > 0 && popNow * 2 < popStart) {
        abortReason = `population collapsed: ${popNow} < 50% of start ${popStart} on day ${checkDay}`;
        break;
      }
    }

    // Periodic snapshot.
    if (wantOut && snapInterval !== null && checkDay > 0 && checkDay % snapInterval === 0) {
      const snap = serializeWorld(world, checkDay);
      const path = join(opts.outDir, `snap-day-${padDay(checkDay)}.json`);
      await writeSnapshot(snap, path);
      snapshotPaths.push(path);
    }

    // Per-tick instruments (docs/15 §C15).
    if (timeSeriesInstrument !== null) {
      timeSeriesInstrument.tick(world, checkDay as Day);
    }

    // Yield to the event loop occasionally so very long runs don't stall it.
    if ((dayCount + 1) % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Optional progress log every 30 days. Emitted on stderr so the CLI's
    // one-line stdout summary remains parseable.
    if (opts.silent !== true && (dayCount + 1) % MONTH_DAYS === 0) {
      process.stderr.write(
        `[burnin] day=${world.day} settlements=${world.settlements.size} ` +
          `pop=${totalPopulation(world)} caravans=${world.caravans.size} ` +
          `viol=${violations.length}\n`,
      );
    }
  }

  // 7. Finalize summary.
  summary = {
    ...summaryAtStart,
    totalSettlementsAtEnd: world.settlements.size,
    populationAtEnd: totalPopulation(world),
    caravansActiveAtEnd: world.caravans.size,
    banditCampsAtEnd: world.banditCamps?.size ?? 0,
    epidemicsTriggered,
    famineDeaths,
    diseaseDeaths,
    baselineDeaths,
    recipeRunsTotal: recipeRuns,
    marketsClearedTotal: marketsCleared,
  };

  const totalElapsedRealMs = Date.now() - start;

  const report: BurnInReport = {
    opts,
    finalDay: world.day,
    totalElapsedRealMs,
    violations,
    dailySummaries,
    summary,
    snapshotPaths,
  };

  if (wantOut) {
    const reportPath = join(opts.outDir, 'report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }

  if (timeSeriesInstrument !== null) {
    await timeSeriesInstrument.flush();
  }

  if (abortReason !== null && opts.silent !== true) {
    process.stderr.write(`[burnin] aborted: ${abortReason}\n`);
  }

  return report;
};
