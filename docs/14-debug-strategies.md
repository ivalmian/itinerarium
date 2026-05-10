# 14 — Debug Strategies

How to figure out *why* a burn-in is failing. The simulation has many
interlocking parts; when something collapses (population crashes, prices
explode, caravans vanish), the question is always "which loop broke
first." This doc lists the diagnostic instruments and the patterns they
reveal.

## Standard runtime instruments

These exist (or should exist) in `src/burnin/` and are wired into the
CLI runner so any burn-in can dump them.

### Per-settlement, per-resource time series (planned, docs/15 §C15)

For each (settlement, resource), record at every tick:

- `stockpile` (sum across all owners present in the settlement)
- `inflows` from production + caravan deliveries
- `outflows` to consumption + caravan loadings
- `lastClearingPrice`
- `unmetDemandAtClearingPrice` (from market clearing)

Dump as CSV per settlement (`outDir/settlement-X-resource-Y.csv`)
with one row per tick. Not yet implemented; current debug telemetry
in `scripts/debug-activity.ts` is global yearly aggregates only.
A spreadsheet or quick `chart` script over the planned per-settlement
CSV would reveal collapses (line going to zero), runaway prices
(line going up exponentially), or production starvation (inflow=0
for many days).

### Global aggregates

At each tick, summarize across all settlements:

- Total population
- Total population by class (patrician / plebeian / freedman / slave)
- Total stockpile per resource (Tier 0 raw + Tier 1 refined +
  Tier 2 manufactured, separately)
- Total active caravans, news carriers, bandit camps
- Mean clearing price per resource (volume-weighted)
- Daily famine deaths, disease deaths, war deaths
- Recipe runs per recipe (how often each fired)

The CLI's `summarizeForDay` already tracks several of these; the
missing per-resource and per-recipe breakdowns are the next
instrument to add.

### Per-recipe shortfall log

When `runRecipe` returns `ranAtFraction < 1` with a `shortfall`, the
tick records a `recipe_blocked` event with the reason (`no_building`
/ `no_labor` / `missing_input`). Aggregating these across a run tells
you *which* input is the bottleneck. If `mill_grain` is missing
`food.grain` 90% of days, the upstream `harvest_grain` is the real
problem (not the mill).

### Per-named-character reputation slate (planned)

