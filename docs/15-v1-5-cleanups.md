# 15 — Current v1.5 Notes and TODOs

v1.5 is the current baseline. Earlier simplifications are either
landed here as current behavior or explicitly marked as `[TODO]`.

When you complete a `[TODO]`, delete or rewrite that note and update
the cross-referenced doc to reflect the new behavior.

## C4 — Dynamic settlement investment (Stage 2 specialization, landed)

**Pre-v1.5 hack:** all production buildings were seeded once at procgen
time. No new buildings are ever built; no existing ones are
upgraded or torn down. Specialization is purely "what procgen put
where".

**Why it was a hack:** the building-investment loop has cost,
ROI, and political dimensions (who decides? Who pays?) that
needed the rest of the politics layer to land first.

**Realistic:** every season, each settlement's stockpile-owning
actors look at observed market prices (their `priceBook`) vs. the
recipes their existing buildings could run. If a recipe is
profitable AND the actor has the treasury for the building cost,
they invest in adding capacity (or a new building of that type).

**Current implementation:**
1. Each season-end (90-day boundary), in `politicsPhase`, for each
   actor with `kind ∈ {patrician_family, free_village,
   city_corporation, governor_office, hamlet_household}`:
   a. For each recipe in the catalog, compute expected daily
      profit at last-observed input + output prices.
   b. Pick the most profitable recipe whose building isn't already
      saturated locally.
   c. If treasury ≥ building cost AND expected profit / building
      cost > 0.005/day: invest. Treasury decreases by cost;
      `pendingBuilding` is added at a free urban or catchment hex.
      The building becomes productive only after construction
      worker-days complete.
2. Building costs live in `src/sim/buildings/catalog.ts`; docs/08
   describes the current construction semantics.
3. Cap investment at 1 building per actor per season to prevent
   runaway feedback.

**Acceptance:** at year 10, settlements show specialization
beyond the procgen seed: cities near mines have more bloomeries;
coastal towns have more fisheries; etc. New buildings logged via
a new `building_invested` TickEvent.

**Cross-refs:** `docs/05-settlements.md` §"Stage 2 — Dynamic
investment", `docs/03-production.md`, `docs/08-money-and-trade.md`
(price observation).

## C5 — Bootstrap stockpile final reduction [TODO]

**Current cushion:** `GRAIN_DAYS_OF_RESERVE` is now 180 days (down from
the original 365). Wood + tools bootstrap remain high
(pop*5 wood, pop*20 tools).

**Why this is still a hack:** ideally seed bootstrap = ~30 days of
grain + ~7 days of tools/wood. We can't reduce further yet because
the worker reallocation hook (C6) takes ~8%/yr to migrate workers
into bottlenecked roles, and dynamic settlement investment (C4)
now adds capacity over seasons rather than within the first
bootstrap month. Cities still need enough initial slack for
foresters / smithies / mills to converge.

**Realistic:** seed bootstrap = ~30 days of grain + ~7 days of
tools/wood. Forces production to come online within the first
month. Requires:
- C4 (dynamic investment) so cities self-correct capacity gaps
- Faster C6 reallocation (or a smarter initial allocation at
  procgen) so labor isn't permanently mismatched

**TODO implementation:**
1. Drop `GRAIN_DAYS_OF_RESERVE` to 30.
2. Drop `pop * 5` wood seed → `pop * 0.5`.
3. Drop `pop * 20` tools seed → `pop * 1`.
4. Run burn-in. If it fails, the issue is *upstream*: not enough
   buildings being built fast enough by C4.

**Acceptance:** burn-in passes the 10-year watchdog with the
realistic recipe ratios (C2) AND the reduced bootstrap.

**Three architectural gaps block reaching the spec target**
(diagnosed during C5 attempts):

1. Same-tick topological sort means downstream recipes consume
   their inputs the same day they're produced — a buffer day of
   slack doesn't accumulate, so a thin chain cascades into local
   famine within ~60 days at spec bootstrap.
2. One-building-per-type-per-settlement at procgen leaves no
   inter-tick slack; daily capacity resets each tick. C4
   (dynamic investment, now landed) addresses this over years
   but not within the first month.
