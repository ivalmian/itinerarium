#!/usr/bin/env python3
"""Generate a markdown analysis report from a burn-in output directory.

Per CLAUDE.md §"Burn-in output goes under ./burnin/", every burn-in
run lives under `./burnin/<name>/`. This script takes that directory
and produces a multi-section markdown report covering:

  1. Run overview (pop / famine / caravan / invariant counts).
  2. Population by tier × year.
  3. Stockpile days-of-supply per tier × resource × year.
  4. Median clearing prices × year.
  5. Caravan fleet composition × year.
  6. Treasury concentration by actor kind × year.
  7. Wage payments by hiring-owner-kind × year.
  8. Owner take by class × year.
  9. Top recipes by total output value.
  10. Worst recipes (loss-makers).

Inputs read from the burn-in directory:
  - snap-day-NNNNNN.json (one per --snapshots boundary; the script
    picks up all yearly boundaries it finds and skips missing ones)
  - recipe-economics.csv (stream-aggregated; written when
    --instruments=recipe-economics was passed to the burn-in)
  - report.json (always written by the burn-in)

CLI:
  python3 scripts/analyze-burnin.py \\
    --dir burnin/v1-9-resolved-10y \\
    --out docs/v1-9-burnin-report.md \\
    [--title "v1.9 10y burn-in"] \\
    [--max-years 9]

Both --dir and --out are required. If recipe-economics.csv is
missing the script still generates sections 1-6 + a warning note
in place of 7-10.
"""
from __future__ import annotations
import argparse, json, csv, statistics, os, re, sys
from collections import defaultdict, Counter

# --- Snapshot loaders ------------------------------------------------------

def load_snapshot(burnin_dir: str, day: int) -> dict:
    path = os.path.join(burnin_dir, f'snap-day-{day:06d}.json')
    with open(path) as f:
        return json.load(f)


def discover_yearly_snapshot_days(burnin_dir: str, max_years: int | None) -> list[tuple[int, int]]:
    """Return [(year_label, day)] for every snap-day-N file at a 365-day
    boundary that exists in the burn-in directory.

    The burn-in CLI's `--snapshots=year` mode writes one snapshot per
    year. We tolerate runs that wrote at different intervals by
    accepting any file whose day is an exact multiple of 365 and that
    exists on disk.
    """
    pattern = re.compile(r'^snap-day-(\d{6})\.json$')
    available_days: list[int] = []
    if not os.path.isdir(burnin_dir):
        return []
    for entry in sorted(os.listdir(burnin_dir)):
        m = pattern.match(entry)
        if m is None:
            continue
        day = int(m.group(1))
        if day == 0:
            continue  # day 0 = pre-tick state, not interesting
        if day % 365 != 0:
            continue  # only yearly boundaries
        available_days.append(day)
    out: list[tuple[int, int]] = []
    for day in available_days:
        year_label = day // 365
        if max_years is not None and year_label > max_years:
            continue
        out.append((year_label, day))
    return out

# Per-capita daily consumption matching scheduleBuilder.ts COMFORT_WANT_QTY.
KG_PER_MODIUS = 6.7
PCD = {
    'food.grain': 0.4 / KG_PER_MODIUS,
    'food.wine': 0.25,
    'food.olive_oil': 0.04,
    'food.cheese': 0.012,
    'food.salted_fish': 0.015,
    'food.salted_meat': 0.025,
    'goods.cloth': 0.005,
    'goods.clothing': 0.004,
    'goods.furniture': 0.0003,
    'material.pottery': 0.012,
}

# --- Population / tier breakdown ------------------------------------------

def settlement_pop_and_tier(snap):
    """Return {settlement_id: (tier, total_pop)} for the snapshot."""
    out = {}
    for sid, sval in dict(snap['world']['settlements']).items():
        total = 0
        for entry in sval.get('population', []):
            if isinstance(entry, list) and len(entry) == 2:
                total += entry[1]
        out[sid] = (sval.get('tier'), total)
    return out

