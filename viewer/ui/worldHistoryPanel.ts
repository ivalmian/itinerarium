/**
 * World History panel — sidebar widget showing global aggregates
 * over time as sparklines + numeric tables.
 *
 * Reads from `ViewerHistory.global`, which is sampled every
 * `GLOBAL_HISTORY_SAMPLE_DAYS` and capped at
 * `GLOBAL_HISTORY_MAX_SAMPLES` entries (about 13.7 game-years).
 *
 * The panel is built as a single collapsible section in the sidebar
 * with these sub-blocks:
 *   - Population by tier (sparklines + current values)
 *   - Treasury by actor kind (sparklines for the biggest holders)
 *   - Caravan fleet composition
 *   - Bandit pressure (camp count + total bandits)
 *   - Cumulative events (famine, disease, recipes, market clearings)
 *   - Key resource prices (median across settlements)
 *
 * All rendering is DOM + inline SVG sparklines (no Pixi). Per-tick
 * `update()` re-derives the displayed series from history.global so
 * the panel naturally tracks the live sim.
 */

import { createSparkline, fmtCompact } from './sparkline.js';
import type { ViewerHistory, GlobalSnapshot } from '../state/history.js';
import type { ResourceId } from '../../src/sim/types.js';

export interface WorldHistoryPanel {
  update(): void;
  readonly root: HTMLElement;
}

interface SparkRow {
  readonly row: HTMLElement;
  readonly sparkHost: HTMLElement;
  readonly valueEl: HTMLElement;
}

const KEY_PRICE_RESOURCES: readonly ResourceId[] = [
  'food.grain',
  'food.bread',
  'goods.tools',
  'metal.iron',
  'goods.cloth',
] as ResourceId[];

const TREASURY_KIND_ORDER: readonly string[] = [
  'governor_office',
  'city_corporation',
  'patrician_family',
  'merchant_guild',
  'free_village',
  'hamlet_household',
  'plebeian_household',
  'freedman_household',
  'foreigner_household',
  'caravan_owner',
  'off_map_house',
];

const TREASURY_LABELS: Readonly<Record<string, string>> = {
  governor_office: 'governor',
  city_corporation: 'city corp',
  patrician_family: 'patricians',
  merchant_guild: 'guilds',
  free_village: 'villages',
  hamlet_household: 'hamlets',
  plebeian_household: 'plebeians',
  freedman_household: 'freedmen',
  foreigner_household: 'foreigners',
  caravan_owner: 'caravan owners',
  off_map_house: 'off-map',
};

export interface WorldHistoryPanelOpts {
  readonly history: ViewerHistory;
}