3. The pre-C6 universal-labor estimator hid role-level
   under-staffing; with C6's `jobAllocations` driving the
   production engine, role mismatches surface as
   `recipe_blocked(reason='labor')` and the monthly hook nudges
   workers — but at ~8%/yr that's slow.

So C5-final waits for either: (a) C4-built buildings to
accumulate over years AND C6 to converge on the right
allocation, OR (b) a smarter procgen worker distribution +
multi-pair monthly reallocation in C6. Neither is blocking;
the 180-day cushion holds the slack while we mature the others.

**Cross-refs:** `docs/05-settlements.md` §"Hardening",
`src/procgen/seed.ts` `seedCityCorporation`,
`docs/14-debug-strategies.md`.

## C9 — Disaggregate villages + hamlets (landed, follow-ups)

**Status (2026-05):** procgen + same-hex movement short-circuits
landed. Local trade runs over settlement pairs with distance 0
costing 0 transport. Viewer stack-glyphs are landed (see
`viewer/map/settlements.ts`). Full-scale performance work
(settlements-by-hex spatial index for the 3,000–8,000 entity
target) remains.

**Pre-v1.5 hack (now fixed):** procgen generated aggregated
"village" entities representing multiple real-world villages and
"hamlet" entities representing small clusters. Each entity sat on
its own hex with no neighbors of the same type sharing it.

**v1.5 — landed:**
1. ✅ Procgen `siteSettlements`: applies a 3x village + 5x hamlet
   disaggregation factor so caller-requested counts (which were
   "aggregated entities" in old units) translate to one entity per
   real village + one per real hamlet. On the 80×80 burn-in
   (villages=60, hamlets=30), settlement count rises ~101 → ~341.
2. ✅ Multiple `SettlementSite`s may share a hex: hamlets stack on
   a village or another hamlet, capped at `MAX_SAMEHEX_HAMLETS = 5`.
   Hamlet scoring biases toward same-hex / adjacent-to-village
   placements (the *pagus* pattern).
3. ✅ Catchment arbitration: same-hex settlements share the urban
   hex; `orderSitesForCatchment` extends the kind-order with a
   descending-population tiebreak so the bigger village runs first
   through `computeCatchment`'s closer-wins rule. Same-hex hamlets
   get whatever isn't already claimed (often empty in the inner
   ring of a *pagus*).
4. ✅ `claimVillageHexes` no longer overwrites a larger-tier
   settlement's urban-hex ownership.
5. ✅ Same-hex 0-tick movement short-circuit in `tickCaravanMovement`
   and `tickCarrierWithGrid` + `createNewsCarrier`. Lock-in tests
   in `src/sim/caravan/movement.test.ts` and
   `src/sim/reputation/newsMovement.test.ts`.

**Still open:**
- [TODO] Performance: `tickPhase` per-settlement loops are tolerable at
  ~341 entities (60-100 ms/tick) but become hot paths at the full
  500×500 / 3,000-8,000 entity target. A settlements-by-hex index
  is the obvious next step.

**Cross-refs:** `docs/04-population.md` §"Sizing the realistic
hinterland", `docs/01-simulation-frame.md` §"Entity counts",
`docs/05-settlements.md` §"Same-hex coexistence" + §"Catchment",
`docs/07-geography.md` §"Site villages and hamlets",
`src/procgen/settlements.ts`, `src/procgen/seed.ts`,
`src/sim/caravan/movement.ts`, `src/sim/reputation/newsMovement.ts`.

## C8 — Construction time + labor cost (landed; demolition TODO)

**Pre-v1.5 hack:** the investment loop in `tick.ts` `investmentPhase`
spends the construction resources and immediately adds a fully
operational building. Real construction is weeks-to-months of
mason + carpenter labor.

**Why it was a hack:** the investment loop was the load-bearing
piece (C4); making it heavyweight on top of getting the basics
right would have made debugging harder.

**Realistic:** per docs/08 §"Construction is heavy":