Helpful when the political layer behaves oddly. Dump every named
character's reputation toward every other actor at the end of a run
(or periodically). Look for runaway negative cascades (everyone hates
the player) or implausible positives (the player is "everyone's
friend" without effort). Today `scripts/debug-activity.ts` only
reports the total number of reputation entries; the full
character-by-character dump is the obvious next step (rolled into
docs/15 §C15 alongside the per-settlement-resource CSV).

## Failure patterns and what they look like

### Pattern A: Famine cascade (population cliff at season transition)

**Signal**: population stable through ~day N, then a cliff (drop
>10% in 30 days) at a season boundary.

**Likely cause**: a seasonal recipe was under-producing outside its
peak season (`harvest_grain` has an autumn peak with lower
spring/summer/winter output; `press_olives` is autumn-only), and the
starter stockpile depleted.

**Diagnose**:
1. Inspect food stockpile over time: it monotonically drops to ~0
   just before the cliff.
2. Inspect `recipe_blocked` for `harvest_grain`: it should show
   whether the current seasonal multiplier is too low for the
   settlement's food needs.
3. Confirm by checking `food.grain` inflows across the year: a
   spike in autumn, lower shoulders in winter/spring/summer.

**Fix**: tune the recipe's seasonalMultiplier, adjust the bootstrap
granary cushion, or improve storage capacity so harvest peaks can
sustain the population through lean months.

### Pattern B: Production starvation (recipes don't fire)

**Signal**: low or zero `recipes_ran` total per day; population
slowly starves regardless of stockpiles.

**Likely cause**: production is gated by missing buildings, missing
labor, or missing inputs.

**Diagnose**:
1. Check `recipe_blocked` events. The aggregate by `reason` tells
   you immediately whether buildings / labor / inputs are the gate.
2. If `no_building`: settlements lack the right building type. Check
   seedWorld's Phase 9 (starter buildings).
3. If `missing_input`: the upstream producer isn't feeding the
   downstream. Trace one level up.
4. If `no_labor`: role allocations are mismatched or the monthly
   v1.5 reallocation hook is too slow to converge.

**Fix**: add seed buildings, fix the input chain, or check labor
distribution.

### Pattern C: Owner-stockpile mismatch (food exists but isn't eaten)

**Signal**: settlement has plenty of grain in some actor's stockpile
but population still starves.

**Likely cause**: the consumption phase only draws from
`settlement.stockpileOwners`. If the food owner isn't in that list,
the population can't reach it.

**Diagnose**:
1. Dump `settlement.stockpileOwners` and compare to who actually
   holds the food.
2. Look for grants going to actors that aren't registered as
   stockpile owners of the consuming settlement.

**Fix**: ensure every settlement registers all its food-holding
actors in `stockpileOwners`. Especially patrician families that
own villages — both their city and their villages need them as
owners.

### Pattern D: Multi-grant overwrite (silent loss)

**Signal**: a multi-village patron family ends up with much less
food than the sum of their granted reserves.

**Likely cause**: `grantStockpile` uses `.set()` instead of `+=`,
overwriting earlier grants with later ones. Already fixed; check
that any new grant helpers also accumulate correctly.

**Diagnose**: instrument grantStockpile to log every grant. Compare
post-seedWorld stockpile totals against the sum of all grant calls.

### Pattern E: Caravan vanishing (commerce stops)

**Signal**: `caravans@end = 0` despite having seeded N at start.

**Likely cause**: caravans run out of rations mid-route, abandon
cargo, crew dies. Or NPC AI marks them all as "no profitable route"
and disbands.

**Diagnose**:
1. Check `caravan_arrived` events — if zero, no caravan is
   completing trips.
2. Inspect a caravan's path + ration consumption manually via
   snapshot inspection.
3. Check the seedWorld initial-cargo amount vs. typical trip
   length.

**Fix**: bump initial rations, add forage/restock logic, ensure NPC
AI returns to base when funds low.

### Pattern F: Price explosion (runaway clearing prices)

**Signal**: `lastClearingPrice` for a resource grows unboundedly
day over day.

**Likely cause**: subsistence demand at a settlement vastly
exceeds supply (food shortage), and the demand curve is purely
inelastic — price climbs to cover the wealth of the wealthiest
remaining buyer.

**Diagnose**:
1. Look at `unmetDemandAtClearingPrice` — if positive and growing,
   the market is structurally short.
2. Inspect aggregate population wealth: if the wealthiest stratum
   alone can pay enormously, prices reflect that.

**Fix**: current behavior caps prices at a sane multiple of the base
price (configurable). Modeling the cascading consequences (riots →
edicts → mob looting) per docs/08 is tracked in docs/15 §C16.

## How to add a new instrument

1. Decide what shape: time-series CSV, single-snapshot JSON,
   periodic summary line.
2. Wire into the tick loop (or post-tick) so it's deterministic.
3. Expose via the burn-in CLI flag (`--out=DIR --instruments=X,Y`).
4. Document the format in this file.
5. Add a test that asserts the instrument fires when a known
   failure pattern is constructed.

## Checklist for triaging a failed burn-in

When a burn-in produces unwanted results, walk through in order:

1. **Did anything throw?** Check final-day, fatal violations.
2. **What's the top-line cause of mortality?**
   `summary.famineDeaths` vs `diseaseDeaths` vs `baselineDeaths`.
3. **Per-recipe firing rates** — which recipes ran 0 times?
4. **Per-resource stockpile trajectory** — what depleted first?
5. **Per-settlement-tier trajectory** — did villages die before
   cities, or vice versa?
6. **Caravan trajectories** — did commerce keep flowing?
7. **Reputation cascade** — anyone end up at -1 with everyone?

Each answer narrows the next dive. Don't bisect by changing
parameters until the *which loop* is identified.
