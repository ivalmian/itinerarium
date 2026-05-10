# 04 — Population & Labor

People are the universal bottleneck. Every recipe needs them.
Every person needs to eat, wear something, sleep somewhere. They
are born, they age, they get sick, they die, and some of them go
bandit when conditions degrade. This doc covers the full
demographic model, consumption, jobs, mortality, disease, and
the demographic pathways into banditry.

## Population structure: full demographic pyramid (locked)

Each settlement's population is modeled as a **stratified pool**
with the following dimensions:

- **Age cohort**: 5-year buckets (0–4, 5–9, 10–14, …, 75–79,
  80+). 17 cohorts.
- **Sex**: male / female.
- **Class**: free citizen (with sub-tier patrician / plebeian),
  freedman, slave, foreigner-resident.

So a settlement's pop is ~17 × 2 × 4 = **~136 buckets**, each
holding a count and a few aggregate properties (current job
assignments for adult cohorts, average wealth for the segment,
recent disease exposure / immunity).

For ~1,500 settlements that's ~200k buckets total — trivial in
memory. Per-day update is mostly aging-in-place + births / deaths
/ migration adjustments. Expensive transitions (cohort aging)
happen yearly, not daily.

We model populations as stratified pools, not individual agents.
Notable individuals are modeled separately as **named characters**
(see [11 — Politics & Ownership](11-politics-and-ownership.md) and
[13 — Reputation & Relationships](13-reputation-and-relationships.md)).

## Vital rates (Roman-era reference)

First-pass numbers tuned to historical Roman demographic
estimates; tunable.

| Metric | Estimate | Notes |
|---|---|---|
| Crude birth rate | 38–42 / 1000 / year | High by modern standards, normal for pre-industrial. |
| Infant mortality (0–1 yr) | 25–30% | Half the gap to age-5 mortality. |
| Child mortality (1–5 yr) | 15–20% | Combined with infant: ~40% don't reach 5. |
| Adult baseline mortality | 10–15 / 1000 / year | Excludes plague, war, famine. |
| Life expectancy at birth | 25–30 yr | Heavily skewed by child mortality. |
| Life expectancy at age 15 | +40–55 more yr | If you survive childhood, you can live long. |
| Plague-year excess mortality | +5–25% in one year | Historically devastating. |
| Famine-year excess mortality | +5–20% if severe | Often local rather than universal. |

The pyramid for a stable, healthy population is fat at the bottom
(many children, many died young) and skinny at the top (few
elderly). A long peace with good food fattens the whole pyramid.
A plague carves out cohorts that show up as dents for decades. A
war thins the young-adult-male band specifically.

## Disease (in v1, locked)

Disease is part of the model from the start. Trade routes are
epidemic routes, and that fact must be visible in gameplay.

Modeled diseases (first pass):

- **Endemic background mortality**: malaria, dysentery,
  gastrointestinal illness, chronic respiratory illness. Folded
  into baseline cohort mortality, modulated by climate (malaria
  worse in marshes, etc.) and density (worse in cities).
- **Epidemic events**: stochastic outbreaks of higher-mortality
  diseases (smallpox-analog, typhus-analog, bubonic-plague-
  analog). Each has:
  - A spawn probability per turn per high-density hex.
  - A transmission model: spreads on caravans (and migration
    columns) that visit infected settlements; spreads internally
    at a crowding-dependent rate.
  - A mortality rate per cohort (often worst on infants,
    elderly, and weakened).
  - A duration (weeks to months).
  - Possible immunity in survivors.
- **Defenses**: cities can declare quarantine — refuse caravans
  for N days. This kills trade temporarily but blunts spread.
  The governor or city council can order it.

Implications:

- A connected city benefits from imports but absorbs plague risk.
- Closing your city to caravans during an epidemic protects you
  but starves you (food blockade by self-defense).
- A devastating plague reshapes the labor pool for years —
  fewer workers, higher wages, possibly mass migration,
  abandoned villages.

