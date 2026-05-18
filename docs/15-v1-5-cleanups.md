# 15 — Historical v1.5 Cleanup Log

**Status: historical.** This doc was the v1.5 cleanup punch-list.
Nearly every item below has landed (see the per-section status
tags). Current authoritative state is in
[10 — Scope & Decisions](10-scope-and-questions.md) §"Decisions
locked" and in the code itself.

A handful of items remain genuinely open (C7 bootstrap-safeguard
removal, C16 price-explosion cascade). New design decisions land
into docs/10's locked table directly, **not** here.

Earlier doc cross-references like "see docs/15 §CXX" describe the
historical change context; for *current* behavior consult the
locked-decision row in docs/10.

## C4 — Dynamic settlement investment (Stage 2 specialization, landed)

**Pre-v1.5 hack:** all production buildings were seeded once at procgen
time. No new buildings are ever built; no existing ones are
upgraded or torn down. Specialization is purely "what procgen put
where".

**Why it was a hack:** the building-investment loop has cost,
ROI, and political dimensions (who decides? Who pays?) that
needed the rest of the politics layer to land first.

**Realistic:** every season, each settlement's stockpile-owning
investor looks at observed market prices vs. recipe input costs. If a
recipe is profitable and the actor has the required construction
materials in stockpile, they commit those materials to adding capacity
(or a new building of that type). This is capital allocation, not magic
spawning: mines need matching local deposits, and ore refineries need
local ore stock or a deposit-backed mine already present/under
construction.

**Current implementation:**

1. Each season-end (90-day boundary), in `politicsPhase`, for each
   settlement's richest investor with `kind ∈ {patrician_family,
free_village, city_corporation, governor_office, hamlet_household}`:
   a. For each recipe in the catalog, compute expected daily
   profit at last-observed input + output prices.
   b. Pick the most profitable recipe whose building isn't already
   saturated locally and whose resource gates are satisfiable.
   c. If the investor has the construction materials and expected
   profit / local material opportunity cost > 0.005/day: invest.
   Construction materials leave the actor stockpile; a
   `pendingBuilding` is added at a free urban or catchment hex. Mine
   placement must be on a matching finite deposit, including rugged
   mountain deposits. The building becomes productive only after
   construction worker-days complete.
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

## C5 — Bootstrap stockpile final reduction (landed)

**v1.5 — landed.** `GRAIN_DAYS_OF_RESERVE` is now 30 days. Starter
wood is about 7 days of subsistence fuel (`0.001 cord/adult/day`),
with small minimum buffers for tiny settlements. Starter tools are
`0.2` tool units per capita, again with small settlement minimums.

**Why:** the previous `pop*20` tool grant created millions of tools
before the economy ran. That flattened tool prices and made smithing
look irrelevant. The reduced reserve is still enough for the current
tool-wear ratios to bridge early burn-in, but forces tools and fuel to
come from actual production, local trade, and caravans within the first
season.

**Remaining risk:** if a seed lacks enough forester/smith capacity or
labor, the market should show that as real wood/tool scarcity rather
than hiding it behind bootstrap stock.

**TODO implementation:**

1. Drop `GRAIN_DAYS_OF_RESERVE` to 30.
2. Drop `pop * 5` wood seed → `pop * 0.5`.
3. Drop `pop * 20` tools seed → `pop * 1`.
4. Run burn-in. If it fails, the issue is _upstream_: not enough
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
   workers. The current hook moves roughly 8%/month using both blocked
   events and local price-profit signals, so convergence is gradual but
   burn-in-visible.

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
   placements (the _pagus_ pattern).
3. ✅ Catchment arbitration: same-hex settlements share the urban
   hex; `orderSitesForCatchment` extends the kind-order with a
   descending-population tiebreak so the bigger village runs first
   through `computeCatchment`'s closer-wins rule. Same-hex hamlets
   get whatever isn't already claimed (often empty in the inner
   ring of a _pagus_).
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
   assigned). The owner pays free/paid worker-days at the local
   subsistence-basket reservation wage, moving coin to local worker
   households. Enslaved construction worker-days advance the project
   without a cash wage, while still requiring owner-funded upkeep.
   When `workerDaysRemaining ≤ 0`, the building is added via
   `addBuilding` and the pending record is removed.
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

Short-lived perishables with `perishableDays <= 14` also spoil
naturally from day 0 using a first-order daily fraction
`1 - exp(-1 / perishableDays)`. This covers grapes, olives, bread,
milk, fish, game, and hides: they must sell, process, or rot even
during bootstrap.

365-day grace period: longer-lived bootstrap stockpiles (for example
flour, cheese, salted fish, salted meat) consume naturally before the
capacity-overflow cap kicks in.

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
trade phase. Pasture/dairy `requires` also create productive-capital
demand: a dairy short of cattle bids for herd stock as a real owned
asset before it can produce the milk stream.

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

## C19 — Bid-ask book per market (landed)

**Pre-v1.5 hack:** market clearing returned only a single
`clearingPrice` per resource per settlement. The CDA actually produces
a residual schedule on both sides (unsold asks, unmet bids), and that
ladder is the visible "spread" any caravan would observe walking
through a real forum. The viewer's settlement panel had a `bid-ask`
column as a placeholder showing `—`.

**Realistic (per docs/08 §"Bid-ask book"):** after clearing each
day, derive a five-field book per (settlement, resource):

```
bestAsk, askDepth   ← residual SupplySource with availableToSell > 0
bestBid, bidDepth   ← residual DemandSource with quantityAt > 0
midPrice            ← clearing price if any, else mean(bestBid, bestAsk),
                      else the single side
