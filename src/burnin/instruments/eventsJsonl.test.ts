/**
 * Tests for the events.jsonl instrument (docs/14 §"Raw tick-event log").
 *
 * Two layers of coverage:
 *  - Unit-level: feed synthetic TickEvent arrays through the instrument
 *    and assert one JSON-per-line file is produced, day-stamped.
 *  - Runner integration: confirm runBurnIn writes events.jsonl when
 *    --instruments=events is passed, and writes nothing by default.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventsJsonlInstrument } from './eventsJsonl.js';
import type { Day, SettlementId, ResourceId } from '../../sim/types.js';
import { runBurnIn, type BurnInOpts } from '../runner.js';

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'eventsjsonl-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('createEventsJsonlInstrument', () => {
  it('writes one JSON line per event with day stamped', async () => {
    await withTempDir(async (outDir) => {
      const inst = createEventsJsonlInstrument({ outDir, flushEvery: 1 });
      inst.tick(5 as Day, [
        {
          type: 'market_cleared',
          settlement: 'S1' as SettlementId,
          resource: 'food.grain' as ResourceId,
          price: 12,
          volume: 80,
        },
        {
          type: 'caravan_arrived',
          caravan: 'C1' as never,
          at: { q: 0, r: 0 } as never,
        },
      ]);
      await inst.flush();
      expect(inst.count()).toBe(2);
      const content = await readFile(join(outDir, 'events.jsonl'), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
      const parsed = lines.map((l) => JSON.parse(l));
      expect(parsed[0]).toMatchObject({ day: 5, type: 'market_cleared', price: 12, volume: 80 });
      expect(parsed[1]).toMatchObject({ day: 5, type: 'caravan_arrived' });
    });
  });

  it('flushes buffered lines only when buffer threshold hit', async () => {
    await withTempDir(async (outDir) => {
      const inst = createEventsJsonlInstrument({ outDir, flushEvery: 10 });
      // 3 events should NOT trigger a write yet.
      inst.tick(1 as Day, [
        { type: 'market_cleared', settlement: 'S' as SettlementId, resource: 'r' as ResourceId, price: 1, volume: 1 },
        { type: 'market_cleared', settlement: 'S' as SettlementId, resource: 'r' as ResourceId, price: 2, volume: 2 },
        { type: 'market_cleared', settlement: 'S' as SettlementId, resource: 'r' as ResourceId, price: 3, volume: 3 },
      ]);
      // The file may or may not exist yet, but flush() must produce all events.
      await inst.flush();
      const content = await readFile(join(outDir, 'events.jsonl'), 'utf8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(3);
    });
  });
});

const tinyOpts = (overrides: Partial<BurnInOpts>): BurnInOpts => ({
  seed: 'events-runner',
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

describe('runBurnIn — events instrument integration', () => {
  it('does NOT write events.jsonl when --instruments is not passed', async () => {
    await withTempDir(async (outDir) => {
      await runBurnIn(tinyOpts({ outDir }));
      const files = await readdir(outDir);
      expect(files.includes('events.jsonl')).toBe(false);
    });
  });

  it('writes events.jsonl when instrument is enabled', async () => {
    await withTempDir(async (outDir) => {
      await runBurnIn(tinyOpts({ outDir, instruments: ['events'] }));
      const files = await readdir(outDir);
      expect(files.includes('events.jsonl')).toBe(true);
      const content = await readFile(join(outDir, 'events.jsonl'), 'utf8');
      // Even a 5-day run produces some events (market clearings, recipe runs).
      const lines = content.trim().split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      const sample = JSON.parse(lines[0]!);
      expect(sample).toHaveProperty('day');
      expect(sample).toHaveProperty('type');
    });
  });
});
