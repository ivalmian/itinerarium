# 06 — Caravans

The protagonists of the simulation. The player has one. The world has
hundreds. They're how goods, people, news, and risk move between
settlements.

**Land caravans only in the current scope** — sea trade is deferred (see
[10 — Scope](10-scope-and-questions.md)).

## Composition

A caravan is a unit with:

- **Crew**: merchants + drovers + guards. Each consumes daily
  rations.
- **Animals**: pack animals (donkeys, mules, horses) and/or draft
  animals (oxen for wagons, horses for fast carts). Each consumes
  daily fodder.
- **Vehicles**: pack saddles or carts/wagons.
- **Cargo**: stockpile of goods, capped by total carry capacity.
- **Treasury**: coin or barter goods.
- **Knowledge**: prices observed at hexes recently visited (decays
  with time).
- **Owner**: a named actor (the player, a patrician family, the
  governor's office, an off-map merchant house). Cargo belongs to
  the owner.
- **Disease state**: healthy / exposed / infectious. See
  [04 — Population](04-population.md). An infectious caravan can
  start an outbreak in any settlement it visits.

## Animal & vehicle reference (real-world numbers)

| Unit                           | Carry capacity | Fodder/day    | Notes                           |
| ------------------------------ | -------------- | ------------- | ------------------------------- |
| Donkey (pack)                  | ~50 kg         | ~3 kg         | Browses marginal forage; cheap. |
| Mule (pack)                    | ~100 kg        | ~6 kg         | Roman workhorse of land trade.  |
| Horse (pack)                   | ~80 kg         | ~7 kg         | Faster but more demanding.      |
| Camel (pack, arid only)        | ~180 kg        | ~3 kg         | Browses where nothing else can. |
| Ox-cart (2-wheel, ox team)     | ~500 kg        | ~20 kg (team) | Slow, road-bound.               |
| Heavy wagon (4-wheel, ox team) | ~1,200 kg      | ~30 kg (team) | Roads only.                     |
| Light cart (donkey/horse)      | ~200 kg        | ~5–7 kg       | Versatile.                      |

Crew:

- **Drover**: handles ~5 pack animals or 1 wagon team.
- **Guard**: armed escort; needs weapons + ideally armor.
- **Merchant**: makes trade decisions; 1 per caravan suffices.
- Crew rations: ~0.4 kg grain-equivalent / crew / day.
- NPC caravans try to depart with a 21-day ration reserve. That is
  enough for ordinary cross-province detours at full daily timing
  without making every caravan a pure food hauler.
- Warm-start, replacement merchant, edge-hub, and tax-shipment caravans
  are seeded or locally provisioned with this reserve before their first
  trip; otherwise early burn-in would kill caravans before the market AI
  gets its first chance to restock. A replacement merchant that cannot
  source at least a week of local/owner rations should wait rather than
  depart as a doomed unit.
- Warm-start seeding is **one-shot by default**, not an append
  operation. Re-entering the viewer/burn-in seeder must not inject a
  second random fleet. The default warm-start target is a bounded
  standing fleet (about 0.25 caravans per generated settlement, min 4,
  max 80), not one caravan per settlement; large maps must not boot
  with hundreds of arbitrary merchant units. Explicit top-up calls can
  pass a target total, but existing caravans count toward both that
  target and each owner's caravan cap, and the province-wide active
  caravan ceiling still applies.
- Replacement merchants prefer a normal mule train, but if transport
  animals are scarce they can launch a smaller pack train once the owner
  has at least one herd-unit (~six animals) plus starter rations. This
  keeps the fleet constrained by real equine stock without requiring a
  perfect full-size caravan before any commerce can restart.
- A cash-rich owner does not need the equines to already sit in its own
  stockpile: assembly can first buy local pack animals from another
  stockpile owner at the observed market price, then transfer those
  animals into the caravan.
- The live sim also has a province-wide active-caravan ceiling across
  standing merchants, tax shipments, and edge-hub convoys. When the road
  network is already saturated, new dispatches queue or wait instead of
  appearing as a discontinuous wave.
- During burn-in, wealthy patrician families, caravan-owner actors,
  and merchant houses may assemble replacement caravans when the
  standing merchant fleet falls below the province target. This is
  paced (at most a couple per week), owner-capped, and funded by a
  real transfer from the owner's treasury into the caravan's operating
  cash. It is not a second warm-start wave.

### Crew demographics

Per the pillar-1 rule "everyone in all units has gender and age",
every `CrewMember` carries an optional **demographics** map: a
sparse `Map<string, number>` keyed by `${sex}|${ageBand}` whose
values sum to the entry's `count`. The same encoding is used by
`Settlement.population` so the two can be compared / fed into each
other.

Sourcing rule (procgen + recruitment):

- A crew is drawn from the **origin settlement's working-age
  population pool** via `drawDemographicsFromPool(pool, count, bias,
rng)` (in `src/sim/population/demographics.ts`).
- Per-role bias profiles live in `ROLE_BIASES`:
  - `caravan_merchant` — sex-neutral, peaks 25-44.
  - `caravan_drover` — male-favored (0.2 weight on female), prime
    adulthood 20-39.
  - `caravan_guard` / `caravan_soldier` — heavily male
    (0.05 weight on female), fighting-age 15-44.
- Bias is a multiplicative weight on the cohort count, so it
  collapses to whatever's actually available when a small hamlet
  is the origin (a 50-person village fielding 5 guards may run
  out of prime-age men and dip into older bands).
- **Replacement merchant assembly and villager caravan dispatch**
  use the same draw: every newly-assembled crew entry in
  `phases/caravan.ts` is given a demographics map sized to its count
  with the role-appropriate bias. There is no longer a code path
  that creates an anonymous count-only crew.

Casualty rule (battle):

- `applyCrewCasualties(caravan, deaths, rng)` in
  `src/sim/caravan/caravan.ts` reduces `count` AND drains
  `demographics` proportionally (largest-remainder rounding,
  RNG-tie-breaking for determinism).
- The drained per-bucket map is returned so a future caller can
  feed deaths back to the home settlement's `PopulationPool` (the
  widows-and-orphans accounting). The drain is wired; the
  feed-back-to-home is staged for a tick-layer integration.

