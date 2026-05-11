# 05 — Settlements

A settlement is the primary economic unit of the world. Caravans
connect them; the work happens inside them.

## What a settlement is

A settlement = a name + an **anchor hex** + the **set of urban hexes
it physically occupies** + a population pool (full demographic
pyramid — see [04 — Population](04-population.md)) + a stockpile of
all resources held by named owners + a list of buildings (each
located in a specific hex, owned by a named owner) + a **catchment**
of worked hexes (each owned by a specific actor) + a market state.

It is not a separate entity from its workers — see
[01 — Simulation Frame](01-simulation-frame.md). The "settlement"
is just a convenient grouping of the people who live and work
together.

## Physical extent (1 km hexes)

Settlements take real area on the map. A single icon on a hex is no
longer correct.

| Tier | Population | Built-up area | Daily catchment radius | Catchment hexes |
|---|---|---|---|---|
| Hamlet | 30–150 | sub-hex (multiple per hex) | ~1 km | 1–3 |
| Village | 150–800 | 1 hex | ~2 km | 3–10 |
| Town | 1k–5k | 1–2 hexes | ~3 km | 10–30 |
| Small city | 5k–15k | 2–3 hexes | ~5 km | 30–80 |
| Large city | 15k–50k | 3–10 urban hexes | ~5 km direct + tenant-village dependency further out | many, indirect |

Sanity check against history: Pompeii ~0.6 km², Ostia ~0.8 km², Rome
inside the Servian wall ~14 km². Even big Roman cities are a
single-digit count of 1 km² hexes. Cities are dense, not sprawling.

