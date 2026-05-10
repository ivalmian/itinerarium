# 08 — Money, Prices, Trade

How the economy actually clears, given the no-hidden-hands rule.

## Money

Coin (silver/gold denominations) is one resource among many. It has
weight and volume in cargo. Settlements with mints produce it from
bullion. In backwater regions, barter dominates — caravans haul goods
directly traded for goods.

Implications worth keeping in mind:

- Carrying a million sesterces of profit home is a logistics
  problem.
- A mint that loses access to silver bullion stops minting; the
  local economy reverts toward barter.
- Coin debasement is a real thing — a state short on silver mixes
  more lead into its denarius, and merchants *notice* and adjust
  prices.

## Demand: how it forms (locked)

Each turn, in each settlement, for each resource, we compute a
**demand schedule** — how many units would be bought at each
possible price. There are four kinds of demand and they all
contribute.

### 1. Consumer subsistence demand (inelastic)

People MUST eat, salt their food, heat their homes. They will pay
**any price they can afford** to meet subsistence needs.

For each population segment `s` (see [04 — Population](04-population.md)):

```
need_per_day      = s.subsistence_need(resource)
wealth_remaining  = s.cash + s.assets_liquidatable
max_willingness   = wealth_remaining / need_per_day

quantity(p) = need_per_day               if p ≤ max_willingness
            = wealth_remaining / p       if p > max_willingness
```

The demand curve is essentially **vertical** at `need_per_day`
until price exceeds the segment's wealth-per-unit. Then the
segment begins to starve (consumption falls below need →
mortality).

Aggregating across segments produces a step function: poorest
segments fall off first as price rises, then progressively richer
ones. A famine is a price climbing the steps until enough people
have starved or fled to clear the market.

### 2. Consumer comfort demand (elastic)

For wants above subsistence (wine, oil, cheese, decent clothing,
furniture). For each segment with a comfort want:

```
want_quantity = s.comfort_want(resource)
budget        = s.discretionary_income_per_day

quantity(p) = want_quantity * decay(p / budget)
```

…where `decay()` falls smoothly to zero as `p` rises past the
segment's budget — sigmoid or exponential.

People walk away if comfort goods get expensive — they substitute
or do without.

### 3. Consumer status demand (elite, inelastic-but-deep-pockets)

For luxuries (luxury textiles, silver tableware, exotic goods).
Patrician families and the governor demand these almost regardless
of price (deep pockets), but the *quantity* is small.

```
quantity(p) = status_want   if p ≤ very_high_threshold
            = 0             otherwise
```

### 4. Producer derived input demand (rational)

This is the missing piece that makes the economy chain-react
properly. **Producers buy intermediate goods only when they expect
a profit on the downstream sale.**

For each recipe `R` that uses this resource as an input, run by
producer `o`:

```
expected_output_revenue = R.output_per_unit_input * recent_local_price(R.output)
other_costs             = labor_cost
                        + other_input_costs
                        + building_amortization
break_even_input_price  = expected_output_revenue - other_costs - margin
production_capacity     = min(building_cap, available_labor, other_inputs)
quantity_demanded       = production_capacity * R.input_per_output

quantity(p) = quantity_demanded   if p ≤ break_even_input_price
            = 0                   if p > break_even_input_price
```

A weaver only bids for wool if they can sell the cloth at a profit.
If the cloth market collapses, wool demand collapses. If the cloth
market spikes, wool demand spikes.

**Worked example**: a famine in City A spikes bread prices →
bakers can afford much higher flour prices → millers can pay more
for grain → grain caravans pour into City A from villages and
nearby cities. The whole supply chain tilts toward the famine.
This is the right behavior, and it falls out of the math without
any hand-coded "drought-response" logic.

### Aggregating demand

Per-resource aggregate demand at price `p` =
sum over all four kinds for all relevant actors. This produces a
downward-sloping step function with sharp drops where individual
willingness thresholds sit.

## Supply: how it forms

Each owner with a stockpile of the resource decides whether to sell
and at what minimum price.

```
production_cost   = recipe inputs + labor + amortization
                    (sunk, but a floor for "below this it's a loss")
opportunity_cost  = expected price next week minus storage cost
spoilage_pressure = if perishable AND days_to_spoil < holding_period,
                    urgency to sell rises
owner_urgency     = subsistence-class owners are desperate to
                    realize cash; patrician owners can wait

reservation_price = max(production_cost,
                        opportunity_cost - spoilage_pressure)
                    / (1 + owner_urgency_factor)

available_to_sell = stockpile - reserved_for_own_use

supply(p) = available_to_sell  if p ≥ reservation_price
          = 0                  if p < reservation_price
```

