/**
 * Raw tick-event log instrument (docs/14 §"Raw tick-event log").
 *
 * Streams every emitted TickEvent to `outDir/events.jsonl`, one line
 * per event, with the day stamped in. Used to diagnose class-of-event
 * bugs — e.g. "zero caravan_robbed events fire despite bandit camps
 * existing" — that aggregate summaries can't see.
 *
 * Cost: bounded by the per-tick event volume. A 10y burn-in produces
 * millions of lines; use `--instruments=events` only when a class-of-
 * event question is being asked. Use grep / jq to filter by `type`.
 *
 * To keep memory bounded across long runs we buffer per-tick and flush
 * to disk on each tick rather than holding all events until run end.
 * The file is opened once and appended to.
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Day } from '../../sim/types.js';
import type { TickEvent } from '../../sim/tick.js';

export interface EventsJsonlInstrumentOpts {
  readonly outDir: string;
  /** Buffer N events before flushing to disk. Default 5000. */
  readonly flushEvery?: number;
}

export interface EventsJsonlInstrument {
  tick(day: Day, events: readonly TickEvent[]): void;
  /** Flush any buffered lines and close the file. */
  flush(): Promise<string>;
  /** Total events recorded (for tests). */
  readonly count: () => number;
}

const replacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  return value;
};

export const createEventsJsonlInstrument = (
  opts: EventsJsonlInstrumentOpts,
): EventsJsonlInstrument => {
  const flushEvery = Math.max(1, Math.floor(opts.flushEvery ?? 5_000));
  const path = join(opts.outDir, 'events.jsonl');
  let buffer: string[] = [];
  let total = 0;
  let initialized = false;

  const ensureInit = async (): Promise<void> => {
    if (initialized) return;
    await mkdir(opts.outDir, { recursive: true });
    await writeFile(path, '', 'utf8');
    initialized = true;
  };

  let pendingWrite: Promise<void> = Promise.resolve();
  const flushBuffer = (): void => {
    if (buffer.length === 0) return;
    const chunk = buffer.join('\n') + '\n';
    buffer = [];
    pendingWrite = pendingWrite.then(async () => {
      await ensureInit();
      await appendFile(path, chunk, 'utf8');
    });
  };

  return {
    tick(day: Day, events: readonly TickEvent[]): void {
      for (const e of events) {
        buffer.push(JSON.stringify({ day, ...e }, replacer));
        total += 1;
      }
      if (buffer.length >= flushEvery) flushBuffer();
    },
    async flush(): Promise<string> {
      flushBuffer();
      await pendingWrite;
      return path;
    },
    count(): number {
      return total;
    },
  };
};
