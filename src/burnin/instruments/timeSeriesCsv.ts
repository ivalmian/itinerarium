/**
 * Per-settlement, per-resource CSV time-series instrument (docs/15 §C15).
 *
 * Reference: docs/14-debug-strategies.md §"Per-settlement, per-resource time
 * series" and docs/15-v1-5-cleanups.md §C15.
 *
 * For each (settlement, resource) pair the burn-in encounters, this instrument
 * records one CSV row per tick:
 *
 *   day, stockpile, inflow, outflow, lastClearingPrice, unmetDemandAtClearingPrice
 *
 * - `stockpile`  — sum across every actor in the settlement's stockpileOwners
 *   (plus stragglers that show up over time as catchment / actor sets shift).
 * - `inflow`     — per-tick delta of `settlement.market.recentInflows[r]`.
 *   `recentInflows` is now exponentially-decayed (~30-day half-life) every
 *   day by `ageRecentFlowsPhase`, so the raw counter can DECREASE between
 *   ticks on a day with no new flow. We clamp the delta to `≥ 0` here, so
 *   "no flow today" days correctly record `inflow = 0` instead of a
 *   negative decay-drift number.
 * - `outflow`    — same clamped-delta semantics applied to `recentOutflows`.
 * - `lastClearingPrice` — `settlement.market.lastClearingPrice[r]` at the
 *   end of the tick (NaN encoded as empty cell when the resource has never
 *   cleared on this settlement).
 * - `unmetDemandAtClearingPrice` — derived from the trade phase result for
 *   the day. **Currently not surfaced via TickEvent**; the trade phase in
 *   `src/sim/tick.ts` discards `clearMarket()`'s `unmetDemandAtClearingPrice`
 *   field. For v1 of C15 we record 0; future work needs to extend the
 *   `market_cleared` TickEvent (or add a sibling event) so this column carries
 *   real signal. See docs/15 §C15 acceptance criteria.
 *
 * The instrument is opt-in (default behavior writes nothing): the burn-in
 * runner only constructs and ticks it when `--instruments=time-series` is
 * passed. The 6-year watchdog burn-in deliberately does not opt in; enabling
 * it on a 100-settlement realistic burn-in would write tens of thousands of
 * CSV files per run.
 *
 * Resource selection: by default, we record every resource that any actor in
 * the settlement holds at burn-in start. This avoids opening empty CSVs for
 * the ~50 catalog resources at every settlement. Resources that first appear
 * mid-burn are added on-the-fly with backfilled zero rows.
 *
 * Per-CSV row cap (default 10,000 rows ≈ ~27 in-game years) prevents a long
 * debug run from exploding disk / memory. Once the cap is reached the row
 * accumulator silently stops appending; flush() still writes whatever was
 * collected.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Day, ResourceId, SettlementId } from '../../sim/types.js';
import type { WorldState } from '../../procgen/seed.js';
import type { Settlement } from '../../sim/world/settlement.js';
import { actorStockEntriesAt, getStockAt } from '../../sim/politics/actor.js';

export interface TimeSeriesInstrumentOpts {
  /** Directory CSVs are written to. Created (recursive) if missing. */
  readonly outDir: string;
  /**
   * Maximum rows recorded per (settlement, resource) CSV. Cap exists so a
   * 50-year debug run doesn't OOM (50 × 365 = 18,250 rows × thousands of
   * pairs would be massive). Defaults to 10,000 (~27 in-game years).
   */
  readonly maxRowsPerCsv?: number;
}

export const DEFAULT_MAX_ROWS_PER_CSV = 10_000;

interface CsvRow {
  readonly day: Day;
  readonly stockpile: number;
  readonly inflow: number;
  readonly outflow: number;
  readonly lastClearingPrice: number | null;
  readonly unmetDemandAtClearingPrice: number;
}