spread              ← bestAsk - bestBid when both >0, else null
```

The book lives in `MarketSnapshot` (per resource) alongside
`lastClearingPrice`, refreshed every tick. It does **not** persist as
a limit order book — each tick re-derives it from current
stockpiles / treasuries / recipe demand. Caravans and "internal
needs" (workshops short on inputs, tax convoys assembling, off-map
houses sweeping in cargo) cross the spread by bidding above bestAsk
or asking below bestBid; the next clearing matches them against the
remaining book.

**Implementation:**

1. `ClearingResult` returns `bestBid`, `bidDepth`, `bestAsk`,
   `askDepth`, `midPrice`, `spread` based on residual sources.
2. `Settlement.market` carries `bestBid`, `bestAsk`, `bidDepth`,
   `askDepth`, `midPrice` per resource plus a compact
   `bookLadder` of per-actor residual bid/ask orders. Cleared on
   the same path that prunes `lastClearingPrice` for dead markets.
3. Merchants use the settlement book as the trade surface: origin
   asks are their expected buy price, destination bids are their
   expected sale price, and destination bid depth caps planned cargo.
4. Viewer `settlementPopup` renders the spread column as
   `bestBid – bestAsk` with depth annotations, and the resource
   popup shows the per-actor book ladder.

**Acceptance:** at year 5 of a watchdog burn-in, every city
shows a non-trivial spread on at least 30 different resources;
goods with zero clearing volume for >30 days are flagged as
dormant in the diagnostics and surfaced for triage. Tests cover
the residual-book extraction (`clear.test.ts`), the schedule
builder's bid-ask projection, and the viewer's spread rendering.

**Cross-refs:** `docs/08-money-and-trade.md` §"Bid-ask book",
`docs/10-scope-and-questions.md` Decision 32,
`src/sim/market/clear.ts`, `src/sim/world/settlement.ts`,
`viewer/ui/settlementPopup.ts`.

## C20 — Cash circulation across owner kinds (landed)

**Diagnosed during the C19 burn-in audit:** a watchdog burn-in
showed `patrician_family` average treasury of 2 coin (max 8) and
`common_household` average treasury 0, against 14 `city_corporation`
actors with up to ~320k treasury each. The bid-ask book correctly
showed quoted asks on most goods but almost no crossings — buyers
were broke. See docs/08 §"Cash circulation discipline" for the
mechanism.

**v1.5 mechanics (landed):**

The redistribution lives in `fiscalRedistributionPhase` called on a
**quarterly** cadence (every 90 days), alongside `investmentPhase`.
Each transfer emits a `fiscal_redistribution` `TickEvent` (`channel`
∈ `civic_dividend / tenant_rent`) for viewer + burn-in audit.

1. **Quarterly civic dividend to patricians.** Every 90 days, each
   `city_corporation` distributes a fraction of its treasury
   (`CITY_CORP_DIVIDEND_FRACTION = 0.08`, ≈32% APR) split evenly
   among `patrician_family` actors whose `homeSettlement` matches
   the city's settlement. Models cura annonae stipends, civic
   contract pay, magistrate salaries — the real Roman income
   channel for families running the city council.
2. **Quarterly rent collection from tenant villages.** Every 90 days,
   each `free_village` and `hamlet_household` pays rent to the
   patrician families of its nearest patron city within
   `TENANT_RENT_MAX_HEX_DISTANCE = 30` hexes. The rent is
   `TENANT_RENT_FRACTION_PER_QUARTER = 0.05` of the tenant's
   treasury, capped to `TENANT_RENT_TREASURY_CAP_FRACTION = 0.15`
   so a single collection cannot overdraft a tiny hamlet. The rent
   is split EVENLY across all patrician families in the patron
   city — without that split a single nearest family was
   collecting all the regional rent.
3. ~~**Quarterly merchant-house residual to patricians.**~~ **REMOVED
   in §C22.** The original C20 had off-map houses paying back a
   fraction of their treasury to patrician families, but this was a
   synthetic transfer with no real economic story. The legitimate
   off-map → on-map coin channel is the export caravan path (see
   §C22): cities ship surplus to edge hexes and global-market coin
   credits the source actor on cargo exit.
4. **Initial treasury seed by kind, rebalanced.** Patrician families
   now seed with `8000-24000` coin (was 2000-8000) so they survive
   the first quarter before redistribution arrives. Common
   households are unchanged; they still equilibrate to ~0 via
   subsistence spending but receive their cash from wages (paid by
   now-solvent patrician employers) every tick.

An earlier iteration tried monthly cadence with proportionally
smaller fractions (3% / 2% / 2.5% per month vs 8% / 5% / 6% per
quarter). The monthly version produced WORSE outcomes — patrician
treasuries averaged lower and famine deaths rose ~30%, likely
because the smaller monthly drips did not deliver enough working
capital to outpace the wage burn in any single month. Quarterly
chunks, even though they arrive in pulses, give families a
bigger buffer that survives the gap between redistributions.

**Acceptance:** at year 3 the median patrician_family treasury is
in the 1000+ coin band; comfort/status/capital markets in cities
show non-trivial clearing volume; the bid-ask book's dormant-good
count drops materially.

**Cross-refs:** `docs/08-money-and-trade.md` §"Cash circulation
discipline", `docs/10-scope-and-questions.md` Decision 33,
`docs/11-politics-and-ownership.md` §"Tax revenue is real",
`src/sim/tick.ts` `fiscalRedistributionPhase`.

## C21 — Disaggregate `common_household` by class (landed)

**Diagnosed during the C19/C20 burn-in audit:** even with the C20
redistribution flowing, a town/city's "common household" actor still
appeared with avg treasury ~0 most of the time, suppressing comfort
and status demand from the urban free population. The structural
cause was that `common_household` was a single aggregate ledger
representing thousands of plebeians + freedmen + foreigners. When
the schedule builder capped demand at "actor treasury", it was
capping the buying power of an entire city's free population at a
single number. Spending by ANY class drained the treasury for ALL
classes; wages routed to ONE actor regardless of who actually
worked the recipe.

**v1.5 mechanics (landed):**

1. **Three new actor kinds replace `common_household`:**
   `plebeian_household`, `freedman_household`, `foreigner_household`.
   Per the CLAUDE.md "no backwards compatibility — ever" rule,
   `common_household` is removed entirely; no shim, no deprecated
   enum value. The three kinds carry the same ownership semantics
   `common_household` did (own no hexes, own no buildings by
   default, exist to anchor per-class household cash + stockpile).
2. **Per-settlement seeding** — every settlement that previously
   got a `common_household` actor now gets up to three actors, one
   per class WITH POSITIVE POPULATION in that settlement. A
   settlement with no plebeians (rare, but possible in tiny
   slave-only estates) gets no `plebeian_household`. Initial
   treasury per class:
   plebeian_household = plebeian_count × 30 coin
   freedman_household = freedman_count × 15 coin
   foreigner_household = foreigner_count × 50 coin
   Same totals as the old `common_household` seed, just split.
3. **Hamlets and free villages keep their existing actor.**
   `hamlet_household` and `free_village` are settlement-political
   concepts (they own land, they have elders, they pay rent to a
   patron) — they are not the same thing as a class-level household
   aggregate. They continue to represent the dominant smallholder
   population of those tiers.
4. **Wage routing splits by class.** When a recipe runs at a
   town/city building, its `payProductionWages` call now splits the
   wage bill across `plebeian_household` / `freedman_household` /
   `foreigner_household` IN PROPORTION to the recipe's actual class
   mix consumed (computed via the same LaborClassContext that the
   production engine already uses). Hamlet/free-village settlements
   route wages to their single `hamlet_household` / `free_village`
   actor as before — those settlements typically have a single
   class dominant anyway.
5. **Slaves stay on the owner's books.** No `slave_household`
   actor. Slave subsistence demand still bids through the slave's
   owner (`patrician_family`, `city_corporation`, `governor_office`,
   `temple`, `hamlet_household` / `free_village` as appropriate),
   exactly as before. Per docs/11: enslaved labor is owner-funded
   subsistence; the slave does not hold personal coin.
6. **Schedule builder buyer selection.** The
   `CONSUMER_BUYER_KIND_PRIORITY` table that previously mapped
   `plebeian → [common_household, hamlet_household, free_village,
...]` becomes the cleaner mapping `plebeian →
[plebeian_household, hamlet_household, free_village, ...]`.
   Direct 1:1 lookup; no shared bucket.

**Why this matters for the bid-ask book:**

With three class-level actors instead of one, the residual book per
resource is genuinely **richer**: plebeian comfort-demand and
freedman comfort-demand show up as separate quote sources, each with
their own WTP cap derived from their own treasury. A city of 50k
plebeians + 10k freedmen + 5k foreigners produces three independent
DemandSource entries per resource per day instead of one merged
schedule. The CDA matches highest-WTP first, so freedmen with a
slightly higher reservation can clear before plebeians get squeezed
out.

This also unlocks volume-based caravan planning (docs/06 §"NPC
caravan AI" follow-up): a caravan arriving with cargo can read each
class's residual bid depth and price its sales against the actual
absorption ceiling at each WTP step, rather than against the
single-actor aggregate that treated the whole city as one ledger.

**Acceptance:** at year 3, every city has at least
`plebeian_household` with treasury > 0 most of the time, comfort
markets (wine, oil, cheese, cloth, pottery) clear regularly, the
viewer's per-resource book ladder shows multiple distinct bid
sources per resource.

**Cross-refs:** `docs/04-population.md` §"Class structure"
(plebeian/freedman/foreigner are the wage-earning + bidding classes,
slaves are owner-funded), `docs/08-money-and-trade.md` §"Cash
circulation discipline" + §"Bid-ask book" (richer per-class book),
`docs/11-politics-and-ownership.md` §"Every faction has named
characters" (the common-household actor concept), `src/sim/politics/
actor.ts` `ActorKind`, `src/procgen/seed.ts` household seeding,
`src/sim/tick.ts` wage routing.

## C22 — Off-map coin flow via exports, not synthetic residual (landed; superseded in v1.6)

> **v1.6 update:** the two-channel model below (off_map_house spawns
> imports + city actor spawns separate export caravan via a fixed
> cadence) is replaced by **patrician + merchant-guild international
> ventures**: a single round-trip caravan dispatched on-demand when
> `expected_profit ≥ 3 × transport_cost`, with a 20-tick off-map
> sojourn at the edge hex. See decisions 37–41 in
> [10 — Scope](10-scope-and-questions.md), [06 — Caravans](06-caravans.md)
> §"International ventures", and [08 — Money & Trade](08-money-and-trade.md)
> §"The off-map global market". The historical C22 text below
> documents the v1.5 mechanic for audit-trail purposes.

**Pre-§C22 hack (C20 channel 3):** every quarter, each `off_map_house`
actor paid back `OFF_MAP_HOUSE_RESIDUAL_FRACTION = 0.06` of its
treasury to patrician families in the nearest on-map city. This was
documented as "factor commissions / agent retainers / partnerships,"
but it was a synthetic transfer with no real economic mechanism —
off-map houses don't structurally owe anything to on-map patrician
families.

**Realistic (per docs/08 §"Off-map global market" + docs/06 §"Edge-
hub caravans"):** the two coin channels between on-map and off-map
are:

1. **Imports.** An `off_map_house` spawns an import caravan at an
   edge hex with cargo and operating coin. The caravan sells the
   cargo on-map; the sale credits the off-map house's treasury. The
   house's treasury grows.
2. **Exports.** A city-based actor (`patrician_family`,
   `city_corporation`, `governor_office`) has surplus cargo
   registered as `availableForExport`. An export caravan is spawned
   with the city actor as `ownerActor`. The caravan walks to an
   edge hex; on arrival, `completeOffMapExportIfArrived` sells the
   cargo at `DEFAULT_GLOBAL_PRICES` and credits the OWNER's
   treasury. The on-map actor's treasury grows.

That is sufficient. The trade surplus / deficit is the real
balance: a province with strong exports earns more from off-map
than it spends on imports; a province with thin exports drains
its money supply. Off-map houses still hoard import-sale coin in
their treasuries, but they don't bid for anything on-map (their
export caravans are owned by city actors, not by them), so the
hoard is a benign sink.

**v1.5 mechanics (landed):**

- The `merchant_residual` channel in `fiscalRedistributionPhase`
  is deleted. The `OFF_MAP_HOUSE_RESIDUAL_FRACTION` constant is
  removed.
- The `fiscal_redistribution` `TickEvent` channel union no longer
  has `'merchant_residual'`.
- The existing `caravan_exported_off_map` event remains the
  authoritative inbound coin signal. Per-resource export quantities
  and global-price-denominated coin are surfaced for the viewer +
  diagnostics.

**Acceptance:** at year 3 the patrician/city-corp treasuries are
sustained by civic dividends, tenant rents, and export-caravan
proceeds — not by a synthetic merchant transfer. Off-map house
treasury grows monotonically (with no observable behavioral
consequence). The viewer's economic event log shows export
caravans completing instead of residual transfers firing.

**Cross-refs:** `docs/06-caravans.md` §"Edge-hub caravans",
`docs/08-money-and-trade.md` §"Off-map global market",
`docs/15-v1-5-cleanups.md` §C20, `src/sim/tick.ts`
`fiscalRedistributionPhase`, `completeOffMapExportIfArrived`.

## C23 — Non-cash wealth floor on comfort + status demand (REVERTED in §C27)

**Diagnosed during the §C22 bid-book audit:** in a year-1 burn-in
snapshot a large city had 45 of 61 priced resources with NO bid in
the book — including obviously-consumed goods like olive oil (228k
units sitting in stockpile), wine (140k), cheese, cloth, pottery.
Cause: `plebeian_household / freedman_household / foreigner_household`
actors all had treasury = 0. The schedule builder's
`budgetCapForActor` was a HARD cap at actor treasury — when treasury
hit zero, the comfort/status demand source was skipped entirely.
Households drained because wages-in-coin only fire when the payer
has cash, and patrician estates pay in-kind grain when their own
treasury runs low. The result: a chicken-and-egg cash deadlock with
giant stockpiles, no bidders, and a silent bid book.

**v1.5 mechanics (landed):**

1. `budgetCapForActor` gains a `nominalBudgetFloorFraction`
   parameter. The cap becomes
   `max(min(treasury, nominal), nominal × floor)` — the actor's
   treasury still caps demand at the upper end, but a small fraction
   of the **population-derived nominal budget** is always available,
   representing non-cash wealth (household food stockpile, barter,
   in-kind exchange, savings stashed in goods).
2. `COMFORT_NOMINAL_FLOOR_FRACTION = 0.05` for plebeian/freedman/
   foreigner comfort demand.
3. `STATUS_NOMINAL_FLOOR_FRACTION = 0.05` for patrician status
   demand (broke patricians retain credit lines + lineage wealth).
4. Subsistence demand is unchanged — it already uses
   `subsistenceBudgetForActor` which credits the actor's own
   stockpile through `selfProvisionCredit`. Subsistence at literal
   zero treasury AND zero stockpile remains zero, which is correct:
   starving people don't bid.

**Effect:** the bid book in cities populates correctly even when
households drain. Comfort markets (wine, oil, cheese, cloth,
pottery) clear continuously instead of pulsing. The floor unlocks
~5% of nominal volume per affected good — modest in absolute
terms, but critical for the cash-flow loop because it gives
patrician estates a buyer for their output.

**Cross-refs:** `docs/08-money-and-trade.md` §"Cash circulation
discipline", `src/sim/market/scheduleBuilder.ts`
`budgetCapForActor`.

## C24 — Patrician family members share the family nomen (landed)

**Pre-§C24 hack:** every patrician_family seeded ONE named
character (the patriarch), generated via `generateFullName` which
drew a random praenomen + nomen. The patriarch of Family Vibian
might be named "Lucius Caelius" — the actor's name said one
family, the character's name said another. The faction screen
in the viewer showed a single misnamed character per family.

**v1.5 mechanics (landed):**

1. New `generateFamilyMemberName(rng, sex, nomen)` in
   `src/sim/politics/character.ts`. Produces a Latin name using the
   given nomen as the family surname.
2. `seedPatricianFamily` in `src/procgen/seed.ts` now seeds 3-5
   members per family (patriarch + 2-4 adult members), all sharing
   the family nomen. Members include:
   - Patriarch (male, age 35-60).
   - Heir (male, 18-32).
   - Matron (female, 35-55).
   - Younger scion (any sex, 10-24).
   - Optional elder (any sex, 45-68).
3. Faction members list contains all of them. Reputation and news
   propagation still target individuals — but now the family has
   members for events to affect.

**Cross-refs:** `docs/11-politics-and-ownership.md` §"Every
faction has named characters", `src/sim/politics/character.ts`
`generateFamilyMemberName`, `src/procgen/seed.ts`
`seedPatricianFamily`.

## C25 — Caravan minimum-margin gate + unprofitable-disband (landed)

**Pre-§C25 hack:** the caravan planner accepted any route with
`netProfit > 0`, so caravans regularly ran 0.5%-margin trades that
covered travel cost by a few coin and netted nothing. Worse,
caravans that found no profitable route at all just kept scouting
indefinitely, draining their owner's treasury on rations forever.

**v1.5 mechanics (landed):**

1. `PlanCaravanRouteInputs` gains:
   - `minNetProfitCoin` — absolute net-profit floor in coin per
     trip. Default 0 (back-compat). tick.ts wires
     `CARAVAN_MIN_NET_PROFIT_COIN = 5`.
   - `minNetProfitFraction` — fractional floor relative to travel
     cost. Default 0. tick.ts wires
     `CARAVAN_MIN_NET_PROFIT_FRACTION = 0.05` (≥5% margin over
     travel cost; loosened from 10% in §C28 — see below).
2. `planCaravanRoute` rejects evaluations failing either floor.
3. `Caravan` gains optional `noProfitableRouteDays` counter.
   `caravanReplanPhase` resets to 0 on a successful plan, increments
   every tick the planner returns null. After
   `CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS = 45` consecutive ticks,
   the caravan disbands.
4. New `disbandUnprofitableCaravan` helper returns the caravan's
   treasury + cargo to the owner, refunds equine herd-units +
   carts to the owner's stockpile, and emits a
   `caravan_disbanded` event with reason `'unprofitable'`.

**Effect:** caravans only form / persist when there's real
incentive. The province's caravan count tracks the real opportunity
set rather than mechanical replacement.

**Cross-refs:** `docs/06-caravans.md` §"NPC caravan AI",
`src/sim/caravan/ai.ts` `planCaravanRoute`, `src/sim/tick.ts`
`disbandUnprofitableCaravan`.

## C26 — Patrician + city-corp market making (landed)

**Pre-§C26 hack:** even with §C23's comfort-floor, many resources
in cities had no quoted bid OR ask in the book because no concrete
buyer/seller had reason to engage that day. The book showed `—`
even for goods both sides held in stockpile + would trade if given
a price signal.

**Realistic:** in a real Roman forum, the institutional traders
(patrician estates with surplus, city corporations with reserves)
maintained STANDING BID/ASK quotes for every good they held or
might need — a small fraction of inventory listed at a modest
markup, and a small fraction of treasury reserved as a passive bid
at a modest discount. This is **market making**: providing
liquidity at the spread for any counterparty willing to cross. It
is the "wide spread, low volume" baseline against which the
"narrow spread, high volume" concrete bids and asks layer on top.

**v1.5 mechanics (landed):**

1. New `marketMakerSupplySources` in scheduleBuilder.ts: for every
   resource in a patrician_family / city_corporation /
   governor_office stockpile with a known `lastClearingPrice`,
   emit a SupplySource offering 5% of stockpile at
   `lastPrice × 1.05`. The 5% is `PASSIVE_INVENTORY_LIST_FRACTION`.
2. New `marketMakerDemandSources` in scheduleBuilder.ts: each
   market-making actor dedicates 10% of its treasury
   (`PASSIVE_TREASURY_BID_FRACTION`) split across the resources for
   which a `lastClearingPrice` is observed. The per-resource bid is
   at `lastPrice × 0.95` for quantity `(treasury_share / bid_price)`.
3. Market-making sources are ADDITIVE — they sit alongside
   concrete supply (production-derived) and demand (subsistence /
   comfort / status / derived input). When a concrete buyer/seller
   has a tighter price, that price wins in the CDA. When no
   concrete counterparty exists, the market maker's quote is the
   only thing in the book and ensures `bestBid` / `bestAsk` are
   never null on resources the actor touches.
4. Service resources are excluded — they don't have a stockpile
   shape and aren't tradable as physical goods.

**Effect:** the bid-ask book is meaningfully non-empty for every
resource any cash-and-stockpile institution holds. Two-sided book
coverage in cities rises from ~10% of priced goods to near
universal.

**Cross-refs:** `docs/08-money-and-trade.md` §"Bid-ask book",
`src/sim/market/scheduleBuilder.ts` `marketMakerSupplySources`,
`marketMakerDemandSources`.

## C27 — MM as last-resort bidder + revert C23 ghost-bid floor (landed)

**Diagnosed during the §C26 burn-in audit:** the original C26 added
patrician + city-corp + governor market-making (passive bid 5% below
last price, passive ask 5% above) ADDITIVELY to concrete demand
sources. Result: famine deaths jumped 60% (13.7k vs 8.5k baseline).
The mechanism was that MM bids at 0.95 × last_price competed with
plebeian subsistence demand on staple grain — and when the household
treasury was drained (the recurring "wages-in-kind, no coin
accumulation" pattern), MM cleared the cheap grain first, raising the
next tick's clearing price further out of reach for poor subsistence
buyers. Separately, C23's 5% nominal-budget floor was creating
"ghost bids" — sources that appeared in the book with positive
quantityAt(p) but failed at trade execution because the actor's
treasury cap was 0.

**v1.5 mechanics (landed):**

1. **C23's 5% nominal-budget floor is REVERTED.** The
   `COMFORT_NOMINAL_FLOOR_FRACTION` and `STATUS_NOMINAL_FLOOR_FRACTION`
   constants are now 0. Comfort and status demand only fire when the
   actor has real cash (or self-provision credit for subsistence).
   Bid-book coverage of consumed goods is now provided by §C26
   market-making (real treasury-backed bids) instead.
2. **MM bid is clamped strictly below the lowest concrete-bid finite
   WTP per resource.** `buildSettlementSchedules` builds concrete
   demand sources first, computes `minFiniteWtpForConcreteSources`
   (excluding subsistence which has WTP=∞), and passes that to
   `marketMakerDemandSources`. The MM bid is at
   `min(0.95 × lastPrice, minConcreteFiniteWtp - 1e-3)`. Since the
   CDA matches buyers in descending WTP order, concrete bids always
   fill first; MM only picks up residual supply.
3. **MM ask stays additive** at +5% above last price. Concrete asks
   sit at MC (lower); MM ask is a higher-tier price layer that only
   engages when demand walks up past the natural supply.

**Effect:** MM no longer crowds out subsistence on staples. Famine
deaths drop back near baseline (9.1k vs 8.5k, +6% instead of +60%).
Bid-book coverage stays at 95% in cities. Patrician treasuries
recover (median 481 vs 121 under C26, avg 1741 vs 217). The MM
quote layer remains the "least tight, least volume" outer edge of
the book; it just no longer competes for goods that broke
households legitimately need.

**Test fixture impact:** the `places mine investments only on
matching mineral deposits` test seeded `iron_ore = 5_000` with a
bloomery present. C26's MM bid kept the price artificially high
(MM bid acted as a price-setter when no concrete demand existed at
that level), so mine investment scored well. With C27's clamp the
MM bid stays below bloomery's break-even (~120), the scarcity
price reflects reality, and forester_camp outscores mine on wood
scarcity. The test was rewritten to seed mine-friendly prices
directly without the competing bloomery / quarry buildings.

**Cross-refs:** `docs/08-money-and-trade.md` §"Bid-ask book",
`docs/15-v1-5-cleanups.md` §C23 + §C26,
`src/sim/market/scheduleBuilder.ts` `marketMakerDemandSources`,
`minFiniteWtpForConcreteSources`.

## C28 — Softer caravan margin gate (landed)

**Diagnosed during the §C27 burn-in audit:** even after §C27 fixed
MM's starvation issue, the 3-year burn-in still ended with only 15
caravans active (vs ~36 baseline) and famine deaths ~6% above
baseline. The 10% fractional profit floor
(`CARAVAN_MIN_NET_PROFIT_FRACTION = 0.10` from §C25) was rejecting
marginal routes that would have moved real food between
settlements — with prices closer to marginal cost after §C26 +
§C27, a 10% margin is unusually wide.

**v1.5 mechanics (landed):**

- `CARAVAN_MIN_NET_PROFIT_FRACTION` lowered from 0.10 → 0.05. A 5%
  margin still rejects 0.5%-spread "noise trades" but accepts
  legitimate marginal flows that move real food between
  settlements.
- Day-based 45-tick disband counter
  (`CARAVAN_NO_PROFITABLE_ROUTE_DISBAND_DAYS = 45`) unchanged from
  §C25.
- 3-year burn-in: famine deaths 6622 (vs baseline 8543, **-22%**);
  ~19 caravans active at end (vs baseline 36, §C27 15).

**Variants prototyped and dropped:**

- _Stop-based disband counter_ — only count "no-profit" ticks
  when the caravan is at a settlement anchor, allowing N free
  scouting stops before disband. In burn-in this produced FEWER
  caravans and HIGHER famine than the day-based counter. Long-trip
  caravans got too many free stops + the loosened 5% margin meant
  they took marginal trades that bled resources. The day-based
  45-tick counter more reliably catches caravans that bleed
  without finding a route.
- _Explicit `'insolvent'` disband_ (treasury=0 + cargo=0) — caught
  caravans in transient gaps (just-sold, about-to-buy) and bumped
  famine +14%. The natural failure path is: insolvent caravan
  can't buy rations → health depletes → the existing
  `zero_health` disband fires. That chain is forgiving enough to
  let owner top-ups or trade with passing caravans rescue the
  unit before assets return.

**Cross-refs:** `docs/06-caravans.md` §"NPC caravan AI",
`src/sim/tick.ts` `caravanReplanPhase`, `disbandUnprofitableCaravan`,
`docs/15-v1-5-cleanups.md` §C25.

## C29 — Tribute / rent decoupling for client villages (landed)

**Diagnosed during the post-§C28 audit:** the viewer-reported city
stockpile inflated by ~4.5× world-wide on the watchdog seed. Asculum
showed 8.5M grain after 365 days when the actors physically held only
~2.7M between them. Root cause: each patrician family was registered
as a `stockpileOwner` of (a) its home city AND (b) every client
village it patronised — up to 17 villages per family. Since
`actor.stockpile` is a single pool, the viewer's settlement aggregate
counted the same modius once for the city and once for every client
village. Per pillar §1 (no hidden hands), a pool of grain in one
warehouse cannot simultaneously satisfy markets at 18 different
settlements.

**v1.5 — landed:**

1. `Settlement.clientPatron?: ActorId` — explicit pointer from a
   client village to the patrician family that collects its rent.
   Replaces the old "push patron to village.stockpileOwners"
   convention.
2. `seedClientVillage` no longer pushes the patron to
   `village.stockpileOwners`. Instead it creates a `free_village`
   actor for the village (same kind as free villages) that owns the
   village's stockpile + buildings + starter grain reserves.
3. Building ownership at client villages now resolves to the village
   household actor, not the patron. Recipe outputs and recipe inputs
   both flow through the village's pool — the village stockpile is
   now physical. Hex ownership (`tile.ownerActor = patron`) is
   unchanged: the patron still owns the LAND politically, but does
   not magically hold the harvest.
4. Quarterly `tributePhase` (every 90 days, season boundary): for
   each settlement with a `clientPatron`, transfer
   `TRIBUTE_FRACTION × village.treasury` coin to the patron's
   treasury, capped at what the village can spare without dropping
   below a small operating floor. Default
   `TRIBUTE_FRACTION = 0.25` — chosen to be lower than historical
   share-rent (~⅓–½) because the in-game village_household also
   pays wages to its plebeian workers and we don't want the village
   to be drained to zero between seasons. Tunable per §C30 below.
5. The patron's pool now grows from tribute coin (received quarterly)
   rather than from physical harvest teleportation. Patrons spend
   that coin on caravans, festivals, comfort goods, and market making
   per the existing pathways.

**Why tribute is coin not in-kind:**

In-kind crop-share would either (a) teleport grain from village to
city (violates pillar §1), or (b) require a tribute caravan that
physically moves crop from village to city granary every season,
which is an unbounded amount of caravan-routing work. Coin tribute
matches the late-imperial transition to fixed-cash rents (paid by
selling the harvest at the village market first) and lets the
existing market clearing absorb the village's surplus into local
buyers (or via caravans that arbitrage to the city if the city's
grain price is higher than the village's).

**Result:** world-aggregate stockpile inflation drops from 4.5× to
1.0×. Settlement-level "Stock" columns now report what's physically
in that settlement.

**Cross-refs:** `docs/11-politics-and-ownership.md` §"Patron-client
villages", `src/procgen/seed.ts` `seedClientVillage`, `src/sim/tick.ts`
`tributePhase`.

## C30 — Per-settlement actor inventory (landed)

**Why even after §C29:** §C29 makes the patron-client case clean,
but the underlying type (`Actor.stockpile: Map<ResourceId, Quantity>`
— a single pool per actor) is still **hidden-handed**. If a future
feature lets an actor legitimately hold inventory at multiple
settlements (a city corporation buying a workshop in a satellite
town, a merchant guild operating warehouses in several ports, a
patrician buying a country villa with its own granary), the model
silently shares one pool across all those locations again. Per
pillar §1, inventory must be physical.

**v1.5 — landed:**

1. `Actor.stockpile` is now `Map<SettlementId, Map<ResourceId, Quantity>>`.
   The outer key is the settlement where the inventory physically
   lives. Single-settlement actors (the common case) have a map of
   size 1 whose key is their `homeSettlement`.
2. New helpers in `src/sim/politics/actor.ts`: `getStockAt`,
   `addStockAt`, `removeStockAt`, `actorTotalStock` (sums across
   settlements for debug/UI only), `actorSettlementsWithStock`.
3. Every prior `actor.stockpile.get(r)` / `.set(r, q)` call site is
   migrated to settlement-keyed access. Per CLAUDE.md no compat
   shims — old API is deleted, every call site walks through a
   settlement explicitly.
4. Production phase: a recipe firing at building `b` adds the output
   to `b.ownerActor.stockpile.get(b.settlement)` and drains inputs
   from the same slice. Even if the owner had inventory elsewhere,
   it does not satisfy local recipe inputs without a caravan or a
   market trade.
5. Market clearing at settlement `s`: only same-settlement slices of
   each `stockpileOwner` participate as supply. A patron with a
   country villa cannot sell that villa's grain at his town house
   without first shipping it via caravan.
6. Caravan loading/unloading: same model — buying at `s` increases
   the caravan owner's `s`-slice, then loading moves it to
   `caravan.cargo` (which is settlement-free; caravans are in
   transit).

**Migration scope:** ~30 read/write sites in `tick.ts`, the supply
schedule builder, the spoilage phase, the snapshot serializer,
seed/seedCaravans, and the viewer's stockpile aggregator. All call
sites needed an explicit settlement parameter — most were already
passing settlement around (production loops, market clearing) so the
threading was mechanical.

**Acceptance:** world-aggregate inflation is exactly 1.0× (each
modius counted in exactly one settlement's "Stock" column);
`debug-stockpile-accounting.ts` reconciles `Δstock = produced +
imported − consumed − exported` within 0.1% per settlement per day.

**Known follow-up — famine regression:** the 3-year watchdog burn-in
(80×80, 3 cities) shows famine deaths rise from ~6.6k (post-§C29) to
~22k after §C30. This is **expected** behaviour, not a bug: before
§C30 a patron's grain pool was implicitly accessible at every market
they were registered at, which masked food-distribution friction.
The honest physical model exposes that the trade system doesn't
yet move enough grain from village granaries to city subsistence
markets. Population still settles at ~87% over 3 years (pass) and
no fatal invariants fire. Real fix lives in trade/caravan tuning,
not in re-introducing the hidden hand.

**Cross-refs:** `docs/11-politics-and-ownership.md` §"Hex-level
ownership", `src/sim/politics/actor.ts`,
`docs/15-v1-5-cleanups.md` §C29.

## C31 — Villager caravans (landed; extended in v1.6)

> **v1.6 extension (locked, decision 43):** the abstract daily-pass
> `localTradePhase` is deleted; villager caravans become the
> general-purpose vehicle for **all** local inter-settlement trade,
> not just village→nearest-city. Dispatcher logic is extended to
> consider adjacent villages, hamlets, and towns within ≤6 hex as
> candidate destinations whenever the steward's `knownPrices`
> identifies a spread that beats round-trip transport cost +
> reluctance margin. A new smaller "handcart" tier (1 person, ≤50
> kg, no animals) sits below the existing 2-4-mule villager cart
> for very short and very light arcs. All tiers share the SAME
> movement / food / ambush / disease machinery as long-haul
> caravans.

**Motivation:** after §C30 the famine regression revealed that the
trade system wasn't moving enough food and other rural production
from village granaries to city markets. Patron-funded long-haul
merchant caravans handle inter-city trade but rarely originate at a
village. The historical Roman gap is exactly this: a village
steward + 1-2 mules + a handcart, doing a short out-and-back to the
nearest city every few weeks. That's a villager caravan.

**The Roman village ↔ city economic relationship the model exposes:**

A village headman / steward routinely sent a small caravan to the
nearest city for one of three reasons:

1. **Surplus run.** The village has more grain / legumes / wool /
   flax / lumber / cheese / pigs / cloth than the village itself
   needs. Cart it to the city, sell at market, come home with coin
   and/or city-made goods (oil, wine, pottery, salt, iron tools)
   the village can't make itself.
2. **Import trip.** The village has accumulated coin from prior
   trips. The headman wants pottery / tools / oil / salt that the
   city sells cheap, brings them back, distributes them to
   villagers, or stockpiles for the off-season.
3. **Hard-times resupply.** The village's own subsistence grain is
   running low (bad harvest, locusts, plague), and the headman
   drains some of the village treasury to send the caravan to buy
   staples back from the city.

All three are the same caravan with different cargo + direction.
We model the dispatch trigger as "village has meaningful exportable
inventory OR has decent treasury to fund an import / resupply
trip"; the planner picks the actual cargo each leg.

**v1.5 mechanics (landed):**

1. New caravan ID prefix `villager-`. Distinct from the existing
   `merchant-`, `tax-`, `import-`, `export-` prefixes. The viewer
   renders these with a dedicated peasant-with-handcart SVG
   (`viewer/art/units/villager_caravan.svg`) so they read
   visually distinct from patron-funded long-haul mule trains.
2. `villagerCaravanAssemblyPhase` runs every 14 days. For each
   `free_village` actor whose home settlement is a village and that
   has either:
   - any of `VILLAGER_EXPORTABLE_RESOURCES` (food, fibre, wood,
     hides, livestock, cloth) at ≥14 days of local subsistence
     equivalent, OR
   - treasury ≥ 200 coin (import-trip threshold), OR
   - grain stock <7 days AND any treasury (hard-times resupply)

   ...the steward dispatches a villager caravan (one per village
   at a time).

3. Caravan composition: 2-4 mules + 0-1 donkeys, 1 drover + 1
   guard, no light cart, 4-day starter rations. Operating
   treasury 50-250 coin (vs 250-750 for merchant caravans),
   scaled to leave at least 30 coin at the village.
4. Movement + trade routes identical to merchant caravans: the
   shared planner finds profitable arbitrage (village exports →
   city; city imports → village, depending on price gradient).
   Same 5% profit floor (§C28) + 45-day no-profit disband (§C25).
5. Villager caravans count toward a separate fleet target
   (~0.5 × villageCount) so they don't compete with the standing
   merchant fleet (~0.25 × settlements).
6. Profit remittance: when a villager caravan returns to its
   village home with surplus coin, the same
   `remitStandingCaravanProfitAtHome` logic that handles
   merchants pays the steward — coin accumulates at the village
   for tribute (§C29), wages, or future trips.
7. New `tribute_paid` companion event `villager_caravan_dispatched`
   for telemetry.

**Why the 5% profit floor still works for villages:**

Short-haul village→city routes have low transport cost but smaller
price spreads than long-haul. A village-grain → city-grain spread
of even 3-4% may not clear the gate, but a village-grain →
city-grain via the city's higher subsistence price often does, and
the return-leg arbitrage (city-pottery → village-pottery) also
clears. The planner picks whichever leg is profitable.

**Cross-refs:** `docs/06-caravans.md` §"NPC caravan AI",
`docs/11-politics-and-ownership.md` §"Patron-client villages" +
§"Free villages", `src/sim/tick.ts` `villagerCaravanAssemblyPhase`,
`viewer/art/units/villager_caravan.svg`.

## C32 — Bandit actions through movable parties + missing renderers (landed)

**Motivation:** the viewer rendered caravans and bandit camps but
**not** patrols, news carriers, or any visible "raid in progress."
Patrols + news carriers always existed in the sim and ticked daily —
they just had no map layer. Worse, every bandit action (raid, fence,
recruit, migrate, bribe) resolved instantaneously at the camp's
hex — no physically visible raid party walking from the camp to the
target settlement, no spatial chance for a patrol to intercept en
route, no hard-times "you can see the raiders coming" warning. Per
pillar §1 (no hidden hands) all of this needs to be physical.

**v1.5 — landed:**

1. **Generic mover layer** (`viewer/map/movers.ts`) — a factory that
   takes an art kind + a `getMovers` callback and produces a Pixi
   `Container` with sprites + faction-colour badges + smooth
   inter-tick interpolation. Reused by the three new layers below.
2. **Patrol layer** (`viewer/map/patrols.ts`) — renders
   `world.patrols` with the `patrol` glyph.
3. **News-carrier layer** (`viewer/map/newsCarriers.ts`) — renders
   the in-transit subset of `world.newsCarriers` with the
   `news_carrier` glyph.
4. **BanditParty as a real sim entity** — new `BanditParty` type and
   `world.banditParties` Map. A party is a subset of bandits split
   off from a camp at action time, walking to a target and back
   (one-way for `migrate` missions). Per-camp cap = 1 active party
   at a time (the user's design — keeps the world legible).
5. **Camp actions now spawn parties, not resolve in-place.** The
   `applyCampAction` cases that touch another hex (`raid_settlement`,
   `raid_caravan`, `fence_loot`, `recruit_drive`, `bribe_settlement`,
   `move_camp`) dispatch a `BanditParty` carrying:
   - a mission discriminator (where to walk, what to do on arrival),
   - a roster (mission-dependent share of the camp's bandits — half
     for a raid, ~25% for a fence escort, ~20% for recruit / bribe,
     the entire roster for `migrate`),
   - cargo / treasury pre-loaded for missions that need it (fence
     trip carries loot; bribe trip carries coin).
     `lay_low` and `recruit_drive`'s pressure-multiplier side-effects
     still happen at the camp.
6. **`banditPartyPhase`** — runs each tick (after `banditPhase`,
   before `patrolPhase`). Advances each party up to **25 hex/day**
   (`BANDIT_PARTY_MOVEMENT_HEXES_PER_DAY`) toward its target
   (outbound) or home (returning) — comparable to a mule caravan
   (docs/06) and faster than a refugee on foot (~20 hex/day).
   With a ~1-week round-trip budget that puts plausible mission
   targets up to ~75-100 hex one-way from the home camp. On
   arrival at the mission hex it resolves the mission (reusing
   `executeSettlementRaid` / `resolveAmbush` /
   `executeFenceTransaction` via a temporary synthetic-camp
   adapter so the existing combat maths stays canonical), then
   flips to `returning`. On arrival back at home, merges the
   party's surviving roster + loot + coin back into the home
   camp. If the home camp was destroyed while the party was out
   (e.g. patrol wiped it), the party founds a new camp at its
   current hex.

   **Patrols also move 25 hex/day**
   (`PATROL_MOVEMENT_HEXES_PER_DAY`) so they aren't structurally
   outpaced by the parties they're chasing. `patrolPhase` calls
   `tickPatrol` up to 25 times per day, stopping the loop early on
   the first iteration that produces a pending battle (combat eats
   the rest of the day).

7. **Bandit-party viewer layer** (`viewer/map/banditParties.ts`) —
   renders `world.banditParties` with the existing `bandit_raid`
   glyph so raid parties, fence trips, and migrating camps are all
   visible on the map.
8. **Deterministic party ids**: `bp-<campId>-<today>` (per-camp,
   per-day) so two runs with the same seed produce identical event
   sequences (the smoke test's determinism gate still passes).

9. **Patrol detection + pursuit** (`visibleQuarryForPatrol`,
   `Patrol.pursuit`): each tick a patrol scans for bandit camps +
   parties within `PATROL_SIGHT_HEXES = 2` of its current
   position. If a target is in sight AND the patrol's effective
   combat strength exceeds the target's (likely-to-win check),
   the patrol enters pursuit — deviates from its cyclic route to
   chase the target at `PATROL_PURSUIT_HEXES_PER_DAY = 30` (a
   small speed bonus so equal-speed targets don't perpetually
   escape). Pursuit lasts up to `PATROL_PURSUIT_MAX_DAYS = 3`
   days; if not caught up, the patrol gives up and resumes its
   route.
10. **Party flee behaviour** (`visibleThreatForParty`): each tick
    a bandit party scans for patrols within `PARTY_SIGHT_HEXES = 2`.
    If a likely-to-win patrol is in sight, the party flips to
    `fleeing` phase and walks 25 hex/day away from the threat
    (mission is paused). When the threat clears, the party
    resumes `outbound` or `returning` depending on where it is
    relative to the mission target.
11. **`patrolPartyEngagementPhase`** runs after both movement
    phases. For each patrol, finds the nearest bandit (camp or
    party) within 2 hex and resolves a single battle via
    `resolveBattle`. Casualties apply to both sides; pursuit
    state clears on a patrol win so the patrol resumes its route.
    No bribery (every encounter is fought, per the user's spec).

**Still on the docket** (separate follow-up):

- Road-bias for patrol cyclic route seeding so patrols spend more
  time on roads (where caravans + villager runs are).
- Caravan-escort patrols (a `caravan_escort` patrol kind already
  exists in the type but isn't seeded yet).
- Battle narrative + survivor news for patrol-vs-party fights
  (currently camp engagements emit news; party fights don't yet).

**Burn-in (3-year watchdog, 80×80, 3 cities):**

|                   | pop end | caravans end | famine | settlements end |
| ----------------- | ------- | ------------ | ------ | --------------- |
| pre-§C32          | 151,810 | 50           | 22,176 | 328             |
| §C32 (1 hex/day)  | 156,636 | 81           | 18,323 | 336             |
| §C32 (25 hex/day) | 155,325 | 68           | 20,547 | 333             |
| §C32 final        | 155,325 | 68           | 20,547 | 333             |

Activity counts (1095 days, watchdog seed):

- 99 bandit parties dispatched, 95 returned home, 4 lost
- 22 patrol engagements
- 6 successful settlement raids
- 3 caravan robberies
- 5 active parties + 2 camps + 3 patrols at year 3 (steady-state
  bandit fleet of ~5 visible parties on the map)

(Famine still elevated vs the pre-§C30 baseline because trade
tuning is incomplete — see §C30 + §C31. The bandit refactor is
about _visibility + pillar #1 compliance_; the tuning gain is a
side-effect of more caravans surviving + fewer instant raids.)

**Cross-refs:** `docs/12-bandits-and-conflict.md` §"Bandit raid
parties", `src/sim/bandit/party.ts`, `src/sim/tick.ts`
`banditPartyPhase` + `spawnBanditParty`, `viewer/map/movers.ts`.

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
  drives per-job/per-class labor pools; the tick derives class mix from
  allowed classes and owner command rights so slave-excluded roles
  cannot be staffed by slave adults, and common/merchant actors cannot
  treat another actor's slaves as free labor. The monthly hook
  reallocates ~8% of workers per month across blocked and profitable
  price-signaled roles.
- ✅ C8 — Construction time + labor cost: investments create
  `pendingBuilding` records that consume worker-days before becoming
  productive. Demolition remains [TODO].
- ✅ C9/C12 economics correction — Production now ranks recipes by
  local marginal value, runs a two-pass daily planner so downstream
  high-value goods can claim scarce labor, and keeps per-building
  installed `maxCapacity` instead of resetting starter estates to the
  catalog default. Procgen also seeds rural wine/oil, textile,
  tanning, pottery, tailoring, and prior-vintage market inventories so
  spring day 0 is not an artificial empty-warehouse shock. Labor cost is
  owner-sensitive and paid from the actual class mix consumed by a recipe
  run.
- ✅ C10 — Storage capacity discipline: per-resource cap enforced
  every tick after production; perishable overflow gently spoils after
  the bootstrap grace period instead of being force-sold. Hard goods do
  not spoil.
- ✅ C11 — Roman-road maintenance cost: governor pays
  0.1 coin + 0.01 cut_stone per Roman hex per quarter; missed
  quarters accumulate; after 4 missed quarters the hex demotes
  to dirt with a `road_unmaintained` event.
- ✅ C15 (partial) — Per-(settlement, resource) CSV time-series
  instrument. `--instruments=time-series` writes one CSV per pair;
  `unmetDemandAtClearingPrice` plumbing remains the open piece.
