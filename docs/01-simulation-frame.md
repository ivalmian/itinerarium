# 01 — Simulation Frame

How the world is structured: time, space, scale, and how "no hidden
hands" is operationalized.

## Time

- **Turn length: 1 day.** A year is 365 turns; a season ~91 turns.
  Caravan movement is granular — a typical day equals a real day's
  march. Daily turns give us tight feedback: a city eats today's bread
  today, not last week's aggregate.
- Every turn has sub-phases (in fixed order, all visible):
  1. Production (workers do work, output goes to owner stockpiles)
  2. Consumption (population eats, equipment wears)
  3. Movement (caravans, armies, migrants, couriers resolve travel)
  4. Trade (market clearing at each settlement; caravans buy/sell)
  5. Demographics (births, deaths, migration decisions, disease spread)
  6. Politics (taxation, conscription, edicts, governor / family
     decisions — see [11 — Politics & Ownership](11-politics-and-ownership.md))

Implications of a daily turn:

- Most days, an individual settlement's state changes very little.
  Some bookkeeping (e.g. demographic aggregates, slow job retraining)
  can be deferred to multi-day intervals. Production, movement, and
  market clearing run every day at full resolution.
- **The game is fully turn-based.** There is no real-time fast-
  forward or "skip ahead through days." A turn advances when the
  player clicks "End Turn" — typically after spending their movement
  points, but they may also click End Turn without taking any actions
  (e.g., to wait for caravans they hired to arrive, or for news to
  reach them). The world simulates one day per click. Long stretches
  of waiting are just many End Turn clicks; the UI may bind a hot-
  key to make this fast in practice.

## Space — physical scale (locked)

- **Hexagonal grid.** Pointy-top hexes, axial coordinates `(q, r)`.
- **Hex size: 1 km across.** Picked so that a real day's march by a
  laden mule caravan equals roughly 25 hexes (= 25 km). Every
  distance, area, and travel time in the game is a real number you
  can sanity-check against the historical record.
- **Current map size: ~500 km × 500 km, ~250,000 hexes.** This is
  about the size of historical Roman Italy or the Iberian peninsula —
  large enough to contain multiple distinct settled regions with
  meaningful wilderness between them.
- **Most of the map is sparse or empty.** Settlements + their
  immediate worked catchment occupy only ~15–20% of hexes
  (~40,000 hexes). The remaining ~80% is wilderness — sparsely
  populated forest, hills, marsh, marginal land, and gaps between
  the settled clusters. This is exploration territory and the home
  of bandits, hidden ruins, abandoned mines, and lost shrines (see
  [07 — Geography](07-geography.md)).
- Each hex has: terrain type, climate band, elevation, river flag,
  road grade (none/dirt/Roman road), resource deposits, owning
  settlement (if any), current foragers/herders working it, hidden
  feature flag (if any).

### Why this size

The province has roughly 4–5 cities, but a Roman provincial city
isn't surrounded by uniformly dense countryside in every direction —
its hinterland is concentrated in a regional cluster around it, and
between clusters lie tens of kilometres of marginal or empty land.
500×500 km lets us put 4–5 settled clusters with realistic
inter-cluster gaps. It also gives the player real exploration:
crossing from one cluster to another is a 4–10 day journey through
country that may hold opportunity, danger, or both.

## Settlements occupy real area

- A settlement is the people who live and work on a cluster of hexes,
  not a separate entity from them.
- Settlements **physically occupy multiple hexes for towns and
  cities**: a small city (~10k people) is 2–3 urban hexes; a large
  city (30k+) is 3–10. Hamlets and small villages occupy 1 hex (or
  share one).
- Each settlement has a **catchment** — the surrounding hexes its
  workers can walk to in a working day (~2 km radius for villages,
  ~5 km for cities). Land beyond the daily-walking catchment is
  owned but worked by tenant villages.
- **Natural features have real extent too.** A forest is 20–200
  contiguous forest hexes; a mining region is a cluster of mineral
  hexes; a village's fields are ~6–10 hexes; a good pasture is
  10–50. See [07 — Geography](07-geography.md) for the table.