interface SeriesState {
  readonly settlement: SettlementId;
  readonly resource: ResourceId;
  prevCumulativeInflow: number;
  prevCumulativeOutflow: number;
  rows: CsvRow[];
  capped: boolean;
}

const seriesKey = (settlement: SettlementId, resource: ResourceId): string =>
  `${String(settlement)}|${String(resource)}`;

const sumStockpileAcrossOwners = (
  world: WorldState,
  settlement: Settlement,
  resource: ResourceId,
): number => {
  let total = 0;
  for (const ownerId of settlement.stockpileOwners) {
    const actor = world.actors.get(ownerId);
    if (actor === undefined) continue;
    total += getStockAt(actor, settlement.id, resource);
  }
  return total;
};

/**
 * Determine the initial set of (settlement, resource) pairs to record. For
 * every settlement in `world`, every resource any owner currently holds is
 * recorded. Resources that first appear later are added on-the-fly by
 * `tickInstrument`.
 */
const initialResourcesForSettlement = (
  world: WorldState,
  settlement: Settlement,
): Set<ResourceId> => {
  const set = new Set<ResourceId>();
  for (const ownerId of settlement.stockpileOwners) {
    const actor = world.actors.get(ownerId);
    if (actor === undefined) continue;
    for (const [r, qty] of actorStockEntriesAt(actor, settlement.id)) {
      if (qty > 0) set.add(r);
    }
  }
  return set;
};

export interface TimeSeriesInstrument {
  /** Record one tick of state for every tracked (settlement, resource) pair. */
  tick(world: WorldState, day: Day): void;
  /** Write all accumulated CSVs to `outDir`. Idempotent. */
  flush(): Promise<readonly string[]>;
  /** Number of (settlement, resource) series being tracked (for tests). */
  readonly seriesCount: () => number;
}