Aggregate supply at price `p` = sum across all owners. Upward-
sloping step function.

This is where "patricians hoard during famine" becomes emergent. A
patrician family with a full granary has `owner_urgency_factor`
near zero (they're rich) and a high `opportunity_cost` (price is
rising, they expect more tomorrow). Their reservation price climbs
with the market — they will sell, but only at prices the poor
can't pay. Riots, edicts, mob looting follow as a *consequence*,
not as scripted events.

## Market clearing

For each (settlement, resource, day):

```
price* = price where aggregate_demand(p) = aggregate_supply(p)
```

If demand exceeds supply at every nonzero price, price* climbs
until demand falls (people starve, comfort is dropped, producers
shut down). If supply exceeds demand even at zero price, price*
hits a spoilage / opportunity floor and unsold stock either
spoils or rolls forward.

Trades happen at price*: highest-WTP demanders match with
lowest-reservation sellers, in price order.

This is essentially a **continuous double auction** — the standard
microeconomics of how real markets clear. It gives all the right
emergent behavior:

- **Famine**: prices spike, rich survive, poor starve, granaries
  empty, caravans flood in until supply meets demand or the city
  dies.
- **Glut**: prices crash to spoilage floor, producers reduce next
  cycle, surplus exports if value/weight allows.
- **Cascading shocks**: a collapse in an output market propagates
  back through derived input demand to the raw materials.

### Per-settlement markets, regional smoothing

**Each settlement clears its own market.** A pagus and its three
dependent hamlets sharing a hex are *four separate markets*, each
with its own aggregate demand + aggregate supply schedules. There
is no shared "regional clearing price"; if the village runs short
of grain its price will spike before the neighbor hamlets feel it.

What pulls those four markets back into rough alignment is the
**local-trade pass** specified in
[06 — Caravans](06-caravans.md) §"Local trade between nearby
settlements": after every settlement clears, petty merchants
move small loads between settlements within 3 hexes of each
other, arbitraging price spreads down to roughly the
transport-cost band.

So:
- Same-hex spreads close to ~0 (transport cost is 0).
- Adjacent-hex spreads close to ~0.005 coin/kg.
- 3-hex spreads close to ~0.02 coin/kg.
- Beyond 3 hexes, only long-haul caravans connect markets, and
  spreads can stay wide for days or weeks — exactly when
  caravan owners notice and re-route per
  [06 — Caravans](06-caravans.md) §"NPC caravan AI".

This is what makes the no-aggregation entity model
(docs/04) coherent: 8,000 settlements with 8,000 separate
markets still produce a regional price gradient, not 8,000
disconnected wells.

## Information

Caravans don't see all prices. They remember what they've seen
and pick up news from other caravans they meet.

- Each caravan has a price book:
  `{ resource: { hex_id: (price, observation_day) } }`.
- Prices decay in confidence over time — a 6-month-old price is
  very little signal.
- When two caravans meet on the same hex, they exchange a subset
  of their price books (for a fee, or as merchant courtesy).
- News of major events (city fall, plague outbreak, war, banditry
  surge) propagates the same way — only as fast as someone carries
  it.

Arbitrage is **real labor**: finding the spread is part of the
game, not a UI feature.

## Communicated price discovery via guilds (locked)

NPC merchants are not isolated — they share information through
**merchant guilds**. Guilds are mid-level information hubs that
mediate price gossip without breaking pillar 1 (no global market).
A guild lives at a settlement; its members are NPC caravan owners
based there. Information flows:

1. **A caravan observes a price.** It updates its own price book.
2. **On return to its home guild's settlement, it deposits a copy
   of recent observations to the guild's price ledger** (a
   settlement-attached, guild-owned price book).
3. **Other guild members who arrive at the guild can read the
   ledger** — paying a guild membership fee or already being a
   member. This is a per-day update, not instant: a member
   arriving on day D reads observations the guild had on day D.
4. **Guilds talk to each other via traveling merchants.** When a
   member visits a different guild (different city), they exchange
   a subset of ledgers (also for a fee). This is the long-haul
   rumor channel.

