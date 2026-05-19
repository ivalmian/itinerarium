# v1.9 handoff: village-collapse market failure

**Status**: resolved in follow-up investigation on
`realism/v1-9-investigation`. The original notes below are kept for
context; see "Follow-up resolution notes" for the surviving diagnosis
and validation runs.

## Follow-up resolution notes

The failure was not a pure world-level tool shortage. `forge_tools`
was producing plenty of total tools, but rural production owners were
not retaining usable local tool stock.

Surviving root causes:

- `free_village` / `hamlet_household` actors treated `goods.tools` as
  ordinary sellable surplus. The market schedule had a community food
  reserve, but no production-tool reserve, so rural actors could sell
  the starter tools needed to keep farms running.
- Even after preserving rural tools from market sale, hamlets burned
  most of their stock on light production before harvest. In the 3y
  diagnostic run, hamlets spent roughly 909 tools on `fell_timber`,
  410 on `saw_lumber`, and 226 on `fish_lake`, while crop harvest
  itself consumed only about 31 tools after the first wear adjustment.
  Those recipes were priced as fractions of an 8 kg `goods.tools` kit,
  but their wear constants were still too high for light hand-tool
  depreciation.
- Villager caravans also had a whole-unit import issue: a village
  could afford city tools at the origin ask, but its home-market bid
  depth was often fractional because the stale local bid price was
  enormous. The planner capped cargo below one whole tool kit, and
  whole-unit trade rounded that to zero.

Fix set that survived burn-in:

- Add a rural production-tool reserve in
  `src/sim/market/scheduleBuilder.ts` so `free_village` and
  `hamlet_household` actors do not list their core `goods.tools`
  reserve as sellable market supply.
- Retune light tool wear in `src/sim/production/recipes.ts` to match
  `goods.tools` as an 8 kg kit:
  - crop/light agriculture: `0.001`
  - fishing: `0.001`
  - forestry/sawmill: `0.002`
  - mining/quarry remain heavier at `0.02`
- Remove the global rural caravan target/slot model. Villager caravans
  now dispatch from local demand and local viability: sellable surplus,
  home-learned import shortage, or hard-times resupply, subject to
  per-owner cap, animals, provisions, operating cash, known prices, and
  route economics.
- Let villager caravans unload imports into their owner stockpile at
  home, and add a planned tool-import path. The tool shortage is recorded
  before departure; the caravan does not remotely re-check the home
  stockpile while away.
- Add city criers as a physical price-news channel. Each city with
  patrician funding gets one persistent crier who walks a greedy
  nearest-neighbor circuit through tied villages/hamlets, records and
  merges `knownPrices` at each stop, checks back into the city to
  restock, and is replaced if missing for over 30 days.

Validation runs:

| Run | Pop | Settlements | Famine deaths | `harvest_grain` runs | `harvest_grain` missing-input blocks | Violations |
|---|---:|---:|---:|---:|---:|---:|
| 3y current baseline (`burnin-v19-current-3y`) | 141,544 -> 142,663 | 220 -> 220 | 1,635 | 21,542 | 179,675 | 0/0/0 |
| 3y final fix (`burnin-v19-rural-toolwear-reserve-3y`) | 141,544 -> 143,037 | 220 -> 220 | 1,312 | 80,589 | 125,044 | 0/0/0 |
| 10y final fix (`burnin-v19-rural-toolwear-reserve-10y`) | 141,544 -> 149,492 | 220 -> 215 | 2,576 | 151,412 | not logged | 0/0/0 |
| 3y demand-backed caravans (`burnin-v19-demand-caravans-3y`) | 141,544 -> 142,646 | 220 -> 220 | 1,716 | not logged | not logged | 0/0/0 |
| 1y city-crier smoke (`burnin-v19-city-crier-1y`) | 116,626 -> 117,333 | 220 -> 220 | 12 | not logged | not logged | 0/0/0 |

The 10y fixed run materially beats both original comparison points in
this handoff: v1.9 old was 141,544 -> 125,947 with 25,351 famine
deaths, and v1.8 main was 141,544 -> 134,765 with 16,236 famine
deaths.

