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

When a recipe runs, the building owner pays a local wage bill for the
free/paid worker-days to a worker/household actor. Labor is
owner-sensitive, not just settlement-wide: a patrician estate, temple,
governor office, city corporation, village household, or player estate
may command enslaved workers it owns or controls; common-household
aggregates, merchant guilds, synthetic off-map endpoints, and caravan firms cannot
draw on another actor's slaves as free labor just because those slaves
exist in the same settlement. Enslaved worker-days are real labor but do
**not** receive a cash wage; their subsistence/upkeep appears through
owner-funded consumption instead. The wage is not a fixed constant: it is
the local subsistence-basket reservation wage documented in
[08 — Money & Trade](08-money-and-trade.md). That paid wage also appears
inside marginal cost, so production, household income, and prices are the
same economic loop rather than separate tuning knobs.

Paid/free-labor production is cash-constrained before it runs when the
wage would transfer to a distinct worker actor. A bankrupt owner cannot
hire free workers by fiat; the recipe scales down to the wage bill the
owner can actually pay in coin or staple in-kind wages
(grain/flour/bread valued at local prices). Owner-operated household
labor and slave-only labor are not cash-wage constrained, but the owner
still has to support the household or enslaved workforce through
upkeep/consumption demand.

Within a day's production planner, labor is depleted from per-job,
per-class pools. Owners who can command enslaved labor draw from that
pool first, then free labor; owners who cannot command slaves see only
the free/freed/foreigner/patrician labor available for the job. The wage
bill is based on the actual class mix consumed by the recipe run, not on
a fixed settlement-average labor cost.

Production also respects output inventory. A building owner who already
holds the stock target for a recipe output idles that recipe instead of
turning every available input into more unsold goods. Staples and
preserved foods use longer targets; ordinary manufactured and trade
goods default to about a month of installed capacity.

Mining is geographically constrained. A `mine` building only runs the
recipe whose output matches the finite mineral deposit under that mine
hex (`mineral.iron_ore`, `mineral.copper_ore`, `mineral.tin_ore`,
`mineral.lead_ore`, `mineral.silver_ore`, `mineral.gold_ore`, or
`mineral.salt`). Depositless mines do not fabricate ore. Starter
seeding can claim nearby unowned deposit hexes as mining claims, but it
only places mines on actual deposits; bloomeries are seeded only where
local smeltable ore exists. This keeps ore supply and charcoal demand
tied to geography rather than province-wide bootstrap magic.

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
  notes:    bread spoils in ~3 days; baked for local consumption only.
            Since one mill run makes 45 flour and one oven run consumes
            30 flour, bakery capacity should be about 1.5x mill capacity
            where mills and bakeries are paired.
```

Mills should not target their full flour shelf life as working stock.
Flour can last for months if dry, but a rational miller with local baker
customers holds roughly a fortnight of working inventory and then idles
until bakers draw it down. Rural household baking is modeled as direct
grain demand and hand-milling, not tiny flour bids in every hamlet. This
prevents a flour glut from coexisting with persistent bread shortages.

Military and capital workshop outputs are even tighter. Weapons,
armor, shields, and carts are not ordinary speculative inventory:
unless barracks, governor offices, caravans, or caravan owners are
actively buying them, workshops keep only tiny showroom/procurement
buffers. That leaves scarce iron for tools before smithies fill stores
with armor nobody has ordered.

```
burn_charcoal:
  inputs:   { material.wood: 1 }                # one cord ≈ 700 kg wood
  labor:    { collier: 1 }
  building: charcoal_kiln
  outputs:  { material.charcoal: 5 }            # five 30 kg sacks
  notes:    Roman clamp burn yield is roughly 4–5 kg wood per kg
            charcoal. Keep resource units straight: wood is a cord,
            charcoal is a sack. A collier-day tends a batch; four cords
            into one sack is a unit bug, not historical scarcity.
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
  inputs:   { metal.iron: 5, material.lumber: 0.08, material.charcoal: 3 }
  labor:    { smith: 1 }
  building: smithy
  outputs:  { goods.tools: 15 }                 # mixed simple tools
  notes:    lumber is handle stock, not structural timber; tools are
            required by farmers, miners, woodcutters etc.
