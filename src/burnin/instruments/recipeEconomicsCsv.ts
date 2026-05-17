/**
 * Per-recipe economics CSV instrument (docs/14 §"Per-recipe economics
 * CSV" + docs/08 §"Marginal-product wages").
 *
 * For each tick, records one row per emitted `recipe_economics` event:
 *
 *   day, settlement, recipe, owner, owner_kind, runs, output_value,
 *   input_value, wage_paid_coin, wage_paid_inkind, wage_paid_total,
 *   owner_take, paid_worker_days, subsistence_wage_per_day,
 *   mp_per_worker_day
 *
 * Aggregation: within a single day, multiple recipe_economics events
 * for the same (settlement, recipe, owner) tuple are summed into one
 * row so a settlement with 5 farms running grain doesn't emit 5 rows
 * per day per recipe.
 *
 * Use: surfacing rural→urban surplus flow, family income, slave-vs-
 * free-labor wage differential, recipe-margin distribution, and
 * settlement-level production economics across a burn-in.
 *
 * Cost: bounded by daily recipe-run count × settlement count. A
 * 600-settlement, 50-recipe burn-in over 2 years writes ≈
 * 600 × 50 × 730 / N rows where N is the per-day aggregation factor;
 * empirically tens of thousands of rows, single-file CSV.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActorId, Day, RecipeId, SettlementId } from '../../sim/types.js';
import type { TickEvent } from '../../sim/tick.js';
import type { WorldState } from '../../procgen/seed.js';

export interface RecipeEconomicsInstrumentOpts {
  readonly outDir: string;
  /** Cap on total rows recorded; protects very long runs from OOM. */
  readonly maxRows?: number;
}

export const DEFAULT_MAX_ROWS = 5_000_000;

interface AggKey {
  readonly day: Day;
  readonly settlement: SettlementId;
  readonly recipe: RecipeId;
  readonly owner: ActorId;
}

interface AggValue {
  ownerKind: string;
  runs: number;
  outputValue: number;
  inputValue: number;
  wagePaidCoin: number;
  wagePaidInKind: number;
  wagePaidTotal: number;
  ownerTake: number;
  paidWorkerDays: number;
  subsistenceWagePerDay: number;
  mpPerWorkerDay: number;
}

const aggKey = (k: AggKey): string =>
  `${k.day}|${String(k.settlement)}|${String(k.recipe)}|${String(k.owner)}`;

export interface RecipeEconomicsInstrument {
  /** Record one tick's recipe_economics events. */
  tick(world: WorldState, day: Day, events: readonly TickEvent[]): void;
  /** Write the accumulated CSV to outDir/recipe-economics.csv. */
  flush(): Promise<string>;
  /** Row count (for tests). */
  readonly rowCount: () => number;
}

export const createRecipeEconomicsInstrument = (
  opts: RecipeEconomicsInstrumentOpts,
): RecipeEconomicsInstrument => {
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? DEFAULT_MAX_ROWS));
  const agg = new Map<string, AggValue & AggKey>();
  let capped = false;

  return {
    tick(world: WorldState, day: Day, events: readonly TickEvent[]): void {
      if (capped) return;
      for (const e of events) {
        if (e.type !== 'recipe_economics') continue;
        const ownerActor = world.actors.get(e.owner);
        const ownerKind = ownerActor?.kind ?? 'unknown';
        const k: AggKey = {
          day,
          settlement: e.settlement,
          recipe: e.recipe,
          owner: e.owner,
        };
        const key = aggKey(k);
        let row = agg.get(key);
        if (row === undefined) {
          if (agg.size >= maxRows) {
            capped = true;
            return;
          }
          row = {
            ...k,
            ownerKind,
            runs: 0,
            outputValue: 0,
            inputValue: 0,
            wagePaidCoin: 0,
            wagePaidInKind: 0,
            wagePaidTotal: 0,
            ownerTake: 0,
            paidWorkerDays: 0,
            subsistenceWagePerDay: 0,
            mpPerWorkerDay: 0,
          };
          agg.set(key, row);
        }
        row.runs += 1;
        row.outputValue += e.outputValue;
        row.inputValue += e.inputValue;
        row.wagePaidCoin += e.wagePaidCoin;
        row.wagePaidInKind += e.wagePaidInKindValue;
        row.wagePaidTotal += e.wagePaidTotal;
        row.ownerTake += e.ownerTake;
        row.paidWorkerDays += e.paidWorkerDays;
        // Subsistence wage + mp are not additive — we record the
        // latest observed value per (settlement, recipe) per day,
        // which is the same across the day's runs.
        row.subsistenceWagePerDay = e.subsistenceWagePerDay;
        row.mpPerWorkerDay = e.marginalProductPerWorkerDay;
      }
    },
    async flush(): Promise<string> {
      await mkdir(opts.outDir, { recursive: true });
      const path = join(opts.outDir, 'recipe-economics.csv');
      const lines: string[] = [];
      lines.push(
        'day,settlement,recipe,owner,owner_kind,runs,output_value,input_value,' +
          'wage_paid_coin,wage_paid_inkind,wage_paid_total,owner_take,paid_worker_days,' +
          'subsistence_wage_per_day,mp_per_worker_day',
      );
      const rows = Array.from(agg.values()).sort((a, b) => {
        if (a.day !== b.day) return a.day - b.day;
        const sa = String(a.settlement);
        const sb = String(b.settlement);
        if (sa !== sb) return sa < sb ? -1 : 1;
        return String(a.recipe) < String(b.recipe) ? -1 : 1;
      });
      for (const r of rows) {
        lines.push(
          [
            r.day,
            String(r.settlement),
            String(r.recipe),
            String(r.owner),
            r.ownerKind,
            r.runs,
            r.outputValue.toFixed(2),
            r.inputValue.toFixed(2),
            r.wagePaidCoin.toFixed(2),
            r.wagePaidInKind.toFixed(2),
            r.wagePaidTotal.toFixed(2),
            r.ownerTake.toFixed(2),
            r.paidWorkerDays.toFixed(4),
            r.subsistenceWagePerDay.toFixed(2),
            r.mpPerWorkerDay.toFixed(2),
          ].join(','),
        );
      }
      await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
      return path;
    },
    rowCount(): number {
      return agg.size;
    },
  };
};
