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

For ~3,000–8,000 settlements that's ~400k–1.1M buckets total —
large but still tractable with compact storage. Per-day update is
mostly aging-in-place + births / deaths / migration adjustments.
Expensive transitions (cohort aging) happen yearly, not daily.

We model populations as stratified pools, not individual agents.
Notable individuals are modeled separately as **named characters**
(see [11 — Politics & Ownership](11-politics-and-ownership.md) and
[13 — Reputation & Relationships](13-reputation-and-relationships.md)).

### Person registry for moving units (locked)

Settled villagers stay aggregate, but **everyone in a moving unit
has a stored identity**: caravan crew, patrol soldiers, bandit camp
fighters and hangers-on, bandit raid parties, and migration columns.
Each such individual is a `Person` record in the world's central
`persons: Map<PersonId, Person>` registry.

A `Person` carries:

- `id`, `name` (Latin praenomen + nomen),
- `age`, `sex`, `class`, `faction`,
- `role` (drover / merchant / guard / soldier / bandit /
  bandit_hanger_on / migrant / civilian),
- `status` (`alive` | `wounded` | `dead` | `captured` | `missing`),
- `health` 0..1,
- `bornOnDay`, optional `diedOnDay`,
- optional `unitId` back-reference to the moving unit they belong to,
- optional `namedCharacterId` linking up to a politically notable
  `NamedCharacter` (a patrician merchant leading a caravan, a
  warlord-grade bandit_leader, etc.).

Equipment is **unit-level** (the unit owns a `UnitInventory:
Map<ResourceId, int>` of issued weapons / armor / shields) plus a
**per-person slot map** (`personEquip: Map<PersonId,
Map<ResourceId, 0|1>>`) recording which specific kit each person
currently carries. This sidesteps materializing 50k tiny equipment
maps while still letting the battle resolver name specific
casualties and ask what they were carrying.

### What the registry is NOT used for

- **No per-day iteration.** Persons are touched only at events:
  recruitment, equipment issue/return, casualty resolution, and the
  once-per-year aging pass. The daily tick loops do not walk the
  registry.
- **Settled villagers stay aggregate.** Births, deaths, and aging in
  the settled `PopulationPool` do NOT materialize/retire Person
  records. The pool's bucket counts remain the load-bearing source of
  truth for the settled population's labor and consumption.
- **No upgrade path to settled villager identity.** When a moving
  unit disbands and the survivors rejoin a settlement's pool, the
  matching Person records are marked `status='missing'` (they leave
  the moving-unit world) rather than persisted forever.

### Composition with NamedCharacter

`NamedCharacter` (docs/11) keeps its existing shape (id, name, age,
sex, class, faction, role, location, status, traits). Where such a
character physically walks with a moving unit, the Person record
that represents them in the unit's roster has
`namedCharacterId` pointing at the NamedCharacter. Reputation and
political traits stay on the NamedCharacter; equipment and
moving-unit status live on the Person. This is composition, not
unification — most Persons are not NamedCharacters and most
NamedCharacters (the governor, patrician matriarchs, headmen who
stay home) are not Persons.

## Vital rates (Roman-era reference)

First-pass numbers tuned to historical Roman demographic
estimates; tunable.

| Metric                       | Estimate            | Notes                                                |
| ---------------------------- | ------------------- | ---------------------------------------------------- |
| Crude birth rate             | 38–42 / 1000 / year | High by modern standards, normal for pre-industrial. |
| Infant mortality (0–1 yr)    | 25–30%              | Half the gap to age-5 mortality.                     |
| Child mortality (1–5 yr)     | 15–20%              | Combined with infant: ~40% don't reach 5.            |
| Adult baseline mortality     | 10–15 / 1000 / year | Excludes plague, war, famine.                        |
| Life expectancy at birth     | 25–30 yr            | Heavily skewed by child mortality.                   |
| Life expectancy at age 15    | +40–55 more yr      | If you survive childhood, you can live long.         |
| Plague-year excess mortality | +5–25% in one year  | Historically devastating.                            |
| Famine-year excess mortality | +5–20% if severe    | Often local rather than universal.                   |