```

```
olive_and_grape_harvest:                         # seasonal
  inputs:   { goods.tools: small wear }          # ~0.001 8kg tool-kit units / farmer-day
  labor:    { farmer: fractional }
  building: olive grove / vineyard
  outputs:  { food.olives / food.grapes }
  notes:    harvest output occurs in autumn only; pruning and grove/vine
            care are abstracted into the standing building capacity
```

Ordinary crop recipes (`sow_grain`, `harvest_grain`, `grow_flax`,
`grow_legumes`, olive/vine tending) use the same low daily tool-wear
rate. A `goods.tools` unit represents an ~8 kg mixed tool kit, so
crop, fishing, and forestry depreciation consume only small fractions
of a kit per worker-day (`0.001` for crop/fishing, `0.002` for
forestry/sawmill). Mining, quarrying, and heavy craft recipes keep
higher wear because picks and industrial tools break faster under load.
This keeps tools load-bearing without making farms, fishing, or timber
work consume a province's tool stock in a few months. `sow_grain` is a
seed-and-labor upkeep pass, not a market output recipe: it consumes
seed grain in spring but does not mint any symbolic `service.*` output
or public-works capacity. Harvest output is represented by
`harvest_grain`.

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
              food.salted_meat (on cull):  600,
              material.hides (on cull):    30 }
  notes:    standing herd is itself a stockpile; over-grazing degrades
            pasture for a season or more
```

`milk_dairy` is the parallel dairy flow: the recipe requires standing
cattle stock, outputs explicit `food.milk`, and downstream
`make_cheese` consumes that milk plus salt.

Recipes can also declare `requires`: stock that must be present but is
not consumed. Shearing requires sheep and milking requires cattle. A
producer short of that standing herd now bids for it as productive
capital, valued from the expected output stream over a payback window,
rather than receiving free capacity from the settlement.

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
`slaughter_for_meat_and_hides`,
`slaughter_sheep_for_meat_and_hides`,
`slaughter_pigs_for_meat_and_hides`.

**Extraction:** `fell_timber`, `quarry_stone`, `dig_clay`, `mine_iron`,
`mine_copper`, `mine_tin`, `mine_lead`, `mine_silver`, `mine_gold`,
`evaporate_salt`, `mine_salt`, `fish_river`, `fish_lake`,
`hunt_game`, `gather_oak_bark` (tanning input).

**Refining:** `mill_grain`, `bake_bread`, `press_olives`, `make_wine`,
`make_cheese`, `salt_fish`, `salt_meat`, `ret_flax`, `tan_leather`,
`burn_charcoal`, `saw_lumber`, `dress_stone`, `fire_bricks`,
`throw_pottery`, `throw_amphorae`, `smelt_iron`, `smelt_copper`,
`smelt_tin`, `alloy_bronze`, `smelt_lead`, `cupel_silver`,
`refine_gold`.

`smelt_copper` and `smelt_tin` refine ore into `metal.copper` and
`metal.tin`; `alloy_bronze` then consumes those intermediates plus
charcoal. Direct copper/tin-ore to bronze conversion is not part of
the recipe model.

**Manufacture:** `weave_cloth`, `weave_linen_cloth`,
`tailor_clothing`, `forge_tools`, `forge_gladius`, `forge_hasta`,
`forge_pilum`, `forge_dagger`, `forge_helmet`, `forge_body_armor`,
`make_shield`, `make_bow`, `make_arrow`, `make_sling`,
`cast_sling_bullet`, `build_cart`, `make_furniture`, `weave_luxury`,
`mint_coin`. (No `build_ship` — sea trade deferred; see
[10 — Scope](10-scope-and-questions.md).)

### Weapon-archetype substitution policy (locked)

The military demand for "an armed soldier" is itemized per archetype
across these recipes rather than as a single generic `goods.weapons`
unit. A garrison soldier kit is one melee weapon, one ranged option,
one shield, one helmet, and (when available) body armor. When the
preferred archetype is unavailable, the soldier falls back through
the priority order below:

| Slot       | Preference                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Melee      | `goods.gladius` > `goods.hasta` > `goods.dagger` > bare-handed                                          |
| Ranged     | `goods.bow` (with `goods.arrow`) > `goods.sling` (with `goods.sling_bullet`) > `goods.pilum` > none     |
| Defense    | `goods.shield` (one); `goods.helmet` (one); `goods.body_armor` (one)                                    |

A bandit / militia kit is the same priority order but the inventory
floor is much lower — most bandits carry whatever they looted, often
just a dagger and a sling. The battle resolver derives each unit's
effective `weaponsScore` and `armorScore` from the actual issued
inventory using this priority, not from a single 0–1 scalar.

**Construction (one-shot, accumulates `service.public_works`):**
`build_road`, `build_aqueduct`, `build_walls`, `build_warehouse`,
`build_temple`, `build_workshop`, `build_house`.

**Institutional upkeep and service sale:** barracks, temples, and
forums are not ordinary output recipes. Their buildings offer local
`service.garrison`, `service.priesthood`, and
`service.administration` capacity for coin. Forum/market offices also
offer `service.public_works` capacity when local patrons have pending
construction. These services are consumed locally and never become
stockpile or caravan cargo. The same institutions create procurement
demand for the goods that sustain that capacity (rations, tools,
weapons, armor, wine/oil/incense, cloth). The purchased goods are
consumed immediately as upkeep.

## Reconciliation rule

Each turn, every settlement runs a small planner. Recipes are ranked
by local marginal value using observed prices, with the recipe
topological order as the tie-breaker. The planner makes two passes:
high-value downstream recipes get first claim on existing inventory,
then upstream recipes can produce fresh inputs and downstream recipes
can retry if labor/capacity remains. For each attempted recipe, check
that **inputs, labor, AND building capacity** are all available; if
any are short, scale that recipe down proportionally. Surplus workers
in a role go idle for the day. Job retraining is gradual (current v1.5
timing: ~8% of workers can shift roles per month using blocked-event
and price-profit signals) so a settlement can't pivot its whole economy
in a week.

Recipe outputs go to the **owner's stockpile**, not to a generic
settlement pool — see [11 — Politics & Ownership](11-politics-and-ownership.md).
Physical buildings keep an installed `maxCapacity`; the daily
`capacity` counter resets to that installed capacity, not the catalog
default. This matters because procgen starter estates and city
workshops can represent many farm plots or workshop benches under one
logical building record.

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
deflation as coin leaves the system. Per docs/08, synthetic off-map
edge visitors arrive with desirable goods (spices, silks, exotic dyes);
the province pays in surplus oil/wine/cloth + minted silver.

In implementation terms, `mint_coin` outputs `goods.coin` only as the
recipe/resource identity. A successful mint run credits the mint owner's
spendable `treasury`; it does not leave inert coin sitting in stockpile.
`goods.coin` appears as physical cargo only while coin is being moved,
for example in a tax caravan.

## Monetary balance (no inflation, no deflation)

For a stable price level under population growth `g` and a per-capita
coin holding target `M`:

```
new coin produced per year = g × P × M  +  net imports value  −  net exports value
```

- **`g × P × M`** = the new transactional + savings demand from extra people.
- **Net imports value** = coin paid to synthetic off-map edge visitors → leaves the system.
- **Net exports value** = coin received from the off-map global market → enters the system.

If a province exports more than it imports, the trade surplus brings
silver in _without_ needing to mint locally. If it imports more, the
local mint must run faster — and if the silver mines can't keep up,
the province bleeds out its coin supply (deflation, broken markets).

In the current v1.5 setup (~700k pop, 0.5% growth, ~50 coin/person target) the
analyzer suggests ~3 cupel_silver instances/day + 1 mint_coin/day are
sufficient to match pop growth IF trade is roughly balanced. Provinces
with surplus exports need less minting; deficit provinces need more.