# --- Stockpile shape per (tier, resource) ---------------------------------

def aggregate_stockpiles_by_settlement(snap):
    """{settlement_id: {resource: total_qty}}."""
    agg = defaultdict(lambda: defaultdict(float))
    actors = dict(snap['world']['actors'])
    for aid, a in actors.items():
        for loc in a.get('stockpile', []):
            if not (isinstance(loc, list) and len(loc) == 2): continue
            sid, entries = loc
            if not isinstance(entries, list): continue
            for entry in entries:
                if not (isinstance(entry, list) and len(entry) == 2): continue
                res, qty = entry
                agg[sid][res] += float(qty)
    return agg

def days_of_supply_by_tier(snap):
    """{tier: {resource: median_days_of_supply}}."""
    sett_info = settlement_pop_and_tier(snap)
    stock = aggregate_stockpiles_by_settlement(snap)
    by_tier = defaultdict(lambda: defaultdict(list))
    for sid, stock_by_res in stock.items():
        tier, pop = sett_info.get(sid, (None, 0))
        if pop <= 0 or tier is None: continue
        for res, pcd in PCD.items():
            qty = stock_by_res.get(res, 0)
            days = qty / (pop * pcd) if pcd > 0 else 0
            by_tier[tier][res].append(days)
    return by_tier

# --- Price level per resource ---------------------------------------------

def median_settlement_price(snap, resource):
    """Median of lastClearingPrice across all settlements that recorded one."""
    prices = []
    for sid, sval in dict(snap['world']['settlements']).items():
        for r, p in sval.get('market', {}).get('lastClearingPrice', []):
            if r == resource and p > 0:
                prices.append(p)
                break
    return statistics.median(prices) if prices else None

# --- Caravan counts -------------------------------------------------------

def caravan_breakdown(snap):
    """Count caravans by ID prefix."""
    cnt = Counter()
    for cid, c in dict(snap['world']['caravans']).items():
        s = cid
        if s.startswith('villager-'): cnt['villager'] += 1
        elif s.startswith('export-'): cnt['export'] += 1
        elif s.startswith('import-'): cnt['import'] += 1
        elif s.startswith('tax-'): cnt['tax'] += 1
        elif s.startswith('merchant-'): cnt['merchant'] += 1
        else: cnt['other'] += 1
    return cnt

# --- Treasury distribution -----------------------------------------------

def treasury_by_kind(snap):
    """{kind: (count, sum_treasury, median, top1)}."""
    by_kind = defaultdict(list)
    for aid, a in dict(snap['world']['actors']).items():
        by_kind[a['kind']].append(a.get('treasury', 0))
    out = {}
    for k, treasuries in by_kind.items():
        if not treasuries: continue
        treasuries = [t for t in treasuries if t is not None]
        n = len(treasuries)
        total = sum(treasuries)
        median = statistics.median(treasuries) if treasuries else 0
        top1 = max(treasuries) if treasuries else 0
        out[k] = (n, total, median, top1)
    return out

# --- Class wage share (from recipe-economics CSV) -------------------------
# Heavy: stream-aggregate the CSV instead of loading.

OWNER_KIND_CLASS = {
    # rough class proxy by owner kind (for wage share)
    'free_village': 'rural',
    'hamlet_household': 'rural',
    'plebeian_household': 'urban_plebeian',
    'freedman_household': 'urban_freedman',
    'foreigner_household': 'urban_foreigner',
    'patrician_family': 'patrician',
    'city_corporation': 'civic',
    'governor_office': 'state',
    'temple': 'state',
    'merchant_guild': 'guild',
}