The pyramid for a stable, healthy population is fat at the bottom
(many children, many died young) and skinny at the top (few
elderly). A long peace with good food fattens the whole pyramid.
A plague carves out cohorts that show up as dents for decades. A
war thins the young-adult-male band specifically.

### How the dynamics actually run (locked)

Two ticks together drive demographics:

- `tickDaily(pool, rates, rng)` (in `src/sim/population/vitalRates.ts`)
  fires every simulation day. It samples a **per-cohort death
  binomial** at the day-equivalent of the annual rate, then a
  **per-fertile-female birth binomial** for new infants. Children
  _appear_ in the 0-4 band the day they're born.
- `tickYearly(pool, rng)` fires once per game year (in the annual
  hook). Per cohort, **20% of its members age into the next band**
  each year — the standard discretization for 5-year buckets, since
  on average 1 of 5 residents has their next-band birthday each
  calendar year. So a 0-4 cohort of 100 contributes ~20 to 5-9 and
  retains ~80 (which is then refilled continuously by tickDaily
  births). The 80+ band is absorbing: it accepts ~20% of 75-79 with
  no further outflow. No births or deaths happen in this tick —
  that's tickDaily's job all year long.

So in any 365-day burn-in segment, every adult has had ~365 daily
mortality samples and every fertile woman has had ~365 daily birth
chances. At year-end, the pyramid drifts gently up: each cohort
hands a fifth of its residents to the next band. After 5 burn-in
years the pyramid has reshuffled significantly but no individual
"birth wave" has propagated wholesale through it (an earlier
implementation aged 100% per year, producing exactly that
pathology).

**Verifying it's working** — `scripts/debug-activity.ts` snapshots
the global pyramid (sum across all settlements) at year 0, 1, 5,
and 10. Expect:

- Year 5 vs. year 0: the 0-4 cohort still exists (~12% of total
  population in steady state), refilled by ongoing births. Mid-life
  bands smoothly increase as the surviving 0-4s of year 0 partly
  age up. The 80+ band stays small but non-zero — geometric
  mortality balances inflow.
- Year 10: similar shape, total population roughly stable
  (~+0.5%/yr in good years) and visibly drops in famine/plague
  years.
- Anti-pattern (failure mode of the old 100%/yr code): a single
  bulge propagating up the pyramid with the 0-4 band at zero each
  year-end. If the snapshot shows that, demographics are broken.

If a burn-in shows a frozen pyramid (no aging-up of cohorts) or no
new 0-4 babies appearing, demographics are not running and the
politics + economy will eventually crash from no labor turnover.

## Disease (current, locked)

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
generations (out of current scope for the player).

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
`wright`, `carpenter`, `bowyer`, `fletcher`, `minter`.

**Tertiary:** `merchant`, `drover`, `caravan_guard`, `soldier`,
`officer`, `scribe`, `official`, `priest`, `physician`,
`entertainer`, `servant`.

**Unproductive consumers:** `child` (under working age), `elder`
(past working age), `idle` (working-age but unemployed — bad for
the city: consume but don't produce, and become bandits faster —
see [12 — Bandits & Conflict](12-bandits-and-conflict.md)).

(No `sailor` or `shipwright` in the current scope — sea trade deferred.)

## Consumption per adult per day (subsistence baseline)

| Need           | Amount                         | Substitutes / notes                                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Calories       | ~0.4 kg grain-equivalent / day | Bread, porridge, legumes, cheese, meat. Substitutable across food types with diminishing returns. |
| Salt           | ~7 g / day                     | Hard floor; no substitute.                                                                        |
| Fuel           | ~0.7 kg wood-equivalent / day  | More in cold climate, less in hot. Charcoal substitutes (~0.25 kg charcoal ≈ 1 kg wood for heat). |
| Clothing wear  | ~1 garment / 700 days          | Cloth + tailor labor.                                                                             |
| Shelter upkeep | small lumber + brick over time | Per-household, accrues monthly.                                                                   |
| Water          | (hex must have water access)   | Aqueducts let cities exceed local water.                                                          |

