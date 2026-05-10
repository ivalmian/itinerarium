# 15 — v1.5 cleanups

The v1 implementation made several simplifications to keep the
burn-in stable while the rest of the system was being built. Each
of these is now ready to be replaced with the realistic version.
This doc is the source of truth for the v1.5 effort.

When you complete a cleanup, **delete** its section from this file
and update the cross-referenced doc to reflect the new behavior.
This file should shrink as the work lands; an empty file means
v1.5 is done.

## C4 — Dynamic settlement investment (Stage 2 specialization)

**v1 hack:** all production buildings are seeded once at procgen
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

**v1.5 implementation:**
1. Each season-end (90-day boundary), in `politicsPhase`, for each
   actor with `kind ∈ {patrician_family, free_village,
   city_corporation, governor_office}`:
   a. For each recipe in the catalog, compute expected daily
      profit at last-observed input + output prices.
   b. Pick the most profitable recipe whose building isn't already
      saturated locally.
   c. If treasury ≥ building cost AND expected profit / building
      cost > 0.05/day (~18% APR threshold): invest. Treasury
      decreases by cost; new building added at a free urban or
      catchment hex.
2. Add building cost table to `docs/03-production.md`.
3. Cap investment at 1 building per actor per season to prevent
   runaway feedback.

**Acceptance:** at year 10, settlements show specialization
beyond the procgen seed: cities near mines have more bloomeries;
coastal towns have more fisheries; etc. New buildings logged via
a new `building_invested` TickEvent.

**Cross-refs:** `docs/05-settlements.md` §"Stage 2 — Dynamic
investment", `docs/03-production.md`, `docs/08-money-and-trade.md`
(price observation).

## C5 — Bootstrap stockpile final reduction (deferred to after C4)

**v1 hack:** `GRAIN_DAYS_OF_RESERVE` is now 180 days (down from
the original 365). Wood + tools bootstrap held at v1 levels
(pop*5 wood, pop*20 tools).

**Why this is still a hack:** ideally seed bootstrap = ~30 days of
grain + ~7 days of tools/wood. We can't reduce further yet because
the worker reallocation hook (C6) takes ~8%/yr to migrate workers
into bottlenecked roles, and dynamic settlement investment (C4)
hasn't landed — so cities can't build the additional foresters /
smithies / mills they'd need to keep up with realistic demand.

**Realistic:** seed bootstrap = ~30 days of grain + ~7 days of
tools/wood. Forces production to come online within the first
month. Requires:
- C4 (dynamic investment) so cities self-correct capacity gaps
- Faster C6 reallocation (or a smarter initial allocation at
  procgen) so labor isn't permanently mismatched

**v1.5 implementation:**
1. After C4 lands, drop `GRAIN_DAYS_OF_RESERVE` to 30.
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
`docs/14-debug-strategies.md`. **Depends on C4.**

## C9 — Disaggregate villages + hamlets

**Status (2026-05):** procgen + same-hex movement short-circuits
landed. Local-trade between same-hex settlements (the parallel
agent's scope) and viewer stack-glyphs are still open. Once both
land, this section may be deleted.

**v1 hack (now fixed):** procgen generated ~600–900 "village"
entities representing 2–5 real-world villages each, and ~300–500
"hamlet" entities representing small clusters. Each entity sat
on its own hex with no neighbors of the same type sharing it.

**v1.5 — landed:**
1. ✅ Procgen `siteSettlements`: applies a 3x village + 5x hamlet
   disaggregation factor so caller-requested counts (which were
   "aggregated entities" in v1 units) translate to one entity per
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
5. ✅ Same-hex 0-day movement short-circuit in `tickCaravanMovement`
   and `tickCarrierWithGrid` + `createNewsCarrier`. Lock-in tests
   in `src/sim/caravan/movement.test.ts` and
   `src/sim/reputation/newsMovement.test.ts`.

**v1.5 — still open:**
- Local-trade phase: same-hex settlements should exchange goods
  every tick at zero transport cost (parallel-agent scope). Until
  this lands, satellite hamlets with empty catchments rely on
  bootstrap stockpiles for ~180 days.
- Viewer: same-hex settlements should render as a stack with
  offset glyphs so they're individually clickable.
- Performance: `tickPhase` per-settlement loops are tolerable at
  ~341 entities (60-100 ms/tick) but become hot paths at the full
  500×500 / 3,000-8,000 entity target. A settlements-by-hex index
  is the obvious next step.

**Cross-refs:** `docs/04-population.md` §"Sizing the realistic
hinterland", `docs/01-simulation-frame.md` §"Entity counts",
`docs/05-settlements.md` §"Same-hex coexistence" + §"Catchment",
`docs/07-geography.md` §"Site villages and hamlets",
`src/procgen/settlements.ts`, `src/procgen/seed.ts`,
`src/sim/caravan/movement.ts`, `src/sim/reputation/newsMovement.ts`.

## C8 — Construction time + labor cost

**v1 hack:** the investment loop in `tick.ts` `investmentPhase`
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
2. Each tick, in production phase, the settlement consumes
   `mason` + `carpenter` worker-days from `jobAllocations` toward
   pending buildings (proportional to how many people are
   assigned). When `workerDaysRemaining ≤ 0`, the building is
   added via `addBuilding` and the pending record is removed.
3. While pending, the building doesn't produce.
4. Demolition is symmetric: removes the building over ~10-20% of
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
non-deterministic in a "v1 was easier" sense. They should all be
deleted once the corresponding v1.5 task lands.

- `src/burnin/invariants.ts` line 244: "Growing from zero:
  bootstrap can seed people" — once full C5 lands, the bootstrap
  is small enough that this isn't a special case.

(Comments about the v1 charcoal/iron/timber hacks have already
been removed by the C2 work.)

## Order of operations

C4 (dynamic investment) is the load-bearing remaining task. Once
buildings can be built mid-burn-in:
- C5 final reduction becomes feasible (no more bootstrap stockpile
  papering over capacity gaps).
- C7 cleanup naturally follows.

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
- ✅ C5 (partial) — Grain reserve halved (365 → 180 days). Full
  reduction deferred per above.
- ✅ C6 — Worker reallocation by demand: `Settlement.jobAllocations`
  drives `laborAvailableInSettlement`; monthly hook reallocates
  ~0.66% of workers per month based on `recipe_blocked` events.