The `demographics` field is **optional** so existing tests that
construct ad-hoc crews don't all have to be updated at once.
Serializers (snapshot, future save game) should treat it as part
of the unit identity once a crew has been seeded with one.

## Movement (1 km hex, 1 day turn — locked)

Distances are real. The numbers below are **hexes per day** (= km per
day, since hex = 1 km).

| Mover                             | Roman road | Dirt road | Off-road (rough) | Mountain pass winter |
| --------------------------------- | ---------- | --------- | ---------------- | -------------------- |
| Pack mule caravan, laden          | ~25        | ~20       | ~5               | 0–2                  |
| Pack mule caravan, light          | ~30        | ~25       | ~6               | 2–4                  |
| Pack donkey caravan               | ~20        | ~17       | ~4–5             | 0–2                  |
| Ox-cart, laden                    | ~15        | ~12       | impassable       | impassable           |
| Heavy wagon, laden                | ~12        | ~8        | impassable       | impassable           |
| Walking peasant / migrant column  | ~20        | ~18       | ~5               | 0–3                  |
| Roman legion on march             | ~30        | ~25       | ~7–8             | 5–10                 |
| Express courier (changing horses) | ~150       | ~80       | ~15              | 5–15                 |

These are first-pass; tunable. Movement progress accumulates as a
fraction; partial movement carries to the next day. Wagons can fail
in mud, snow, or steep climbs. Crossing a river needs a ford or
bridge or a delay.

Implication: a mule caravan crossing a 100-km province takes ~4 days
on a Roman road, ~5 days on dirt, ~20+ days off-road. A famine
relief caravan is a real number of days late, not "instant on the
turn the famine starts."

### Terrain difficulty model (locked)

Movement cost is computed as `base_movement_per_day / difficulty`,
where difficulty is determined by the hex's terrain × road grade,
modified by the mover's equipment / animals / load. Higher difficulty
= slower. Reference difficulty factors (lower = easier):

