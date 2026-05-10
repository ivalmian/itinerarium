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
4. **Resource deposits**: terrain + climate weighted, with
   geological clustering for ores (real mining regions, not uniform
   sprinkles).
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
   deposits). Density per hex driven by carrying capacity.
   Aggregation rule from
   [01 — Simulation Frame](01-simulation-frame.md) applies.
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