Why this matters (and why no stampedes):

- A spike in pottery price at City B reaches the guild in City A
  several days later (when the caravan that observed it returns).
- Guild members in City A then see the spike — but they all
  receive the same info on the same day, and they each rationally
  decide based on travel time, capacity, current cargo, and other
  guild members' likely actions. **Not all jump at once because
  the calculation includes "expected competition" — if every
  guild member is heading to City B, the price will collapse by
  the time mine arrives, so I should pick a different route.**
- Crowding-aware planning: each NPC trader's planner accounts for
  visible competing caravans planning the same route (visible via
  the spatial index + guild gossip). Some defect to nearby
  alternatives; only N caravans actually commit to City B.
- Result: the price spike attracts more caravans over a few days
  (not all at once), the surplus arrives gradually, the price
  normalizes over a week, and the system settles. Natural
  liquidity, no stampedes.

Guilds are also the network through which the player's reputation
spreads among honest merchants (cross-ref
[13 — Reputation](13-reputation-and-relationships.md)).

## The off-map global market (locked)

Beyond the playable map there is an abstract **global market**.

It has:

- Slowly drifting reference prices for all goods.
- Effectively infinite buying and selling capacity (the rest of
  the world is too big for one province to move it).
- Reachable only via long, expensive caravans (see edge-hub
  caravans in [06 — Caravans](06-caravans.md)).

In practice:

- **Imports**: external caravans periodically arrive at edge
  hexes carrying goods bought at off-map global prices, looking
  to sell at local prices. Their margin covers their costs.
- **Exports**: NPC long-haul merchant houses based in our cities
  periodically assemble caravans of high-value low-weight goods
  to ship out. Their margin (local price → global price) covers
  their costs.

### Why imports and exports are dominated by luxuries (emergent)

- The fixed cost of a long-haul caravan (food, fodder, animal
  wear, guards over weeks of travel) is **per-unit-weight**, not
  per-unit-value.
- For grain and other low-value bulk staples, the spread between
  local and global prices doesn't cover the per-kg transport cost.
  These stay local.
- For spices, silk, silver, fine cloth, and amphora-packed oil/wine
  when quality or scarcity makes the spread high enough, the spread
  per kg can cover transport. These flow naturally.

We don't hard-code a fixed export list — exportability emerges from
value-to-weight, route cost, risk, and current local/global spreads
in [06 — Caravans](06-caravans.md).

### Player and global market

**The player cannot run off-map caravans** in the current scope. Long-haul export
is the business of established merchant houses with capital,
network, and patience for multi-month round-trips. The player
operates inside the map, where they're competitive.

## Tariffs & taxes

- Settlements with administration capacity can tax: a flat % on
  caravans passing through, or a fixed toll per cart, or a
  tribute on produced goods.
- The province governor (locked — see
  [11 — Politics & Ownership](11-politics-and-ownership.md))
  extracts taxes from settlements; this is grain shipped to the
  capital, soldiers paid, public works funded. All of it moves on
  real caravans — and a tax-shipment caravan attacked by bandits
  (see [12 — Bandits & Conflict](12-bandits-and-conflict.md)) is
  an unfunded garrison.
- Caravans can attempt to evade tolls by going off-road; trade-off
  is speed and risk.

## In-settlement money flows (locked)

A market is not "the settlement" — it is the **set of actors
present at the same place buying and selling from each other**.
On any given day in a town's market hex, you might find:

- The **city corporation**'s grain reserves on offer.
- A **patrician family**'s wine and oil from their country estate
  (delivered overnight by their own carts).
- A **free village** caravan that walked in this morning with
  cheese and wool to sell + tools to buy.
- An **off-map merchant house**'s caravan unloading silks and
  loading silver.
- A **bandit fence** quietly buying stolen amphorae at 60% price.
- The **governor's office** procuring wheat for the legion.
- Random **plebeian** households drawing their daily bread.

All of them have separate ledgers (per docs/11 hex-level
ownership and actor-level treasuries). All of them want to make
money from each other where possible. The clearing price emerges
from their combined demand + supply schedules — see §"Market
clearing" earlier in this doc.

### What "owns" a transaction

When a sale clears, the buyer's coin moves to the seller's
treasury, and the goods move from the seller's stockpile to the
buyer's stockpile. **No aggregate "settlement pool" exists.**
Every coin and every kg has a named owner at every moment.