export const createWorldHistoryPanel = (opts: WorldHistoryPanelOpts): WorldHistoryPanel => {
  const { history } = opts;
  const root = document.createElement('div');
  root.className = 'world-history-panel';

  // Population by tier
  const popSection = subSection(root, 'Population');
  const popRows = new Map<string, SparkRow>();
  for (const tier of ['hamlet', 'village', 'town', 'small_city', 'large_city', 'total']) {
    popRows.set(tier, addSparkRow(popSection, tier));
  }

  // Caravan fleet
  const caravanSection = subSection(root, 'Caravan fleet');
  const caravanRows = new Map<string, SparkRow>();
  for (const kind of ['villager', 'merchant', 'export_', 'import_', 'tax', 'other', 'total']) {
    caravanRows.set(kind, addSparkRow(caravanSection, caravanLabel(kind)));
  }

  // Bandits
  const banditSection = subSection(root, 'Bandits');
  const banditRows = {
    camps: addSparkRow(banditSection, 'camps'),
    total: addSparkRow(banditSection, 'total bandits'),
  };

  // Treasury by kind
  const treasurySection = subSection(root, 'Treasury (sum coin)');
  const treasuryRows = new Map<string, SparkRow>();
  for (const kind of TREASURY_KIND_ORDER) {
    treasuryRows.set(kind, addSparkRow(treasurySection, TREASURY_LABELS[kind] ?? kind));
  }

  // Cumulative event counters
  const cumSection = subSection(root, 'Cumulative');
  const cumRows = {
    famine: addSparkRow(cumSection, 'famine deaths'),
    disease: addSparkRow(cumSection, 'disease deaths'),
    recipes: addSparkRow(cumSection, 'recipe runs'),
    markets: addSparkRow(cumSection, 'market clears'),
    settlements: addSparkRow(cumSection, 'settlements'),
  };

  // Median key resource prices
  const priceSection = subSection(root, 'Median price (key resources)');
  const priceRows = new Map<ResourceId, SparkRow>();
  for (const r of KEY_PRICE_RESOURCES) {
    priceRows.set(r, addSparkRow(priceSection, priceLabel(r)));
  }

  const update = (): void => {
    const series = history.global;
    if (series.length === 0) {
      // Render placeholders.
      for (const row of popRows.values()) renderRow(row, [], 0);
      for (const row of caravanRows.values()) renderRow(row, [], 0);
      renderRow(banditRows.camps, [], 0);
      renderRow(banditRows.total, [], 0);
      for (const row of treasuryRows.values()) renderRow(row, [], 0);
      renderRow(cumRows.famine, [], 0);
      renderRow(cumRows.disease, [], 0);
      renderRow(cumRows.recipes, [], 0);
      renderRow(cumRows.markets, [], 0);
      renderRow(cumRows.settlements, [], 0);
      for (const row of priceRows.values()) renderRow(row, [], 0);
      return;
    }
    const last = series[series.length - 1] as GlobalSnapshot;

    // Population by tier.
    const popSeries = (key: keyof GlobalSnapshot['population']): number[] =>
      series.map((s) => s.population[key]);
    renderRow(popRows.get('hamlet')!, popSeries('hamlet'), last.population.hamlet);
    renderRow(popRows.get('village')!, popSeries('village'), last.population.village);
    renderRow(popRows.get('town')!, popSeries('town'), last.population.town);
    renderRow(popRows.get('small_city')!, popSeries('small_city'), last.population.small_city);
    renderRow(popRows.get('large_city')!, popSeries('large_city'), last.population.large_city);
    renderRow(popRows.get('total')!, popSeries('total'), last.population.total);

    // Caravans.
    renderRow(caravanRows.get('villager')!, series.map((s) => s.caravans.villager), last.caravans.villager);
    renderRow(caravanRows.get('merchant')!, series.map((s) => s.caravans.merchant), last.caravans.merchant);
    renderRow(caravanRows.get('export_')!, series.map((s) => s.caravans.export_), last.caravans.export_);
    renderRow(caravanRows.get('import_')!, series.map((s) => s.caravans.import_), last.caravans.import_);
    renderRow(caravanRows.get('tax')!, series.map((s) => s.caravans.tax), last.caravans.tax);
    renderRow(caravanRows.get('other')!, series.map((s) => s.caravans.other), last.caravans.other);
    renderRow(caravanRows.get('total')!, series.map((s) => s.caravans.total), last.caravans.total);

    // Bandits.
    renderRow(banditRows.camps, series.map((s) => s.banditCampCount), last.banditCampCount);
    renderRow(banditRows.total, series.map((s) => s.banditTotalCount), last.banditTotalCount);

    // Treasury by kind — only render kinds present in the latest snapshot.
    for (const [kind, row] of treasuryRows) {
      const values = series.map((s) => s.treasuryByKind.get(kind) ?? 0);
      const lastVal = last.treasuryByKind.get(kind) ?? 0;
      // Hide rows for kinds that are universally zero across the whole history.
      const hasAny = values.some((v) => v > 0);
      row.row.style.display = hasAny ? '' : 'none';
      renderRow(row, values, lastVal);
    }

    // Cumulative event counters.
    renderRow(
      cumRows.famine,
      series.map((s) => s.cumulativeFamineDeaths),
      last.cumulativeFamineDeaths,
    );
    renderRow(
      cumRows.disease,
      series.map((s) => s.cumulativeDiseaseDeaths),
      last.cumulativeDiseaseDeaths,
    );
    renderRow(
      cumRows.recipes,
      series.map((s) => s.cumulativeRecipeRuns),
      last.cumulativeRecipeRuns,
    );
    renderRow(
      cumRows.markets,
      series.map((s) => s.cumulativeMarketClearings),
      last.cumulativeMarketClearings,
    );
    renderRow(
      cumRows.settlements,
      series.map((s) => s.settlementCount),
      last.settlementCount,
    );

    // Median prices.
    for (const [r, row] of priceRows) {
      const values = series.map((s) => s.medianPrices.get(r) ?? 0);
      const lastVal = last.medianPrices.get(r) ?? 0;
      const hasAny = values.some((v) => v > 0);
      row.row.style.display = hasAny ? '' : 'none';
      renderRow(row, values, lastVal);
    }
  };

  return { update, root };
};

const subSection = (host: HTMLElement, title: string): HTMLElement => {
  const wrap = document.createElement('div');
  wrap.className = 'world-history-subsection';
  const h = document.createElement('h4');
  h.textContent = title;
  h.style.margin = '6px 0 2px 0';
  h.style.fontSize = '11px';
  h.style.opacity = '0.7';
  h.style.textTransform = 'uppercase';
  h.style.letterSpacing = '0.05em';
  wrap.appendChild(h);
  host.appendChild(wrap);
  return wrap;
};

const addSparkRow = (host: HTMLElement, label: string): SparkRow => {
  const row = document.createElement('div');
  row.className = 'world-history-row';
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '90px 90px 60px';
  row.style.alignItems = 'center';
  row.style.gap = '4px';
  row.style.fontSize = '11px';
  row.style.lineHeight = '14px';

  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  labelEl.style.opacity = '0.85';
  row.appendChild(labelEl);

  const sparkHost = document.createElement('span');
  sparkHost.style.display = 'inline-block';
  sparkHost.style.height = '14px';
  row.appendChild(sparkHost);

  const valueEl = document.createElement('span');
  valueEl.style.textAlign = 'right';
  valueEl.style.fontVariantNumeric = 'tabular-nums';
  valueEl.textContent = '—';
  row.appendChild(valueEl);

  host.appendChild(row);
  return { row, sparkHost, valueEl };
};

const renderRow = (sr: SparkRow, values: number[], current: number): void => {
  sr.sparkHost.replaceChildren();
  if (values.length > 0) {
    sr.sparkHost.appendChild(
      createSparkline(values, { width: 90, height: 14 }),
    );
  }
  sr.valueEl.textContent = fmtCompact(current);
};

const caravanLabel = (kind: string): string => {
  if (kind === 'export_') return 'export';
  if (kind === 'import_') return 'import';
  return kind;
};

const priceLabel = (r: ResourceId): string => {
  const s = String(r);
  // Drop the category prefix for display.
  const idx = s.indexOf('.');
  return idx >= 0 ? s.slice(idx + 1) : s;
};
