# 07 — Geography & Climate

What hexes are made of, how seasons change them, and how we generate
the world.

## Hex extent — locked

Hexes are 1 km across (= 1 km² area). **Every natural feature has
real physical extent**: not "a forest hex" as a token, but 1 km² of
forest land that is part of a much larger forest spanning many hexes.

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
| Lake | 1–20 hexes | Fishing + water access. |
| River | linear chain of river hexes | Transport corridor + water + fishing. |
| Coastline | linear chain | Fishing + salt; no sea trade in v1. |
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
`dense_forest`, `marsh`, `desert`, `steppe`, `coast`, `river`,
`lake`, `urban`, `ruin` (see hidden features below).

Each terrain type has yields per hex per day for resources it can
produce, modified by climate and season.

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
v1 includes a small set (~10–30) of hidden features placed during
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
the v1 approach.

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
   - **Coastline smoothing.** A water hex with ≥5 land neighbours
     becomes land (no isolated puddles). A land hex with ≥5 water
     neighbours becomes coast (no thin peninsulas).
   - **Tributary rivers.** Trace from MULTIPLE springs at high
     elevation; rivers MERGE when paths cross (downstream river
     becomes "wider" — flagged in tile metadata). Bigger rivers
     are slower to ford and better fishery hexes.
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
   - Salt is bottlenecked geographically — only on coast hexes
     (evaporation pans) or in specific salt-mine deposits in
     mountain hexes. Inland regions without salt depend on trade.
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
   entities and travel between them takes 0 days
   (docs/05 §"Same-hex coexistence").
8. **Generate roads**: dense intra-cluster roads connecting
   settlements; a few arterial routes between clusters via
   wilderness.
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

### Phase 2 — Stabilization (burn-in)

After procgen, run the full simulation forward for a substantial
in-game period (target: 5–20 game years) **without a player**
before play begins. This:

- Lets caravans actually start moving and discover real prices.
- Lets settlements that procgen got wrong (too small, wrong
  location, underfed) collapse, shrink, or migrate.
- Lets settlements with good fundamentals grow, build infrastructure,
  attract migrants.
- Lets the political layer (governor's tax rates, families' estate
  management, headmen's choices) settle into stable patterns.
- Produces a starting world that has a *history* — real stockpiles,
  family wealth, road wear, trade partnerships, debts.
- Surfaces bugs in the economic model: if half the cities collapse
  during burn-in, the model is broken, not the world.

The burn-in result is the world the player walks into on day 1. We
should retain enough history (last few in-game years of major
events) to expose to the player so the world feels lived-in.

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