def stream_recipe_economics(burnin_dir: str):
    """Aggregate recipe-economics CSV by (year_bucket, owner_kind, recipe).

    Returns:
      yearly_wages: {year: {owner_kind: total_wage_paid}}
      yearly_owner_take: {year: {owner_kind: total_owner_take}}
      top_recipes: {recipe: (runs, output_value_sum)}
      worst_recipes: {recipe: (runs, owner_loss_sum)}

    If recipe-economics.csv doesn't exist (the burn-in wasn't run
    with --instruments=recipe-economics), returns three empty dicts
    and the caller emits a warning in the report.
    """
    path = os.path.join(burnin_dir, 'recipe-economics.csv')
    if not os.path.isfile(path):
        return defaultdict(lambda: defaultdict(float)), defaultdict(lambda: defaultdict(float)), defaultdict(lambda: [0, 0.0, 0.0])
    yearly_wages = defaultdict(lambda: defaultdict(float))
    yearly_owner_take = defaultdict(lambda: defaultdict(float))
    recipe_agg = defaultdict(lambda: [0, 0.0, 0.0])  # runs, output_value, owner_take
    print(f'streaming {os.path.getsize(path)/1024/1024:.0f} MB CSV...', file=sys.stderr)
    with open(path) as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            if i % 1_000_000 == 0 and i > 0:
                print(f'  ...{i:>10} rows', file=sys.stderr)
            day = int(row['day'])
            year = day // 365 + 1
            owner_kind = row['owner_kind']
            wage = float(row['wage_paid_total'])
            take = float(row['owner_take'])
            yearly_wages[year][owner_kind] += wage
            yearly_owner_take[year][owner_kind] += take
            recipe = row['recipe']
            a = recipe_agg[recipe]
            a[0] += int(row['runs'])
            a[1] += float(row['output_value'])
            a[2] += take
    return yearly_wages, yearly_owner_take, recipe_agg

# --- Report writer --------------------------------------------------------

def fmt_int(n):
    return f'{int(n):,}' if n >= 1 else f'{n:.2f}'

def fmt_kc(n):
    """Format coins with k/M suffix for readability."""
    if abs(n) >= 1e9: return f'{n/1e9:.2f}B'
    if abs(n) >= 1e6: return f'{n/1e6:.1f}M'
    if abs(n) >= 1e3: return f'{n/1e3:.1f}k'
    return f'{n:.0f}'

# --- Report body ---------------------------------------------------------

def write_section_overview(out, report):
    """Pop / famine / caravans over the run."""
    out.append('## 1. Run overview\n')
    s = report['summary']
    v = {sev: sum(1 for x in report.get('violations', []) if x.get('severity') == sev) for sev in ('fatal', 'error', 'warning')}
    out.append(f'- **Seed**: {report["opts"].get("seed", "?")}')
    final_day = report.get('finalDay', 0)
    years = final_day / 365
    out.append(f'- **Years**: {years:.1f} ({final_day} days)')
    out.append(f'- **Population**: {s["populationAtStart"]:,} → {s["populationAtEnd"]:,} (Δ {(s["populationAtEnd"]/s["populationAtStart"]-1)*100:+.1f} %)')
    out.append(f'- **Settlements**: {s["totalSettlementsAtStart"]:,} → {s["totalSettlementsAtEnd"]:,}')
    out.append(f'- **Total famine deaths**: {s["famineDeaths"]:,}')
    out.append(f'- **Total epidemics**: {s["epidemicsTriggered"]}')
    out.append(f'- **Baseline + disease deaths**: {s["baselineDeaths"]:,} + {s["diseaseDeaths"]:,}')
    out.append(f'- **Recipe runs (total)**: {s["recipeRunsTotal"]:,}')
    out.append(f'- **Market clearings (total)**: {s["marketsClearedTotal"]:,}')
    out.append(f'- **Invariant violations**: fatal {v["fatal"]} / error {v["error"]} / warning {v["warning"]}')
    out.append('')