## Class structure

- **Patrician (free)**: small fraction (~1–3%) of citizens. Own
  estates, workshops, slaves. Comfort + status demand. Detailed
  in [11 — Politics & Ownership](11-politics-and-ownership.md).
- **Plebeian (free)**: bulk of free urban and rural population.
  Subsistence + some comfort demand. Most jobs.
- **Freedman**: former slaves. Free legally; often economically
  dependent on former owners. Can hold most jobs, can accumulate
  wealth.
- **Slave**: owned property. Subsistence consumption only.
  Higher mortality (especially mines and large estates). No
  comfort/status demand. Sources: war captives, debt bondage,
  raids/trade from beyond the map (carried as cargo by real
  caravans).
- **Foreigner-resident**: from outside the province; itinerant
  traders, mercenaries. Limited rights but earn and consume.

Class is sticky. Slaves can be freed (becoming freedmen).
Plebeians can rise into patrician through wealth + marriage over
generations (out of v1 scope for the player).

## Job roles

These are the labor types referenced in the recipe catalog (see
[03 — Production](03-production.md)). Roles are assigned per
adult cohort; class restricts which roles are available (slaves
are never officials or merchants; patricians are never miners).

**Primary sector:** `farmer`, `shepherd`, `cattle_herder`,
`swineherd`, `fisher`, `hunter`, `forester`, `miner`, `quarryman`,
`salt_worker`.

**Secondary sector:** `miller`, `baker`, `presser`, `vintner`,
`dairy_worker`, `tanner`, `collier`, `sawyer`, `mason`,
`brickmaker`, `potter`, `smelter`, `smith`, `weaver`, `tailor`,
`wright`, `carpenter`, `minter`.

**Tertiary:** `merchant`, `drover`, `caravan_guard`, `soldier`,
`officer`, `scribe`, `official`, `priest`, `physician`,
`entertainer`, `servant`.

**Unproductive consumers:** `child` (under working age), `elder`
(past working age), `idle` (working-age but unemployed — bad for
the city: consume but don't produce, and become bandits faster —
see [12 — Bandits & Conflict](12-bandits-and-conflict.md)).

(No `sailor` or `shipwright` in v1 — sea trade deferred.)

## Consumption per adult per day (subsistence baseline)

| Need | Amount | Substitutes / notes |
|---|---|---|
| Calories | ~0.4 kg grain-equivalent / day | Bread, porridge, legumes, cheese, meat. Substitutable across food types with diminishing returns. |
| Salt | ~7 g / day | Hard floor; no substitute. |
| Fuel | ~0.7 kg wood-equivalent / day | More in cold climate, less in hot. Charcoal substitutes (~0.25 kg charcoal ≈ 1 kg wood for heat). |
| Clothing wear | ~1 garment / 700 days | Cloth + tailor labor. |
| Shelter upkeep | small lumber + brick over time | Per-household, accrues monthly. |
| Water | (hex must have water access) | Aqueducts let cities exceed local water. |

Children consume ~0.5×, elders ~0.8×.
**Slaves**: subsistence calories + minimal salt + minimal
clothing only. No comfort/status demand.

## Comfort and status demand

Free populations want more than subsistence. Three demand bands:

- **Subsistence**: grain, salt, fuel, water, basic clothing,
  shelter. Slaves and the urban poor live here.
- **Comfort**: wine, olive oil, cheese, meat, pottery, decent
  clothing, furniture, public services. Most plebeians.
- **Status** (elite-only): luxury textiles, silver/gold
  tableware, exotic goods (spices, silk, incense), large houses.
  Patricians and the governor.

The mathematical model — including **producer derived input
demand** — is in [08 — Money & Trade](08-money-and-trade.md).
Short version: subsistence is **inelastic** (people pay any price
they can afford to not starve); comfort is **elastic** (people
walk away if too expensive); status is **inelastic-but-
deep-pockets** (rich people pay).

## Mortality, migration, banditry

