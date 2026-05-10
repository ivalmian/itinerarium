# 15 — v1.5 cleanups

The v1 implementation made several simplifications to keep the
burn-in stable while the rest of the system was being built. Each
of these is now ready to be replaced with the realistic version.
This doc is the source of truth for the v1.5 effort.

When you complete a cleanup, **delete** its section from this file
and update the cross-referenced doc to reflect the new behavior.
This file should shrink as the work lands; an empty file means
v1.5 is done.

## C1 — Pasture / livestock model

**v1 hack:** `shear_wool` and `milk_dairy` consume `livestock.sheep`
/ `livestock.cattle` from the herd stockpile (0.01 + 0.005 units per
recipe-instance). This treats every shearing or milking as a
slaughter event, which inflates pasture demand by ~50× in the
steady-state analyzer.

**Why it was a hack:** the recipe model only supports `inputs`
(consumed) and `outputs` (produced). There's no notion of a
"present-but-not-consumed" input. So we faked herd presence by
treating shearing as consumption, then let `raise_sheep` /
`raise_cattle` regenerate the stock at the same rate.

**Realistic:** shearing + milking are *flow* extractions. The
herd is a standing stock that grows naturally and produces wool /
milk per herd-unit per day. Slaughter is the only herd-consuming
recipe.

**v1.5 implementation:**
1. Introduce a `requires` field on `RecipeDef` (alongside `inputs`
   and `outputs`): `ReadonlyMap<ResourceId, Quantity>`. The recipe
   needs `requires[r]` of resource `r` *available* in the owner's
   stockpile but does not consume it.
2. Update `runRecipe` (production engine) to check `requires` against
   stockpiles for fraction calculation, but skip the deduction step
   for those resources.
3. Move `livestock.sheep` from `inputs` to `requires` on `shear_wool`
   and `milk_dairy`. Same for any other "stock-as-witness" pattern
   (none right now, but worth the hook).
4. Update the steady-state analyzer to ignore `requires` when
   back-chaining demand.

**Acceptance:** the analyzer for pop=700k drops pasture-required
capacity from ~52,000 to a realistic ~2,000–5,000 (one pasture per
settlement is then over-capacity, not 15× under).

**Cross-refs:** `docs/02-resources.md`, `docs/03-production.md`
("livestock are stocks, not flows"), `src/sim/production/engine.ts`,
`src/sim/production/recipes.ts`.

## C2 — Realistic recipe ratios

**v1 hacks:**

| Recipe | v1 (hack) | Realistic | Notes |
|---|---|---|---|
| `smelt_iron` | 6 ore + 10 charcoal → 2 iron | 60 ore + 100 charcoal → 15 iron | docs/03 worked example. Bloomery is genuinely charcoal-heavy. |
| `harvest_grain` tools wear | 0.001/recipe | ~0.005-0.01/recipe | Roman sickle replaced ~1/yr per farmer; per recipe-day = ~0.003. |
| `fell_timber` output | 10/recipe | 1.5/recipe | A foresterperson cuts ~1.5 cords/day historically. v1 inflated to keep wood chain ahead of bake_bread + smithy. |
| `bake_bread` wood | 0.5/recipe | 5/recipe | A baker burns ~5 kg of wood per day baking. v1 reduced. |

**Why they were hacks:** small early-game settlements with thin
trade networks couldn't sustain the realistic ratios; settlements
either ran out of charcoal/wood/tools or their populations starved.
The hacks bought breathing room while bandit/news/patrol/trade
machinery was being wired.

**Realistic:** restore the docs/03 numbers. Trade now circulates
goods between specialized settlements (caravans re-route after
arrival per docs/06), so wood-rich forester villages can supply
charcoal-hungry mining cities.

**v1.5 implementation:**
1. Restore each recipe's realistic numbers in
   `src/sim/production/recipes.ts`.
2. Update the recipe tests that assert specific values.
3. Run the steady-state analyzer to confirm no new bottlenecks
   emerge.
4. Run the 10-year burn-in. If it fails, the issue is *upstream*:
   not enough forester_camp / charcoal_kiln / mine capacity, OR
   trade isn't circulating fast enough.

**Acceptance:** burn-in passes without bootstrap stockpiles
(see C5). Steady-state analyzer shows positive surplus on the
heavy industry chain (smithy/bloomery/forge_tools).

**Cross-refs:** `docs/03-production.md`, `src/sim/production/recipes.ts`,
`src/sim/production/recipes.test.ts`.

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

## C5 — Replace bootstrap stockpiles with real production

**v1 hack:** every city corporation seeds with a year of grain
+ ample wood + 500–2000 tools + 20+ amphorae. Hamlets / villages
get smaller bootstrap stocks. Without these, the burn-in's first
few months would famine before production reached steady state.

**Why it was a hack:** procgen has no concept of "the world has
been running for years" — settlements bootstrap with day-1
populations that haven't yet produced anything.

**Realistic:** seed bootstrap = ~30 days of grain + ~7 days of
tools/wood. This forces production to come online within the
first month. Requires:
- Enough farms / mills / bakeries at procgen
- Working trade so a settlement that runs short can buy from
  a neighbor

**v1.5 implementation:**
1. Reduce `GRAIN_DAYS_OF_RESERVE` and similar constants in
   `src/procgen/seed.ts` from 365 → 30.
2. Drop `pop * 5` wood seed → `pop * 0.5`.
3. Drop `pop * 20` tools seed → `pop * 1`.
4. Run burn-in. If first-year cohort_deaths spikes, the issue
   is upstream production capacity.

**Acceptance:** burn-in passes the 10-year watchdog with the
realistic recipe ratios (C2) AND the reduced bootstrap.

**Cross-refs:** `docs/05-settlements.md` §"Hardening",
`src/procgen/seed.ts` `seedCityCorporation`,
`docs/14-debug-strategies.md`.

## C7 — Removing bootstrap-only safeguards

These are tiny code branches whose presence makes the early world
non-deterministic in a "v1 was easier" sense. They should all be
deleted once the corresponding v1.5 task lands.

- `src/sim/production/recipes.ts` line 64-66: comment about the
  `harvest_grain` tools wear hack — delete after C2.
- `src/sim/production/recipes.ts` line 174-176: comment about
  `fell_timber` output bump — delete after C2.
- `src/burnin/invariants.ts` line 244: "Growing from zero:
  bootstrap can seed people" — once C5 lands, the bootstrap is
  small enough that this isn't a special case.

## Order of operations

C1 (pasture) and C2 (recipes) are independent of everything else
and can land in either order. They're the smallest changes.

C5 (bootstrap stockpiles) depends on C2: realistic ratios need to
be in place before reducing bootstrap, or the world starves
before production catches up.

C4 (dynamic investment) is larger and most realistic alongside C6
(worker reallocation, already landed): the investment loop creates
new buildings, the reallocation loop staffs them.

C7 is documentation cleanup, after each prior task lands.