def write_section_population(out, snaps):
    """Population by tier over years."""
    out.append('## 2. Population dynamics by tier (cyclicality)\n')
    out.append('All numbers are total population in that tier across all settlements of that tier.\n')
    out.append('| Year | hamlet | village | town | small_city | large_city | total |')
    out.append('|-----:|-------:|--------:|-----:|-----------:|-----------:|------:|')
    for label, snap in snaps:
        si = settlement_pop_and_tier(snap)
        by_tier = defaultdict(int)
        for sid, (tier, pop) in si.items():
            by_tier[tier] += pop
        total = sum(by_tier.values())
        out.append(f'| Y{label} | {by_tier["hamlet"]:,} | {by_tier["village"]:,} | {by_tier["town"]:,} | {by_tier["small_city"]:,} | {by_tier["large_city"]:,} | {total:,} |')
    out.append('')

def write_section_stockpiles(out, snaps, tiers_of_interest):
    """Days-of-supply per (tier, resource) by year."""
    out.append('## 3. Stockpile days-of-supply by tier × year\n')
    out.append('Median days-of-supply per settlement in each tier. ')
    out.append('Days = stockpile / (population × per-capita daily consumption rate).\n')
    resources = ['food.grain', 'food.wine', 'food.olive_oil', 'food.cheese',
                 'food.salted_meat', 'food.salted_fish',
                 'goods.cloth', 'goods.clothing', 'goods.furniture', 'material.pottery']
    for tier in tiers_of_interest:
        out.append(f'### {tier}\n')
        header = '| Year | ' + ' | '.join(r.split('.')[-1][:10] for r in resources) + ' |'
        sep = '|-----:|' + ':--:|' * len(resources)
        out.append(header)
        out.append(sep)
        for label, snap in snaps:
            dt = days_of_supply_by_tier(snap).get(tier, {})
            row = [f'Y{label}']
            for r in resources:
                vals = dt.get(r, [])
                if not vals: row.append('—')
                else:
                    med = statistics.median(vals)
                    row.append(f'{med:.0f}' if med >= 1 else f'{med:.2f}')
            out.append('| ' + ' | '.join(row) + ' |')
        out.append('')

def write_section_prices(out, snaps):
    """Median clearing price per resource per year."""
    out.append('## 4. Price level by resource × year\n')
    out.append('Median across all settlements that recorded a clearing price that year. Coin-per-unit.\n')
    resources = ['food.grain', 'food.bread', 'food.wine', 'food.olive_oil',
                 'food.cheese', 'food.salted_meat', 'food.salted_fish',
                 'goods.cloth', 'goods.clothing', 'goods.furniture',
                 'material.pottery', 'metal.iron', 'goods.tools',
                 'goods.gladius', 'metal.silver']
    out.append('| Year | ' + ' | '.join(r.split('.')[-1][:9] for r in resources) + ' |')
    out.append('|-----:|' + ':--:|' * len(resources))
    for label, snap in snaps:
        row = [f'Y{label}']
        for r in resources:
            p = median_settlement_price(snap, r)
            row.append('—' if p is None else f'{p:g}')
        out.append('| ' + ' | '.join(row) + ' |')
    out.append('')

def write_section_caravans(out, snaps):
    """Caravan count by type per year."""
    out.append('## 5. Caravan fleet composition by year\n')
    out.append('Active caravans on the map at end-of-year by ID-prefix type.\n')
    out.append('| Year | villager | merchant | export | import | tax | other | TOTAL |')
    out.append('|-----:|---------:|---------:|-------:|-------:|----:|------:|------:|')
    for label, snap in snaps:
        c = caravan_breakdown(snap)
        total = sum(c.values())
        out.append(f'| Y{label} | {c["villager"]} | {c["merchant"]} | {c["export"]} | {c["import"]} | {c["tax"]} | {c["other"]} | {total} |')
    out.append('')

