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

| Unit | Carry capacity | Fodder/day | Notes |
|---|---|---|---|
| Donkey (pack) | ~50 kg | ~3 kg | Browses marginal forage; cheap. |
| Mule (pack) | ~100 kg | ~6 kg | Roman workhorse of land trade. |
| Horse (pack) | ~80 kg | ~7 kg | Faster but more demanding. |
| Camel (pack, arid only) | ~180 kg | ~3 kg | Browses where nothing else can. |
| Ox-cart (2-wheel, ox team) | ~500 kg | ~20 kg (team) | Slow, road-bound. |
| Heavy wagon (4-wheel, ox team) | ~1,200 kg | ~30 kg (team) | Roads only. |
| Light cart (donkey/horse) | ~200 kg | ~5–7 kg | Versatile. |

Crew:

- **Drover**: handles ~5 pack animals or 1 wagon team.
- **Guard**: armed escort; needs weapons + ideally armor.
- **Merchant**: makes trade decisions; 1 per caravan suffices.
- Crew rations: ~0.4 kg grain-equivalent / crew / day.

## Movement (1 km hex, 1 day turn — locked)

Distances are real. The numbers below are **hexes per day** (= km per
day, since hex = 1 km).

| Mover | Roman road | Dirt road | Off-road (rough) | Mountain pass winter |
|---|---|---|---|---|
| Pack mule caravan, laden | ~25 | ~20 | ~10 | 0–2 |
| Pack mule caravan, light | ~30 | ~25 | ~12 | 2–4 |
| Pack donkey caravan | ~20 | ~17 | ~9 | 0–2 |
| Ox-cart, laden | ~15 | ~12 | impassable | impassable |
| Heavy wagon, laden | ~12 | ~8 | impassable | impassable |
| Walking peasant / migrant column | ~20 | ~18 | ~10 | 0–3 |
| Roman legion on march | ~30 | ~25 | ~15 | 5–10 |
| Express courier (changing horses) | ~150 | ~80 | ~30 | 5–15 |

These are first-pass; tunable. Movement progress accumulates as a
fraction; partial movement carries to the next day. Wagons can fail
in mud, snow, or steep climbs. Crossing a river needs a ford or
bridge or a delay.

Implication: a mule caravan crossing a 100-km province takes ~4 days
on a Roman road, ~5 days on dirt, ~10+ days off-road. A famine
relief caravan is a real number of days late, not "instant on the
turn the famine starts."

### Terrain difficulty model (locked)

Movement cost is computed as `base_movement_per_day / difficulty`,
where difficulty is determined by the hex's terrain × road grade,
modified by the mover's equipment / animals / load. Higher difficulty
= slower. Reference difficulty factors (lower = easier):

| Hex | Roman road | Dirt road | Off-road |
|---|---|---|---|
| Plains / fertile valley | 1 | 1.25 | 2.5 |
| Coast / steppe / urban | 1 | 1.25 | 2.5 |
| Hills / desert | 1 | 1.5 | 3.5 |
| Forest | 1 | 1.5 | 4 |
| Dense forest | 1 | 2 | 6 |
| Marsh | 1 | 2 | 5 |
| Mountains (summer) | 1 | 2 | 8 |
| Mountains (winter) | impassable | impassable | impassable |
| River (without ford/bridge) | impassable | impassable | impassable |
| Lake | impassable | impassable | impassable |

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
   - +1 per pack-mule equivalent (~50 kg cargo capacity)
   - +0.5 per crew member (people on foot pack the trail too,
     just less than animals)
   - +0.2 per news carrier (single person walking)
   - +0.5 per patrol soldier
   So a 50-mule + 12-crew caravan crossing a hex adds 50 + 6 = 56
   wear. A two-soldier patrol adds 1.
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
   `road = 'none'`. Wear keeps accruing during the dirt phase, so
   a popular dirt road builds up reserve and won't snap back the
   first quiet week.

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

| Constant | Default | Meaning |
|---|---|---|
| `WEAR_PER_PACK_ANIMAL` | 1.0 | per hex entered |
| `WEAR_PER_CREW` | 0.5 | per hex entered |
| `WEAR_PER_NEWS_CARRIER` | 0.2 | per hex entered |
| `WEAR_PER_PATROL_SOLDIER` | 0.5 | per hex entered |
| `WEAR_DECAY_PER_DAY` | 1.0 | per hex with wear > 0 |
| `DIRT_UPGRADE_THRESHOLD` | 100 | wear needed to upgrade `none` → `dirt` |
| `DIRT_DOWNGRADE_THRESHOLD` | 20 | wear floor below which `dirt` → `none` |
| `ROMAN_WEARS` | false | Roman roads don't accrue wear or decay |

A medium caravan (~10 mules, ~5 crew) puts down ~12 wear per hex
crossed. So a single caravan transit adds ~12; ~10 transits in
quick succession can take a hex from wilderness to dirt road.
That matches the intuition: the third or fourth caravan along a
route is when locals start calling it a path.

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
  seasonality), an external caravan spawns at a designated
  off-map-trade-route hex with cargo (e.g. ~1,500 kg of spices on
  30 mules, plus a dozen crew and guards).