| Hex                         | Roman road | Dirt road  | Off-road   |
| --------------------------- | ---------- | ---------- | ---------- |
| Plains / fertile valley     | 1          | 1.25       | 5          |
| Coast / steppe / urban      | 1          | 1.25       | 5          |
| Hills / desert              | 1          | 1.5        | 7          |
| Forest                      | 1          | 1.5        | 8          |
| Dense forest                | 1          | 2          | 12         |
| Marsh                       | 1          | 2          | 10         |
| Mountains (summer)          | 1          | 2          | 16         |
| Mountains (winter)          | impassable | impassable | impassable |
| River (without ford/bridge) | impassable | impassable | impassable |
| Lake                        | impassable | impassable | impassable |

Modifiers (multiplicative on the off-road column where applicable):

- Heavy load (>80% capacity): ×1.25 off-road, ×1.0 on Roman road
- Wagon-class vehicle: cannot enter forest/dense_forest/mountains/
  marsh off-road at all (impassable)
- Camel pack train in arid: ×0.7 in desert/steppe; not allowed in
  marsh
- Roman legion: trained engineers reduce hills/forest off-road by 25%

Equipment matters: a courier on a fast horse with no cargo gets the
"light" profile (faster); a laden wagon gets the "heavy" profile
(slower, road-bound). The pathfinder picks the path that minimizes
total difficulty × distance, not raw distance.

## Consumption en route

- Crew rations from cargo (or local purchase if passing through a
  settlement).
- Animal fodder: pack animals graze where pasture or roadside
  vegetation exists; supplemented from cargo. Draft animals on heavy
  wagons can't graze enough on the move and need carried feed.
  In v1.5, carried feed is represented by `food.grain` and
  `food.legumes` in the caravan cargo. Terrain and season determine how
  much grazing offsets that need; urban, desert, winter, and long detour
  days therefore consume real cargo or damage caravan health.
- Wear: carts and equipment depreciate per day of use.

A 50-mule caravan with 12 crew & guards over a 30-day journey burns
~9,000 kg of fodder + ~150 kg of crew rations. If grazing is poor,
that's a lot of cargo space lost just to keeping themselves alive.
**Long routes are economically only viable for high-value
low-weight goods.** This is exactly what makes the import / export
section below behave correctly.

If a caravan runs out of food en route, animals weaken first, then
crew. A starving caravan abandons cargo. A crew that dies leaves
loose goods on the map for whoever finds them next.

## Trail wear → emergent dirt roads (locked)

A trade route in the real world is **made by walking it**. The
first caravan that crosses a wilderness hex flattens grass; the
hundredth packs the dirt; the thousandth has worn a recognizable
track. After enough of them, the locals call it a road.

We model this directly. Each `HexTile` carries a `roadWear`
counter (integer, 0 at procgen for un-roaded hexes). Every day:

1. **Wear accrues** per traffic. Each caravan, news carrier, and
   patrol that ENTERS a hex during movement adds:
   - +0.2 per pack-mule equivalent (~50 kg cargo capacity)
   - +0.05 per crew member (people on foot pack the trail too,
     just less than animals)
   - +0.2 per news carrier (single person walking)
   - +0.5 per patrol soldier
     A single moving unit's contribution to one hex is capped at 10
     wear per day, so a giant caravan can help wear a route in, but
     cannot instantly bank years of road memory. A 50-mule + 12-crew
     caravan crossing a hex adds about 10.6 wear before that cap, so
     it lands at +10. A two-soldier patrol adds 1.
2. **Wear decays** -1 per day on every hex with roadWear > 0
   (wilderness reclaims unused trails). So a hex needs at least 1
   wear-unit/day on average just to hold its accumulated trail.
3. **Threshold upgrade**: when `roadWear ≥ 100` AND
   `tile.road === 'none'` AND the terrain is passable, the hex
   upgrades to `tile.road = 'dirt'`. Emits a `road_upgraded`
   event.
4. **Roman roads are engineered, not worn in.** Hexes with
   `road === 'roman'` don't gain wear (no upgrade target above
   them) and their wear-counter doesn't decay because the road is
   maintained — both behaviors landed in `addRoadWear`/
   `trailWearTickPhase`. Modeling a real labor + materials cost
   for the maintenance (so a defunded province eventually loses
   its roads) is tracked in docs/15 §C11.