For multi-hex settlements, one hex is the **anchor** (where the
forum/market/governor's house sits); other urban hexes are
neighborhoods (residential, craft quarters, warehouses). All of
them share one population pool and one market, but specific
buildings live in specific hexes.

### Same-hex coexistence (locked)

A single hex can host more than one settlement entity. The
canonical case is a Roman *pagus* with its dependent hamlets:
one larger village plus 1–4 satellite hamlets all clustered on
or around a fertile patch. Per docs/04 §"Sizing the realistic
hinterland" we never aggregate — the village and each hamlet
are distinct entities with their own population, ledgers, and
political leadership.

Same-hex settlements:
- Each appears as its own glyph in the viewer (offset slightly
  so all are individually clickable).
- Travel between them is **0 hexes / 0 ticks** — caravans, news
  carriers, and refugees that arrive at the hex reach all of
  them immediately in the same pass. There is no "trivial caravan"
  walking from A to B in the same hex.
- Each may claim its own catchment hexes per the closer-wins
  rule below; on a shared hex the larger settlement gets first
  pick of the surrounding ring, satellites get the leftovers.

## Multi-hex entry UX (locked)

A settlement is **one entity**, even if it occupies many hexes.
Entering *any* hex that belongs to the settlement triggers the
settlement screen — the player doesn't have to find the "right" hex.

"Belongs to the settlement" means:

- Any of its urban hexes (the built-up area).
- Optionally (UX choice — to be tuned), any of its catchment hexes
  that are flagged as "settlement gates" (e.g. a manned watchtower
  at a road approach).

A single settlement screen shows: population pyramid, stockpile by
owner, buildings, market state, recent caravan history, current
production. The player doesn't have to click each hex separately.

## Catchment

A catchment hex is one a worker can walk to in the morning, work in,
and walk back from the same day. With ~5 km/h walking and an
8-hour working day, the practical limit is **~2 km for villages,
~5 km for cities** (city dwellers tolerate longer commutes for
prestige work or because the city has crowded labor markets).

Land beyond the daily-walking catchment is still owned by city
families but worked by **patron-client villages** — themselves
settlements with their own catchments. This is exactly what the
historical Roman countryside looked like (see
[11 — Politics & Ownership](11-politics-and-ownership.md)).

A worker can only contribute to a recipe if (a) the building is in
their settlement, (b) the inputs are available, and (c) any source
hex (a field, a pasture, a quarry, a forest patch) is in their
settlement's catchment AND owned by an actor that's hiring this
settlement's labor.

Self-sufficiency rules of thumb:

- Hamlets and villages mostly feed themselves from catchment.
- Towns are partially self-sufficient; need imports for fuel, salt,
  some metal.
- Cities are **not** self-sufficient. They depend on supplying
  villages and on long-haul trade for grain, fuel, materials. Cut
  the supply lines and a city dies — exactly the consequence the
  player can engineer or suffer.

### Dynamic catchment recompute (locked)

Catchment is **not** static. A settlement that grows from 500 → 5,000
people farms more land; a settlement that shrinks 5,000 → 500
abandons fields back to wilderness. The procgen-assigned catchment
is just the day-0 baseline.

Per-settlement, every annual phase:

1. Compare `current_pop` to `catchmentBaselinePop` (the population at
   which the catchment was last sized).
2. If `|current_pop − baselinePop| / baselinePop > 0.25` AND
   `today − catchmentDayLastChanged > 365`: trigger a recompute.
3. New catchment radius:
   `r' = catchmentRadiusFor(tier) × sqrt(current_pop / typicalPopForTier(tier))`
   (radius scales with √pop — area is what scales linearly with people).
4. Released hexes (in old catchment, not in new): clear ownership
   (`setOwner(grid, hex, null)`); buildings on those hexes are
   abandoned (their owner stockpiles are NOT drained — the buildings
   still belong to their owner but no longer produce).
5. Claimed hexes (in new catchment, not in old): only if no
   neighboring settlement already owns them. Contested hexes go to
   the more populous settlement; ties broken by deterministic
   settlement-id sort.
6. Update `catchmentBaselinePop = current_pop` and
   `catchmentDayLastChanged = today`.

The 365-day cooldown prevents thrashing during rapid population
swings (epidemic year + bounce-back).

This is what makes a city visibly **swell** in the burn-in viewer
when its trade arms grow, and **shrink** when a plague strikes.

## Ownership of catchment hexes (locked)

Every catchment hex (every field, pasture, forest patch, mine
deposit, quarry) is **owned by a specific actor**:

- A hamlet's fields are typically owned by the hamlet collectively
  (free village) or by the patron family in a nearby city
  (patron-client village).
- A village's grain fields, vineyard, and woodlot are similarly
  owned per the village's status.
- A mining region's deposit hexes are owned by whichever actor
  holds the mining rights — usually a patrician family, sometimes
  the city, the governor, or an off-map merchant house.
- A managed forest near a settlement may be communal (city-owned),
  private (family-owned), or governor-owned (imperial estate).
- **Wilderness hexes are typically unowned.** First-come extraction
  works for unowned features; if a settlement extends its catchment
  to include the hex and starts working it consistently, it
  effectively claims it (formal recognition by the governor may
  follow — or may not).

Ownership is the load-bearing connection between geography and the
political layer. See [11 — Politics & Ownership](11-politics-and-ownership.md)
for who can own what, how transfers happen, and what the player can
do (mostly: trade with owners, not become one in the current scope).

When a recipe runs at a catchment hex, output goes to the **hex
owner's stockpile**, not to a generic settlement pool. The owner
then decides whether to sell into the local market.

## Growth and decay

- Population grows when food is abundant, peace holds, immigration
  arrives, disease is in remission.
- Population shrinks when food fails, plague hits, war kills, or
  people migrate out.
- A settlement can die. **Locked rule:** when a settlement's
  population reaches 0, the settlement entity is removed
  immediately (next daily tick), all of its buildings vanish with
  it, all of its catchment hexes have their `ownerActor` cleared
  (returning to wilderness), all of its urban hexes have their
  `ownerActor` cleared and their terrain converted to `ruin`
  (the abandoned town is now physically a ruin, potentially
  re-discoverable later as a hidden feature — see
  [07 — Geography](07-geography.md)). Stockpile actors (patrician
  families, city corporations) survive on `world.actors` with
  whatever goods they had; only their settlement-side accounting
  goes away. Emits `settlement_abandoned`.
- A settlement can grow into new hexes — a town that bursts past
  its built-up area annexes adjacent rural hexes as new urban
  hexes; its catchment expands.

Growth and decay are emergent from the rules in
[04 — Population](04-population.md). There is no "settlement size up"
event — it just has more people now than last turn.

## Building catalog (current)

**Production:** `farm`, `pasture`, `vineyard`, `olive_grove`,
`orchard`, `fishery`, `mine`, `quarry`, `forester_camp`, `mill`,
`bakery`, `oil_press`, `winery`, `dairy`, `tannery`, `charcoal_kiln`,
`sawmill`, `kiln`, `pottery`, `bloomery`, `smithy`,
`weaver_workshop`, `tailor_shop`, `cart_wright`, `mint`.

**Storage & civic:** `granary`, `warehouse`, `cistern`,
`aqueduct_segment`, `temple`, `forum_market`, `walls`, `barracks`,
`road_segment`.

(No `shipyard` in the current scope — sea trade deferred.)

Each building has:

- A specific hex (within an urban hex for workshops, within a
  catchment hex for farms/mines/etc).
- A capacity (how many recipe-instances it can host per day).
- A maintenance cost in labor + materials (decay if unmaintained).
- A construction cost (one-shot, recipe in
  [03 — Production](03-production.md)).
- An **owner** — see [11 — Politics & Ownership](11-politics-and-ownership.md).

Recipes need **both the building AND a specialist worker** with the
right job role (see [03 — Production](03-production.md)). A bakery
without a baker bakes no bread.

## Specialization (locked, market-driven)

Settlements are NOT uniformly self-sufficient. They specialize because
**the market makes it profitable**: where inputs are cheap and the
output sells at a wide enough margin somewhere reachable, an actor
invests in a workshop and starts producing. Where margins are thin,
the workshop never gets built, or shuts down later.

This is the load-bearing realism: a city in farmland becomes a
grain-trade hub because grain inputs flow from villages cheaply and
finished bread sells at scale to its own population. A city next to
an iron mine becomes a metalworking center because cheap ore + cheap
charcoal + expensive tools elsewhere = wide margin per ingot. The
right specialization **emerges** from local input prices vs. output
demand — not from a hardcoded tier table or a static input-checklist.

### Two stages of specialization

**Stage 1 — Procgen seeding (current)**: at world genesis we don't have a
price history to optimize against, so we seed the OBVIOUS workshops
implied by abundant local inputs. This is a reasonable cold-start
that lines up with the eventual market-driven equilibrium.

**Stage 2 — Dynamic investment (current v1.5)**: every season, each
settlement's richest stockpile-owning investor evaluates observed
market spreads. If an output trades much higher than its input cost
basis, and the investor already holds the construction materials, the
investor commits those materials to a pending building (per the
construction recipes in docs/03). Construction then consumes worker-
days before the building becomes productive. Mines are additionally
geography-gated: a mine investment must go on a matching finite
deposit, and ore refineries require local ore stock or a
deposit-backed mine already present/under construction. If a workshop
runs at a loss for many months, it decays and isn't rebuilt. This is
what makes the specialization *adaptive* over the burn-in.

### Two ways a market gap closes

When a settlement is short of resource X (price spikes locally), two
independent responses can fix it — **whichever is cheaper at the
margin wins**:

1. **Trade response (caravans)**: NPC merchants observe the spread
   between cheap-X-elsewhere and expensive-X-here, and route a
   caravan accordingly. Bandwidth: how much one caravan can haul per
   trip × how many trips per season. Limited by transport cost
   (fodder + crew rations + risk + tariffs).
2. **Production response (in-settlement workshop)**: a local owner
   spends coin + materials to construct a workshop producing X
   locally, then hires workers. Bandwidth: workshop daily output ×
   continuous days. Limited by input availability locally and
   construction lead time.

When transport is cheap (good roads, low banditry, short distance),
trade fills the gap quickly and a local workshop never makes
economic sense. When transport is expensive (long distance, hostile
roads, no allies), local production wins even at higher input
costs. The same model handles both:

- A famine inland (no port) is more likely to be solved by local
  pastoral expansion than by sea-shipped grain.
- A spike in tool prices in a coastal city near iron mines triggers
  a smithy locally rather than waiting for tools to be shipped from
  the inland metalworking center.
- A spike in luxury textile demand in a small inland town is more
  likely to attract import caravans than to spawn a local
  weaver_workshop (low population can't justify the build cost).

### Stage-1 seeding rules (current, input proxy for market)

Procgen evaluates each settlement and seeds workshops where the
inputs are cheap enough nearby that the output is plausibly
profitable:

1. **Local catchment scan**: what resource hexes does this settlement
   directly work?
2. **Trade-range scan**: what resource hexes are within ~10 hexes
   (one day's caravan haul) — accessible cheaply enough to be a
   plausible input?
3. **For each candidate workshop**, seed it if **all inputs are
   reasonably cheap nearby AND the output has plausible local
   demand** (population, neighboring populations, or a known export
   chain).
4. **Subsistence floor**: every settlement seeds `farm` + `pasture`
   regardless. People always need to eat; even a marginal harvest
   beats nothing on day 0.

Concrete heuristics for stage 1:

| Building | Seeded when |
|---|---|
| `farm` / `pasture` | Always (subsistence floor) |
| `forester_camp` | ≥1 forest/dense_forest hex in catchment |
| `sawmill` / `charcoal_kiln` | wood available locally OR within ~10 hexes (own forester_camp counts) |
| `mine` | iron_ore / copper_ore / etc. deposit in catchment |
| `bloomery` | iron_ore + charcoal both reachable within ~10 hexes (cheap inputs) |
| `smithy` | iron + lumber + charcoal all reachable + non-trivial population to sell tools to (≥village) |
| `mill` | any settlement (grain is universal) |
| `bakery` | mill present + ≥village (urban demand for bread) |
| `granary` | town+ (real storage building) |
| `weaver_workshop` | wool/linen reachable + ≥village |
| `cart_wright` | smithy + sawmill present (city) |
| `fishery` | river/lake hex in catchment |
| `olive_grove` / `vineyard` | Mediterranean climate + hills hex in catchment |
| `mint` | silver/gold reachable + city tier |

**Net effect:** a hamlet next to a forest is a forestry hamlet
(forester_camp + sawmill). A village next to an iron deposit becomes
a mining village (mine + bloomery, exports iron). A city in farmland
becomes a grain-trade hub (mill + bakery + granary, IMPORTS ore and
tools). A city near both ore AND forest is a metalworking city. The
*specialization emerges from the geography* — and, through current
dynamic investment, from observed market spreads.

**Why a settlement starves**: when its specialty stockpile (the thing
it exports) builds up to capacity AND the food it needs to import
isn't arriving (caravan disrupted, road closed, neighbor hostile),
population drops over months as the local pasture/garden can no
longer cover the deficit. This is the docs/00 pillar promise: "block
the food → city dies."

## Storage capacity (locked)

Settlements have **finite storage capacity** for goods, just like
caravans do. Capacity comes from two sources:

- **Buildings**: dedicated storage structures hold specific resources.
  Granaries hold grain (bulk). Warehouses hold mixed manufactured
  goods. Cisterns hold water. Each building's capacity is set in its
  catalog entry (see [02 — Resources](02-resources.md) for unit
  weights and [03 — Production](03-production.md) for building
  capacities).
- **People**: every household has informal storage in the home
  (~50 kg per adult, mixed). This is a small per-capita baseline so
  settlements without dedicated buildings don't immediately reject
  all goods.

Effective per-resource capacity at a settlement:

```
capacity(resource) =
    sum_over_buildings(b.storage_capacity_for(resource))
  + population_adults * baseline_household_kg(resource)
```

Adding to a stockpile that would exceed capacity is **rejected**
(the producer holds excess in their workshop until it spoils, or
sells at any price to clear inventory). Caravans arriving with cargo
the settlement can't store either pay storage fees to private
warehouses, sell at depressed prices, or move on.

This is the realistic constraint that makes warehouses + granaries
matter as buildings — without them, a city's traders can't
accumulate enough stockpile to weather a bad season.

**Current implementation status (planned, tracked in docs/15 §C10).**
Capacity discipline is not yet enforced anywhere — neither at
bootstrap nor in the tick loop. Stockpiles grow without bound. This
is fine for current burn-ins (no settlement holds an absurd amount)
but the realistic gameplay constraint above does not yet bite.
See docs/15 §C10 for the full follow-up plan.

## Market state per settlement

For each tradable resource, the settlement tracks:

- Current stockpile **per owner** (not aggregated — owners decide
  individually whether to sell).
- Recent inflows / outflows (last ~10 days).
- Last clearing price.
- Standing buy/sell intents from local actors (granary keepers
  buying for patron families, consumers bidding for bread, vintners
  buying amphorae, off-map merchants offering exports, etc.).

When a caravan arrives, it sees this market and posts its own
intents. The day's **market clearing** runs (math in
[08 — Money & Trade](08-money-and-trade.md)) and produces a price
and a set of trades. Stockpiles update by owner. The next caravan
that arrives sees the updated state.

## Diagnostics — important for player legibility

Because the world has no hidden hands, the player needs to be able
to ask the world *why*. We commit to:

- Every settlement panel shows per-resource history: inflows,
  outflows, named caravans that delivered or bought, named owners
  holding stockpile.
- Every recipe shows why it's running below capacity: missing
  input? missing labor? missing building? Owner not selling at the
  prevailing price?
- Every population segment shows what they're consuming, what
  wants are unmet, and current health/disease state.
- Every market shows the demand schedule (who wants what at what
  price) and the supply schedule (who'd sell what at what price),
  so the price is *visible reasoning*, not magic.
- Every catchment hex shows who owns it, what's currently being
  produced from it, and which workers are assigned.

If we don't build this, the simulation will feel like fate. With
it, it feels like a world.