def write_section_treasury(out, snaps):
    """Wealth distribution by actor kind."""
    out.append('## 6. Treasury (wealth) by actor kind\n')
    out.append('Aggregate coin holdings at year-end, by actor kind. Shows where money concentrates over 10 years.\n')
    out.append('| Year | governor | city_corp | patrician (sum) | guild (sum) | freedman (sum) | plebeian (sum) | hamlet (sum) | free_village (sum) | off_map_house |')
    out.append('|-----:|---------:|----------:|----------------:|------------:|---------------:|---------------:|-------------:|-------------------:|--------------:|')
    for label, snap in snaps:
        tk = treasury_by_kind(snap)
        def total(k): return tk.get(k, (0, 0, 0, 0))[1]
        out.append(f'| Y{label} | {fmt_kc(total("governor_office"))} | {fmt_kc(total("city_corporation"))} | {fmt_kc(total("patrician_family"))} | {fmt_kc(total("merchant_guild"))} | {fmt_kc(total("freedman_household"))} | {fmt_kc(total("plebeian_household"))} | {fmt_kc(total("hamlet_household"))} | {fmt_kc(total("free_village"))} | {fmt_kc(total("off_map_house"))} |')
    out.append('')

def write_section_economics(out, yearly_wages, yearly_owner_take, recipe_agg):
    """Wage share + top/bottom recipes."""
    out.append('## 7. Wage payments by class × year\n')
    out.append('Total coin + in-kind wages paid to workers, aggregated by hiring-owner kind. Shows labor income flows.\n')
    kinds_to_track = ['city_corporation', 'patrician_family', 'free_village',
                      'hamlet_household', 'plebeian_household', 'freedman_household',
                      'governor_office']
    out.append('| Year | ' + ' | '.join(k for k in kinds_to_track) + ' | total |')
    out.append('|-----:|' + ':--:|' * (len(kinds_to_track) + 1))
    for year in sorted(yearly_wages.keys()):
        row = [f'Y{year}']
        wages = yearly_wages[year]
        total_year = sum(wages.values())
        for k in kinds_to_track:
            row.append(fmt_kc(wages.get(k, 0)))
        row.append(fmt_kc(total_year))
        out.append('| ' + ' | '.join(row) + ' |')
    out.append('')

    out.append('## 8. Owner take (recipe profit) by class × year\n')
    out.append('Net coin to owners after wages + inputs. Negative means owners ran the recipe at a subsidy.\n')
    out.append('| Year | ' + ' | '.join(k for k in kinds_to_track) + ' | total |')
    out.append('|-----:|' + ':--:|' * (len(kinds_to_track) + 1))
    for year in sorted(yearly_owner_take.keys()):
        row = [f'Y{year}']
        takes = yearly_owner_take[year]
        total_year = sum(takes.values())
        for k in kinds_to_track:
            row.append(fmt_kc(takes.get(k, 0)))
        row.append(fmt_kc(total_year))
        out.append('| ' + ' | '.join(row) + ' |')
    out.append('')

    out.append('## 9. Top 15 recipes by 10-year output value\n')
    out.append('Sum of `runs × output_value` across the full burn-in. Indicates which recipes drove the most coin-denominated output.\n')
    out.append('| Recipe | total runs | total output value | total owner take |')
    out.append('|--------|-----------:|-------------------:|-----------------:|')
    top = sorted(recipe_agg.items(), key=lambda kv: -kv[1][1])[:15]
    for recipe, (runs, out_val, take) in top:
        out.append(f'| `{recipe}` | {runs:,} | {fmt_kc(out_val)} | {fmt_kc(take)} |')
    out.append('')

    out.append('## 10. Worst 15 recipes by owner take (loss-makers)\n')
    out.append('Recipes whose owners paid more in wages + inputs than they recouped from outputs. Subsidies / loss-leaders.\n')
    out.append('| Recipe | total runs | total output value | total owner take |')
    out.append('|--------|-----------:|-------------------:|-----------------:|')
    worst = sorted(recipe_agg.items(), key=lambda kv: kv[1][2])[:15]
    for recipe, (runs, out_val, take) in worst:
        if take >= 0: break  # only show actual losses
        out.append(f'| `{recipe}` | {runs:,} | {fmt_kc(out_val)} | {fmt_kc(take)} |')
    out.append('')