- **Famine**: when calorie intake drops below threshold for
  sustained days, deaths rise sharply. Cohort-specific: infants
  and elderly die first.
- **Plague / epidemic**: see Disease section above.
- **War**: military action kills soldiers (predominantly young
  adult males) and (if walls fall) civilians.
- **Migration**: when wants are unmet locally and conditions
  are better elsewhere (and the news has reached them), pools
  drain toward better places. This is itself a caravan — they
  walk, eat on the way, and arrive smaller than they left.
- **Banditry**: when conditions degrade severely (failed
  harvests, lost land, demobilization, escaped slavery) and
  other paths are blocked, some adults defect into banditry.
  They leave the settlement and join (or form) a bandit camp in
  nearby wilderness. See
  [12 — Bandits & Conflict](12-bandits-and-conflict.md). The
  `idle` class is the main recruitment pool; persistent
  unemployment + food insecurity drives the rate up.
- **Births**: depend on food security, peace, crowding, female
  cohort composition, and time since the last calamity
  (post-plague baby booms are real).

## Worker → labor pool reconciliation

At each turn's production phase: for each settlement, sum up
labor demanded by all desired recipes; compare to available
workers in each role; if short, recipes scale down
proportionally; surplus workers become idle. The settlement's
planner can shift workers between roles slowly (target: ~2%
retraining per month).

A recipe also requires its building (see
[03 — Production](03-production.md)). Both must be present.

### Worker reallocation by demand (locked, v1.5 implemented)

Workers are paid out of recipe-output profits. When a settlement has
unmet demand for a resource (bread, oil, cloth) and no workers in
the relevant role, the settlement's planner re-trains idle workers
+ pulls from oversupplied roles toward the shortage. Mechanically:

1. **At procgen**, every settlement's working-age adults are
   distributed across job roles in proportion to the seeded
   building capacity × per-recipe labor weights. A farm + smithy
   settlement starts with a roughly farm-vs-smithy split; an
   un-staffable settlement parks everyone on `idle`.
2. **Each tick**, the production engine reads
   `Settlement.jobAllocations` directly — a recipe needing
   `miller` only sees the workers actually assigned as millers,
   not the whole adult pool.
3. **Every 30 days**, in `politicsPhase`, a monthly reallocation
   hook walks each settlement: it looks at the last 30 days of
   `recipe_blocked` events with `reason="no_labor"`, picks the
   most-blocked job role as the recipient, and pulls ~0.66% of
   workers from the largest non-target allocation (often `idle`).
   Each move emits a `workers_reallocated` TickEvent for
   telemetry. Across a year that compounds to ~8% reallocated.
4. Class restrictions per [03 — Production](03-production.md) are
   enforced at the recipe-engine boundary, not at the allocation
   step.

The fallback path (settlements without `jobAllocations`, e.g.
hand-built test fixtures) retains the v1 "every adult is available
for every role" behavior so existing tests continue to work.

## Player labor control (locked)

**The player cannot direct labor in any settlement in v1.**
Caravan crews the player hires are theirs to direct; settlement
workers are not. See [09 — Player](09-player.md).

## Sizing the realistic hinterland

The "economically correct" rural population for a given urban
population is, very roughly:

- A pre-industrial city of size N requires roughly **8–12×N**
  people in the surrounding countryside producing food, fuel,
  fiber, and raw materials, accounting for transport losses
  and rural self-consumption.
- For 4–5 cities of 5k–30k each (call it ~80k urban total),
  that's **600k–1M rural** in the wider catchment — way more
  than we can efficiently model atomically.

To keep settlement counts tractable we **aggregate**: each
"village" entity in the sim represents 2–5 real-world villages.
Each "hamlet" entity represents a small cluster. See
[01 — Simulation Frame](01-simulation-frame.md) for the
entity-count target (**~1,000–1,500 settlement entities for v1,
representing ~700k–1.2M modeled people in a ~500×500 km map
mostly composed of wilderness**).