export const createTimeSeriesInstrument = (
  opts: TimeSeriesInstrumentOpts,
): TimeSeriesInstrument => {
  const maxRows = Math.max(1, Math.floor(opts.maxRowsPerCsv ?? DEFAULT_MAX_ROWS_PER_CSV));
  const series = new Map<string, SeriesState>();

  const ensureSeries = (
    settlement: SettlementId,
    resource: ResourceId,
    backfillToDay: Day | null,
  ): SeriesState => {
    const key = seriesKey(settlement, resource);
    let s = series.get(key);
    if (s !== undefined) return s;
    const rows: CsvRow[] = [];
    s = {
      settlement,
      resource,
      prevCumulativeInflow: 0,
      prevCumulativeOutflow: 0,
      rows,
      capped: false,
    };
    series.set(key, s);
    // Backfill zero rows so per-CSV row counts align across resources that
    // were discovered mid-run vs. recorded from day 0. Only backfill if we've
    // ticked at least once (backfillToDay != null).
    if (backfillToDay !== null) {
      // Find the earliest day any series has — assume we want zeros for every
      // day prior to today. The simplest correct thing is to count how many
      // ticks have happened and backfill that many zero rows ending at
      // (today - 1). We approximate by looking at any existing series's row
      // count.
      let priorRows = 0;
      for (const other of series.values()) {
        if (other === s) continue;
        if (other.rows.length > priorRows) priorRows = other.rows.length;
      }
      // Backfill `priorRows` zero rows. The day numbers are unknown without
      // tracking them globally; we fill `(backfillToDay - priorRows + i)`.
      for (let i = 0; i < priorRows && rows.length < maxRows; i++) {
        const d = (backfillToDay - priorRows + i) as Day;
        rows.push({
          day: d,
          stockpile: 0,
          inflow: 0,
          outflow: 0,
          lastClearingPrice: null,
          unmetDemandAtClearingPrice: 0,
        });
      }
      if (rows.length >= maxRows) s.capped = true;
    }
    return s;
  };

  let initialized = false;

  const initialize = (world: WorldState, today: Day): void => {
    for (const settlement of world.settlements.values()) {
      const resources = initialResourcesForSettlement(world, settlement);
      for (const r of resources) {
        ensureSeries(settlement.id, r, today);
      }
    }
    initialized = true;
  };

  const tickInstrument = (world: WorldState, day: Day): void => {
    if (!initialized) initialize(world, day);

    for (const settlement of world.settlements.values()) {
      // Discover any new resources that have appeared since we last looked.
      // (Cheap: iterates the owner stockpiles, which are small Maps.)
      for (const ownerId of settlement.stockpileOwners) {
        const actor = world.actors.get(ownerId);
        if (actor === undefined) continue;
        for (const [r, qty] of actorStockEntriesAt(actor, settlement.id)) {
          if (qty > 0) ensureSeries(settlement.id, r, day);
        }
      }
      // Also include any resource the market has price/flow for, even if
      // current stockpile is 0 (the producer just sold every unit).
      for (const r of settlement.market.recentInflows.keys()) {
        ensureSeries(settlement.id, r, day);
      }
      for (const r of settlement.market.recentOutflows.keys()) {
        ensureSeries(settlement.id, r, day);
      }
      for (const r of settlement.market.lastClearingPrice.keys()) {
        ensureSeries(settlement.id, r, day);
      }
    }

    for (const s of series.values()) {
      if (s.capped) continue;
      const settlement = world.settlements.get(s.settlement);
      // If a settlement has been removed (it can't be today, but defensive)
      // skip — leave any remaining rows in place.
      if (settlement === undefined) continue;

      const stockpile = sumStockpileAcrossOwners(world, settlement, s.resource);
      const cumInflow = settlement.market.recentInflows.get(s.resource) ?? 0;
      const cumOutflow = settlement.market.recentOutflows.get(s.resource) ?? 0;
      const inflowDelta = Math.max(0, cumInflow - s.prevCumulativeInflow);
      const outflowDelta = Math.max(0, cumOutflow - s.prevCumulativeOutflow);
      const lastPrice = settlement.market.lastClearingPrice.get(s.resource);

      s.rows.push({
        day,
        stockpile,
        inflow: inflowDelta,
        outflow: outflowDelta,
        lastClearingPrice: lastPrice ?? null,
        // unmetDemandAtClearingPrice is not surfaced by the trade phase yet;
        // see file header + docs/15 §C15.
        unmetDemandAtClearingPrice: 0,
      });

      s.prevCumulativeInflow = cumInflow;
      s.prevCumulativeOutflow = cumOutflow;

      if (s.rows.length >= maxRows) s.capped = true;
    }
  };

  const formatPrice = (p: number | null): string => {
    if (p === null || !Number.isFinite(p)) return '';
    return String(p);
  };

  const formatRow = (r: CsvRow): string =>
    [
      String(r.day),
      String(r.stockpile),
      String(r.inflow),
      String(r.outflow),
      formatPrice(r.lastClearingPrice),
      String(r.unmetDemandAtClearingPrice),
    ].join(',');

  const csvForSeries = (s: SeriesState): string => {
    const header = 'day,stockpile,inflow,outflow,lastClearingPrice,unmetDemandAtClearingPrice';
    const lines: string[] = [header];
    for (const r of s.rows) lines.push(formatRow(r));
    return `${lines.join('\n')}\n`;
  };

  const sanitizeForFilename = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

  const flush = async (): Promise<readonly string[]> => {
    await mkdir(opts.outDir, { recursive: true });
    const written: string[] = [];
    for (const s of series.values()) {
      const settlementSafe = sanitizeForFilename(String(s.settlement));
      const resourceSafe = sanitizeForFilename(String(s.resource));
      const filename = `settlement-${settlementSafe}-resource-${resourceSafe}.csv`;
      const path = join(opts.outDir, filename);
      await writeFile(path, csvForSeries(s), 'utf8');
      written.push(path);
    }
    return written;
  };

  return {
    tick: tickInstrument,
    flush,
    seriesCount: () => series.size,
  };
};