- It walks to the nearest large city, sells, often buys local goods
  for the return (wine, oil, iron, slaves, silver), and walks back
  off the map.

### Exports

- Symmetrically, NPC long-haul merchant houses based in cities
  periodically assemble export caravans heading to off-map
  destinations.
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

1. **Movement phase**: if caravan has a destination, advance via A*
   (already implemented). Emit `caravan_moved`/`caravan_arrived`.
2. **Trade-on-arrival** (trade phase): if a caravan is at its
   destination AND has a settlement on that hex, run the local market:
   sell cargo at clearing prices into local stockpiles; buy whatever
   the price book / NPC heuristic deems most profitable to load for
   the next leg. Crew rations replenish from local stockpile (paid in
   coin from caravan treasury).
3. **Re-plan** (politics phase, after trade): after the trade, call
   `planCaravanRoute` (T37) with the caravan's updated price book +
   knownBetterDestinations. The plan returns `RoutePlan | null`. If
   plan, set `caravan.destination` to its hex; if null, caravan stays
   put (becomes idle — could disband later if nothing to do for N
   days).

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

Family caravans (run by a patrician family) have additional
priorities: moving family goods to market, supplying the family
town house, returning rents in kind from owned villages.

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
- Food: must eat on the way; out-of-rations triggers a forage
  sub-goal or detour to the nearest settlement.
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
the two settlements are within **3 hexes** of each other AND
travel between them is feasible (not blocked by impassable
terrain in the current season):

1. Look at every tradable resource. Find the spread:
   `spread = buyer.lastPrice - seller.lastPrice − transportCost`
2. If the spread is positive, a petty merchant moves a small
   quantity (capped at ~50 kg per pair per day) from a seller
   actor's stockpile in `sellerSettlement` to a buyer actor's
   stockpile in `buyerSettlement`. Coin moves the other way at
   the midpoint price (split the spread).
3. The merchant takes a small cut (~5%) for their effort. This
   is what funds the merchant household — not modeled as a
   separate stockpile in the current model; just absorbed into
   the spread.

### Distance and cost

| Hex distance | Days to walk | Transport cost (coin/kg) | Notes |
|---|---|---|---|
| 0 (same hex) | 0 ticks | 0 | Same-hex pagus + hamlets — free sync. |
| 1 (adjacent) | 1 | 0.005 | A villager walks over with a basket. |
| 2 | 1 | 0.01 | Pickup cart, half-day each way. |
| 3 | 1–2 | 0.02 | Mule with one driver, full day. |
| 4+ | 2+ | use long-haul caravan rules | Out of petty-trade scope. |

Transport cost is a fixed coin/kg surcharge added to the seller's
asking price. If buyer's price doesn't beat seller's price + cost
+ merchant cut, no trade happens that day for that resource pair.

### Why this matters

- The pagus + dependent-hamlets cluster on the same hex shares
  surplus instantly: a hamlet that produced extra wool sees it
  reach the village's weaver with 0 ticks of travel.
- A rich city's market spike for grain pulls grain from every
  neighbor village within 3 hexes within a day or two — the
  classic "city sucks the countryside dry" pattern.
- A village starting to starve sees its grain price spike, and
  neighbors with surplus respond *before* the long-haul caravan
  AI notices the opportunity.
- Famine still happens — but only when the WHOLE region's
  surplus is exhausted, not because the village across the road
  hadn't been visited by a caravan recently.

### Local trade vs. long-haul caravans

| Local trade | Long-haul caravan |
|---|---|
| ≤3 hexes, daily | 4+ hexes, multi-day |
| Small load (~50 kg/pair/day) | Large load (50–1500 kg) |
| No persistent unit; abstracted as a daily pass | Persistent Caravan entity with crew/animals/goal stack |
| Smooths regional spreads | Connects regions that don't touch |
| Can't be raided (too small, too dispersed) | Real ambush risk |
| Free same-hex (the canonical pagus case) | Same-hex moot — caravans are inter-region |

Local-trade is a tick-loop pass over Settlement pairs (no separate
unit). Long-haul caravans are full units with movement, cargo,
crew, and risk. Both flow through the same actor stockpiles, so
trade activity from EITHER source updates the same market state.

### Same-hex coexistence (locked, cross-ref docs/05)

Per docs/05 §"Same-hex coexistence": multiple settlement entities
can share a hex (typically a *pagus* + 1–4 dependent hamlets).
Each keeps its own market and ledgers; local trade between them
runs at the 0-hex / 0-tick rate above. They appear as offset
glyphs in the viewer and are individually clickable.

This is the only case where "same hex" matters — adjacent and
2-hex pairs walk one tick to deliver. It's also why the same-hex
exception isn't a free aggregation: each settlement's stockpile
owners, factions, and political reputation stay distinct.
