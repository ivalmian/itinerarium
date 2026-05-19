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
- **Owner**: usually a named domestic actor (the player, a patrician
  family, the governor's office, an optional `caravan_owner`, or a
  `free_village` / `hamlet_household` for short-haul villager carts).
  Cargo belongs to the owner. The exception is an edge-hub inbound
  import caravan: it is owned while on-map by the per-edge-gate
  synthetic `off_map_house` endpoint, which has no `homeSettlement`
  and is deleted/sunk when the visit ends (docs/10 §45).
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
  target and each owner's caravan cap. There is no province-wide active
  caravan slot pool; dispatch pressure is constrained by owner caps,
  animals, crew, provisions, treasury, and route economics.
- Replacement merchants prefer a normal mule train, but if transport
  animals are scarce they can launch a smaller pack train once the owner
  has at least one herd-unit (~six animals) plus starter rations. This
  keeps the fleet constrained by real equine stock without requiring a
  perfect full-size caravan before any commerce can restart.
- A cash-rich owner does not need the equines to already sit in its own
  stockpile: assembly can first buy local pack animals from another
  stockpile owner at the observed market price, then transfer those
  animals into the caravan.
- During burn-in, wealthy patrician families and optional
  `caravan_owner` actors may assemble replacement caravans when the
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
| Steppe / urban              | 1          | 1.25       | 5          |
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
   them) and their wear-counter doesn't decay while the road is
   maintained — both behaviors landed in `addRoadWear`/
   `trailWearTickPhase`. **Maintenance has a real cost**:
   quarterly (every 91 days) `roadMaintenancePhase` drains 0.1
   coin per Roman-road hex from the governor's treasury. After 4
   consecutive unfunded quarters the hex demotes to `dirt`
   (`roadWear` reseeds to 100 so it doesn't immediately decay
   further); the demote emits `road_unmaintained`.
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
| `ROMAN_WEARS`                   | false   | Roman roads don't accrue trail wear; quarterly maintenance can still demote them     |

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

## International ventures (locked, v1.6)

Some goods come from beyond the mapped world. Some go to it. Both
move on **real caravans**, but the owner differs by direction. Exports
are dispatched by named on-map patrician families and merchant guilds;
imports are inbound edge-hub visits owned by per-edge-gate synthetic
`off_map_house` actors. The off-map destination is abstract (see
[08 — Money & Trade](08-money-and-trade.md)) but every on-map step is
fully simulated.

The old sparse import-house spawn schedule is gone, but the current
implementation still evaluates edge trade every day with high safety
caps and stochastic spawn probabilities. **No off-map merchant has a
permanent on-map base**: there is no "import house" with an on-map
`homeSettlement`. (See §"Edge-hub inbound visits" below.)

### Who dispatches a venture

**Patrician families** and **merchant guilds** at large/small cities
are the only dispatchers. Each evaluates routes daily using its own
`knownPrices` map (see §"Caravan information model" below) and its
own treasury. Other actors (city-corp, governor, household actors)
do not run international caravans.

### Venture dispatch criterion (3× transport cost)

For every (resource, destination) pair an actor knows a remote price
for, it computes:

```
expected_profit =
    quantity × (remote_known_bid - home_known_ask)
  - transport_cost
expected_transport_cost =
    crew_wages × total_days
  + animal_feed_kg × total_days × feed_price
  + cart_wear_coin
  + bandit_loss_expectation × cargo_value
  + tolls
total_days = home→edge + 20 sojourn + edge→home
```

A venture dispatches when **expected_profit ≥ 3 × expected_transport_cost**.
The 3× threshold reflects the real reluctance of Roman merchants to
commit capital + months of time + cargo-loss risk to long-haul trade
unless the upside is well above the bare break-even.

The dispatcher debits the projected `transport_cost + home-market
purchase price × cargo_qty` from its treasury when assembling the
caravan. If the actor can't afford it, no dispatch. The dispatcher
collects the caravan's profit when the caravan returns home and
remits surplus cash at the home-market visit (per the standard
lifecycle rule).

### The 20-tick off-map sojourn (locked)

A caravan dispatched to the global market follows this path:

1. Walks from home settlement to its chosen edge hex (normal
   on-map movement).
2. **At the edge hex (day E):** sells outbound cargo to the global
   market at the global reference price (paid in coin from the
   global market — see [08](08-money-and-trade.md) §"The off-map
   global market"). Optionally buys return cargo at the global
   reference price.
3. **Enters `off_map` state.** The caravan disappears from the
   on-map grid; it is not rendered, cannot be ambushed, cannot
   be intercepted, and does not appear in any spatial index. **It
   is still ticking, though:** crew wages, animal fodder, and cart
   wear continue to accrue against its operating treasury for **20
   ticks** (days). No revenue accrues during the sojourn — this is
   pure cost representing the off-map portion of the journey.
4. **On day E + 20:** the caravan re-emerges at the same edge hex
   with its return cargo intact (if any) and walks back to its
   owner's home settlement. Bandit ambush risk applies normally on
   the on-map return leg.
5. At home: sells return cargo at the local market (bid/ask, just
   like any other caravan); remits surplus to the dispatcher.

Important: **provisioning at dispatch must cover the full trip,
including the 20 sojourn days.** A caravan that leaves home with
`(home→edge + 1) ration days` will starve in the off-map sojourn —
the dispatcher's pre-flight loadout calculation must include `20`
in `total_days` for both rations and fodder. Same goes for any
carried bank of `goods.coin` the venture needs for its return-cargo
purchase at the edge hex.

A single 20-tick sojourn duration applies to every edge gate. We
don't model destination diversity (Egypt vs. Britain vs. Gaul) in
v1.6 — that's a procgen-flavor extension for later.

### Global market is an infinite-demand sink

The edge hex itself is the global-market venue. The global market
has effectively infinite buying and selling capacity at the
[global reference price](08-money-and-trade.md#the-off-map-global-market-locked) —
a caravan arriving at the edge hex can dump its entire cargo and
fill its capacity from the global market without slippage. The market
itself does not impose slippage; the code still keeps high per-edge-flow
daily and active-fleet safety caps around the edge-hub pipeline so it
cannot appear as one discontinuous burst.

### What restrains volume

The code has high finite per-day and active-fleet caps on the edge-hub
pipeline (`20` import spawns/day, `30` export spawns/day, `200` active
imports, `300` active exports). These are safety rails, not global
slots and not the economic throttle. What keeps trade volumes from
exploding is the **margin gate + bounded actor information**:

- A patrician or merchant-guild export dispatcher in City A only knows the prices it has
  seen via its own returning caravans + carrier-piggyback news. A
  destination that no caravan has reached recently has unknown
  remote prices — the actor cannot rationally dispatch a venture
  there.
- Once a route gets exploited, the local home-market ask price for
  the exported good rises (because supply is being drained) and
  the remote bid price falls (because the global market's
  reference price doesn't drift, but the caravan that arrives and
  competes for the local return cargo at the destination affects
  the destination's local market). The 3× margin shrinks; further
  ventures wait.
- Real treasury and stockpile constraints. A patrician with 20,000
  coin and limited cargo can't dispatch 50 simultaneous ventures;
  an inbound off-map import only spawns when a target town/city has a
  positive landed scarcity margin.

These together produce the right shape: profitable routes attract a
few ventures, prices converge, dispatch slows. The high caps prevent
runaway load but are not meant to determine normal trade volume.

### Player and international ventures

The **player cannot dispatch international caravans** in the
current scope (matches the existing rule). Long-haul export is the
business of established patrician houses and guilds with the
capital, network, and patience for multi-month round-trips. The
player operates inside the map.

### Edge-hub inbound visits (locked, v1.9)

In addition to domestic outbound ventures (above), the **off-map
global market dispatches its own merchants who visit our province**.
These are the "edge-hub inbound" caravans. They model the
realistic counterpart: Syrian, Egyptian, and Gallic merchants who
brought their wares to Italian markets, sold them, looked for
something worth carrying home, and left.

**No off-map merchant has a permanent on-map presence.** There is
no `off_map_house` actor with an on-map `homeSettlement`. Domestic
caravans are owned by domestic actors (`patrician_family`,
`caravan_owner`, `governor_office`, `free_village`,
`hamlet_household`, or export-dispatching `merchant_guild`). The
per-edge-gate synthetic actor (kind `off_map_house`, no home
settlement) exists solely as the accounting endpoint for inbound
visits — it owns the inbound caravan while it is on-map and is the
sink for value that returns off-map.

**Lifecycle of an inbound off-map caravan:**

1. **Spawned at an edge gate** by the edge-hub phase with an
   import cargo loaded at off-map reference prices. The owner is
   the synthetic `off_map_house` for that gate hex.
2. **Walks to an on-map destination city** (chosen for high demand
   on its cargo).
3. **Sells imported cargo at the local market.** Local buyers pay
   coin to the caravan's operating treasury.
4. **Evaluates profitable return cargo** before turning around.
   For each resource available at the local market, the caravan
   compares `(global_reference_price − local_ask − transport_cost
   per kg back to the edge)`. If positive on any resource, the
   caravan buys it up to its capacity and treasury, prioritizing
   highest margin per kg.
5. **Walks back to the same edge gate.** May be ambushed on the
   on-map leg.
6. **At the edge gate (return):** sells any carried cargo to the
   global market at the global reference price. **The caravan is
   then deleted along with its entire operating treasury.** Coin
   that returns off-map is physically destroyed from our economy —
   it represents real wealth leaving the province with the
   merchant. There is no remittance, no home-actor settlement,
   no provincial savings account.

The cash-deletion step is the load-bearing realism mechanic: it
closes the foreign-trade loop. Imports physically arrive; goods
physically leave; coin paid to foreign merchants physically leaves
with them. Provincial treasuries equilibrate against the trade
deficit/surplus naturally — coin only "stays" if exports out-earn
imports, and vice versa.

**Consequence**: there is no `consign` path for unsold imports.
If the inbound caravan can't sell some of its imports in the
destination city for coin, those goods stay in its cargo and ship
back off-map at the end of the visit. The destination does not
receive free inventory.

**Owner kinds by caravan class in the implementation**:

- Warm-start standing caravans: `patrician_family` and
  `governor_office`.
- Replacement standing merchant caravans: `patrician_family` and
  `caravan_owner` if such an owner exists.
- Outbound edge exports: `patrician_family` and `merchant_guild`.
- Tax shipments: `governor_office`.
- Villager carts: `free_village` / `hamlet_household`.
- Inbound edge imports: synthetic `off_map_house` endpoint only.

`off_map_house` is **never** a warm-start or replacement standing-
merchant owner; it only owns temporary inbound edge-hub visits.

## Caravan information model (locked, v1.6)

Caravan dispatch + market participation depends on **what each actor
knows about prices**. There is no global price oracle. Each
**Actor** carries a per-settlement snapshot of the market state they
last observed there:

```
Actor.knownPrices: Map<SettlementId, MarketObservation>

MarketObservation {
  quotes: Map<ResourceId, ResourceQuote>   // whole-ladder snapshot
  observedDay: Day                          // when this snapshot was taken
}

ResourceQuote {
  bestAsk: integer coin
  bestBid: integer coin
}
```

The granularity is **one observation per (actor, settlement)** — not
per-resource. When you walk to city X and see the market, you see
the WHOLE market on that day, not separate per-resource events.

### Merge rule: newer date always wins, atomically

Two observations of the same settlement reconcile as follows: the
one with the higher `observedDay` wins **entirely**. The older
observation — and every resource quote in it — is discarded. There
is no per-resource merge. If today's snapshot is missing wine
because the wine market didn't clear that day, the actor's wine
quote is now "unknown" even if a 60-day-old observation had a wine
quote. This matches the "what I last heard about city X" mental
model.

### No deception: shared observations are authoritative

When two actors share their `knownPrices`, they transmit
**authoritative quotes** — there is no deceptive-misinformation
channel. Hostile reputation gates the **decision to share** (a
hostile counterparty refuses to talk; see [13 — Reputation](13-reputation-and-relationships.md)),
but it never causes one party to feed the other false numbers.
Real merchants who got caught lying about market prices lost their
trade network; the model reflects that.

### All knowledge comes from syncs (no magical home channel)

Every observation in `knownPrices` comes from a **physical sync
event** — there is no "you implicitly know your home settlement"
shortcut. The cases:

1. **Resident-presence sync (daily, automatic).** Actors that
   physically live at a settlement — patrician families, free
   villages, hamlet households, plebeian / freedman / foreigner
   households, governor's office, temple, city corporation,
   merchant guild — are present at their home settlement every
   day. Their `knownPrices[home]` is refreshed each tick with
   that settlement's current market state, stamped to today. This
   is **not magic**; it's literally "I live here, I see the forum
   prices today." Bandit camps anchored to a hex with no
   settlement don't get this; they have to send a real unit to
   the nearest market.
2. **Arrival sync.** When any mobile unit (caravan, news
   carrier, patrol, migration column, the player) arrives at a
   settlement on day D, the unit's owner gets a fresh
   `MarketObservation` for that settlement stamped to D. The
   unit and owner share the same map; the unit observes and
   writes, the owner reads for dispatch decisions.
3. **Meeting sync (piggyback).** When two friendly units share a
   hex on the same day OR are both at the same settlement on the
   same day, each owner merges in everything the other owner
   knows. Per-settlement, newer day wins. This is the transitive
   long-distance channel: A's day-30 observation of city X reaches
   C several weeks later if A→B→C met on consecutive days.
4. **Guild ledger sync.** A merchant guild is itself a resident
   actor that holds a `knownPrices` map. Members visiting the
   guild perform a meeting sync against the guild's map. The
   guild's map gets refreshed whenever any member is on-site, so
   it acts as a same-city aggregation of member knowledge. See
   docs/08 §"Communicated price discovery via guilds".
5. **City-crier sync.** Each city with a patrician family can
   maintain one patrician-funded city crier. The crier has his own
   `knownPrices` map, walks a deterministic greedy nearest-neighbor
   circuit from the city through the villages and hamlets tied to
   that city, then returns home to restock. Client villages use their
   `clientPatron`'s city; other rural stops fall back to the nearest
   city. At every stop the crier records that settlement's current
   market snapshot and mutually merges with resident / stockpile-owner
   actors there. He does **not** know remote shortages or prices until
   he physically reaches a place or hears them from someone present.
   If he fails to check back into the city for over 30 days, the
   city replaces him.
6. **Edge-hex observation.** A caravan that touches an edge hex
   observes the **global reference price** as a full
   `MarketObservation`, with `quotes` populated from the global
   palette and stamped to today. The owner learns the global
   prices when this caravan-owner sync happens. (Procgen seeds
   guild-member maps with a day-0 global observation to model the
   institutional consular-report channel.)

### No deception, no provenance tracking

Shared observations are always **authoritative** — there is no
deceptive-misinformation channel. Hostile reputation gates the
**decision to share** (hostile units refuse to talk; see
docs/13), but never causes false numbers. By design we don't
track who-told-whom: A→B→C transitive gossip means C's day-30
observation of city X has no remaining record of going through B.
Only `observedDay` survives, because that's what controls
staleness and merge precedence.

### Information decay

A `MarketObservation` older than **180 days** is treated as
missing on read. A 6-month-old price is too stale to commit a
multi-month venture against. Stale entries are pruned lazily on
read (not on store).

### What gets written

`knownPrices` is updated **only** by physical-unit events:
caravan/patrol/news-carrier/city-crier observations and meets. **It is
NEVER updated by reading a global state directly.** A patrician
in City A learns City B's market only because someone walked
there and back, or because someone who walked there and back met
someone the patrician's caravan later met. This is the "no
hidden hands" rule, made literal for prices.

### Snapshot

`knownPrices` is part of every actor's snapshot, and each persistent
city crier's own `knownPrices` map is snapshotted with the crier.
Schema version bumps when either shape changes.

### Initial state (procgen)

At world generation, only physical-presence + institutional
syncs run:

- Every **resident actor** is at their home settlement on day 0,
  so the day-0 resident-presence sync records a fresh
  `MarketObservation` for home. (After day 0 this continues
  automatically every tick as long as the actor remains a
  resident.)
- **Merchant guilds** are seeded with a day-0 `MarketObservation`
  of the global reference prices at every edge hex — modeling the
  consular trade reports / institutional intelligence that
  historical guilds maintained. Guild **members** pick this up
  through the next member-visits-guild meeting sync; non-members
  don't get it.
- Mobile units (any seeded standing caravans, villager carts,
  patrols) carry whatever their owner knows at the moment of
  dispatch. The owner has a day-0 home observation; the caravan
  inherits it. As the caravan walks, it picks up arrival /
  meeting syncs and the owner's map updates accordingly.
- City criers are spawned by the tick loop after markets clear, not
  preloaded as a global oracle. Their first act is to observe their
  home city, then they physically walk the greedy rural circuit and
  carry only what they learned.
- No actor knows any other settlement's prices at world start.
  The first wave of seeded standing caravans + villager carts
  plus city criers propagates information across the map during Q1.

## Caravan lifecycle in the tick loop (locked)

Per-day, for every NPC caravan in `world.caravans`:

1. **Movement phase**: if caravan has a destination, advance via A\*
   (already implemented). Emit `caravan_moved`/`caravan_arrived`.
2. **Trade-on-arrival** (politics phase): if a caravan is at its
   destination AND has a settlement on that hex, the caravan
   **participates in the settlement's market as a regular actor**:
   it submits **asks** for goods in its cargo and **bids** for
   goods it intends to buy (rations to top up to its provisioning
   target, plus any next-leg cargo identified by its planner). All
   asks and bids are integer-coin per docs/08 §"Integer-coin
   prices"; the caravan owns its asks and the trades clear through
   the standard CDA market alongside resident actors. Cross-settlement
   trade happens by market purchase and sale. A villager caravan can
   deliver already-owned imports into its owner's home stockpile on
   return, but acquisition still happened via a market ask at the
   visited settlement; this is not a third-party stockpile bypass.
   The owner's home-market visit similarly remits surplus cash by
   selling accumulated cargo through the market, not by mailing coin to
   the owner's treasury. Caravan-as-market-participant applies
   uniformly to standing merchants, villager carts, replacement
   caravans, edge-hub returning ventures, and the player. See
   docs/08 §"Caravans transact via local markets; owned cargo can be
   delivered home".
3. **Edge-hex global-market transaction**: if a caravan arrives at
   an edge hex with cargo destined for the global market, it sells
   the cargo at the global reference price (paid in coin from the
   global market — an unbounded buyer) and optionally fills its
   capacity with return cargo at the global reference price. Then
   it enters `off_map` state for 20 ticks (see §"International
   ventures" → §"The 20-tick off-map sojourn").
4. **Re-plan** (same politics phase): after the trade, the
   caravan's planner re-evaluates routes using its owner's
   `knownPrices` map (caravans share the owner's map — they
   observe and update it; the owner reads it for venture
   decisions). The planner returns `RoutePlan | null`. If plan,
   set `caravan.destination` to its hex; if null, caravan scouts
   for prices using the same known bandit-density map as route
   planning. Low-ration caravans still bias toward nearby markets,
   but known ambush corridors count as extra effective distance.
   Well-provisioned scouts choose among low-risk nearby
   alternatives rather than rolling blindly into a camp.
5. **Replacement assembly**: if the active standing merchant fleet
   is below target, eligible owners can fund a small number of
   replacement caravans from their own treasuries and
   transport-capital stockpiles. The owner first **buys carts and
   equines on its home market** (a regular bid alongside other
   buyers), then loads outbound cargo by **buying it on the home
   market** (not draining its own stockpile). New caravans start
   at the owner's home market and enter the same arrival/re-plan
   logic on the next tick.

**Disbanding**: a caravan with empty cargo + zero coin + no
profitable route for 30 consecutive days disbands; crew + animals
join the local population pool. Captured carts go to local
inventory.

**Re-routing means commerce circulates.** Without this loop, every
NPC caravan walks to its seeded destination once and then stands
still forever (the old baseline before this section was added).

## NPC caravan AI

NPC merchants run an expected-profit calculation against their
**owner's `knownPrices` map** — not against a global oracle:

```
expected_profit =
    sum_over_cargo (
        owner.knownPrices[destination][resource].bestBid
      - owner.knownPrices[origin][resource].bestAsk
    ) × cargo_qty
  - travel_cost_full_operating
  - expected_loss_from_risk
  - tolls_and_tariffs
```

Destinations whose `knownPrices` entry is `undefined` or older than
180 days are simply not eligible as candidates — the merchant
cannot rationally plan a trip to a city it has no recent
intelligence on. This is what makes the "no hidden hands" rule
actually constrain dispatch.

`travel_cost_full_operating` is the **full operating cost** of the
trip: crew wages × days + carried-fodder share × days + cart wear
+ expected bandit-loss × cargo value + tolls. International
ventures additionally include the 20-day off-map sojourn in `days`.
The 3× threshold (§"Venture dispatch criterion") applies only to
**international** dispatches — domestic ventures use the standard
positive-margin filter.

Cargo planning is a microeconomic feasible-set problem: the
merchant ranks goods by expected margin per kg, then caps the
load by carrying capacity already occupied, missing ration-reserve
capacity, **cash available after survival + the home-market
purchase cost** (because cargo is acquired through a market bid,
not pulled from owner stockpile), and stock-actually-clearing-at-a-bid-the-owner-can-afford
in the origin market. Fresh perishables are only planned for routes
whose estimated travel time fits inside their shelf life; milk,
fresh fish, and game therefore remain local/nearby flows while
cheese, salted foods, wine, oil, metals, and exotics can support
longer hauls. This keeps planned demand consistent with the local
market the caravan can really buy from.

When the expected-profit calculation returns no plan, scouting is still
economic behavior rather than Brownian motion. The caravan is buying
information with time, rations, and risk exposure, so it should avoid
known bandit corridors unless hunger makes the nearest reachable market
the least bad option.

Family caravans (run by a patrician family) have additional
priorities: moving family goods to market, supplying the family
town house, returning rents in kind from owned villages.

**Villager caravans** are a separate low-capacity sub-type dispatched
by `free_village` and `hamlet_household`
stewards. Same planner logic, but smaller: 2-4 mules, optional
donkey, 1 drover + 1 guard, no light cart, operating treasury
50-250 coin. The dispatch trigger covers everyday village / hamlet
market runs:

- **surplus run** — village has any exportable inventory (food,
  fibre, wood, hides, livestock, cloth) above ~14 days of local
  use;
- **import trip** — steward has a home-learned shortage, currently
  production tools, and either a known affordable source or a sellable
  surplus trip that can fund the import;
- **hard-times resupply** — village grain is under 7 days of
  subsistence AND the steward has any cash, so coin drains out
  to fund a buy-back run.

The caravan's ID carries the `villager-` prefix so the viewer
renders it with the dedicated handcart glyph. Per-owner cap = 3
active. There is no global rural slot pool. Every qualifying steward
can try to dispatch on its assembly cadence, but the dispatch still has
to clear local constraints: pack animals, starter rations, operating
treasury, per-owner cap, and a demand-backed mission.

Villager caravans have one owner-specific import behavior on top of
normal arbitrage. The owner records import demand before departure from
its home stockpile state; the caravan does not remotely re-check home
shortage while away. If that planned demand includes `goods.tools`, the
caravan may buy whole tool kits at a visited market and route directly
home. On arrival at the owner's home settlement, any imported cargo is
unloaded into the owner stockpile before ordinary local sale. The
purchase still happens through the visited market's bid/ask supply; the
home unload is delivery of already-owned cargo into the steward's
physical stockpile.

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

## Local trade between nearby settlements (locked, v1.6)

Local trade beyond same-hex is **not** a daily-pass abstraction. The
old `localTradePhase` behavior that teleported goods between distinct
hexes based on spread calculation is **deleted**. The remaining
implementation is same-hex only. Realism rule (per user
direction): a villager walking a cart of grain to the next pagus is
exposed to the **same ambush, weather, disease, and food-supply
risks** as a 50-mule merchant train walking the same road. A grain
cart cannot pass through a bandit ambush corridor unscathed just
because the model abstracts the trip away. Therefore every inter-
settlement trade flow goes through a **real caravan unit** with a
position on the map, a goal stack, food consumption, ambush
exposure, and a snapshot identity.

The **villager caravan** subsystem is the implemented low-capacity
local-trade vehicle. Free-village and
hamlet stewards spawn real caravans; the normal caravan planner then
chooses routes from known prices / fallback scouting. There is no
separate hidden daily-pass for adjacent settlements.

### Caravan size tiers (locked, v1.6)

All caravans share the SAME machinery (movement / food / ambush
exposure / disease vector / snapshot identity). They differ only in
size, dispatcher, and typical route length:

| Tier | Cargo cap | Crew + animals | Typical dispatcher | Typical range |
|------|-----------|----------------|---------------------|---------------|
| **Villager pack caravan** | ~200–450 kg gross before rations | 1 drover + 1 guard, 2–4 mules plus optional donkey, pack saddle | `free_village` / `hamlet_household` steward | usually short because treasury/capacity are small; no abstract 6-hex daily-pass cap |
| **Standing merchant** | 500 – 1,500 kg | full crew + escort, 10–50 mules or wagons | warm-start: `patrician_family` / `governor_office`; replacement: `patrician_family` / optional `caravan_owner` | multi-cluster, multi-day |
| **International venture** | 500 – 1,500 kg | full crew + escort | outbound: `patrician_family` / `merchant_guild`; inbound: synthetic `off_map_house` | export: home → edge hex → 20-tick sojourn → home; import: edge → city → edge |

Cargo caps come from the animals / vehicles on the actual unit, NOT
from a pair-wise daily flow rate. A village steward dispatching a
small pack caravan creates ONE caravan unit. If later planning still
finds a viable route, another unit may dispatch within the owner and
world caps.

### Why all tiers see the same risk

This is the user's direct realism call: **a peasant on a road carrying
a cart of grain is as ambush-exposed as a senatorial merchant**.
Bandits don't filter targets by abstraction layer. Plague carriers
don't either. So the petty arc must use the same mechanics:

- **Movement** uses the same per-hex / per-terrain / per-season cost
  model (§"Movement").
- **Food consumption** uses the same crew-rations + animal-fodder
  rules. A villager pack caravan feeds its drover, guard, and
  pack animals.
- **Ambush exposure** uses the same bandit-density roll. Smaller,
  lightly defended units are easier targets — the same ambush
  formula naturally produces this (low `guardScore` × low
  `weaponsScore`).
- **Disease** uses the same caravan-as-vector rule. An infected
  villager caravan entering a clean village can spark a local
  outbreak.
- **Snapshot** carries the same `Caravan` fields. There is no
  separate "petty" type — only different size parameters.

### Dispatch triggers (locked, v1.6)

A `free_village` or `hamlet_household` steward is eligible to
dispatch when the home settlement is a village or hamlet, the owner
has at least the minimum operating treasury, it is under the per-owner
active cap, and one of these conditions is true:

1. **Surplus run** — exportable inventory is meaningfully above a
   local-use reserve.
2. **Import trip** — the steward has accumulated enough treasury to
   buy goods the settlement cannot make.
3. **Hard-times resupply** — grain stocks are critically low and the
   steward has cash to fetch staples back.

Dispatch does not itself pick an adjacent arbitrage target. Once the
unit exists, the normal caravan planner uses the caravan's
`knownPrices`, bid-depth estimates, route costs, bandit risk, tolls,
and fallback scouting to choose a destination. A village with stale
or missing observations can still scout, but it does not receive a
hidden price oracle. If the caravan is away from home and can buy whole
tool kits for a tool-poor home stockpile, that home-import leg can
override the generic arbitrage plan.

### Same-hex coexistence is the ONLY zero-tick case

Per docs/05 §"Same-hex coexistence": pagus + 1–4 dependent
hamlets share a literal hex. Trade between THEM only is a 0-tick
intra-hex transfer — but it still goes through each settlement's
CDA market (the buyer's bid clears against the seller's ask at the
clearing price). No unit is dispatched because no road crossing
is involved.

**Every other distance — even 1 hex — uses a real caravan unit**
that walks the route, consumes rations, rolls for ambush, and may
arrive sick.

### Distance and cost (still useful as planner heuristics)

| Hex distance | Days to walk (laden mule) | Approx round-trip operating cost |
|--------------|-----|-----|
| 0 (same hex) | 0 | 0 (intra-hex market clearing only) |
| 1 (adjacent) | 1 each way | wages + fodder for 2 days + cart wear |
| 2 | 1 each way | 2 days |
| 3 | 1–2 each way | 3 days |
| 4 | 2 each way | 4 days |
| 5 | 2–3 each way | 5 days |
| 6 | 3 each way | 6 days |
| 7+ | 3+ each way | same operating-cost model; small caravans rarely profit |

There is no hard 6-hex local-trade cap in the implementation. Longer
routes are naturally discouraged because a small villager pack caravan
has limited cargo capacity, limited treasury, ration/fodder needs, and
the same risk model as larger caravans. The old fixed coin/kg
local-cartage surcharge is not used for distance >= 1 trade.

### Why this matters

- The pagus + dependent-hamlets cluster on the same hex shares
  surplus instantly via market clearing: a hamlet that produced
  extra wool sees it reach the village's weaver same-tick.
- A rich city's market spike for grain can pull grain from villages
  whose stewards have stock, cash, observations, and viable routes -
  but each shipment is a real villager caravan on the road, taking
  real days, exposed to real bandits. The "city sucks the countryside
  dry" pattern emerges only through dispatchable units.
- A village starting to starve sees its grain price spike; a
  neighbor with surplus can dispatch a real villager caravan that
  walks the route, arrives, and clears its bid at the famished
  market. The caravan can be ambushed en route - and is, sometimes.
- Famine still happens — but it can happen because the regional
  surplus genuinely failed, OR because the road between two
  settlements is unsafe and the cart never arrived.

### Local petty trade vs. long-haul caravans

| Villager pack caravan | Standing merchant / international |
|-----------------------------|-----------------------------------|
| 2–4 mule pack caravan, optional donkey | Larger mule train or wagon, 10–50 animals |
| Originates at village/hamlet; route chosen by normal planner from known prices or fallback scouting | Any city-based dispatcher; route anywhere with information |
| Dispatched by `free_village` / `hamlet_household` steward | Standing replacement by `patrician_family` / optional `caravan_owner`; outbound edge exports by `patrician_family` / `merchant_guild`; tax shipments by `governor_office`; inbound imports by synthetic `off_map_house` |
| Usually short because capacity, treasury, and rations are small; no hidden local-trade distance cap | Multi-cluster, multi-day, possibly international (with 20-tick off-map sojourn) |
| **Real Caravan unit with full movement / food / ambush / disease machinery** | Same |
| Buys + sells via the destination's CDA market (bid/ask); owned imports unload into the home stockpile on return | Same market transaction discipline; no owner-home unload except normal profit/cargo refund on disband |
| Cheaper to lose (less capital exposed) but proportionally less defended | Bigger losses possible but proportionally better defended |

Both buy and sell through the same per-settlement markets via bid/ask.
Villager caravans additionally unload already-owned imports into the
steward's home stockpile on return; this is delivery after a market
purchase, not a cross-settlement trade bypass. The main differences are size,
dispatcher class, and typical route length. **There is no "local
trade abstraction"** — every inter-settlement trade is a Caravan
unit that walked the route.

### Same-hex coexistence (locked, cross-ref docs/05)

Per docs/05 §"Same-hex coexistence": multiple settlement entities
can share a hex (typically a _pagus_ + 1–4 dependent hamlets).
Each keeps its own market and ledgers. Because they're literally
on the same hex (a few hundred meters apart, no road crossing
involved), inter-settlement bids/asks between THEM clear in a
zero-tick intra-hex market step — no caravan unit is dispatched
because there is no road to walk. They appear as offset glyphs in
the viewer and are individually clickable.

This is the **only** case where "same hex" matters. Adjacent
(1-hex) and farther pairs always dispatch a real caravan unit,
because a 1-km road crossing is enough exposure to ambush /
weather / disease to count. The same-hex exception isn't a free
aggregation: each settlement's stockpile owners, factions, and
political reputation stay distinct, and the inter-settlement
intra-hex clearing still respects per-actor bids/asks.