1. When `investmentPhase` decides to build, deduct
   `constructionCost` resources AND add a `pendingBuilding` record
   on the settlement: `{ buildingId, hex, ownerActor, beganOnDay,
   workerDaysRemaining }`.
2. Each tick, after production, the construction phase consumes
   construction worker-days derived from `mason` + `carpenter`
   allocations toward
   pending buildings (proportional to how many people are
   assigned). When `workerDaysRemaining ≤ 0`, the building is
   added via `addBuilding` and the pending record is removed.
3. While pending, the building doesn't produce.
4. [TODO] Demolition is symmetric: removes the building over ~10-20% of
   construction time, returns ~50% of materials.

**Acceptance:** at year 10, the burn-in shows `building_invested`
events spread out over ~30-90 days, not instantaneous. Cities that
suffer a stockpile shock (lost trade route, raid) still take real
time to rebuild productive capacity.

**Cross-refs:** `docs/03-production.md` §"Construction",
`docs/08-money-and-trade.md` §"Construction is heavy",
`src/sim/tick.ts` `investmentPhase`.

## C7 — Removing bootstrap-only safeguards

These are tiny code branches whose presence makes the early world
non-deterministic in a "bootstrap was easier" sense. They should all be
deleted once the corresponding current-scope TODO lands.

- `src/burnin/invariants.ts` line 244: "Growing from zero:
  bootstrap can seed people" — once full C5 lands, the bootstrap
  is small enough that this isn't a special case.

(Comments about the old charcoal/iron/timber hacks have already
been removed by the C2 work.)

## C10 — Storage capacity discipline (landed, post-production sweep)

**Pre-v1.5 hack:** stockpiles grew without bound; the `granary`/
`warehouse`/`cistern` buildings were decorative.

**v1.5 — landed:**
1. Each building catalog entry now carries a
   `storageCapacity: ReadonlyMap<ResourceId, Quantity>` field.
   Storage buildings carry the bulk of the capacity:
   - `granary`: +5000 modii of `food.grain` (≈ 33 t — a sturdy
     Roman provincial granary).
   - `warehouse`: +10 000 kg "generic" pool, expressed as a
     wildcard slot (any non-grain tradable can occupy it).
   - `cistern`: +50 000 kg of water (water resource not yet in the
     catalog, so this is dormant until C12 lands).
   All other buildings carry a small implicit ~100 kg pool for
   in-process work (per-resource for tradables they actively touch,
   tracked as the wildcard pool to avoid thousands of dead Map
   entries).
2. A per-capita household baseline of ~50 kg mixed is added on top
   so buildingless hamlets don't reject every delivery.