Children consume ~0.5×, elders ~0.8×.
**Slaves**: subsistence calories + minimal salt + minimal
clothing only. No comfort/status demand.

### Per-capita consumption sanity ranges (Roman reference, locked v1.6)

Beyond the subsistence floor above, **comfort demand** for non-staple
goods (wine, oil, cheese, salted meat/fish, cloth, clothing,
pottery, furniture) must be calibrated to plausible Roman per-
capita ranges. Burn-in stockpile bloat (cities holding 5+ years of
salted meat, oil, wine at Q8) is the symptom of consumption rates
set far below the historical band. Production rates calibrated to
real recipes (one cattle slaughter = 60 kg salted_meat) only make
sense if downstream demand is also calibrated.

The historical reference per adult per year (citations: Garnsey,
_Food and Society in Classical Antiquity_, 1999; Erdkamp,
_The Grain Market in the Roman Empire_, 2005; Jongman,
_The Economy and Society of Pompeii_, 1988):

| Good          | Roman per-capita / yr | Per-day equivalent | Notes |
|---------------|-----------------------|---------------------|-------|
| Grain (mixed staple) | 200–250 kg | 0.55–0.68 kg | Already approx via 0.4 kg/day grain-equivalent floor. |
| Salt          | ~2.5 kg              | ~7 g                | Already locked. |
| Wine          | 50–150 L (≈ kg)      | 0.14–0.41 kg        | Plebeian to lower-class urban range; soldiers got ~1 L/day. |
| Olive oil     | 10–25 kg             | 0.027–0.068 kg      | Cooking + lamps + soap. Plebs lower; patricians higher. |
| Cheese        | 3–6 kg               | 0.008–0.016 kg      | Mostly rural / soldier ration. |
| Salted meat   | 5–15 kg              | 0.014–0.041 kg      | Plebs low; military / patrician higher. |
| Salted fish (incl. garum) | 4–10 kg | 0.011–0.027 kg | Water-adjacent cities higher; inland lower. |
| Cloth         | 1.5–3 kg             | 0.004–0.008 kg      | Replacement for clothing + household textile wear. |
| Clothing      | 1–2 garments         | n/a                 | Garment-units of ~0.5 kg each. ~0.003–0.005 kg/day cloth-equivalent. |
| Pottery       | 3–6 vessels          | n/a                 | Breakage rate; ~0.01 units/day. |
| Furniture     | 0.05–0.15 pieces     | n/a                 | Replacement lifetime ~10 years. |

These ranges are **per ADULT**; children/elders apply the same
0.5×/0.8× scaling as the subsistence row. Class modifiers:

- **Slaves**: subsistence calories + minimal salt + 1 garment / 2 yr
  only. No comfort/status demand.
- **Plebeian / foreigner**: low-end of range.
- **Freedman**: mid-range (typically urban, with some discretionary
  income).
- **Patrician**: high-end + status demand layer (luxury textiles,
  silver, gold, fine pottery) per docs/08 §"Consumer status demand".

**When current rates fall below the historical range and stockpiles
balloon over time, the calibration is wrong, not the production.**
Phase 28 audits each per-capita rate against this table and bumps
consumption to land inside the range. Where a recipe is plausibly
over-yielding (e.g. cattle slaughter producing 60 kg per run when
historical yields were closer), we trim the recipe output instead.

This calibration table is the source of truth for the comfort demand
arm in `src/sim/market/scheduleBuilder.ts` and the per-capita rates
in `src/procgen/seed.ts` `grantStarterMarketInventory`. The two must
agree.

