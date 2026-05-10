# 06 — Caravans

The protagonists of the simulation. The player has one. The world has
hundreds. They're how goods, people, news, and risk move between
settlements.

**Land caravans only in v1** — sea trade is deferred (see
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

The **player cannot run off-map caravans** in v1. Long-haul export is
the business of established merchant houses with the capital,
network, and patience for multi-month round-trips.

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