(Detailed numbers in [05 — Settlements](05-settlements.md).)

## Settled clusters and wilderness

The map is structured (during procgen) as ~3–5 **settled clusters**
plus the wilderness between them.

- A settled cluster centres on a city. It contains the city's urban
  hexes, its dense ring of supporting villages and hamlets (within
  ~30–50 km), worked fields and pastures, and the road network
  binding them.
- Wilderness sits between clusters. It contains forests, hills,
  marginal land, the occasional independent frontier hamlet,
  scattered hidden features, and bandits.
- Roads connect cities within a cluster (dense network) and link
  clusters to each other (a few arterial routes through the
  wilderness).

This isn't a hard partition — the cluster/wilderness boundary is
fuzzy and procgen-derived. But it determines where most of the
economy is concentrated and where the long, risky trade routes lie.

## Scale targets (current v1.5)

- **Map**: 500 × 500 km, ~250,000 hexes.
- **Settled hexes** (urban + active catchment): ~30,000–50,000
  (~15–20%).
- **Wilderness hexes**: the rest (~200,000+).
- **Population**: ~700k–1.2M modeled people (typical procgen target
  ~1M), concentrated in clusters.
- **Cities**: 4–5 (typical mix: one provincial capital ~25–40k, two
  to four secondary cities ~8–15k).
- **Towns**: ~10–25 small market towns (1k–5k each).
- **Villages**: ~1,200–2,500 entities (each a real village,
  ~200–800 people). Per docs/04 §"Sizing the realistic hinterland"
  we no longer aggregate; one entity = one village.
- **Hamlets**: ~1,500–4,500 entities (one per real hamlet,
  ~30–150 people each). Multiple hamlets per hex is normal in
  the inner ring of a fertile patch — same-hex settlements
  remain distinct entities but trade and news between them
  takes 0 ticks.
- **Total settlement entities**: ~3,000–8,000. This is the
  performance-critical count, not raw population or hex count.
  Current scope does not aggregate villages or hamlets into
  meta-settlements.
- **Hidden features** (ruins, abandoned mines, hermit shrines,
  abandoned villages): ~10–30, scattered in wilderness.
- Hundreds of caravans simultaneously active.
- Population modeled as **stratified pools per settlement** with a
  full demographic pyramid (5-year cohorts × M/F × class — see
  [04 — Population](04-population.md)), not individual agents.
- Performance plan: data-oriented layout (Structure-of-Arrays),
  fixed-point arithmetic, viewport-culled rendering, sim/render
  separation (Web Worker candidate). Implement naively first,
  profile, then optimize. Burn-in is the heaviest workload; raw
  hex count is cheap (mostly static), settlement & caravan logic
  is the hot path.

## The "no hidden hand" rule, operationalized

- **Prices are not set by a global market.** Each settlement clears
  its own market every day from local supply and demand. Caravans
  observe prices when they arrive. (Math in
  [08 — Money & Trade](08-money-and-trade.md).)
- **News travels at the speed of caravans (or couriers).** A famine
  in one city is unknown elsewhere until someone carries the news.
- **"Migration" is a caravan too** — a column of people walking with
  their belongings, eating as they go. They can be intercepted,
  starve, settle somewhere unexpected.
- **Taxes don't teleport.** Tax revenue is grain in carts physically
  moving. If bandits take the carts, the capital doesn't get fed.
- **Imports from beyond the map are real caravans** — see edge-hub
  caravans in [06 — Caravans](06-caravans.md).
- **Exports beyond the map are also real caravans** — long-haul NPC
  merchant houses send goods off-map to an abstract global market;
  the on-map portion of the journey is fully simulated.
- **Disease is carried by caravans** — see
  [04 — Population](04-population.md). Trade routes are also
  epidemic routes.
- **Discovery is real.** Hidden features in the wilderness are
  discovered when someone (player or NPC) physically visits them.
  Knowledge of a discovery spreads as news, at the speed of
  caravans.
- **Stockpiles are owned by named actors**, not "the settlement." See
  [11 — Politics & Ownership](11-politics-and-ownership.md).
