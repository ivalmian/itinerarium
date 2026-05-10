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
do (mostly: trade with owners, not become one in v1).

When a recipe runs at a catchment hex, output goes to the **hex
owner's stockpile**, not to a generic settlement pool. The owner
then decides whether to sell into the local market.

## Growth and decay

- Population grows when food is abundant, peace holds, immigration
  arrives, disease is in remission.
- Population shrinks when food fails, plague hits, war kills, or
  people migrate out.
- A settlement can die: 0 population → buildings decay → eventually
  a ruin hex (potentially re-discoverable later as a hidden feature
  — see [07 — Geography](07-geography.md)).
- A settlement can grow into new hexes — a town that bursts past
  its built-up area annexes adjacent rural hexes as new urban
  hexes; its catchment expands.

Growth and decay are emergent from the rules in
[04 — Population](04-population.md). There is no "settlement size up"
event — it just has more people now than last turn.

## Building catalog (v1)

**Production:** `farm`, `pasture`, `vineyard`, `olive_grove`,
`orchard`, `fishery`, `mine`, `quarry`, `forester_camp`, `mill`,
`bakery`, `oil_press`, `winery`, `dairy`, `tannery`, `charcoal_kiln`,
`sawmill`, `kiln`, `pottery`, `bloomery`, `smithy`,
`weaver_workshop`, `tailor_shop`, `cart_wright`, `mint`.

**Storage & civic:** `granary`, `warehouse`, `cistern`,
`aqueduct_segment`, `temple`, `forum_market`, `walls`, `barracks`,
`road_segment`.

(No `shipyard` in v1 — sea trade deferred.)

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
