# 07 — Geography & Climate

What hexes are made of, how seasons change them, and how we generate
the world.

## Hex extent — locked

Hexes use a 1 km movement scale. For production and carrying-capacity
tuning, each hex is treated as roughly 1 km² of land. **Every natural
feature has real physical extent**: not "a forest hex" as a token, but
a real patch of forest land that is part of a much larger forest
spanning many hexes.

A village's fields are not "the village's farm hex." They are several
real fields covering several real hectares — typically 6–10 hexes of
worked land in the village's catchment. A mine isn't a single hex
either; it's a deposit cluster of a few hexes with finite ore. A
forest isn't a token; it's a region.

### Natural feature extents (first-pass, tunable)

| Feature | Typical extent (hexes) | Notes |
|---|---|---|
| Forest (managed near settlements) | 5–30 contiguous | Logged at edge; sustainable yield if not over-cut. |
| Forest (wilderness old-growth) | 50–500+ contiguous | Untouched; rich game; future timber. |
| Mining region (one ore type) | 1–10 hex cluster | Each hex = a deposit; finite ore; deeper hexes last longer. |
| Quarry | 1–3 hexes | Effectively infinite stone, slow extraction. |
| Pasture (good) | 10–50 contiguous | Carries herds at high density. |
| Pasture (marginal) | 50–200+ contiguous | Sparse forage; suits hardy goats, camels. |
| Marsh / wetland | 5–30 contiguous | Productive for fish + reeds; raises disease risk. |
| Lake | 1–20 hexes | Fishing + water access. **Fully occupies its hex** — impassable, unbuildable. |
| River | linear chain of river hexes | Transport corridor + water + fishing. **Sub-1 km wide**; occupies only a sliver of its hex, so the rest is buildable land — settlements and buildings CAN sit on river hexes. Fording without a bridge is slow but possible (~0.35× plains MP); future bridges restore normal speed. |
| Mountains | 50–500+ contiguous | Where ore deposits live; some hexes impassable. |
| Plains (fertile) | 50–1000+ | Where most fields are sited. |
| Steppe / semi-arid | 100–500+ | Pasture for nomadic-feel herds. |
| Desert | 100–1000+ | Marginal; oases support hamlets; camels work. |

### Settlement catchment uses these features

A settlement's catchment is real hexes of real features. A village
needs ~6–10 field hexes; if its catchment has only 4 plains hexes,
it can only support a smaller population. A mining hamlet needs
mineral deposits in its catchment; if the deposits run out, the
hamlet shrinks or migrates.

This means **terrain matters geographically** — the right mix of
plains + forest + water + minerals determines whether a settlement
can grow. Procgen has to honour this.

## Terrain types

`plains`, `fertile_valley`, `hills`, `mountains`, `forest`,
`dense_forest`, `marsh`, `desert`, `steppe`, `river`, `lake`,
`urban`, `ruin` (see hidden features below).

There is no `coast` terrain. Per the user's ruling — "what even
is coast? we have lakes and rivers, I don't think there should
be separate coast" — sub-sea-level hexes are `lake` directly
and sea-trade content is deferred along with any need for coast.

Each terrain type has yields per hex per day for resources it can
produce, modified by climate and season.

### Buildability + passability summary

| Terrain | Buildable? | Passable? | Movement multiplier |
|---|---|---|---|
| `plains`, `fertile_valley`, `steppe`, `urban` | yes | yes | 1.0 |
| `forest` | yes | yes | 0.85 |
| `hills` | yes | yes | 0.75 |
| `desert` | yes | yes | 0.7 |
| `dense_forest` | **no** (too rugged) | yes | 0.5 |
| `marsh` | no (waterlogged + disease) | yes (closed in spring) | 0.5 |
| `mountains` | no | yes (closed in winter) | 0.4 |
| `river` | **yes** (riverbank) | yes (slow ford without bridge) | 0.35 |
| `lake` | **no** (water occupies whole hex) | **no** | 0 |
| `ruin` | no (re-settleable as a settlement, not a building) | yes | 0.8 |

## Climate bands

`mediterranean`, `temperate`, `continental`, `arid`, `alpine`.

Determines:

- Which crops grow (olives & grapes only in Mediterranean & warm
  temperate; flax prefers cooler).
- Heating-fuel demand (cold climate → more wood/charcoal per adult
  per day).
- Disease risk (warm + crowded = worse — see
  [04 — Population](04-population.md)).
- Pasture carrying capacity.

At 500 km per side, a single map can straddle multiple climate
bands (e.g. coastal Mediterranean lowlands + temperate uplands +
alpine peaks). This is not just flavor — it determines what can be
produced where.

## Seasons

Four seasons of ~91 days each. Effects:

- **Spring**: planting; pastoral lambing.
- **Summer**: growing; mountain passes open; campaigning season.
- **Autumn**: harvest peak (grain, olives, grapes).
- **Winter**: low production; high fuel demand; mountain passes
  closed.

Seasons matter. A blockade in winter when the granary is low is much
more dangerous than the same blockade after harvest.

## Settled clusters and wilderness (locked)

The map is not uniformly populated. Procgen produces ~3–5 **settled
clusters** plus the wilderness between them.

- A **settled cluster** centres on a city. Within ~30–50 km of the
  city, settlement density is high: villages at 5–10 km spacing
  along roads, hamlets in between, fields and pastures filling the
  catchment land.
- **Wilderness** sits between clusters. It contains:
  - Old-growth forest patches.
  - Marginal hills, scrubland, marsh.
  - Mountain ranges (the route bottlenecks).
  - Frontier hamlets (independent smallholders, hermits).
  - Bandit camps (siting determined by procgen — usually near road
    chokepoints in low-garrison terrain).
  - **Hidden features** for exploration (see below).
  - Mostly: empty space.
- **Roads** form a dense local network within each cluster, with a
  small number of arterial routes crossing the wilderness between
  clusters. Cross-cluster trade follows these.

## Hidden features for exploration (locked)

Wilderness exists to be travelled and explored, not just crossed.
The current scope includes a small set (~10–30) of hidden features placed during
procgen:

| Feature | What it does on discovery |
|---|---|
| Abandoned mine | Re-activatable: still has ore (often a rarer ore than the cluster's main mines). |
| Ruins | Lore (a piece of provincial history) + occasional small treasure stockpile. |
| Abandoned village | Re-settleable site — a migration column can found a new settlement here. |
| Hermit shrine | Small religious bonus for a nearby settlement; occasional information from the hermit. |
| Lost route | Discovering it adds a new road segment, shortcutting an arterial. |
| Bandit hideout | Combat encounter; eliminating it lowers regional banditry; unlocks a stash. |

When a caravan (player or NPC) enters a wilderness hex containing a
feature, the feature is **discovered** and its existence becomes
news (spreading at caravan speed). Discoveries can yield one-shot
rewards, change the world (re-activated mine, new settlement), or
trigger NPC interest (other merchants race to exploit a known site).

This keeps wilderness from being just "empty space the player needs
to cross" and gives the player a reason to take less-travelled
routes.

## World generation pipeline

Generation has two phases: **procgen** (build the geography and
seed initial state) and **stabilization** (run the sim forward
without a player to settle into a coherent equilibrium). Locked as
the current approach.

### Phase 1 — Procgen

1. **Continents/coastlines**: noise-based, parameters tuned for the
   intended map shape (mostly inland — sea trade deferred — but a
   long coastline is fine and adds geography variety).
2. **Climate bands** by latitude + elevation + distance to large
   water.
3. **Macro terrain**: noise-based assignment of plains, hills,
   mountains, forest, etc. Honour the natural-feature extents in
   the table above (forests cluster, mountains range, etc.).
   **Realism rules (locked):**
   - **Mountain ranges, not splotches.** Anisotropic noise: stretch
     mountain regions along a per-region orientation so they form
     linear chains (Apennine-style spines), not blobs. A second
     elevation pass smooths isolated single-hex peaks down.
   - **Forest cohesion smoothing.** After initial forest assignment,
     run a 1-step "majority vote" pass: a hex flips to forest if ≥4
     of its 6 neighbours are forest, and flips out of forest if ≤1
     are. Removes single-hex forest specks in the desert and
     single-hex desert specks in the forest.
   - **Lake/water cleanup.** A water hex with ≥5 land neighbours
     becomes land (no isolated puddles). Below-sea-level hexes
     become `lake` directly; there is no separate `coast` terrain.
   - **Tributary rivers.** Trace from MULTIPLE springs at high
     elevation; rivers MERGE when paths cross (downstream river
     becomes "wider" — flagged in tile metadata). Bigger rivers
     are slower to ford and better fishery hexes.
   - **River adjacency caps (locked).** Run an iterative cleanup
     after river tracing that enforces two symmetric rules:
     - A `river` hex may have at most **3 water neighbors total**
       (rivers + lakes), of which at most **1 may be a lake**. So
       up to 3 rivers, OR up to 2 rivers + 1 lake (entering or
       exiting a single lake), but never two separate lakes.
     - A `lake` hex may have at most **1 river neighbor** (a
       single canonical inflow/outflow). Surplus river neighbors
       collapse into more lake (the lake's surface effectively
       grew to swallow them).
     - Violators in either direction collapse to `lake`. Iterate
       until stable. Without this we get visually-jarring "river
       lakes" — large clusters of river-terrain hexes that look
       nothing like an actual river — and lakes with implausibly
       many tributary outlets.
   - **Plains–fertile_valley distinction.** Hexes adjacent to
     rivers and at low-to-mid elevation become `fertile_valley`
     (higher base yield); pure plains are the rest. Fertile
     valleys cluster along river corridors.
4. **Resource deposits**: terrain + climate weighted, with
   geological clustering for ores (real mining regions, not uniform
   sprinkles). **Realism (locked):**
   - One ore TYPE per cluster (a tin region doesn't also produce
     iron). Picked once per cluster from the ore palette weighted
     by rarity (iron common, tin/silver/gold rare).
   - Salt is bottlenecked geographically — only in specific
     salt-mine deposits in mountain hexes (rock salt) or in
     marsh/lake-margin evaporation deposits. Inland regions
     without salt depend on trade. There is no separate coast terrain;
     the current `evaporate_salt` recipe is an abstract pan recipe
     hosted by the mine building.
   - Iron ore is the most common; provincial worlds should always
     have at least 2 iron deposits (smithies need iron).
5. **Place 4–5 city sites + 10–25 town sites**, each at a good
   location (water access, fertile catchment, defensible position,
   transport node). Designate one city as the **provincial capital**
   (governor's seat). Allocate urban hexes per city based on
   intended size.
6. **Define settled clusters** around each city site: the radius
   within which villages and hamlets will be densely placed
   (~30–50 km).
7. **Site villages and hamlets** within clusters, at supporting
   locations (along roads, near fields, on water, near resource
   deposits). Density per hex driven by carrying capacity. **No
   aggregation** — each real village + hamlet is its own
   settlement entity per docs/04. Multiple hamlets and at most one
   village can share a fertile hex (a Roman *pagus* with its
   dependent hamlets); same-hex settlements remain distinct
   entities and travel between them takes 0 ticks
   (docs/05 §"Same-hex coexistence").
8. **Generate roads**: dense intra-cluster roads connecting
   settlements; a few arterial routes between clusters via
   wilderness. Procgen sets `road = 'dirt'` or `'roman'` and
   seeds `roadWear = 100` so the per-tick decay (per docs/06
   §"Trail wear") doesn't immediately revert them. Beyond the
   procgen network, **roads emerge** wherever caravan / patrol
   / news-carrier traffic exceeds the wear threshold — so the
   road map at year 10 is procgen + emergent.
9. **Place wilderness features**: a handful of independent frontier
   hamlets, bandit camps, and ~10–30 hidden features (ruins,
   abandoned mines, hermit shrines, etc.).
10. **Seed initial state**: population stratification (full
    demographic pyramid — see [04 — Population](04-population.md)),
    building stock, stockpiles, and **ownership** (patrician
    families per city, which villages they own, which slaves they
    own). Per [11 — Politics & Ownership](11-politics-and-ownership.md).
11. **Place starter production buildings (locked)**: every
    settlement gets at least a `pasture` (animal protein + wool)
    and a `farm` (grain) so the production phase has work from
    day 1. Towns and cities additionally get `mill` + `bakery`
    (grain → flour → bread, the urban food chain) and a `granary`
    for storage; cities also get a `smithy` and a `weaver_workshop`
    so basic manufactured goods circulate. Building counts scale
    with population. Hex placement: production buildings sit in
    catchment hexes (farms in plains/fertile, pasture in
    grass/hills); workshops sit in urban hexes. Each building has
    an owner — typically the city corporation for civic buildings,
    a patrician family for an estate's farm, or the village/hamlet
    actor for rural settlement buildings.

Generation is seeded so a given seed → same world.

### Phase 2 — Stabilization (burn-in) (locked)

After procgen, run the full simulation forward **without a
player** before play begins. The burn-in is split into two
explicit sub-phases bracketing a one-time road reset:

#### Phase 2a — pre-road burn-in (days 0..1824, ~5 years)

Caravans, news carriers, and patrols use the procgen-laid roads
where useful but **off-road as needed** to follow the actual
demand. Every hex they enter accrues `roadWear` per the trail-
wear rules in [06 — Caravans](06-caravans.md). At the end of
phase 2a the wear field is the empirical record of what the
world's actors actually wanted to do.

#### Day 1825 — road reset (locked, automated)

A one-time pass rebuilds the road network from observed wear:

1. **Roman roads kept for reset purposes.** Engineered Roman roads
   stay Roman regardless of observed wear during this one-time reset.
   Afterward, the quarterly `roadMaintenancePhase` can still demote
   unfunded Roman-road hexes to dirt after 4 missed quarters.
2. **Worn-in trails promoted.** Any non-Roman hex with
   `roadWear ≥ DIRT_UPGRADE_THRESHOLD` (default 100) becomes
   `road = 'dirt'`.
3. **Unused dirt roads removed.** Any procgen-laid `dirt` hex
   with `roadWear < DIRT_DOWNGRADE_THRESHOLD` (default 20) is
   reset to `road = 'none'`.
4. **All wear counters reset to baseline.** Hexes that end up
   `dirt` after the audit get `roadWear = 100`; hexes reset to
   `none` get `roadWear = 0`.
5. Emits `road_reset` event with `{ promotedToDirt, demotedToNone,
   romanKept }`.

Roads ARE the result of trade flows, not procgen guesswork. The
caravan AI no longer fights an inadequate procgen network.

#### Phase 2b — post-road burn-in (days 1825..end)

The world now runs on its empirically-derived road network.
Trail wear continues but the network is much closer to optimal,
so off-roading is rare. This is the phase where price spreads,
banditry incidence, settlement growth, etc. should match the
"steady state" we're tuning toward — so any tuning metric (mean
prices, food security, banditry losses) is read off phase 2b,
not phase 2a.

#### Why this matters for the player

**The player joins on day ≥ 1825.** Day 0 is procgen output
(empty stockpiles, generic roads, no trade history); day 1825 is
the moment the world is "real" — worn-in roads, settled
markets, established trade routes, families with names + history,
bandit camps with reputations, demographic pyramid evolved one
or two generations from the procgen seed. The burn-in is the
mechanism by which we go from "world geometry" to "world that
feels lived-in" without hand-authoring history.

The burn-in also serves as a stability test: if phase 2b doesn't
hold steady, the model is broken before any player can suffer
for it.

## Implications for the design

- Procgen at 250k hex scale needs to be efficient (target: minutes,
  not hours). Static terrain is cheap; the expensive parts are
  settlement placement and the burn-in.
- **Pathfinding** for long-distance caravans crosses many hexes
  (a cross-cluster route can be 100+ hexes). Use jump-point search,
  hierarchical pathfinding (cluster-graph + intra-cluster), or
  precomputed road graphs.
- **Rendering** is viewport-culled. The user only sees a small
  window of the map at a time. Zoomed-out views show aggregate
  biome / region info, not individual hexes.
- The stabilization sim must **converge** — not oscillate, not
  collapse. One of our main tuning targets and a real engineering
  risk (see [10 — Scope](10-scope-and-questions.md)).
- We keep a "world seed + parameters" record per game so we can
  reproduce or restart.
- The headless tuning harness exercises the same code that does
  burn-in; one investment, two payoffs.