3. After the production phase each tick,
   `storageCapacityPhase` walks every (settlement, owner, resource)
   and, if the owner's stockpile of a resource exceeds the
   settlement's allocated capacity for that resource, the excess is
   force-sold at the spoilage floor (0.5 × the resource's baseline
   global price). The seller's treasury credits the proceeds; the
   resource is removed from the world (we don't model who eats it).
   A `storage_overflow` TickEvent records the rejected delta.
4. `seedWorld` is allowed to seed past the cap (no clamp at procgen
   — the bootstrap explicitly over-provisions). Only the tick loop
   enforces the cap.

**Acceptance:** at year 6 burn-in, no settlement holds >2× the
realistic capacity of any one resource — bursting harvests visibly
cap, and the `storage_overflow` event log shows the rejected
deliveries flowing back to the market.

**Cross-refs:** `docs/05-settlements.md` §"Storage capacity",
`docs/02-resources.md` (unit weights),
`src/sim/buildings/catalog.ts`,
`src/sim/world/settlement.ts` (`computeStorageCapacity`),
`src/sim/tick.ts` (`storageCapacityPhase`).

## C11 — Roman-road maintenance cost (landed, quarterly drain)

**Pre-v1.5 hack:** Roman roads neither accrued wear nor decayed —
they were effectively immortal regardless of whether the governor
existed at all.

**v1.5 — landed:** every Roman-road hex now consumes a small
quarterly resource flow from the governor's office:
- 0.1 coin per hex per quarter (≈ 0.4 coin/hex/year, affordable
  for a 20–50k-coin governor with ~hundreds of Roman hexes).
- 0.01 cut_stone per hex per quarter (~0.04/hex/year — the
  governor maintains a small repair stockpile).

`roadMaintenancePhase` runs quarterly (every 91 days). For each
Roman hex, it tries to drain the per-hex cost from the
`governor_office` actor's treasury + cut_stone stockpile. If the
governor can pay, the hex resets `romanQuartersUnmaintained = 0`
(via deletion of the optional field). If they can't, the field
increments. Once a hex has missed 4 consecutive quarters
(≈ 1 year unmaintained), it downgrades to `road = 'dirt'` and a
`road_unmaintained` TickEvent fires — from then on it accrues +
decays wear like any other dirt road.

When the governor partially recovers (treasury back up), payment
resumes; mid-quarter resets clear the missed-quarter counter.

**Acceptance:** in the standard 6y burn-in the governor's
treasury keeps up easily (~0.4 coin/hex/year × ~50–200 Roman
hexes ≈ 20–80 coin/year, vs. the seeded 20–50k coin treasury).
In a deliberately-drained burn-in, the network visibly degrades
within 1–2 years.

**Cross-refs:** `docs/06-caravans.md` §"Trail wear",
`src/sim/tick.ts` (`roadMaintenancePhase`),
`src/sim/world/terrain.ts` (`romanQuartersUnmaintained` field).

## C12 — Promote raw milk to a tracked resource [TODO]

**Current state:** the dairy chain has no explicit `food.milk`
resource. `make_cheese` consumes `livestock.cattle`/sheep herd
units conceptually, but milk is never in any actor's stockpile.

**Decision needed:** promote `food.milk` to a Tier 0/1 resource
(short shelf life, mostly local consumption) or keep it implicit.
The argument for promoting it: it's a real Roman-era trade good
near cities; a cheese-making town buys daily milk from
surrounding villages.

**Acceptance:** decision recorded; if promoted, the resource
catalog (docs/02), recipe catalog (docs/03), and consumption
schedules (docs/04 + market scheduleBuilder) all updated together.

**Cross-refs:** `docs/02-resources.md` `food.cheese`,
`docs/03-production.md` `raise_sheep` + `make_cheese`.

## C13 — Copper / tin intermediates for bronze [TODO]

**Current state:** `alloy_bronze` consumes ore directly. There is
no `metal.copper` or `metal.tin` in the resource catalog.

**Decision needed:** add `metal.copper` + `metal.tin` so smelting
and alloying are separate steps (matches reality), or keep the
direct ore-to-bronze recipe (simpler).

**Acceptance:** decision recorded; if intermediates are added,
recipes and the steady-state analyzer both updated.

**Cross-refs:** `docs/02-resources.md` `metal.bronze`,
`docs/03-production.md` `alloy_bronze`.

## C14 — Construction labor specialization [TODO]

**Current state:** `constructionPhase` consumes generic worker-days
from the settlement's labor pool, not specifically mason or
carpenter days.

**Realistic:** different building types want different specialist
mixes — a granary needs lots of mason days plus some carpenter
days; a smithy is the opposite. Specialization should drive who
actually contributes.

**Acceptance:** building completion rate visibly varies based on
the settlement's mason/carpenter allocation; under-staffed
settlements take longer to complete heavy stoneworks.

**Cross-refs:** `docs/08-money-and-trade.md` §"Construction is
heavy", `src/sim/tick.ts` `constructionPhase`.

## C15 — Per-settlement, per-resource time-series CSV (landed; partial)

**Status (2026-05):** v1 instrument landed. `--instruments=time-series`
on the burn-in CLI writes one
`outDir/settlement-<id>-resource-<r>.csv` per (settlement, resource)
pair, with one row per tick:

    day,stockpile,inflow,outflow,lastClearingPrice,unmetDemandAtClearingPrice

- `stockpile` = sum across every actor in
  `settlement.stockpileOwners`.
- `inflow` / `outflow` = per-tick deltas of
  `market.recentInflows[r]` / `recentOutflows[r]` (those counters
  accumulate monotonically; the instrument differences them).
- `lastClearingPrice` = `market.lastClearingPrice[r]`, blank when
  the resource has never cleared on the settlement.
- `unmetDemandAtClearingPrice` = always 0 in v1. The trade phase in
  `src/sim/tick.ts` discards `clearMarket()`'s
  `unmetDemandAtClearingPrice` field; surfacing it requires
  extending the `market_cleared` TickEvent (or adding a sibling).
  Tracked as the remaining piece of C15 — the column is in the CSV
  schema so a downstream consumer can ignore-or-read uniformly once
  it's plumbed.

**Default behavior unchanged:** without `--instruments=time-series`,
no CSVs are written. The 6-year burn-in watchdog deliberately does
NOT enable it (a 100-settlement realistic burn-in would write tens
of thousands of files per run).

**Cap:** per-CSV row count is capped at 10,000 by default
(~27 in-game years) so a 50-year debug invocation can't OOM.
Configurable via the `timeSeriesMaxRowsPerCsv` runner option.

**Resource selection:** records every resource that any owner in
the settlement holds at burn-in start, plus any resource discovered
during the run (e.g. a producer's first output day). New series
backfill zero rows so all CSVs share the same row count.

**Sample invocation:**

    npm run burnin -- --seed=debug --days=365 \
      --width=32 --height=32 --cities=1 --towns=2 --villages=4 --hamlets=2 \
      --out=./burnin-debug --instruments=time-series

**Cross-refs:** `docs/14-debug-strategies.md`
§"Per-settlement, per-resource time series",
`src/burnin/instruments/timeSeriesCsv.ts`,
`src/burnin/runner.ts`, `src/cli/burnin.ts`.

## C16 — Cascading consequences of price explosion [TODO]

**Current state:** prices are capped at a sane multiple of base
price. There are no riots, edicts, or mob looting events when a
city's grain price spikes through the cap.

**Realistic (per docs/08):** sustained inelastic-demand price
spikes should trigger a chain of named events — first riots
(idle population pressure rises), then governor edicts (price
caps, forced sale of patrician stockpiles), then mob looting
(stockpile transfers from rich actors to poor population).

**Acceptance:** in a deliberately-induced famine burn-in, the
event log shows `riot`, `edict_issued`, and `mob_looting` events
in order. Prices stop runaway because the underlying constraint
gets relaxed (forced sales).

**Cross-refs:** `docs/08-money-and-trade.md` §"Market clearing",
`docs/14-debug-strategies.md` Pattern F.

## C17 — Merchant guilds for price discovery [TODO]

**Current state:** caravans each carry a personal `priceBook`.
There is no `Guild` actor type, no settlement-attached price
ledger, and no per-arrival ledger exchange.

**Why it matters:** docs/08 §"Communicated price discovery via
guilds" is explicitly locked as a design decision (Decision #27
in docs/10). Without guilds, NPC caravan AI either flies blind
(only its own observations) or tacitly assumes information it
shouldn't have. Crowding-aware planning per docs/08 isn't
possible without the shared-but-delayed information channel guilds
provide.

**Realistic implementation:**
1. New `Guild` actor type, one per city of size ≥ town. Each
   guild has a `priceLedger: Map<ResourceId, Map<HexId, PriceObs>>`
   and a member set (NPC caravan owners).
2. On a member caravan arriving at the guild's home settlement,
   it deposits a configurable subset of recent observations into
   the ledger.
3. On a member caravan departing the guild's home settlement, it
   reads the ledger into its own `priceBook`.
4. When two members of different guilds are co-located, they
   exchange a slice of ledgers (the long-haul rumor channel).
5. NPC `planCaravanRoute` factors in visible competing
   commitments (other members planning the same trip) so the
   guild knows everyone won't pile onto the same spread.

**Acceptance:** in a burn-in, an artificial spike in pottery
price at City B is reflected in City A's guild ledger several
days later (matching the round-trip time of the caravan that
observed it), and 2-3 caravans (not all members) commit to a
City B run rather than all of them stampeding.

**Cross-refs:** `docs/08-money-and-trade.md` §"Communicated price
discovery via guilds", `docs/10-scope-and-questions.md`
Decision 27.

## C18 — GoalStack for goal-bearing units [TODO]

**Current state:** caravans carry a single `destination: Position |
null`, not a stack of persistent goals. Patrols carry a route.
News carriers carry a destination + a payload. Migration columns
carry a destination. There is no shared `GoalStack` model.

**Why it matters:** docs/06 §"Goal-bearing units" + Decision #26
in docs/10 lock the design: caravans, migration columns, military
units, and patrols all carry one or more persistent goals on a
stack (`move_to / trade_at / escort / patrol / return_home /
flee_to`) so they can do multi-leg, multi-week intents like "haul
wine to City B and return with grain." Today this is approximated
by per-tick re-planning, which works for simple round trips but
makes complex behavior (escort an ally caravan, then go home,
then wait for a season) hard to express.

**Realistic implementation:** add `goalStack: Goal[]` to the
relevant unit types. The per-tick AI pops the top goal when it
completes, falls back to the next. `escort` becomes a real goal
(stay within N hexes of another unit) instead of a special-case
in the patrol code.

**Acceptance:** an NPC trader runs a 30-day round trip with
trade goals stacked at both endpoints, never needs daily
re-planning, and the goal stack serializes cleanly in the
WorldState snapshot.

**Cross-refs:** `docs/06-caravans.md` §"Goal-bearing units",
`docs/10-scope-and-questions.md` Decision 26,
`src/sim/caravan/caravan.ts`, `src/sim/caravan/ai.ts`.

## Order of operations

C4 dynamic investment and C8 construction time are landed. Remaining
order:
- Finish C9's performance follow-up (settlements-by-hex index).
- Reduce C5 bootstrap stockpiles after burn-in stays stable without
  the cushion.
- Delete C7 bootstrap-only safeguards once C5-final lands.
- C10–C18 are independent and can be tackled in any order; pick by
  burn-in pain (C15 has landed in v1; C10 + C17 are the
  highest-leverage realism gaps).

## Already landed

- ✅ C1 — Pasture / livestock model: `requires` field added to
  RecipeDef; shear_wool + milk_dairy now check herd presence
  without consuming. Steady-state pasture demand dropped 3x.
- ✅ C2 — Realistic recipe ratios: smelt_iron 60+100→15, bake_bread
  5 wood, harvest_grain 0.005 tools, fell_timber 1.5 wood. Plus
  forester_camp / charcoal_kiln / bloomery / farm / mill capacities
  bumped to absorb the load.
- ✅ C3 — Dynamic catchment recompute: settlements that grow or
  shrink ±25% from baseline reclaim or release catchment hexes
  every 365+ days.
- ✅ C4 — Dynamic settlement investment: actors add `pendingBuilding`
  capacity from observed market spreads.
- ✅ C5 (partial) — Grain reserve halved (365 → 180 days). Full
  reduction deferred per above.
- ✅ C6 — Worker reallocation by demand: `Settlement.jobAllocations`
  drives `laborAvailableInSettlement`; monthly hook reallocates
  ~0.66% of workers per month based on `recipe_blocked` events.
- ✅ C8 — Construction time + labor cost: investments create
  `pendingBuilding` records that consume worker-days before becoming
  productive. Demolition remains [TODO].
- ✅ C10 — Storage capacity discipline: per-resource cap enforced
  every tick after production; overflow forced-sold at spoilage
  floor (0.5 × baseline) with a `storage_overflow` event.
- ✅ C11 — Roman-road maintenance cost: governor pays
  0.1 coin + 0.01 cut_stone per Roman hex per quarter; missed
  quarters accumulate; after 4 missed quarters the hex demotes
  to dirt with a `road_unmaintained` event.
- ✅ C15 (partial) — Per-(settlement, resource) CSV time-series
  instrument. `--instruments=time-series` writes one CSV per pair;
  `unmetDemandAtClearingPrice` plumbing remains the open piece.