5. **Dirt roads can downgrade.** A `dirt` hex whose roadWear
   falls below 20 (sustained low traffic) reverts to
   `road = 'none'`. The dirt-road decay rate scales **exponentially
   with the number of road neighbors** (any grade — dirt or roman):
   - 0 neighbors: 0.25 × `DIRT_ROAD_DECAY_PER_DAY` (very slow)
   - 1 neighbor: 0.5 × (half rate — slower than current rate)
   - 2 neighbors: 1.0 × (current rate)
   - 3 neighbors: 2.0 × (double)
   - 4 neighbors: 4.0 × (quadruple)
   - 5 neighbors: 8.0 ×
   - 6 neighbors: 16.0 ×

   Formula: `decay = DIRT_ROAD_DECAY_PER_DAY × 2^(n − 2)` where `n`
   is the count of axial neighbors whose `tile.road !== 'none'`.

   Rationale: an isolated stub of dirt road (0–1 neighbors) is a
   well-defined local path and persists with minimal traffic; a
   dense crossroads (3+ neighbors) competes with parallel routes
   and dirt-grade sections at a busy junction tend to be
   superseded by alternate paths or by an upgrade to Roman pavement,
   so each dirt hex in a dense network is more fragile.

### Why this is good

- The road network **emerges from trade**, matching the
  historical record: every Roman dirt road is just a frequent
  cart-track.
- **Positive feedback loop**: a hex with a dirt road has lower
  movement cost (per the terrain difficulty model), so caravans
  preferentially route through it, which increases its wear,
  which keeps it a road.
- **Negative feedback when trade collapses**: if banditry shuts
  a route down, the dirt road reverts in weeks-to-months, and the
  next decade's caravans have to walk through wilderness again.
- The viewer shows live road growth, not just a static
  procgen-set network.

### Tunable constants

These are first-pass; numbers will move during burn-in:

| Constant                        | Default | Meaning                                                                             |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `WEAR_PER_PACK_ANIMAL`          | 0.2     | per hex entered                                                                     |
| `WEAR_PER_CREW`                 | 0.05    | per hex entered                                                                     |
| `WEAR_PER_NEWS_CARRIER`         | 0.2     | per hex entered                                                                     |
| `WEAR_PER_PATROL_SOLDIER`       | 0.5     | per hex entered                                                                     |
| `WEAR_DECAY_PER_DAY`            | 1.0     | per hex with wear > 0                                                               |
| `DIRT_ROAD_DECAY_PER_DAY`       | 0.75    | per dirt-road hex with wear > 0 (baseline; scales 2^(n−2) with road-neighbor count) |
| `DIRT_UPGRADE_THRESHOLD`        | 100     | wear needed to upgrade `none` → `dirt`                                              |
| `DIRT_DOWNGRADE_THRESHOLD`      | 20      | wear floor below which `dirt` → `none`                                              |
| `MAX_ROAD_WEAR`                 | 200     | maximum stored wear on a non-Roman hex                                              |
| `MAX_ROAD_WEAR_ADDED_PER_ENTRY` | 10      | maximum one moving unit adds to one hex in one day                                  |
| `ROMAN_WEARS`                   | false   | Roman roads don't accrue wear or decay                                              |

A medium caravan (~10 mules, ~5 crew) puts down ~2.25 wear per
hex crossed. So a single caravan transit helps, but does not build
a road by itself; a popular route over a season does.

### Procgen interaction

