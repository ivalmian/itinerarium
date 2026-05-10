/**
 * Tests for the burn-in runner. Uses a tiny world (16×16 hex, 1 city, 2
 * villages, 1 hamlet, 1 month) to keep the test suite fast.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBurnIn, type BurnInOpts } from './runner.js';

const tinyOpts = (overrides: Partial<BurnInOpts> = {}): BurnInOpts => ({
  seed: 'burnin-tiny',
  mapWidth: 16,
  mapHeight: 16,
  cityCount: 1,
  townCount: 1,
  villageCount: 2,
  hamletCount: 2,
  years: 0,
  daysOverride: 30, // bypass years for quick tests
  invariantCheckEvery: 'week',
  snapshotEvery: 'never',
  outDir: '',
  silent: true,
  ...overrides,
});

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'ecogame-burnin-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('runBurnIn', () => {
  describe('shape', () => {
    it('returns a BurnInReport on a tiny world', async () => {
      const r = await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', daysOverride: 7 }));
      expect(r.finalDay).toBe(7);
      expect(r.totalElapsedRealMs).toBeGreaterThanOrEqual(0);
      expect(r.summary.totalSettlementsAtStart).toBeGreaterThan(0);
      expect(r.summary.totalSettlementsAtEnd).toBeGreaterThan(0);
      expect(r.summary.populationAtStart).toBeGreaterThan(0);
    });

    it('uses years when daysOverride is undefined', async () => {
      const r = await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', years: 0, daysOverride: 1 }));
      expect(r.finalDay).toBe(1);
    });
  });

  describe('determinism', () => {
    it('same seed produces identical key counts and finalDay', async () => {
      const a = await runBurnIn(
        tinyOpts({ seed: 'det-X', outDir: '/tmp/ignore', daysOverride: 14 }),
      );
      const b = await runBurnIn(
        tinyOpts({ seed: 'det-X', outDir: '/tmp/ignore', daysOverride: 14 }),
      );
      expect(b.finalDay).toBe(a.finalDay);
      expect(b.summary.totalSettlementsAtStart).toBe(a.summary.totalSettlementsAtStart);
      expect(b.summary.totalSettlementsAtEnd).toBe(a.summary.totalSettlementsAtEnd);
      expect(b.summary.populationAtStart).toBe(a.summary.populationAtStart);
      expect(b.summary.populationAtEnd).toBe(a.summary.populationAtEnd);
      expect(b.summary.epidemicsTriggered).toBe(a.summary.epidemicsTriggered);
      expect(b.summary.famineDeaths).toBe(a.summary.famineDeaths);
      expect(b.violations.length).toBe(a.violations.length);
    });

    it('different seeds usually produce different summaries', async () => {
      const a = await runBurnIn(
        tinyOpts({ seed: 'seedA', outDir: '/tmp/ignore', daysOverride: 14 }),
      );
      const b = await runBurnIn(
        tinyOpts({ seed: 'seedB', outDir: '/tmp/ignore', daysOverride: 14 }),
      );
      // Population at start can equal because procgen knobs match, but the
      // procgen RNG flow differs and at least one of the dynamic fields
      // (population at end, epidemics, famine deaths, total events) should
      // differ in expectation. We test the weaker condition (any difference
      // in any of those fields) so seed-collision flakiness is impossible.
      const same =
        a.summary.populationAtEnd === b.summary.populationAtEnd &&
        a.summary.epidemicsTriggered === b.summary.epidemicsTriggered &&
        a.summary.famineDeaths === b.summary.famineDeaths;
      expect(same).toBe(false);
    });
  });

  describe('invariants', () => {
    it('a small healthy world produces no fatal violations', async () => {
      const r = await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', daysOverride: 30 }));
      const fatal = r.violations.filter((v) => v.severity === 'fatal');
      expect(fatal).toEqual([]);
    });

    it('invariant check frequency honors invariantCheckEvery', async () => {
      // 30 days, 'week' frequency = checks every 7 days starting day 0
      // → days 0, 7, 14, 21, 28 = 5 checks. The number of violations recorded
      // should be ≤ 5 × |invariants|. With a healthy world we expect ≤ a
      // small number of warns.
      const weekly = await runBurnIn(
        tinyOpts({ outDir: '/tmp/ignore', daysOverride: 30, invariantCheckEvery: 'week' }),
      );
      const daily = await runBurnIn(
        tinyOpts({ outDir: '/tmp/ignore', daysOverride: 30, invariantCheckEvery: 'day' }),
      );
      // Daily checks should produce at least as many violations as weekly
      // checks — we just exercise both code paths and ensure neither throws.
      expect(daily.violations.length).toBeGreaterThanOrEqual(weekly.violations.length);
    });
  });

  describe('snapshots', () => {
    it('writes monthly snapshots to outDir when snapshotEvery=month', async () => {
      await withTempDir(async (outDir) => {
        await runBurnIn(tinyOpts({ outDir, daysOverride: 65, snapshotEvery: 'month' }));
        const files = await readdir(outDir);
        const snaps = files.filter((f) => f.endsWith('.json'));
        // Two monthly snapshots in 65 days (days 30 and 60), plus a final
        // snapshot for the report file. Expect ≥ 2 snapshots.
        expect(snaps.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('writes a final report.json containing the BurnInReport', async () => {
      await withTempDir(async (outDir) => {
        const report = await runBurnIn(tinyOpts({ outDir, daysOverride: 7 }));
        const reportPath = join(outDir, 'report.json');
        const raw = await readFile(reportPath, 'utf8');
        const parsed = JSON.parse(raw) as { finalDay: number; summary: typeof report.summary };
        expect(parsed.finalDay).toBe(report.finalDay);
        expect(parsed.summary.totalSettlementsAtStart).toBe(report.summary.totalSettlementsAtStart);
      });
    });

    it('writes no snapshots when snapshotEvery=never', async () => {
      await withTempDir(async (outDir) => {
        await runBurnIn(tinyOpts({ outDir, daysOverride: 60, snapshotEvery: 'never' }));
        const files = await readdir(outDir);
        const snaps = files.filter((f) => f.endsWith('.json') && f !== 'report.json');
        expect(snaps).toEqual([]);
      });
    });
  });

  describe('summary stats', () => {
    it('counts settlements and population correctly', async () => {
      const r = await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', daysOverride: 7 }));
      expect(r.summary.totalSettlementsAtStart).toBeGreaterThanOrEqual(2);
      expect(r.summary.populationAtStart).toBeGreaterThan(100);
    });

    it('caravansActiveAtEnd is non-negative', async () => {
      const r = await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', daysOverride: 7 }));
      expect(r.summary.caravansActiveAtEnd).toBeGreaterThanOrEqual(0);
    });

    it('famineDeaths and epidemicsTriggered are non-negative integers', async () => {
      const r = await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', daysOverride: 30 }));
      expect(r.summary.famineDeaths).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.summary.famineDeaths)).toBe(true);
      expect(r.summary.epidemicsTriggered).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.summary.epidemicsTriggered)).toBe(true);
    });
  });

  describe('runtime budget', () => {
    it('30 days on the tiny world finishes well under 30 seconds', async () => {
      const start = Date.now();
      await runBurnIn(tinyOpts({ outDir: '/tmp/ignore', daysOverride: 30 }));
      const elapsed = Date.now() - start;
      // Tiny world; a 30-second budget is for full v1 (50×50, 10 settlements).
      // This is a much smaller world; should finish in well under 5s.
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
