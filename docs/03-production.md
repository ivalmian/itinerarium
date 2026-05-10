# 03 — Production Recipes

A recipe is `{outputs} = f(inputs, labor, building, time)`. This doc has
a half-dozen worked examples with concrete numbers, then the full recipe
catalog as a one-liner list.

Numbers below are **first-pass** — placeholders for tuning. The structure
of the recipes matters more than the exact figures right now. All
amounts are **per day** (turn length = 1 day; see
[01 — Simulation Frame](01-simulation-frame.md)).

## A recipe needs both a building AND specialist labor

This is **locked**: a recipe can only run if (a) a building of the right
type is present with available capacity AND (b) workers of the matching
job role are present in sufficient numbers. Either missing → the recipe
does not run that day.

Implications:

- Building a smithy in a village without a smith does nothing until a
  smith is trained or migrates in.
- A city losing its bakers (plague, war, defection) cannot bake bread
  even if the ovens still stand.
- The player can fund construction (see [09 — Player](09-player.md)) but
  cannot conjure specialists; specialists arise from the population's
  job-retraining process or arrive as migrants.

## Format

```
recipe-name:
  inputs:   { resource: amount per day }
  labor:    { job_role: worker-days per day }
  building: required structure (must be present, has capacity)
  outputs:  { resource: amount per day }
  notes:    ...
```

## Worked examples (numbers rebased to daily)

```
mill_grain:
  inputs:   { food.grain: 50 }                  # 50 kg/day
  labor:    { miller: 1 }
  building: mill (water- or animal-powered, cap ≥ 50 kg/day)
  outputs:  { food.flour: 45 }                  # ~10% loss to bran
  notes:    scales linearly with miller-days up to mill capacity
```

```
bake_bread:
  inputs:   { food.flour: 30, material.wood: 5 }
  labor:    { baker: 1 }
  building: oven (1 oven cap = 1 baker-day)
  outputs:  { food.bread: 40 }                  # ~1.3 kg bread / kg flour
  notes:    bread spoils in ~3 days; baked for local consumption only
```

```
smelt_iron:
  inputs:   { mineral.iron_ore: 60, material.charcoal: 100 }
  labor:    { smelter: 1 }
  building: bloomery
  outputs:  { metal.iron: 15 }
  notes:    charcoal-heavy; deforests the surrounding hexes if scaled up
            (a single bloomery's annual charcoal need = thousands of trees)
```

```
forge_tools:
  inputs:   { metal.iron: 5, material.lumber: 2, material.charcoal: 3 }
  labor:    { smith: 1 }
  building: smithy
  outputs:  { goods.tools: 15 }                 # mixed simple tools
  notes:    tools are required by farmers, miners, woodcutters etc.
```

```
press_olives:                                    # seasonal
  inputs:   { food.olives: 300, material.amphora: 5 }
  labor:    { presser: 1 }
  building: olive press
  outputs:  { food.olive_oil: 60 }              # ~20% yield by weight
  notes:    only runs in autumn season; presses sit idle the rest of year
```

```
raise_sheep:                                     # annual flows shown
  inputs:   (pasture hex carrying capacity)
  labor:    { shepherd: 0.2 per herd unit (≈100 sheep) }
  outputs:  (per herd unit, per year — applied as steady daily fractions)
            { material.wool:               200,    # kg
              raw_milk (→ cheese recipe):  5000,   # [TODO] Track resource vs implicit dairy flow
              food.salted_meat (on cull):  600,
              material.hides (on cull):    30 }
  notes:    standing herd is itself a stockpile; over-grazing degrades
            pasture for a season or more
```

```
caravan_transport:                               # see also [06 — Caravans]
  inputs:   { food.grain: (fodder for animals),
              food.bread/grain: (crew rations) }
  labor:    { drover, guard, merchant }
  building: none, but needs cart or pack animals
  outputs:  (cargo at destination instead of origin)
  notes:    this is what the player does; everyone else does it too
```

## Full recipe catalog

**Agriculture:** `sow_grain`, `harvest_grain`, `tend_olive_grove`,
`tend_vineyard`, `grow_flax`, `grow_legumes`.

**Pastoral:** `raise_sheep`, `raise_cattle`, `raise_pigs`,
`raise_equines`, `shear_wool`, `milk_dairy`,
`slaughter_for_meat_and_hides`.

