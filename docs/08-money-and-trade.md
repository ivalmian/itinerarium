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
- For grain or oil, the spread between local and global prices
  doesn't cover the per-kg transport cost. So bulk commodities
  stay local.
- For spices, silk, silver, fine cloth, the spread per kg easily
  covers transport. These flow naturally.

We don't hard-code "luxuries are exports" — it emerges from the
caravan economics in [06 — Caravans](06-caravans.md).

### Player and global market

**The player cannot run off-map caravans** in v1. Long-haul export
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