### Bid-ask asymmetry between actor types

Different actors have systematically different reservation prices
on the same goods, and that's what drives most local commerce:

| Actor | Strategy | Effective bid/ask |
|---|---|---|
| Subsistence buyer (plebeian household) | Inelastic on bread/grain; will pay whatever it takes up to bare minimum | High bid for staples, low ceiling for luxuries |
| Comfort buyer (free villager, freedman) | Elastic on wine/oil/cloth; walks away if too dear | Moderate bids that respond to budget |
| Status buyer (patrician) | Inelastic on luxury goods; status is the point of the bid | Very high bids on silks/jewels/fine wine |
| Producer of inputs (a forester selling wood) | Wants to recover production cost + margin | Sells above cost; holds back if price < reserve |
| Producer of outputs (a baker buying flour) | Derived demand; bids only as much as bread will return | Bids = (bread price × output ratio) − labor − fuel |
| Bandit fence | Buys stolen goods at deep discount, resells anonymously | Bids ~60% of going price; never asks below 95% |
| Off-map merchant | Imports = sells slightly above their long-haul cost; exports = buys slightly above local clearing | Tight margins, large volume |
| Governor / city watch | Buys grain + tools for garrisons; sells confiscated bandit loot | Public-procurement bids, sometimes pays above market for political loyalty |

The CDA implementation (per `src/sim/market/clear.ts`) sums these
schedules into one local clearing price per resource per day. The
spread between buy/sell schedules is what every actor lives off.

### Profit-seeking rivalry (locked)

**Everyone wants to make money from everyone else.** Concretely:

1. **Patrician families** prefer to sell their estate's wheat to
   the city corp at the highest price they can get; the city corp
   prefers to buy from a *cheaper* family (or import). Family
   reputation tracks this — repeated price-gouging hurts the
   family's standing with the corp.
2. **Bandit camps** target the most valuable caravans, prioritizing
   patricians whose loss most embarrasses the governor. A successful
   raid is also a price signal: the local market sees output prices
   rise (less supply) and bid prices fall (less coin in the
   plebeian pockets that just bought their grain).
3. **Free villages** with surplus production prefer to sell to the
   nearest town (transport cost low) but will walk further if the
   farther market pays a premium.
4. **The fence** undercuts the legitimate market on price but is
   only available to actors with positive reputation toward the
   bandit camp. Most legit actors won't fence.
5. **Foreign merchants** time their arrivals to harvest seasons
   when local prices are low (so their imports of luxuries fetch
   more relative coin) — emergent from the off-map AI.

### Construction is heavy (locked, current v1.5)

Building a new bloomery or warehouse is a multi-week investment:

- **Resources upfront**: per the building catalog `constructionCost`,
  e.g., `{material.lumber: 4, material.brick_tile: 4, goods.tools: 2}`.
  These come out of the investing actor's stockpile immediately;
  the actor lost real working capital, not just an accounting line.
- **Labor over time**: a building requires worker-days of construction
  labor before it can host any recipe. Until completion the building
  exists as `pendingBuilding` but produces zero. Typical times:
  simple hamlet-scale structures ~30 worker-days, village / town
  workshops ~60, and larger industrial or civic builds ~90.
- **Demolition is also slow** (planned, see docs/15 §C8): a
  settlement that wants to repurpose a hex should spend ~10–20% of
  construction time tearing the existing building down (some
  materials recoverable, some lost). Not yet implemented.
- **Maintenance accrues**: per `maintenancePerDay`, every running
  building consumes a small daily resource flow. A neglected
  building decays after `decayDaysIfUnmaintained` and stops
  producing until repaired.

Because construction is heavy, the investment decision is made
**at the actor level**, not the settlement level. The actor that
funds the build owns the new building (per docs/11 hex-level
ownership) and collects the production. A patrician family that
builds a smithy in their hometown gets the smithy's iron output;
the city corp doesn't get a cut unless explicitly via tax. This
creates real political tension: who gets to build *what* in the
city's hexes, and who profits.

The current v1.5 implementation (see `src/sim/tick.ts`
`investmentPhase` and `constructionPhase`) deducts construction
resources immediately, creates a `pendingBuilding`, then spends
construction worker-days before materializing the building.
Demolition and labor-role-specific construction (mason vs.
carpenter vs. unskilled) remain follow-ups (docs/15 §C8 + §C14).