Implementation note: daily staple consumption is settled through the
local market as a mixed ration: grain remains the backbone, but bread
and legumes also appear as direct subsistence demand. Rural settlements
shift most of the bread line into grain because household baking,
hand-milling, and porridge dominate outside towns; cities keep direct
bread demand because ovens and retail bakeries are local institutions.
Other edible stockpiles, including flour, raw milk, fresh fish, game,
cheese, salted meat, and salted fish, plus any grain that did not clear
in the first market pass, act as fallback rations when market-cleared
staples do not cover the day's calorie need. All of these are still
priced: a local household, civic body, or estate owner buys/allocates
the ration and consumes it immediately. Self-allocation is
ownership-aware: common households, villages/hamlets, city corporations,
governor stores, and the player can consume their own ration stock for
the population they represent; patrician families can self-provision
patricians and enslaved dependents. A cashless common household still
cannot take an unrelated patrician's private granary without a wage,
ration entitlement, or other explicit transfer.

### Community self-provision (locked)

The model treats a `free_village` or `hamlet_household` actor's
stockpile as a **communal subsistence pool** for the
`plebeian_household` / `freedman_household` / `foreigner_household`
actors at the same settlement. When a household's subsistence demand
matches against the village's grain (or any other staple) the trade
still flows through the CDA — the bid and the price ladder are honest
— but **no coin transfer** occurs. The village's grain is the
village's food; it doesn't require the eater to also hold the coin to
"buy" it back from the headman.

Without this rule, a free village that sold its harvest to a wealthy
city would accumulate coin at the village-actor level while its own
households remained cashless and starved beside full collective
granaries — historically Roman in some respects (village landlords
rich, peasants poor) but mechanically too harsh, because the model
doesn't have the informal redistribution mechanisms that real villages
used. Community self-provision approximates that redistribution
without simulating elder councils, kin networks, and gift cycles
individually.

Specifically:

- **Beneficiary kinds** that get the credit: `plebeian_household`,
  `freedman_household`, `foreigner_household`. These are the
  wage-earning, common-class actors at a settlement.
- **Provider kinds** whose stockpile counts toward the credit:
  `free_village`, `hamlet_household`. The village's own community
  stores.
- **NOT included**: `patrician_family`, `city_corporation`,
  `governor_office`, `temple`. These actors hold private or
  institutional stocks; common households need an explicit wage,
  ration entitlement, or other transfer to draw from them.
- **CDA still runs.** The household's demand source is a normal
  subsistence bid, capped at `treasury + community_stockpile_value`.
  When it matches against the village's supply source, the trade
  fires at the clearing price but `buyerPaysSeller = false` so
  the village doesn't receive phantom coin from itself.

Cross-reference: docs/08 §"Communal subsistence pool".

### Village ration discipline (locked)

A village that sells **all** its grain to the highest external bidder
will starve its own residents the next winter. Real Roman villages
did NOT do this — the village's first job was to feed itself; only
the surplus above subsistence reserves went to market. The model
implements this as a **`reservedForOwnUse`** carve-out applied to
`free_village` and `hamlet_household` supply sources for subsistence
resources.

The reserve formula:

```
COMMUNITY_RESERVE_DAYS = 60
reservedQty(resource) =
  COMMUNITY_RESERVE_DAYS × Σ_class(headcount_class × subsistence_need_per_adult(resource, class, tier))
```

Sixty days is two months of community subsistence — enough to bridge
the gap between the autumn harvest and the spring planting without
being so generous that the village never participates in trade. Above
the reserve, the village's stockpile is freely sellable.

The reserve only applies to **subsistence resources** (food.grain,
food.bread, food.legumes, mineral.salt, material.wood — anything in
the SUBSISTENCE_NEEDS_FREE table). Non-subsistence outputs (cheese,
wool, oil, etc.) have no reserve and flow to market normally.

Effect: villages stop draining their granaries to zero during Y1
winter even when a wealthy city is offering 12× procurement premium.
The Q100 equilibrium stabilizes because the village's supply curve
truncates at "above community reserve" rather than chasing the
external bid all the way down.

Patrician estates, city corporations, and other actors do NOT get
this reserve carve-out — they're profit-maximizing market
participants. Only the village commons holds back food for the
village's own residents.

