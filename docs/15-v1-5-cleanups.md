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

## C10 — Storage capacity discipline (landed, gentle perishable spoilage)

**v1.5 — landed.** Each building catalog entry carries
`storageCapacity: ReadonlyMap<ResourceId, Quantity>` (per-resource
caps) + `wildcardCapacityKg` (generic in-process pool). Granary
+5000 modii grain + 1000 kg wildcard; warehouse +10000 kg
wildcard; all other buildings carry 50 kg by default. Per-capita
household baseline of 50 kg/adult covers buildingless hamlets.

`computeStorageCapacity(settlement)` aggregates caps. New
`storageSpoilagePhase` runs daily after politicsPhase: for each
settlement, perishable resources (catalog `perishableDays`
present) above their per-resource cap (or wildcard pool aggregate)
spoil at 0.2%/day proportionally across owners. Hard goods (iron,
tools, cut stone, weapons) NEVER spoil.

365-day grace period: bootstrap stockpiles (90 days of grain in
a 30k city = 161k modii vs. one granary's 5k cap) consume
naturally before the cap kicks in.

New `storage_spoilage` TickEvent.

**Why we landed gentle perishable-only spoilage:** the prior
attempt did instant force-sales at floor prices for ALL
overflowing resources. That cascaded into market collapse +
85k famine deaths within 2 years. The 0.2%/day perishable-only
model self-regulates: production naturally backs off because
output goes nowhere → seller's stockpile stays full → next
round's clearing prices fall → derived input demand falls.

**Cross-refs:** `docs/05-settlements.md` §"Storage capacity"
(planned doc), `docs/02-resources.md` (perishableDays),
`src/sim/buildings/catalog.ts` (storageCapacity field),
`src/sim/world/settlement.ts` (`computeStorageCapacity`),
`src/sim/tick.ts` (`storageSpoilagePhase`).

## C11 — Roman-road maintenance cost (landed, quarterly drain)

**v1.5 — landed.** HexTile gains an optional
`romanQuartersUnmaintained: number` counter. Quarterly
(every 91 days) `roadMaintenancePhase` runs:

For each Roman-road hex:
- If governor.treasury ≥ 0.1 coin → drain it, reset counter to 0.
- Else → increment counter. After 4 consecutive missed quarters
  (~1 year), the hex demotes to `road = 'dirt'` (with `roadWear`
  seeded at 100), the counter resets, and a `road_unmaintained`
  TickEvent fires.

Cost calibrated trivial vs. governor wealth: ~50-200 Roman hexes
× 0.1 coin × 4 qtrs/yr = 20-80 coin/yr against a seeded 20-50k
treasury. Only matters under deliberate political/economic stress.

The eternal Roman road is now contingent on a paying governor.

**Cross-refs:** `docs/06-caravans.md` §"Trail wear",
`src/sim/tick.ts` (`roadMaintenancePhase`),
`src/sim/world/terrain.ts` (`romanQuartersUnmaintained` field).

## C12 — Promote raw milk to a tracked resource (landed)

**v1.5 — landed.** `food.milk` added to catalog (tier 0,
perishable 2 days, 1 kg/unit). `milk_dairy` outputs milk: 30
per recipe-instance (was: cheese: 8 directly). `make_cheese`
consumes milk: 60 + salt: 0.5 → cheese: 6 (historical ~10 kg
milk per kg hard cheese). Surrounding villages can now sell
daily milk to neighboring cheesemaking towns through the local-
trade phase.

**Decision needed:** promote `food.milk` to a Tier 0/1 resource
**Cross-refs:** `docs/02-resources.md` `food.milk` + `food.cheese`,
`docs/03-production.md` `milk_dairy` + `make_cheese`.

## C13 — Copper / tin intermediates for bronze (landed)

**v1.5 — landed.** `metal.copper` + `metal.tin` added to
catalog (tier 1, 25 kg/unit). New `smelt_copper` (60 ore + 100
charcoal → 12 copper) and `smelt_tin` (40 ore + 50 charcoal →
10 tin) recipes at the bloomery. `alloy_bronze` now consumes
9 copper + 1 tin + 8 charcoal → 10 bronze (~88%/12% historical
Roman ratio). Copper and tin are independently tradable —
matches the historical record where Cornish tin shipped across
Europe to copper-smelting centers.

**Cross-refs:** `docs/02-resources.md` `metal.bronze`,
`docs/03-production.md` `alloy_bronze`.

## C14 — Construction labor specialization (landed)

**v1.5 — landed.** `PendingBuilding` carries optional
`masonDaysRemaining` + `carpenterDaysRemaining`. New
`computeMasonShare(building)` derives the split from construction
cost materials (stone/brick → masons, lumber → carpenters; default
50/50). `constructionPhase` drains the two pools independently.

A granary (heavy stone+brick) bottlenecks on mason allocation;
a smithy (heavy lumber) on carpenters. Settlements not allocating
workers to a role take much longer to complete that role's projects.

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

## C17 — Merchant guilds for price discovery (landed)

**v1.5 — landed.** New ActorKind `merchant_guild` + `Guild` type
(src/sim/politics/guild.ts). One guild per town/city seeded at
procgen (Phase 12); auto-enrolls local patrician families + the
city corporation as members.

Tick-loop wiring:
1. On caravan arrival, `syncCaravanWithLocalGuild` deposits the
   caravan's recent priceBook entries into the owner-guild's ledger
   AND reads freshest collective entries back into the priceBook
   so the next leg uses the guild's intel.
2. `crossGuildRumorPhase`: caravans of DIFFERENT guilds sharing a
   hex bidirectionally exchange ledger slices (capped 60 days old).

Shared-but-delayed channel: a spike at City B becomes visible at
City A as soon as a member caravan completes the round trip — not
instantly, not blind.

**Cross-refs:** `docs/08-money-and-trade.md` §"Communicated price
discovery via guilds", `docs/10-scope-and-questions.md`
Decision 27.

## C18 — GoalStack for goal-bearing units (landed)

**v1.5 — landed.** New `Goal` type
(src/sim/caravan/goal.ts) with variants `move_to`, `trade_at`,
`escort`, `patrol`, `return_home`, `flee_to`. `Caravan` gains an
optional `goalStack: Goal[]`. `caravanReplanPhase` peeks the top
goal each tick; pops when complete (per `isGoalComplete` against
the city-anchor index), adopts the next goal's implied
destination. Backwards-compat: caravans without a stack use the
legacy single-destination re-planning.

A trade route can now be expressed as a single 30-day intent —
"haul wine to City B, trade there, return home with grain" —
instead of being re-discovered every tick. The escort/patrol
goal types are placeholders for future engine wiring.

**Cross-refs:** `docs/06-caravans.md` §"Goal-bearing units",
`docs/10-scope-and-questions.md` Decision 26,
`src/sim/caravan/caravan.ts`, `src/sim/caravan/goal.ts`.

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