# --- Main ---

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description='Generate a markdown burn-in analysis report.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'Example:\n'
            '  python3 scripts/analyze-burnin.py \\\n'
            '    --dir burnin/v1-9-resolved-10y \\\n'
            '    --out docs/v1-9-burnin-report.md \\\n'
            '    --title "v1.9 10y burn-in (resolved)"\n'
        ),
    )
    p.add_argument(
        '--dir',
        required=True,
        help='Burn-in output directory (containing report.json, snap-day-*.json, optionally recipe-economics.csv).',
    )
    p.add_argument(
        '--out',
        required=True,
        help='Markdown file to write. Parent directory is created if missing.',
    )
    p.add_argument(
        '--title',
        default=None,
        help='Report H1 title. Defaults to "Burn-in analysis — <basename of --dir>".',
    )
    p.add_argument(
        '--max-years',
        type=int,
        default=None,
        help='Cap on number of yearly snapshots to render (default: render every yearly snapshot found).',
    )
    return p.parse_args()


def main():
    args = parse_args()
    burnin_dir = args.dir
    out_path = args.out
    title = args.title or f'Burn-in analysis — {os.path.basename(os.path.normpath(burnin_dir))}'

    if not os.path.isdir(burnin_dir):
        print(f'error: --dir {burnin_dir} is not a directory', file=sys.stderr)
        sys.exit(2)

    report_path = os.path.join(burnin_dir, 'report.json')
    if not os.path.isfile(report_path):
        print(f'error: missing {report_path}', file=sys.stderr)
        sys.exit(2)

    print(f'Analyzing {burnin_dir}', file=sys.stderr)
    print('Loading snapshots...', file=sys.stderr)
    years = discover_yearly_snapshot_days(burnin_dir, args.max_years)
    if not years:
        print(f'  no yearly snapshots found under {burnin_dir} (was the burn-in run with --snapshots=year ?)', file=sys.stderr)
    snaps = []
    for label, day in years:
        try:
            s = load_snapshot(burnin_dir, day)
            snaps.append((label, s))
            print(f'  Y{label} day {day}', file=sys.stderr)
        except FileNotFoundError:
            print(f'  Y{label} day {day} MISSING — skipping', file=sys.stderr)

    print('Reading report.json...', file=sys.stderr)
    with open(report_path) as f:
        report = json.load(f)

    print('Streaming recipe-economics CSV...', file=sys.stderr)
    have_economics = os.path.isfile(os.path.join(burnin_dir, 'recipe-economics.csv'))
    if not have_economics:
        print('  recipe-economics.csv missing — sections 7-10 will be omitted', file=sys.stderr)
    yearly_wages, yearly_owner_take, recipe_agg = stream_recipe_economics(burnin_dir)

    print('Writing report...', file=sys.stderr)
    out = []
    out.append(f'# {title}\n')
    out.append(f'Generated from `{burnin_dir}/`.\n')

    write_section_overview(out, report)
    if snaps:
        write_section_population(out, snaps)
        write_section_stockpiles(out, snaps, ['hamlet', 'village', 'town', 'small_city', 'large_city'])
        write_section_prices(out, snaps)
        write_section_caravans(out, snaps)
        write_section_treasury(out, snaps)
    else:
        out.append('## 2-6. Per-year breakdowns\n')
        out.append('_No yearly snapshots found in the burn-in directory; population, stockpile, price, caravan, and treasury time-series sections are omitted._\n')

    if have_economics:
        write_section_economics(out, yearly_wages, yearly_owner_take, recipe_agg)
    else:
        out.append('## 7-10. Recipe economics\n')
        out.append('_`recipe-economics.csv` not present in the burn-in directory. Re-run the burn-in with `--instruments=recipe-economics` to populate wage / owner-take / recipe-runs sections._\n')

    out.append('---\n')
    out.append(f'_Generated by `scripts/analyze-burnin.py --dir {burnin_dir}`._\n')

    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, 'w') as f:
        f.write('\n'.join(out))
    print(f'wrote {out_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
