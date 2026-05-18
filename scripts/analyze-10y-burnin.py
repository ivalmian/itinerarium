#!/usr/bin/env python3
"""Generate the v1.6 10-year burn-in analysis report.

Reads:
  - burnin-final-10y/snap-day-{0365,0730,...,3285}.json
  - burnin-final-10y/recipe-economics.csv  (stream-aggregated)
  - burnin-final-10y/report.json           (per-day pop / caravans / famine)

Writes:
  - docs/v1-6-burnin-report.md
"""
from __future__ import annotations
import json, csv, statistics, os, sys
from collections import defaultdict, Counter

OUT = 'docs/v1-7-burnin-report.md'
BURNIN_DIR = 'burnin-final-10y-pass27'

YEARS = [(i + 1, (i + 1) * 365) for i in range(9)]  # (year_label, day)

# --- Snapshot loaders ------------------------------------------------------

def load_snapshot(day: int) -> dict:
    path = f'{BURNIN_DIR}/snap-day-{day:06d}.json'
    with open(path) as f:
        return json.load(f)

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

def stream_recipe_economics():
    """Aggregate recipe-economics CSV by (year_bucket, owner_kind, recipe).

    Returns:
      yearly_wages: {year: {owner_kind: total_wage_paid}}
      yearly_owner_take: {year: {owner_kind: total_owner_take}}
      top_recipes: {recipe: (runs, output_value_sum)}
      worst_recipes: {recipe: (runs, owner_loss_sum)}
    """
    path = f'{BURNIN_DIR}/recipe-economics.csv'
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
    """Pop / famine / caravans over the 10y run."""
    out.append('## 1. Run overview\n')
    s = report['summary']
    v = {sev: sum(1 for x in report.get('violations', []) if x.get('severity') == sev) for sev in ('fatal', 'error', 'warning')}
    out.append(f'- **Seed**: {report["opts"].get("seed", "?")}')
    out.append(f'- **Years**: 10 (3650 days)')
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

def main():
    print('Loading snapshots...', file=sys.stderr)
    snaps = []
    for label, day in YEARS:
        try:
            s = load_snapshot(day)
            snaps.append((label, s))
            print(f'  Y{label} day {day}', file=sys.stderr)
        except FileNotFoundError:
            print(f'  Y{label} day {day} MISSING — skipping', file=sys.stderr)

    print('Reading report.json...', file=sys.stderr)
    with open(f'{BURNIN_DIR}/report.json') as f:
        report = json.load(f)

    print('Streaming recipe-economics CSV...', file=sys.stderr)
    yearly_wages, yearly_owner_take, recipe_agg = stream_recipe_economics()

    print('Writing report...', file=sys.stderr)
    out = []
    out.append('# v1.6 burn-in analysis — 10-year final\n')
    out.append('Generated from `burnin-final-10y/` after pass 23 (recipe-yield calibration).\n')

    write_section_overview(out, report)
    write_section_population(out, snaps)
    write_section_stockpiles(out, snaps, ['hamlet', 'village', 'town', 'small_city', 'large_city'])
    write_section_prices(out, snaps)
    write_section_caravans(out, snaps)
    write_section_treasury(out, snaps)
    write_section_economics(out, yearly_wages, yearly_owner_take, recipe_agg)

    out.append('---\n')
    out.append(f'_Generated by `scripts/analyze_10y.py` from `{BURNIN_DIR}/`._\n')

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write('\n'.join(out))
    print(f'wrote {OUT}', file=sys.stderr)

if __name__ == '__main__':
    main()