Free workers receive coin income when production recipes run. The wage
is the local subsistence basket, priced through the same market-price
maps used by marginal cost. Enslaved workers do not receive wages; their
owner buys or allocates subsistence for them. Which owner commands the
work matters: slaves in a settlement are not a free public labor pool.
Patrician estates, civic institutions, villages/hamlets, temples, the
governor, and the player can use enslaved workers they control; common
household aggregates, merchant guilds, synthetic off-map endpoints, and caravan firms
must hire free/freed/foreigner labor instead. This is why households can
spend on goods instead of being a purely notional demand source, while
slave upkeep still remains a concrete owner-funded demand.

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
planner can shift workers between roles gradually (current v1.5
timing: ~8% reallocated per month, enough to respond within a year
without making labor teleport daily).

A recipe also requires its building (see
[03 — Production](03-production.md)). Both must be present.

### Worker reallocation by demand (locked, v1.5 implemented)

Workers are paid out of recipe-output profits. When a settlement has
unmet demand for a resource (bread, oil, cloth) and no workers in
the relevant role, the settlement's planner re-trains idle workers

- pulls from oversupplied roles toward the shortage. Mechanically:

1. **At procgen**, every settlement's working-age adults are
   distributed across job roles in proportion to the seeded
   building capacity × per-recipe labor weights. A farm + smithy
   settlement starts with a roughly farm-vs-smithy split; an
   un-staffable settlement parks everyone on `idle`.
2. **Each tick**, the production engine reads
   `Settlement.jobAllocations` and derives a per-job class mix from
   the working-age population plus the job catalog's allowed classes.
   A recipe needing `miller` only sees the workers actually assigned
   as millers, not the whole adult pool; if a role is slave-excluded,
   slave adults cannot satisfy that allocation.
3. **Every 30 days**, in `politicsPhase`, a monthly reallocation
   hook walks each settlement and combines two labor-demand signals:
   recent `recipe_blocked` events with `reason="no_labor"` and
   profitable recipe price signals from the local market. It splits an
   ~8% worker-move budget across demanded roles proportionally and
   pulls workers from the allocation with the lowest demand-per-worker
   (often broad primary or `idle` labor, but sometimes an overbuilt
   low-margin role such as miners after ore has piled up). Each move
   emits a `workers_reallocated` TickEvent for telemetry.
4. Class restrictions per [03 — Production](03-production.md) are
   enforced at the recipe-engine boundary, not at the allocation
   step.

The fallback path (settlements without `jobAllocations`, e.g.
hand-built test fixtures) retains the legacy "every adult is
available for every role" behavior so existing tests continue to
work.

## Player labor control (locked)

**The player cannot direct labor in any settlement in the current scope.**
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
  that's **600k–1M rural** in the wider catchment.

**No aggregation (locked).** Each real-world village and each
real-world hamlet is its own settlement entity in the sim,
with its own population, ledgers, leadership, and catchment
ownership. We do **not** roll N villages into one
"meta-village" entity for performance — the resulting hidden
hand violates pillar 1 (no merchant in the world thinks of
"the average of three villages I've never been to").

**Multiple settlements may share a hex.** A single fertile hex
can host one larger village plus 1–4 satellite hamlets clustered
around it (a Roman _pagus_ with its dependent hamlets is the
canonical case). They are still separate entities — separate
populations, separate elders / patrons, separate stockpiles —
but **travel time between same-hex settlements is zero ticks**, so
caravans, news carriers, and labor moving between them sync
immediately in the same pass. This is locality, not aggregation:
same-hex settlements feel like one community to the people who live
in them, but the political economy stays granular.

Implications:

- The settlement entity count target (see
  [01 — Simulation Frame](01-simulation-frame.md)) is the current
  non-aggregated ~3,000–8,000 settlement range.
- Procgen places hamlets densely around villages (multiple per
  hex is normal in the inner ring of a fertile patch).
- Catchment claim conflicts are resolved per docs/05's
  closer-wins rule even between same-hex settlements (a hamlet
  on the same hex as a village shares the urban hex but carves
  out a smaller catchment than the village).
- Same-hex transport: caravan / news-carrier movement cost
  between two settlements on the same hex is 0 hexes / 0 ticks.
  This avoids the "trivial caravan walking from A to B in the
  same hex" anti-pattern.
