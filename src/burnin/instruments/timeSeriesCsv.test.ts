/**
 * Tests for the per-(settlement, resource) time-series CSV instrument
 * (docs/15 §C15).
 *
 * Two sources of coverage:
 *  - Unit tests against a hand-rolled minimal WorldState shim, exercising
 *    the per-tick deltaing, the row cap, the discovery-of-new-resources
 *    path, and CSV format.
 *  - One integration smoke test that wires the instrument through
 *    runBurnIn() to assert the runner contract: instruments+outDir produces
 *    files of the documented name shape, default behavior produces none.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTimeSeriesInstrument, DEFAULT_MAX_ROWS_PER_CSV } from './timeSeriesCsv.js';
import {
  actorId,
  resourceId,
  settlementId,
  type ActorId,
  type Day,
  type ResourceId,
  type SettlementId,
} from '../../sim/types.js';
import { runBurnIn, type BurnInOpts } from '../runner.js';

// --- Local test shims ------------------------------------------------------

interface FakeMarket {
  recentInflows: Map<ResourceId, number>;
  recentOutflows: Map<ResourceId, number>;
  lastClearingPrice: Map<ResourceId, number>;
}
interface FakeSettlement {
  readonly id: SettlementId;
  readonly stockpileOwners: ActorId[];
  readonly market: FakeMarket;
}
interface FakeActor {
  readonly id: ActorId;
  // Per docs/15 §C30: actor stockpile is Map<SettlementId, Map<ResourceId, Quantity>>.
  readonly stockpile: Map<SettlementId, Map<ResourceId, number>>;
}
interface FakeWorld {
  readonly settlements: Map<SettlementId, FakeSettlement>;
  readonly actors: Map<ActorId, FakeActor>;
}

const grain = resourceId('food.grain');
const wine = resourceId('drink.wine');

const makeFakeWorld = (): FakeWorld => {
  const sId = settlementId('S1');
  const a1Id = actorId('A1');
  const a2Id = actorId('A2');
  const a1: FakeActor = { id: a1Id, stockpile: new Map([[sId, new Map([[grain, 10]])]]) };
  const a2: FakeActor = { id: a2Id, stockpile: new Map([[sId, new Map([[grain, 5]])]]) };
  const settlement: FakeSettlement = {
    id: sId,
    stockpileOwners: [a1Id, a2Id],
    market: {
      recentInflows: new Map(),
      recentOutflows: new Map(),
      lastClearingPrice: new Map(),
    },
  };
  return {
    settlements: new Map([[sId, settlement]]),
    actors: new Map([
      [a1Id, a1],
      [a2Id, a2],
    ]),
  };
};

// Cast helper — the instrument types its parameter as the real WorldState /
// Settlement, but only ever touches `.settlements`, `.actors`, owners, and
// market maps. The fake satisfies that structural shape.
const castWorld = (
  w: FakeWorld,
): Parameters<ReturnType<typeof createTimeSeriesInstrument>['tick']>[0] =>
  w as unknown as Parameters<ReturnType<typeof createTimeSeriesInstrument>['tick']>[0];

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'ecogame-tsi-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('createTimeSeriesInstrument', () => {
  it('records one CSV per (settlement, resource) pair with correct header', async () => {
    await withTempDir(async (outDir) => {
      const world = makeFakeWorld();
      const inst = createTimeSeriesInstrument({ outDir });
      inst.tick(castWorld(world), 0 as Day);
      const written = await inst.flush();
      expect(written.length).toBe(1);
      const path = written[0]!;
      expect(path.endsWith('settlement-S1-resource-food.grain.csv')).toBe(true);
      const csv = await readFile(path, 'utf8');
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe(
        'day,stockpile,inflow,outflow,lastClearingPrice,unmetDemandAtClearingPrice',
      );
      // Day 0 row: stockpile = 10+5 = 15, no inflow/outflow, no price.
      expect(lines[1]).toBe('0,15,0,0,,0');
    });
  });

  it('computes per-tick inflow/outflow as deltas of monotonic counters', async () => {
    await withTempDir(async (outDir) => {
      const world = makeFakeWorld();
      const inst = createTimeSeriesInstrument({ outDir });
      const settlement = world.settlements.get(settlementId('S1'))!;
      // Day 0: cumulative inflow = 0.
      inst.tick(castWorld(world), 0 as Day);
      // Day 1: 7 units of grain inflow happened — the sim accumulates this
      // monotonically.
      settlement.market.recentInflows.set(grain, 7);
      inst.tick(castWorld(world), 1 as Day);
      // Day 2: another 3 units; cumulative now 10.
      settlement.market.recentInflows.set(grain, 10);
      // And 4 units of outflow this tick (cumulative 4).
      settlement.market.recentOutflows.set(grain, 4);
      settlement.market.lastClearingPrice.set(grain, 1.25);
      inst.tick(castWorld(world), 2 as Day);
      const written = await inst.flush();
      const csv = await readFile(written[0]!, 'utf8');
      const lines = csv.trim().split('\n');
      // header + 3 ticks.
      expect(lines.length).toBe(4);
      // Day 1 row: inflow delta = 7, outflow delta = 0, no price yet.
      expect(lines[2]).toBe('1,15,7,0,,0');
      // Day 2 row: inflow delta = 3, outflow delta = 4, price = 1.25.
      expect(lines[3]).toBe('2,15,3,4,1.25,0');
    });
  });

  it('discovers resources that first appear after burn-in start', async () => {
    await withTempDir(async (outDir) => {
      const world = makeFakeWorld();
      const inst = createTimeSeriesInstrument({ outDir });
      // Day 0: only grain exists.
      inst.tick(castWorld(world), 0 as Day);
      expect(inst.seriesCount()).toBe(1);
      // Day 1: an actor mints wine.
      // Add wine to A1's slice at settlement S1.
      const sId = settlementId('S1');
      const a1 = world.actors.get(actorId('A1'))!;
      let slice = a1.stockpile.get(sId);
      if (slice === undefined) {
        slice = new Map();
        a1.stockpile.set(sId, slice);
      }
      slice.set(wine, 4);
      inst.tick(castWorld(world), 1 as Day);
      expect(inst.seriesCount()).toBe(2);
      const written = await inst.flush();
      // Two CSVs (grain + wine) for the one settlement.
      expect(written.length).toBe(2);
      const wineCsv = await readFile(written.find((p) => p.endsWith('drink.wine.csv'))!, 'utf8');
      const wineLines = wineCsv.trim().split('\n');
      // Header + (backfilled day 0 zero row) + day 1 row.
      expect(wineLines.length).toBe(3);
      // Day 1 wine row: stockpile=4 (only A1 holds it).
      expect(wineLines[2]).toBe('1,4,0,0,,0');
    });
  });

  it('caps rows at the configured maximum', async () => {
    await withTempDir(async (outDir) => {
      const world = makeFakeWorld();
      const inst = createTimeSeriesInstrument({ outDir, maxRowsPerCsv: 5 });
      for (let d = 0; d < 20; d++) inst.tick(castWorld(world), d as Day);
      const written = await inst.flush();
      const csv = await readFile(written[0]!, 'utf8');
      const lines = csv.trim().split('\n');
      // 5 data rows + 1 header.
      expect(lines.length).toBe(6);
    });
  });

  it('default cap is 10000 rows', () => {
    expect(DEFAULT_MAX_ROWS_PER_CSV).toBe(10_000);
  });

  it('flush() is idempotent and writes only created series', async () => {
    await withTempDir(async (outDir) => {
      const world = makeFakeWorld();
      const inst = createTimeSeriesInstrument({ outDir });
      inst.tick(castWorld(world), 0 as Day);
      const a = await inst.flush();
      const b = await inst.flush();
      expect(b).toEqual(a);
      const files = await readdir(outDir);
      expect(files.length).toBe(a.length);
    });
  });
});

// --- Runner integration ---------------------------------------------------

const tinyOpts = (overrides: Partial<BurnInOpts>): BurnInOpts => ({
  seed: 'tsi-runner',
  mapWidth: 16,
  mapHeight: 16,
  cityCount: 1,
  townCount: 1,
  villageCount: 1,
  hamletCount: 1,
  years: 0,
  daysOverride: 5,
  invariantCheckEvery: 'week',
  snapshotEvery: 'never',
  outDir: '',
  silent: true,
  ...overrides,
});

describe('runBurnIn — time-series instrument integration', () => {
  it('does NOT write CSVs when --instruments is not passed', async () => {
    await withTempDir(async (outDir) => {
      await runBurnIn(tinyOpts({ outDir }));
      const files = await readdir(outDir);
      const csvs = files.filter((f) => f.endsWith('.csv'));
      expect(csvs).toEqual([]);
    });
  });

  it('writes one CSV per (settlement, resource) when instrument is enabled', async () => {
    await withTempDir(async (outDir) => {
      await runBurnIn(
        tinyOpts({
          outDir,
          daysOverride: 7,
          instruments: ['time-series'],
        }),
      );
      const files = await readdir(outDir);
      const csvs = files.filter((f) => f.endsWith('.csv'));
      expect(csvs.length).toBeGreaterThan(0);
      // Naming convention: settlement-<id>-resource-<r>.csv
      for (const f of csvs) {
        expect(f).toMatch(/^settlement-.+-resource-.+\.csv$/);
      }
      // CSV format: header + at least one data row per file.
      const sample = await readFile(join(outDir, csvs[0]!), 'utf8');
      const sampleLines = sample.trim().split('\n');
      expect(sampleLines[0]).toBe(
        'day,stockpile,inflow,outflow,lastClearingPrice,unmetDemandAtClearingPrice',
      );
      expect(sampleLines.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('throws if instruments are requested but outDir is empty', async () => {
    await expect(runBurnIn(tinyOpts({ outDir: '', instruments: ['time-series'] }))).rejects.toThrow(
      /outDir/,
    );
  });

  it('respects timeSeriesMaxRowsPerCsv to bound CSV size', async () => {
    await withTempDir(async (outDir) => {
      await runBurnIn(
        tinyOpts({
          outDir,
          daysOverride: 30,
          instruments: ['time-series'],
          timeSeriesMaxRowsPerCsv: 4,
        }),
      );
      const files = (await readdir(outDir)).filter((f) => f.endsWith('.csv'));
      expect(files.length).toBeGreaterThan(0);
      const sample = await readFile(join(outDir, files[0]!), 'utf8');
      const lines = sample.trim().split('\n');
      // 4 data rows + 1 header.
      expect(lines.length).toBeLessThanOrEqual(5);
    });
  });
});