Verification:

```bash
npx vitest run
# 92 files passed; 1,464 tests passed; 3 skipped

npx tsc --noEmit
# clean
```

## TL;DR

In v1.9 (PR #17) we removed 5 procgen `off_map_house` "merchant
house" actors that were hoarding 12.4M coin over 10y. The removal
closed the coin leak but **broke village agriculture**: village
population collapses 50% over 10y on a seed where v1.8 only loses
37%. The proximate cause is `harvest_grain` blocking on
`missing_input: goods.tools` 5× more than it runs.

This is a **market failure**: the resources exist, the demand
exists, the producers exist, but the village-merchant-tool
distribution chain doesn't carry the goods. We believe the v1.8
"merchant_house" caravans were doing important commercial work
beyond just hoarding coin — they were the de facto distribution
channel for tools to villages.

## Repro

```bash
# v1.8 main (same seed):
git checkout main
rm -rf burnin-test && mkdir burnin-test
npx tsx src/cli/burnin.ts --seed=v19-final --years=10 \
  --cities=4 --towns=6 --villages=20 --hamlets=30 \
  --out=burnin-test --instruments=recipe-economics --silent
# → pop 141,544 → 134,765 (-4.8%), famine 16,236

# v1.9 branch:
git checkout realism/v1-9-investigation
rm -rf burnin-test && mkdir burnin-test
npx tsx src/cli/burnin.ts --seed=v19-final --years=10 \
  --cities=4 --towns=6 --villages=20 --hamlets=30 \
  --out=burnin-test --instruments=recipe-economics --silent
# → pop 141,544 → 125,947 (-11.0%), famine 25,351
```

Both branches same RNG seed and procgen — only the v1.9 code
changes differ.

## The chain

Side-by-side comparison from the burn-ins:

| Metric | main (v1.8) | v1.9 | Δ |
|---|---:|---:|---:|
| Pop loss | -4.8% | -11.0% | -6.2pp |
| Village pop loss | -37% | -50% | -13pp |
| city_corp recipe runs | 546,078 | 332,570 | **-39%** |
| city_corp wages paid | 726M | 515M | -210M |
| harvest_grain runs | 86,217 | **45,832** | -47% |
| off_map_house actors | 13 (5 procgen + 8 edge) | 8 (edge only) | -5 |

In v1.9 after a 2-year burn-in:
- `harvest_grain` blocked on `missing_input` (tools): **117,664 times**
- `harvest_grain` blocked on `cash` (owner can't pay wages): 27,630
- `harvest_grain` blocked on `no_labor`: 20,719
- `harvest_grain` actually ran: 21,685

**Recipe blocks on missing tools 5× more than it runs.**

## Direct cause

Villages need `goods.tools` to run `harvest_grain`. At the time of the
handoff this was modeled at `LIGHT_TOOL_WEAR = 0.005` units per
farmer-day; the follow-up fix retuned crop wear to `0.001` because a
`goods.tools` unit is an ~8 kg mixed kit, not one sickle. Villages
couldn't keep enough tools under the old wear + reserve rules.

Tool acquisition fails because:
- **Price**: tools clear at 5,000 coin/unit (high)
- **Village treasuries**: 60 villages, mean treasury 950 coin,
  35/60 villages have ZERO treasury at Y1
- **Even with money**: a village would need to ship ~2,500 modii of
  grain (at 2 coin floor price) to buy ONE tool

The cost ratio between rural staples (grain @ 2 coin/modius) and
manufactured goods (tools @ 5000 coin) is **~600× off-historical**.
Roman ratio: ~4 modii of grain per sickle (1 denarius / 0.25
denarius per modius).

## Root cause hypothesis: market failure

Both v1.8 and v1.9 have the SAME prices, same recipes, same costs.
But v1.8 worked because **merchant_house caravans physically
distributed tools to villages** as a side effect of their commercial
routes. Take them out, the tool flow stops.

The system has the right SUPPLY and DEMAND but no DISTRIBUTION
CHANNEL for tools → villages.

## Architectural mechanisms (relevant code)

### Production gate

`src/sim/phases/production.ts:735` `productionOutputInventoryCapacityForRecipe`:

```
target = installedCap × qtyPerRun × productionOutputStockTargetDays(resource)
gap = target - currentStock
// production runs only if gap > 0
```

For grain at a village farm: `200 × 80 × 180 = 2.88M modii target`.
Far above any village's actual stockpile. So the production gate
isn't the binding constraint at the village.

### The real harvest_grain blockers

`src/sim/phases/production.ts:152` `wageAffordableCapacityForRecipe`
returns 0 (block `cash`) when owner can't pay wages.

The "missing input" block fires inside `planRecipeRun` when the
required `goods.tools` aren't in owner's stockpile at the settlement.

### Caravan dispatch

`src/sim/phases/caravan.ts:1136` `assembleMerchantCaravans`:
- Dispatches every `MERCHANT_CARAVAN_ASSEMBLY_INTERVAL_DAYS = 7`
- Max `MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL = 2` per dispatch
- Per-owner cap `MERCHANT_CARAVAN_OWNER_CAP = 3`
- Province-wide target `0.25 × settlement_count` (55 for 220 settlements)
- Eligible owners: `patrician_family`, `caravan_owner` (currently never seeded), `governor_office`

After v1.9 removed merchant_house:
- Eligible-owner slots = 16 patricians × 3 + 1 governor × 3 = **51**
- v1.8 had `+ 5 merchant_house × 3 = 66` total slots
- Province target = 55 → v1.9 chronically under target

### Villager caravans (peasant-driven trade)

`src/sim/phases/caravan.ts:1242-1390` `assembleVillagerCaravans`:
- `free_village` steward dispatches handcart caravans
- Threshold: treasury > `VILLAGER_CARAVAN_MIN_OPERATING_TREASURY = 30`
- 35/60 villages have 0 coin → can't dispatch
- Even with the 30-coin gate lowered to 10, doesn't help because
  villages literally have 0 in many cases

## Things we tried (all failed or made worse)

### 1. Satiation-aware demand cap (Step 4, reverted)

Cap subsistence/comfort/status demand at `(own + communal pool) /
consumption_rate >= target_days → 0 bid`. Idea: prevent grain over-
stockpiling.

**Result**: famine spiked from 770 baseline to 13-39k across
variants. The bid IS the consumption mechanism — suppressing the
bid suppresses the consumption draw via the fallback ration path.
Reverted entirely. Documented as DEFERRED in docs/10 §47.

### 2. Tighter production stock target (with satiation)

`target = settlement_pop × per_capita × 365 × NETWORK_MULTIPLIER`,
floored by `installed_cap × qtyPerRun × MIN_PRODUCTION_BUFFER_DAYS`.
Tried multipliers 5×, 1.5×.

**Result**: cuts production too aggressively. Villages over-supplied
broke other things; villages under-supplied starved faster.
Reverted.

### 3. Remove caravan per-owner cap (uncap test)

Removed `MERCHANT_CARAVAN_OWNER_CAP` check + province target, bumped
`MERCHANT_CARAVAN_MAX_DISPATCHED_PER_INTERVAL` from 2 → 20.

**Result**: caravan count went DOWN slightly (28 vs 29 baseline at
Y9). The cap wasn't binding. Real bottleneck is upstream in
assembly — `createReplacementMerchantCaravan` returns null when
animals/carts/rations can't be assembled at origin settlement.
Reverted.

### 4. Add city_corporation to merchant eligibility

Added `city_corporation` to standing-merchant eligibility list +
lowered villager treasury threshold to 10.

**Result**: city_corp recipes flat (didn't increase activity), famine
worse (34k). City_corps dispatching merchants from THEIR own city
extracts goods OUT — doesn't bring new buyers IN. Reverted.

## What we believe but haven't proven

1. **The merchant_house caravans were the de-facto tool distributor
   to villages.** Their dispatch from cities → village arbitrage routes
   physically carried tools (and other inputs) as cargo. Removing them
   broke that channel.

2. **Iron mining is 3-5× too low** historically. `mine_iron` outputs
   4 modii/miner-day; Roman miners with productive deposits produced
   7.5-15 modii/day equivalent.

3. **smelt_iron has a kg/modius confusion**. Recipe comment says
   "60 kg ore → 15 kg bloom iron" but the code uses 60 = 60 modii
   (402 kg) and outputs 15 = 15 modii (100 kg). Output is 7× too
   high if the comment intent (15 kg = 2.2 modii) is correct.

4. **Recipe run frequency is too low** across the board. Each
   smithy fires forge_tools ~10×/year (~once a month). Real Roman
   smiths worked daily. The recipe is "lumpy" — batches 15 tools
   per run instead of producing 2-3 daily.

5. **No "merchant emergence" mechanism** to spawn new merchants
   when routes are profitable but existing owners are saturated.

## Hypotheses for what's actually wrong (ranked)

### A. Tool distribution channel collapse (most likely)

Tools are produced in cities, needed in villages. The v1.8 merchant
caravan fleet was the channel. v1.9 removed the channel without
replacement.

**Fix candidates**:
- Restore the merchant_house actors as `caravan_owner` kind WITH consumer
  demand (so coin recycles, no hoard)
- Make `villager_caravan` two-way: villager dispatches to city,
  RETURNS with tools
- Direct procgen seeding of more tools at villages annually

### B. Iron/tool pricing structurally too high

Tools at 5000 coin/unit when grain is 2 coin/modius creates an
exchange-rate impossibility. Roman ratio was 4:1, ours is 2500:1.

**Fix candidates**:
- Bump `mine_iron` output 3-5× (historical productivity)
- Fix the `smelt_iron` kg/modius confusion → output 15 KG not 15 modii
- Lower `forge_tools` iron input (less iron per tool)
- Make `harvest_grain` not need tools at all (treat as building requirement)

### C. Recipe frequency bottleneck (related to B)

Recipes batch too much output per run. forge_tools makes 15 tools
in one giant run instead of 2-3 tools across many runs. This
creates capital-threshold barriers (need 12k coin of iron just to
fire a smith).

**Fix candidates**:
- Smaller, more frequent recipes (1 tool/smith/day, not 15/day)
- Or: split the "smelt + forge" chain so smithy doesn't need iron
  on-hand to start

### D. No "merchant emerges" mechanism

When existing owners are at cap and routes are profitable, no new
merchants spawn. The merchant population is fixed at procgen.

**Fix candidates**:
- Spawn new `caravan_owner` actors when freedman/plebeian household
  has treasury > N AND a known profitable route exists nearby
- Make the merchant population endogenous to economic conditions

## Key files

- `src/sim/phases/production.ts:735` — `productionOutputInventoryCapacityForRecipe`
- `src/sim/phases/production.ts:152` — `wageAffordableCapacityForRecipe`
- `src/sim/phases/caravan.ts:1136` — `assembleMerchantCaravans`
- `src/sim/phases/caravan.ts:1242` — `assembleVillagerCaravans`
- `src/sim/phases/caravan.ts:974` — `eligibleMerchantCaravanOwners`
- `src/sim/production/recipes.ts:84` — `harvest_grain` (`LIGHT_TOOL_WEAR` at line 62)
- `src/sim/production/recipes.ts:258` — `mine_iron`
- `src/sim/production/recipes.ts:482` — `smelt_iron`
- `src/sim/production/recipes.ts:581` — `forge_tools`
- `src/sim/market/scheduleBuilder.ts:1062` — `communitySubsistenceReserve`
- `src/sim/phases/consumption.ts:150` — `buyFallbackRationsFromOwner`
- `src/procgen/seedCaravans.ts:74` — warm-start fleet (post-v1.9: only
  family + governor owners, no merchant_house)
- `src/procgen/seed.ts:749` — `seedFreeVillage` (initial grain reserve =
  14 days; initial tools = 10 units per pop, see `STARTER_TOOLS_PER_CAPITA`)

## Diagnostic commands

```bash
# Run a 2y burn-in with full event logging (warning: 1.3GB events.jsonl)
mkdir burnin-diag
npx tsx src/cli/burnin.ts --seed=v19-final --years=2 \
  --cities=4 --towns=6 --villages=20 --hamlets=30 \
  --out=burnin-diag --instruments=events,recipe-economics --silent

# Why is harvest_grain blocking?
jq -r 'select(.type == "recipe_blocked" and (.recipe | tostring) == "harvest_grain") | .reason' \
  burnin-diag/events.jsonl | sort | uniq -c

# Village treasury distribution Y1
jq '[.world.actors[] | .[1] | select(.kind == "free_village") | .treasury]
    | {min: min, max: max, mean: (add/length), zero_count: ([.[] | select(. == 0)] | length)}' \
  burnin-diag/snap-day-000365.json

# Tool distribution by actor kind
jq '[.world.actors[] | .[1] |
     {kind, tools: (([.stockpile[] | .[1][] | select(.[0] == "goods.tools") | .[1]] | first) // 0)}]
    | group_by(.kind)
    | map({kind: .[0].kind, count: length, total_tools: (map(.tools) | add // 0)})' \
  burnin-diag/snap-day-000365.json

# Median tool price across settlements
jq '[.world.settlements[] | .[1].market.lastClearingPrice[]
     | select(.[0] == "goods.tools") | .[1]]
    | {count: length, median: (sort | .[length / 2 | floor]), min: min, max: max}' \
  burnin-diag/snap-day-000365.json

# Recipe runs by owner kind (10y)
awk -F',' 'NR>1 {w[$5]+=$11; r[$5]+=$6} END {for(k in w) printf "%-25s runs=%-10d wages=%.0f\n", k, r[k], w[k]}' \
  burnin-diag/recipe-economics.csv | sort -k4 -rn

# Per-village population time series across snapshots
for d in burnin-diag/snap-day-*.json; do
  echo "$d"
  jq '[.world.settlements[] | .[1] | select(.tier == "village")]
      | {count: length, total_pop: ([.[] | .population[] | .[1]] | add)}' "$d"
done
```

## Locked design constraints (don't break)

These were established earlier and should not be reverted by any fix:

1. **No off-map merchants with permanent on-map homes** (docs/10 §45) —
   the off_map_house kind is per-edge-gate synthetic only.
2. **Off-map caravan profit deletes on edge-return** (docs/10 §45) —
   coin returning off-map physically leaves the province.
3. **Mint only in the capital** (docs/10 §46).
4. **Integer-coin prices, floor at 1** (docs/08) — clearing prices
   are integers ≥ 1.
5. **Per-actor knownPrices, no global oracle** (docs/06 + docs/10 §38).

## What I'd try next (best guess, untested)

1. **Restore the merchant_house concept as `caravan_owner`** with these
   differences from v1.8:
   - Add `caravan_owner` to `CONSUMER_BUYER_KIND_PRIORITY` for at least
     comfort + status (so coin recycles instead of hoarding)
   - 5 actors per province (matching v1.8 count), seeded per city
   - Procgen treasury 5,000-25,000 coin (same as v1.8)
   - All other mechanics same as patrician_family standing-merchant

2. **OR fix iron mining productivity** as a separate change:
   - `mine_iron` output 4 → 15 modii/miner-day
   - `smelt_iron` output 15 → 3 modii (matches comment's kg-intent)
   - Net should drop tool prices ~3× without affecting other systems

Either is more likely to help than the things we tried this session.

Both are mutually compatible.

## Why the previous session got stuck

The pattern was: try fix X → cascading regression → revert → try fix Y →
cascading regression → revert. Each "obvious" fix touched a system
that was load-bearing in a non-obvious way:

- Suppressing demand suppressed consumption (because consumption is
  routed through market clearing, not a separate path)
- Tightening production target idled labor that other recipes depended on
- Removing caravan caps just produced more failed assemblies
- Adding city_corp merchants extracted goods FROM cities (didn't bring
  buyers IN)

The honest read: the simulation has tightly-coupled feedback loops
that need careful analysis BEFORE intervention. The first principles
"if cities starve they bid high → supply flows" doesn't apply when
the failure mode is "cities have enough so they don't bid, but
villages can't get tools because the channel collapsed."
