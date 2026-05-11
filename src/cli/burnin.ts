#!/usr/bin/env tsx
/**
 * Burn-in CLI entry point — `npm run burnin -- [flags]`.
 *
 * Thin wrapper around runBurnIn (src/burnin/runner.ts). Parses argv via
 * Node's built-in util.parseArgs (no external dep), runs the burn-in,
 * prints a one-line summary to stdout, and exits with code 0 on success
 * or 1 if any fatal invariant fired.
 *
 * Example:
 *   npm run burnin -- \
 *     --seed=foo --years=5 \
 *     --width=200 --height=200 \
 *     --cities=5 --towns=15 --villages=300 --hamlets=200 \
 *     --invariants=week --snapshots=year \
 *     --out=./burnin-out
 *
 * Debug instrument example (writes per-(settlement, resource) CSVs):
 *   npm run burnin -- \
 *     --seed=debug --days=365 \
 *     --width=32 --height=32 --cities=1 --towns=2 --villages=4 --hamlets=2 \
 *     --out=./burnin-debug \
 *     --instruments=time-series
 *
 * Note: `--instruments=time-series` writes one CSV per (settlement, resource)
 * — easily thousands of files on a realistic burn-in. Intended for manual
 * debug runs only; the watchdog deliberately does NOT enable it.
 */

import { parseArgs } from 'node:util';
import { runBurnIn, type BurnInOpts, type Instrument } from '../burnin/runner.js';

interface ParsedFlags {
  seed: string;
  width: number;
  height: number;
  cities: number;
  towns: number;
  villages: number;
  hamlets: number;
  years: number;
  days?: number;
  invariants: 'day' | 'week' | 'month';
  snapshots: 'never' | 'month' | 'year';
  out: string;
  silent: boolean;
  instruments: readonly Instrument[];
}

const SUPPORTED_INSTRUMENTS = ['time-series'] as const satisfies readonly Instrument[];

const parseInstruments = (raw: string): readonly Instrument[] => {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: Instrument[] = [];
  for (const p of parts) {
    const found = SUPPORTED_INSTRUMENTS.find((s) => s === p);
    if (found === undefined) {
      throw new Error(
        `--instruments has unknown value '${p}'. Supported: [${SUPPORTED_INSTRUMENTS.join(', ')}]`,
      );
    }
    if (!out.includes(found)) out.push(found);
  }
  return out;
};

const DEFAULTS: ParsedFlags = {
  seed: 'default-burnin',
  width: 100,
  height: 100,
  cities: 4,
  towns: 10,
  villages: 100,
  hamlets: 60,
  years: 5,
  invariants: 'month',
  snapshots: 'year',
  out: './burnin-out',
  silent: false,
  instruments: [],
};

const parseInt10 = (label: string, raw: string): number => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`--${label} must be a number, got '${raw}'`);
  }
  return n;
};

const parseFreq = <T extends string>(label: string, raw: string, allowed: readonly T[]): T => {
  const found = allowed.find((a) => a === raw);
  if (found === undefined) {
    throw new Error(`--${label} must be one of [${allowed.join(', ')}], got '${raw}'`);
  }
  return found;
};

const parseFlags = (argv: readonly string[]): ParsedFlags => {
  const { values } = parseArgs({
    args: argv.slice(),
    strict: false,
    options: {
      seed: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      cities: { type: 'string' },
      towns: { type: 'string' },
      villages: { type: 'string' },
      hamlets: { type: 'string' },
      years: { type: 'string' },
      days: { type: 'string' },
      invariants: { type: 'string' },
      snapshots: { type: 'string' },
      out: { type: 'string' },
      silent: { type: 'boolean' },
      instruments: { type: 'string' },
    },
  });

  const out: ParsedFlags = {
    seed: typeof values['seed'] === 'string' ? values['seed'] : DEFAULTS.seed,
    width:
      typeof values['width'] === 'string' ? parseInt10('width', values['width']) : DEFAULTS.width,
    height:
      typeof values['height'] === 'string'
        ? parseInt10('height', values['height'])
        : DEFAULTS.height,
    cities:
      typeof values['cities'] === 'string'
        ? parseInt10('cities', values['cities'])
        : DEFAULTS.cities,
    towns:
      typeof values['towns'] === 'string' ? parseInt10('towns', values['towns']) : DEFAULTS.towns,
    villages:
      typeof values['villages'] === 'string'
        ? parseInt10('villages', values['villages'])
        : DEFAULTS.villages,
    hamlets:
      typeof values['hamlets'] === 'string'
        ? parseInt10('hamlets', values['hamlets'])
        : DEFAULTS.hamlets,
    years:
      typeof values['years'] === 'string' ? parseInt10('years', values['years']) : DEFAULTS.years,
    invariants:
      typeof values['invariants'] === 'string'
        ? parseFreq('invariants', values['invariants'], ['day', 'week', 'month'] as const)
        : DEFAULTS.invariants,
    snapshots:
      typeof values['snapshots'] === 'string'
        ? parseFreq('snapshots', values['snapshots'], ['never', 'month', 'year'] as const)
        : DEFAULTS.snapshots,
    out: typeof values['out'] === 'string' ? values['out'] : DEFAULTS.out,
    silent: values['silent'] === true,
    instruments:
      typeof values['instruments'] === 'string'
        ? parseInstruments(values['instruments'])
        : DEFAULTS.instruments,
  };
  if (typeof values['days'] === 'string') {
    out.days = parseInt10('days', values['days']);
  }
  return out;
};

const main = async (): Promise<void> => {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`burnin: ${(e as Error).message}\n`);
    process.exit(2);
    return;
  }

  const opts: BurnInOpts = {
    seed: flags.seed,
    mapWidth: flags.width,
    mapHeight: flags.height,
    cityCount: flags.cities,
    townCount: flags.towns,
    villageCount: flags.villages,
    hamletCount: flags.hamlets,
    years: flags.years,
    invariantCheckEvery: flags.invariants,
    snapshotEvery: flags.snapshots,
    outDir: flags.out,
    silent: flags.silent,
    instruments: flags.instruments,
    ...(flags.days !== undefined ? { daysOverride: flags.days } : {}),
  };

  const report = await runBurnIn(opts);
  const fatal = report.violations.filter((v) => v.severity === 'fatal').length;
  const errors = report.violations.filter((v) => v.severity === 'error').length;
  const warnings = report.violations.filter((v) => v.severity === 'warn').length;

  // One-line summary on stdout. Detailed report is on disk in outDir.
  process.stdout.write(
    `burnin done: day=${report.finalDay} ` +
      `settlements=${report.summary.totalSettlementsAtStart}→${report.summary.totalSettlementsAtEnd} ` +
      `pop=${report.summary.populationAtStart}→${report.summary.populationAtEnd} ` +
      `caravans@end=${report.summary.caravansActiveAtEnd} ` +
      `epidemics=${report.summary.epidemicsTriggered} ` +
      `famineDeaths=${report.summary.famineDeaths} ` +
      `recipes=${report.summary.recipeRunsTotal} ` +
      `markets=${report.summary.marketsClearedTotal} ` +
      `viol(fatal/error/warn)=${fatal}/${errors}/${warnings} ` +
      `elapsedMs=${report.totalElapsedRealMs}\n`,
  );

  process.exit(fatal > 0 ? 1 : 0);
};

main().catch((e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  process.stderr.write(`burnin: unhandled error\n${msg}\n`);
  process.exit(1);
});