Procgen-laid roads (per docs/07 §"Generate roads") set
`tile.road` directly to `'dirt'` or `'roman'` and seed
`roadWear = 100` on the hex (above the upgrade threshold so they
don't immediately revert). The wear+decay machinery and
procgen-laid roads coexist cleanly: capital-to-city Roman roads
are eternal, intra-cluster dirt roads stay alive as long as
trade uses them, and entirely emergent trade arteries appear
between settlements that procgen never connected.

## Risk

- **Banditry**: an unguarded caravan in a low-garrison region rolls
  for ambush each day. Outcome: cargo lost, crew killed/scattered.
  Garrisons (city or governor) and roads reduce risk.
- **Weather**: storms, snow close passes seasonally.
- **Disease**: a caravan can carry disease (see
  [04 — Population](04-population.md)). Sick crew/animals slow down
  or die; arrival at a healthy settlement can spark an epidemic
  there. A city in epidemic may quarantine and refuse the caravan
  entirely.
- **Tariffs / tolls**: at borders or governor-controlled choke
  points; can be evaded with risk.

Risk is real, not flavor. Bandits are a specific group of humans on
a specific hex who took your specific cargo and now have to do
something with it (sell it locally, carry it elsewhere, eat it,
ransom it).

## Edge-hub caravans (imports & exports beyond the map)

Some goods come from beyond the mapped world. Some go to it. Both
move on **real caravans** that enter or leave at edge hexes. The
off-map destination is abstract — an abstract global market, see
[08 — Money & Trade](08-money-and-trade.md) — but the on-map portion
is fully simulated.

### Imports

- Periodically (driven by a stochastic schedule that respects
  seasonality), an external caravan spawns at one of a small number
  of designated off-map-trade-route gates with cargo. The palette
  includes exotics (spices, silk, incense, dyes), strategic staples
  (salt), and high-value finished goods (tools, cloth, weapons, armor).
  The exact choice is price-responsive: if a target city shows a local
  price above off-map price plus landed transport cost, that good gets
  weighted ahead of unprofitable cargo. Import houses choose the city
  with the strongest positive landed margin before choosing cargo; they
  do not send scarce tools to the nearest gate city while another city
  is bidding far more. The launch cadence is also price-responsive:
  extreme landed margins raise the chance that an edge gate sends a
  convoy that day. If no target has a positive landed margin, no import
  convoy launches. The sim must cap daily edge-hub spawns and the
  number of still-active edge-hub convoys; trade enters as a paced,
  demand-driven flow, never as a discontinuous wave from every perimeter
  hex or a backlog of stuck visitors.
- Import convoys carry both food and operating coin. The coin is for
  post-delivery rations and road expenses, not profit; an established
  off-map house does not send a loaded convoy into the province with
  an empty purse.
- It walks to the nearest large city, sells, often buys local goods
  for the return (wine, oil, iron, slaves, silver), and walks back
  off the map.
- If the import cargo sells out, the convoy returns to its original
  edge gate and exits the map. If the city cannot absorb the cargo
  for immediate coin that day, the remainder is consigned to a local
  city factor/merchant stockpile and the convoy still returns. It does
  **not** fall into the normal local NPC scouting loop. Off-map imports
  are transient provincial visitors, not a hidden permanent source of
  hundreds of wandering caravans.

### Exports

- Symmetrically, NPC long-haul merchant houses based in cities
  periodically assemble export caravans heading to off-map
  destinations. A city-based merchant house is a named stockpile owner
  at its home market, so its equines, carts, cash, and cargo are bought
  and sold through the same local market schedules as other actors.
- They buy high-value low-weight goods at local prices (luxury
  cloth, silver, fine pottery, slaves, surplus oil/wine in good
  years) and walk to an edge hex, exiting the map.
- Some days/weeks later, a counterpart inbound caravan arrives with
  return cargo and/or coin.
- The off-map portion is not simulated step by step; it is treated
  as a known time + food cost and a known global-market price.

Both import and export caravans are **just caravans**: same code,
same vulnerabilities. The player or bandits can intercept them. A
governor can tax them. A war can close their route. Other merchants
can compete with them on price.

The **player cannot run off-map caravans** in the current scope. Long-haul export is
the business of established merchant houses with the capital,
network, and patience for multi-month round-trips.

## Caravan lifecycle in the tick loop (locked)

Per-day, for every NPC caravan in `world.caravans`:

1. **Movement phase**: if caravan has a destination, advance via A\*
   (already implemented). Emit `caravan_moved`/`caravan_arrived`.
2. **Trade-on-arrival** (politics phase, after settlement markets
   clear): if a caravan is at its destination AND has a settlement on
   that hex, use the latest local clearing prices to sell cargo into
   local stockpiles; then buy the cheapest available local food up to
   the 21-day ration reserve, using the local clearing price when known
   and a staple-derived fallback price for ration goods when stock exists
   but that day's market did not clear the exact food; then buy whatever
   the price book / NPC
   heuristic deems most profitable and feasible to load for the next leg. The
   caravan keeps that reserve, so it does not sell the food needed for
   the next leg of travel. When a standing merchant caravan is back at
   its owner's home market, it remits part of cash above operating
   reserve to the owner while keeping working capital for rations and
   the next cargo purchase. Profits therefore reach the merchant house
   through a physical home-market visit instead of remaining trapped in
   the caravan object.
3. **Off-map import return**: if an import caravan has unloaded its
   market cargo at the target city, set its destination back to its
   originating edge gate. When it reaches that gate, remove it from
   `world.caravans`.
4. **Off-map export completion**: if an export caravan reaches an
   edge hex with globally priced cargo, the cargo leaves the map and
   the owning actor receives the global-market coin.
5. **Re-plan** (same politics phase): after the trade, call
   `planCaravanRoute` (T37) with the caravan's updated price book +
   knownBetterDestinations. The plan returns `RoutePlan | null`. If
   plan, set `caravan.destination` to its hex; if null, caravan scouts
   for prices using the same known bandit-density map as route planning.
   Low-ration caravans still bias toward nearby markets, but known
   ambush corridors count as extra effective distance. Well-provisioned
   scouts choose among low-risk nearby alternatives rather than rolling
   blindly into a camp just because no profitable spread is visible yet.
6. **Replacement assembly**: if the active standing merchant fleet is
   below target, eligible owners can fund a small number of replacement
   caravans from their own treasuries and transport-capital stockpiles.
   A new caravan consumes equine herd stock for its starting animals and
   consumes a cart if the owner has one available. Newly assembled
   caravans start at the owner's home market and enter the same
   arrival/re-plan logic on the next tick.

**Disbanding**: a caravan with empty cargo + zero coin + no
profitable route for 30 consecutive days disbands; crew + animals
join the local population pool. Captured carts go to local
inventory.

**Re-routing means commerce circulates.** Without this loop, every
NPC caravan walks to its seeded destination once and then stands
still forever (the old baseline before this section was added).

## NPC caravan AI

NPC merchants run a simple expected-profit calculation:

```
expected_profit =
    sum_over_cargo (price_at_destination - price_at_origin)
  - travel_cost_in_rations_and_wear
  - expected_loss_from_risk
  - tolls_and_tariffs
```

…weighted by their own risk appetite, capital, and information. They
choose routes that maximize this; ties broken by familiarity.
The `travel_cost_in_rations_and_wear` term uses the same 1.5
provisioning convention as movement: full crew rations plus the carried
fodder reserve share, not full theoretical animal fodder, because pack
animals graze where terrain and season allow. Otherwise the planner
would reject routes that are profitable under the actual movement model.

Cargo planning is not an unconstrained "fill the cart" rule. It is a
microeconomic feasible-set problem: the merchant ranks goods by
expected margin per kg, then caps the load by carrying capacity
already occupied, missing ration-reserve capacity, cash available
after survival reserves, and stock actually available in the origin
market. Fresh perishables are only planned for routes whose estimated
travel time fits inside their shelf life; milk, fresh fish, and game
therefore remain local/nearby flows while cheese, salted foods, wine,
oil, metals, and exotics can support longer hauls. This keeps planned
demand consistent with the local market the caravan can really buy
from.

When the expected-profit calculation returns no plan, scouting is still
economic behavior rather than Brownian motion. The caravan is buying
information with time, rations, and risk exposure, so it should avoid
known bandit corridors unless hunger makes the nearest reachable market
the least bad option.

Family caravans (run by a patrician family) have additional
priorities: moving family goods to market, supplying the family
town house, returning rents in kind from owned villages.

**Villager caravans** (docs/15 §C31) are a separate sub-type
dispatched by free-village stewards to the nearest city. Same
planner logic, but smaller: 2-4 mules + 1 drover + 1 guard, no
light cart, operating treasury 50-250 coin. The dispatch trigger
covers the everyday Roman village ↔ city flow:

- **surplus run** — village has any exportable inventory (food,
  fibre, wood, hides, livestock, cloth) above ~14 days of local
  use;
- **import trip** — steward has accumulated ≥200 coin to buy
  city-made goods (pottery / oil / wine / salt / iron tools)
  the village can't make itself;
- **hard-times resupply** — village grain is under 7 days of
  subsistence AND the steward has any cash, so coin drains out
  to fund a buy-back run.

The caravan's ID carries the `villager-` prefix so the viewer
renders it with the dedicated handcart glyph. Per-village cap = 1
active. Separate fleet target (~0.5 × village count) so they don't
crowd the standing merchant fleet.

Long-haul houses additionally use the global-market reference prices
to evaluate export routes (see
[08 — Money & Trade](08-money-and-trade.md)).

NPC caravans run the same code as the player; the player just gets
manual control instead of heuristics.

## Goal-bearing units (locked)

Caravans, migration columns, military units, and patrols are all
**goal-bearing** — they carry one or more persistent goals across
ticks, and their per-tick behavior is "advance toward the current
goal subject to current constraints." Without persistent goals,
units would re-evaluate from scratch every day and either churn or
sit still; with them, they actually accomplish multi-week intents
like "haul wine from City A to City B and return with grain."

A unit's GoalStack (top of stack = current goal):

- `move_to(hex)` — pathfind, walk daily, finish on arrival.
- `trade_at(settlement)` — open the market, sell intended cargo,
  buy intended return cargo per its price book.
- `escort(other_unit_id)` — stay within N hexes of another unit;
  fight defensively for them.
- `patrol(route_hexes)` — walk a cyclic route; engage suspicious
  movers within reach.
- `return_home()` — go back to base settlement; refuel; rest.
- `flee_to(safe_hex)` — emergency goal pushed by the unit when
  losing combat; pops on arrival.

**Constraints always apply** — every goal is subject to:

- Money: can't pay tolls / hire crew / restock without coin.
- Food: must eat on the way; out-of-rations days draw limited terrain
  forage first, then trigger starvation pressure plus a detour to the
  nearest plausible settlement.
- Health: wounded crew slow down; sickness may force rest.
- Time / season: winter mountain passes block goals that route
  through them.
- Reputation: a hostile settlement on the planned route forces a
  detour or supply shortfall.

When a goal becomes unattainable (path blocked, target settlement
hostile, target caravan destroyed), the unit's planner pops the
goal and either swaps in a fallback (return_home, fence_loot,
disband) or escalates to its owner for a new directive.

This is what lets long-running NPC behavior look intentional:
a Vibian grain caravan doesn't redecide its destination each day
— it knows it's bound for City B with grain, and only the planner
re-evaluates if conditions change materially. Goal stacks are
serialized as part of the WorldState snapshot.

## Local trade between nearby settlements (locked)

Long-haul caravans (the rest of this doc) are not the only way
goods move. The thick layer underneath them is **petty merchants
and villager pickup carts** that walk between neighboring
settlements daily, arbitraging local price spreads with small
loads.

This is what makes the no-aggregation entity model
(docs/04 §"Sizing the realistic hinterland") produce a coherent
regional economy: each village's market clears separately, but
the price differentials don't drift far before petty trade pulls
them back together.

### Mechanics

After every settlement clears its daily market (per docs/08), a
local-trade pass runs:

For each ordered pair (sellerSettlement, buyerSettlement) where
the two settlements are within the resource's local cartage range
AND travel between them is feasible (not blocked by impassable terrain
in the current season):

1. Look at every physical tradable resource with observed local
   prices. Services are not cargo, people use separate population/cargo
   systems, and coin is the settlement rail rather than a commodity in
   this pass. Find the spread:
   `spread = buyer.lastPrice - seller.lastPrice − transportCost`
2. If the spread is positive, a petty merchant moves a resource-
   appropriate quantity from a seller actor's stockpile in
   `sellerSettlement` to a buyer actor's stockpile in
   `buyerSettlement`. Household goods are capped at ~50 kg per
   pair per day, including perishables like raw milk, fresh fish,
   and game that can only plausibly move nearby. Herd capital
   (sheep/cattle/pigs/equines) walks rather than riding in a basket:
   nearby markets can move about a tenth of a herd unit per pair per
   day. Strategic workshop goods (tools, weapons, armor,
   shields, carts) use pickup-wagon lots capped around ~500 kg per
   pair per day, so smith output can reach nearby farms, workshops,
   and barracks without pretending it teleports. Bulky industrial
   inputs (ore, salt, charcoal, wood/lumber, metal bars,
   clay/stone/brick) use local cartage capped around ~3,000 kg per
   pair per day and can reach up to 6 hexes, so mine, charcoal,
   bloomery, and smithy districts can feed each other without waiting
   for long-haul caravans. Coin moves
   the other way at the midpoint price (split the spread).
3. The merchant takes a small cut (~5%) for their effort. This
   is what funds the merchant household — not modeled as a
   separate stockpile in the current model; just absorbed into
   the spread.

### Distance and cost

| Hex distance | Days to walk | Transport cost (coin/kg)    | Notes                                                        |
| ------------ | ------------ | --------------------------- | ------------------------------------------------------------ |
| 0 (same hex) | 0 ticks      | 0                           | Same-hex pagus + hamlets — free sync.                        |
| 1 (adjacent) | 1            | 0.005                       | A villager walks over with a basket.                         |
| 2            | 1            | 0.01                        | Pickup cart, half-day each way.                              |
| 3            | 1–2          | 0.02                        | Outer range for household petty trade.                       |
| 4            | 2            | 0.035                       | Industrial/workshop cartage only.                            |
| 5            | 2–3          | 0.055                       | Industrial/workshop cartage only.                            |
| 6            | 3            | 0.08                        | Outer range for ore/charcoal/metal/tool local cartage.       |
| 7+           | 3+           | use long-haul caravan rules | Out of local-trade scope; persistent caravans should handle. |

Transport cost is a fixed coin/kg surcharge added to the seller's
asking price. If buyer's price doesn't beat seller's price + cost

- merchant cut, no trade happens that day for that resource pair.

### Why this matters

- The pagus + dependent-hamlets cluster on the same hex shares
  surplus instantly: a hamlet that produced extra wool sees it
  reach the village's weaver with 0 ticks of travel.
- A rich city's market spike for grain pulls grain from every
  neighbor village within 3 hexes within a day or two — the
  classic "city sucks the countryside dry" pattern.
- A bloomery six hexes from an ore village can still buy ore by
  cartage if the spread pays for the heavy haul. The same distance
  does not move bread or grain through the petty-trade pass.
- A village starting to starve sees its grain price spike, and
  neighbors with surplus respond _before_ the long-haul caravan
  AI notices the opportunity.
- Famine still happens — but only when the WHOLE region's
  surplus is exhausted, not because the village across the road
  hadn't been visited by a caravan recently.

### Local trade vs. long-haul caravans

| Local trade                                                                                                                          | Long-haul caravan                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| ≤3 hexes for household goods; ≤6 hexes for industrial/workshop cartage, daily                                                        | Beyond local-cartage range, multi-day                  |
| Basket load for household goods; wagon lots for strategic workshop goods; cartage load for local industrial inputs                   | Large load (50–1500 kg)                                |
| No persistent unit; abstracted as a daily pass                                                                                       | Persistent Caravan entity with crew/animals/goal stack |
| Smooths regional spreads                                                                                                             | Connects regions that don't touch                      |
| Can't be raided (too small, too dispersed)                                                                                           | Real ambush risk                                       |
| Free same-hex (the canonical pagus case); heavy cartage pays steep coin/kg costs and only fires when the spread can support the haul | Same-hex moot — caravans are inter-region              |

Local-trade is a tick-loop pass over Settlement pairs (no separate
unit). Long-haul caravans are full units with movement, cargo,
crew, and risk. Both flow through the same actor stockpiles, so
trade activity from EITHER source updates the same market state.

### Same-hex coexistence (locked, cross-ref docs/05)

Per docs/05 §"Same-hex coexistence": multiple settlement entities
can share a hex (typically a _pagus_ + 1–4 dependent hamlets).
Each keeps its own market and ledgers; local trade between them
runs at the 0-hex / 0-tick rate above. They appear as offset
glyphs in the viewer and are individually clickable.

This is the only case where "same hex" matters — adjacent and
2-hex pairs walk one tick to deliver. It's also why the same-hex
exception isn't a free aggregation: each settlement's stockpile
owners, factions, and political reputation stay distinct.