**Extraction:** `fell_timber`, `quarry_stone`, `dig_clay`, `mine_iron`,
`mine_copper`, `mine_tin`, `mine_lead`, `mine_silver`, `mine_gold`,
`evaporate_salt`, `mine_salt`, `fish_river`, `fish_lake`, `fish_coast`,
`hunt_game`, `gather_oak_bark` (tanning input).

**Refining:** `mill_grain`, `bake_bread`, `press_olives`, `make_wine`,
`make_cheese`, `salt_fish`, `salt_meat`, `ret_flax`, `tan_leather`,
`burn_charcoal`, `saw_lumber`, `dress_stone`, `fire_bricks`,
`throw_pottery`, `throw_amphorae`, `smelt_iron`, `alloy_bronze`,
`smelt_lead`, `cupel_silver`, `refine_gold`.

[TODO] `alloy_bronze` currently models copper/tin ore flowing
directly into bronze; decide whether separate `metal.copper` and
`metal.tin` intermediates are worth the added resource count.

**Manufacture:** `weave_cloth`, `tailor_clothing`, `forge_tools`,
`forge_weapons`, `forge_armor`, `make_shields`, `build_cart`,
`make_furniture`, `weave_luxury`, `mint_coin`. (No `build_ship` — sea
trade deferred; see [10 — Scope](10-scope-and-questions.md).)

**Construction (one-shot, accumulates `service.public_works`):**
`build_road`, `build_aqueduct`, `build_walls`, `build_warehouse`,
`build_temple`, `build_workshop`, `build_house`.

## Reconciliation rule

Each turn, every settlement runs a small planner: for each desired
recipe, check that **inputs, labor, AND building capacity** are all
available; if any are short, scale that recipe down proportionally.
Surplus workers in a role go idle for the day. Job retraining is slow
(current v1.5 timing: ~0.66% of workers shift roles per month,
roughly ~8% per year) so a
settlement can't pivot its whole economy in a week.

Recipe outputs go to the **owner's stockpile**, not to a generic
settlement pool — see [11 — Politics & Ownership](11-politics-and-ownership.md).

## Steady-state tuning (Leontief view)

The recipe catalog is a Leontief input-output system: each recipe is
a column of inputs and outputs per recipe-instance per day. Together
they form an `(inputs - outputs)` matrix `M` such that, given recipe
intensities `x` (recipes/day across the world) and final demand `d`
(what people eat + what's exported off-map), the economy is in balance
when `M·x = d`.

Run `npx tsx scripts/analyze-steady-state.ts [population]` to:
1. Back-chain final demand into recipe intensities.
2. Show required intensity per recipe and per building.
3. Compare required vs. seeded building capacity → flag bottlenecks.
4. Estimate the monetary balance (silver minted vs. pop-growth coin
   demand vs. exports/imports).

**Target: a small surplus.** A world that exactly meets demand has no
slack — one bad harvest year and famine cascades. We aim for ~10–20%
slack on staple chains so:
- Seasonal variation in `harvest_grain` (autumn 1.0 → winter 0.3) doesn't
  produce winter shortages.
- Disease outbreaks that kill workers don't immediately shut down the
  smithy.
- Trade can siphon off the surplus to buy off-map goods (luxury
  imports, exotic spices) without triggering local shortages.

Surplus is the source of **export value**. Exports are the only real
income — minting silver doesn't create wealth, it just expands the money
supply. A province with no exports cannot pay for off-map imports
forever; eventually the silver mines run out and inflation turns into
deflation as coin leaves the system. Per docs/08, off-map merchant
houses arrive with desirable goods (spices, silks, exotic dyes); the
province pays in surplus oil/wine/cloth + minted silver.

## Monetary balance (no inflation, no deflation)

For a stable price level under population growth `g` and a per-capita
coin holding target `M`:

```
new coin produced per year = g × P × M  +  net imports value  −  net exports value
```

- **`g × P × M`** = the new transactional + savings demand from extra people.
- **Net imports value** = coin paid to off-map houses → leaves the system.
- **Net exports value** = coin received from off-map houses → enters the system.

If a province exports more than it imports, the trade surplus brings
silver in *without* needing to mint locally. If it imports more, the
local mint must run faster — and if the silver mines can't keep up,
the province bleeds out its coin supply (deflation, broken markets).

In the current v1.5 setup (~700k pop, 0.5% growth, ~50 coin/person target) the
analyzer suggests ~3 cupel_silver instances/day + 1 mint_coin/day are
sufficient to match pop growth IF trade is roughly balanced. Provinces
with surplus exports need less minting; deficit provinces need more.
