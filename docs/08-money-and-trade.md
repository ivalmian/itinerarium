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
  more lead into its denarius, and merchants _notice_ and adjust
  prices.

## Modern microeconomic pricing (locked)

The pricing model is the standard modern microeconomic story,
implemented as explicit schedules rather than as fixed constants:

- **Consumers maximize utility subject to wealth/budget
  constraints.** Subsistence demand is near-inelastic until the
  buyer's wealth is exhausted; comfort demand is elastic; status
  demand is low-volume but high willingness-to-pay.
- **Producers maximize profit.** Output supply is bounded by
  marginal cost, while input demand is derived from the expected
  profit of selling downstream output.
- **Owners sell at reservation prices.** Reservation price combines
  marginal production cost, opportunity cost of holding inventory,
  spoilage pressure, and liquidity urgency. Patient patricians and
  desperate hamlet households can rationally quote different asks for
  the same grain.
- **Markets clear by a continuous double auction.** Highest
  willingness-to-pay buyers match lowest-reservation sellers at a
  clearing price. When no physical trade clears but demand exists,
  the recorded price is a scarcity shadow price: the price signal
  implied by unmet demand, not a fake transaction.
- **Space obeys arbitrage with transport costs.** Nearby markets
  converge by petty trade until the spread is no larger than local
  transport cost. Long-haul caravans move only when the price spread
  exceeds weight, distance, wage/ration, and risk costs. This is the
  law of one price with frictions, not a global price pin.
- **Wages are reservation wages, and labor ownership matters.**
  Free/paid labor is priced as the local subsistence basket, paid by
  producers to local worker/household actors when recipes run, and
  included in marginal cost. Enslaved labor is not wage-paid; its
  upkeep is owner-funded subsistence demand. A producer only gets the
  unpaid slave-labor cost advantage when that producer's actor type can
  command enslaved labor. Food-price shocks therefore raise cash wages
  and feed into goods that rely on paid labor, while slave-heavy estates
  face a lower cash wage bill but a higher upkeep burden.

The only exogenous price table is the off-map global-market boundary
condition for goods that can actually cross provincial borders
(silver, gold, exotics, high-value exports). It is not used to pin
local ordinary goods; local prices emerge from schedules and
arbitrage.

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
wealth_remaining  = min(segment_wealth,
                        buyer_actor.treasury
                        + buyer_actor.own_stock(resource) × reference_price)
max_willingness   = wealth_remaining / need_per_day

quantity(p) = need_per_day               if p ≤ max_willingness
            = wealth_remaining / p       if p > max_willingness
```

The demand curve is essentially **vertical** at `need_per_day`
until price exceeds the segment's wealth-per-unit. Then the
segment begins to starve (consumption falls below need →
mortality).

In the tick loop, staple calories are consumed by the **actual
market-cleared trades**, not by a separate pre-market drain. Grain, bread,
and legumes create direct subsistence bids. Flour is priced primarily by
derived producer demand from bakers; rural household baking is represented
as grain demand and hand-milling so every hamlet does not create a tiny
flour shortage market. The mix is tier-sensitive: hamlets and villages
shift much of the bread line into grain for household baking, while towns
and cities bid directly for baker bread. Any remaining edible stock,
including grain, bread, legumes, flour, cheese, and salted meat/fish, can
still be bought and immediately
consumed as fallback calories when the cleared staple market leaves a
shortfall.
Self-provision is allowed: if the buyer and
seller are the same actor, their own stockpile can be consumed without
a coin transfer. That self-provision is ownership-aware:
civic/village/hamlet/common stores represent the people they feed,
while patrician private stores only self-feed patricians and enslaved
dependents unless a separate wage, ration entitlement, or transfer moves
food to common households.
If buyer and seller differ, the buyer must have coin (or a future
explicit entitlement ledger) to take the seller's goods. There is no
implicit "poor household takes patrician grain for free" transfer in the
market-clear step. Tenant rationing and staple wages are modeled as
owner-controlled self-provision or as explicit in-kind wage transfers;
otherwise a cashless buyer remains a real shortage. Famine pressure is
based on the combined fill.

Aggregating across segments produces a step function: poorest
segments fall off first as price rises, then progressively richer
ones. A famine is a price climbing the steps until enough people
have starved or fled to clear the market.

### 2. Consumer comfort demand (elastic)

For wants above subsistence (fresh local milk/fish/game when
available, fresh grapes/olives in season, wine, oil, cheese, decent
clothing, furniture). For each segment with a comfort want:

```
want_quantity = s.comfort_want(resource)
budget        = s.discretionary_income_per_day
                × resource_budget_share
                capped by buyer_actor.treasury

quantity(p) = want_quantity * decay(p / budget)
```

…where `decay()` falls smoothly to zero as `p` rises past the
segment's budget — sigmoid or exponential.

The daily budget is the segment's whole comfort budget split across
the comfort bundle, not a fresh full budget for every good. People
walk away if comfort goods get expensive — they substitute or do
without. If the concrete household actor is out of cash, comfort
demand drops to zero until wages, trade, or transfers refill it.
Sub-micro coin residues from floating-point transfers are treated as
zero budget; otherwise an actor with numerical dust would create fake
near-zero willingness-to-pay observations.

### 3. Consumer status demand (elite, inelastic-but-deep-pockets)

For luxuries (luxury textiles, silver tableware, exotic goods).
Patrician families and the governor demand these almost regardless
of price (deep pockets), but the _quantity_ is small.

```
resource_wealth = segment_wealth × resource_budget_share
                  capped by buyer_actor.treasury

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
target_output_stock     = 14 days of that recipe's output at capacity
production_capacity     = min(production_capacity,
                              max(0, target_output_stock
                                     - buyer_actor.own_stock(R.output))
                              / R.output_per_run)
production_capacity     = min(production_capacity,
                              buyer_actor.treasury / break_even_input_price)
input_gap               = max(0,
                              production_capacity * R.input_per_run
                              - buyer_actor.own_stock(R.input))
production_capacity     = min(production_capacity,
                              input_gap / R.input_per_run)
quantity_demanded       = production_capacity * R.input_per_run

quantity(p) = quantity_demanded   if p ≤ break_even_input_price
            = 0                   if p > break_even_input_price
```

A weaver only bids for wool if they can sell the cloth at a profit
and has cash to buy the input. If the cloth market collapses, wool
demand collapses. If the cloth market spikes, wool demand spikes —
but only up to the buyer's real treasury and its output-inventory gap.
Workshops do not keep buying iron, wool, or grain just because a
downstream price is high while their own output shelves or input bins
are already full.

Production execution observes the same inventory discipline. A
producer does not keep converting inputs into an output once that
owner's stock already covers the configured stock target for the
producer's installed capacity. Staples and preserved foods can hold
longer targets; ordinary manufactured and trade goods default to about
a month. Military/capital goods such as weapons, armor, shields, and
carts use tiny showroom/procurement buffers unless barracks or merchant
capital buyers are actively drawing them down, so smithies do not hoard
scarce iron into speculative armor while farms and mines lack tools.
This prevents "inputs exist, therefore make infinite goods" gluts.

Present-but-not-consumed productive capital follows the same logic.
If a recipe declares `requires` (for example cattle for milking or
sheep for shearing), the owner bids to acquire the missing stockpile
instead of consuming it. The bid is capped by the output stream the
asset enables over a finite payback window and by the owner's actual
treasury. Once bought, the herd remains in the owner's stockpile and
future recipe runs check its presence rather than deducting it.

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
marginal_cost     = MC anchored to inputs:
                    Σ over recipes that produce this resource of
                      (input_qty × recent_input_price) / output_qty,
                    taking the cheapest available recipe,
                    plus paid labor priced as a local subsistence
                    basket.
expected_future   = most recent local price (the owner's opportunity
                    cost of not selling today), discounted toward
                    marginal cost when the owner is carrying more
                    than ~30 days of local absorption, and discounted
                    hard when there is no current local absorption
salvage_floor     = small physical floor by category × kg/unit
                    (grain, wood, salt, tools, etc. are never worth
                    literally zero even when local price memory is bad)
inventory_pressure = 0 when stock ≤ target inventory; rises toward 1
                    as stock exceeds the local absorption target
spoilage_pressure = if perishable AND days_to_spoil < holding_period,
                    a 0..1 urgency addend
owner_urgency     = subsistence-class owners are desperate to
                    realize cash; patrician owners can wait

raw_value         = max(marginal_cost, expected_future)
urgency_adjusted = raw_value
                   / (1 + owner_urgency_factor + spoilage_pressure)
reservation_price = max(marginal_cost, salvage_floor, urgency_adjusted)

available_to_sell = stockpile - reserved_for_own_use

supply(p) = available_to_sell  if p ≥ reservation_price
          = 0                  if p < reservation_price
```

Aggregate supply at price `p` = sum across all owners. Upward-
sloping step function.

### Why marginal cost is the supply floor (locked, economic theory)

In modern competitive-equilibrium theory, price equals marginal cost
at the margin for active producers: **P = MC**. Producers do not
knowingly sell below their marginal cost — at P < MC every additional
unit loses money, so the rational producer would rather hold
inventory or stop making more. This anchors the supply curve to a
real, input-derived cost rather than to whatever the last clearing
price happened to be.

Liquidity urgency and spoilage pressure lower the opportunity premium
from waiting; they do **not** erase the physical floor. For raw or
locally extracted resources whose current MC is temporarily unpriced,
the salvage floor is a low coins-per-kg fallback. It prevents a one-day
glut from driving grain, timber, salt, ore, or tools into a near-zero
price memory that then becomes self-reinforcing. It is intentionally
below normal trade/import scarcity prices, so it stabilizes the floor
without pinning the market.

Inventory pressure is the non-perishable counterpart to spoilage
pressure. A smith with a few days of tools can rationally wait for a
good price; a smith holding months of unsold tools faces storage cost,
cash tied up in inventory, theft risk, and competitive undercutting.
So the expected-future component moves back toward marginal cost as
stock exceeds the local absorption target. This prevents stale scarcity
prices from persisting after the goods physically exist.

When there is no current buyer at all, the previous scarcity price is
treated as a stale option value rather than today's opportunity cost.
Seller-only markets can still quote an ask, but that ask decays toward
marginal cost/salvage instead of reusing yesterday's shortage cap.

The earlier formulation set `production_cost = 0.8 ×
recent_output_price`, which had no anchor to inputs. When supply
exceeded demand the output price fell, the next tick's reservation
fell with it, and prices spiraled into 1e-7 territory — a
death-spiral that the user flagged as "decay → spike → decay" when
band-aided with periodic re-seeding. The MC formulation removes
the spiral at its source: input prices have to fall too before the
output price can drop, and they can't fall below their own MC. The
whole price column floats up and down together but stays bounded
to physically real costs of production.

Side benefits: cost-push inflation works correctly (an iron
shortage raises tool prices via MC propagation), and cost-pull
deflation works correctly (a bumper grain harvest lowers flour
prices via the bake_bread recipe's flour input).

This is where "patricians hoard during famine" becomes emergent. A
patrician family with a full granary has `owner_urgency_factor`
near zero (they're rich) and a high `opportunity_cost` (price is
rising, they expect more tomorrow). Their reservation price climbs
with the market — they will sell, but only at prices the poor
can't pay. Riots, edicts, mob looting follow as a _consequence_,
not as scripted events.

### Wage pricing

Free recipe labor is paid at a local **reservation wage**. The wage is
the cheapest available subsistence basket priced in the same units as
market goods:

```
wage_per_worker_day =
  min(calorie_substitute_cost)
+ min(salt_substitute_cost)
+ min(fuel_substitute_cost)
+ min(clothing_wear_substitute_cost)
```

Basket rows are physical kg/day, converted through the resource
catalog's `kg_per_unit` before multiplying by market price. A farm
owner therefore pays free workers in coin when recipes run; the
workers' household/civic actor then has money to buy food, fuel,
clothing, and comfort goods. Enslaved worker-days do not create a cash
wage transfer; their owner remains responsible for subsistence through
the consumption market. The unpaid-slave-labor advantage is
owner-specific. A common household workshop cannot price its output as
though it controlled a patrician's slaves, even if those slaves live in
the same settlement. Because paid wage is included in marginal cost, a
grain shock raises wages and propagates into bread, tools, buildings,
and other paid-labor-intensive goods.

Paid/free-labor production is cash constrained before execution when
the wage would move coin to a distinct worker actor. A recipe can only
run to the fraction whose wage bill the owner can cover at the local
reservation wage. Wage settlement can be coin or staple in-kind pay
(grain/flour/bread valued at local prices), so a cash-poor but
grain-rich estate can still hire workers while transferring real food
to the worker household. Owner-operated household labor and slave-only
labor are not wage-transfer constrained, though their owner still faces
the upkeep demand described above.

## Market clearing

For each (settlement, resource, day):

```
price* = price where aggregate_demand(p) = aggregate_supply(p)
```

If demand exceeds supply at every nonzero price, price\* climbs
until demand falls (people starve, comfort is dropped, producers
shut down). A demand-only market still records that scarcity price:
even if no units trade, the last clearing price becomes the signal
that petty traders, guild ledgers, and long-haul caravans can observe.
The unmet quantity must be physically meaningful (currently at least
about 0.25 kg of the good). Dust-sized producer input gaps still block
that recipe locally, but they do not broadcast a full settlement price
signal.
That signal is capped by a resource-specific scarcity ceiling derived
from off-map reference prices, active seller reservation prices, or a
coarse category/weight fallback for local-only goods. This cap is only a
numeric guardrail for demand-only markets; it does not seed local supply
or force a clearing price when actual bids/asks exist. A missing sack of
salt should create a strong import/trade signal; it should not pin the
entire province at the same impossible price forever. Current v1.5 uses
roughly a 12x scarcity ceiling over the best reference price for normal
goods, with a small minimum floor for genuinely cheap local goods.
Strategic producer inputs in the iron/tool chain (`mineral.iron_ore`,
`material.charcoal`, `metal.iron`, `goods.tools`) use a wider ceiling so
their local shadow price can reflect downstream tool scarcity instead of
being clipped below marginal value. Food remains on the narrower ceiling
so a single missing staple does not explode wages and every downstream
marginal cost.

If neither a current bid nor a current ask exists, the local quote is
removed rather than carried forward as a stale price memory. If sellers
have stock but no buyer clears, the recorded quote is the lowest active
seller reservation ask after no-buyer inventory discount, not an old
scarcity cap. Caravans and petty traders therefore react to current
economic signals, not dead markets.
If supply exceeds demand even at zero price, price\* hits a spoilage /
opportunity floor and unsold stock either spoils or rolls forward.

Trades happen at price\*: highest-WTP demanders match with
lowest-reservation sellers, in price order.

This is a **continuous double auction**, a standard market
microstructure model for price discovery with heterogeneous buyers
and sellers. It gives all the right emergent behavior:

### Whole-unit transactions (locked)

Every cross-actor trade in a tangible good crosses ownership in
**integer multiples of the resource's native unit**. A caravan
selling cloth sells 12 bolts, not 12.4. A pickup cart hauling
charcoal between villages hauls 120 sacks, not 120.7. An off-map
amphora export ships 30 amphorae, not 30.5.

What this rules out:

- Phantom price-arbitrage trades — when raw price-spread arithmetic
  would deliver a fractional quote that rounds to zero whole units,
  no trade fires. The price signal still moves through the regional
  bid-ask layer, but no goods change hands until someone wants a
  whole unit.

What this preserves (intentionally fractional):

- **Internal settlement market clearing.** A town clearing wine
  among 200 plebeian households per tick clears the aggregate
  demand (≈ 0.06 amphora today) against aggregate supply. The
  internal market book-keeps in fractions so daily perishable
  consumption is correctly accounted; it's the aggregate-of-many-
  households step, not a player-visible single transaction.
- **Service capacity.** `service.priesthood`, `service.garrison`,
  `service.administration`, and `service.public_works` represent
  intangible per-day capacity (priest-days, garrison-days), which
  is legitimately fractional — half a priest's daily attention on
  a small village ritual is meaningful.
- **Recipe outputs.** A farm running at 0.4 capacity outputs 0.4
  recipe-instances worth of grain into the owner's stockpile.
  Outputs accumulate in the stockpile and round to whole units
  when they're transacted out.

Implementation: `src/sim/market/wholeUnits.ts` exposes
`wholeUnitsForTransaction(resource, qty)` — floors tangible goods
to integer units; passes service resources through unchanged.
Applied at every external trade site: caravan buy / sell / ration,
local trade between settlements, off-map export.

### Integer-coin prices (locked)

The smallest unit of account is **one coin**. Quoted per-unit prices
across the whole market layer — producer reservation asks, consumer
willingness-to-pay bids, the daily clearing price, and the residual
bid-ask book — are **integers ≥ 1 coin**. There is no half-coin or
tenth-coin quote anywhere in the system. A loaf of bread on offer is
quoted at "1 coin" or "2 coin", never "0.4 coin" or "1.3 coin".

Rounding discipline (so the integerization is information-preserving
on the side that matters for the auction):

- **Producer asks round UP.** If marginal cost + opportunity premium
  computes to 2.3 coin, the seller asks 3 coin. A seller never
  knowingly quotes below their real cost.
- **Consumer bids round DOWN.** If a buyer's true willingness-to-pay
  computes to 2.7 coin, they bid 2 coin. A buyer never quotes above
  their true reserve.
- **Subsistence bids stay infinite.** The "any price I can afford"
  case keeps `+Infinity` WTP and clamps at the wealth constraint;
  it does not pass through the rounding step (subsistence is the
  vertical demand segment, not a quoted bid).
- **Clearing price is an integer ≥ 1** that satisfies both sides at
  some point along the intersection segment. The CDA still walks the
  sorted breakpoints; the recorded clearing price is the integer
  nearest to the algebraic intersection, clamped to ≥ 1.
- **Floor of 1 coin per unit.** Any quote whose math wants a positive
  value below 1 is clamped to 1. Zero stays zero (a true free /
  unwanted good).

What this rules in and out:

- A good with true marginal cost ~0.3 coin / unit will quote at 1
  coin and clear at 1 coin. This **inflates the floor** for cheap
  comfort goods. Subsistence is unaffected (infinite WTP). Comfort
  buyers whose discretionary budget would only have covered 0.3 coin
  per unit drop out of that market — a deliberate welfare cost,
  documented to keep player-facing pricing legible.
- Producer marginal cost still flows through the input chain at
  full float precision (kg of iron × coin/kg of iron = recipe input
  cost). Only the externally quoted per-unit price quantizes. A
  smith's internal accounting can still reflect that a kilo of iron
  cost 4.6 coin to acquire; the smith's tool ask just rounds to a
  whole coin.
- Total coin transferred in a trade is `units × price-per-unit`,
  both integers, so totals stay integer too. No fractional coin
  ever moves between treasuries.

Implementation: `src/sim/market/wholeUnits.ts` adds
`integerCoinPrice(p)` (round UP for asks),
`floorCoinPrice(p)` (round DOWN for bids), and
`integerCoinClearing(p)` (round to nearest, clamp ≥ 1). These are
applied at the quote sites in `src/sim/market/supply.ts`,
`src/sim/market/demand.ts`, `src/sim/market/clear.ts`, and at every
price-observation write (`Caravan.priceBook`, guild ledgers).

### Mint output flows to treasury (locked)

`mint_coin` is the only recipe whose output is **not** a stockpile
good. A successful mint run consumes its silver input from the
owner's stockpile, then **credits `output × 1 coin` directly into
the owner's `treasury`**. No `goods.coin` ever sits in the mint's
stockpile from minting.

`goods.coin` still exists as a physical resource for the cases
where coin actually moves as cargo: tax shipments, edge-hub
incoming/outgoing convoys, player coin carried in a caravan, bandit
loot. In all those cases the coin physically arrives at a
destination and is then credited to the destination actor's
`treasury` on arrival (already wired). The mint-to-treasury rule
just removes the special case where coin was being treated as
stockpile inventory by the producer despite never being held that
way.

- **Famine**: prices spike, rich survive, poor starve, granaries
  empty, caravans flood in until supply meets demand or the city
  dies.
- **Glut**: prices crash to spoilage floor, producers reduce next
  cycle, surplus exports if value/weight allows.
- **Cascading shocks**: a collapse in an output market propagates
  back through derived input demand to the raw materials.

### Bid-ask book (locked)

The CDA collapses many heterogeneous quotes to one clearing price each
day, but a real ancient marketplace had a **visible price ladder** —
the next-best ask above the cleared sales and the next-best bid below
them. Caravans walking through a forum gossip not about an idealized
"market clearing" but about "the cheapest sack of grain on offer right
now" and "the highest coin any wine merchant is paying today." We
model that ladder explicitly.

After each day's clearing, the market records a **post-clearing book**
per resource:

```
bestAsk  = lowest reservationPrice among supply sources with
            availableToSell > 0 at clearing-price-or-above that DID
            NOT fully clear today
bestBid  = highest maxWillingnessToPay among demand sources with
            remaining quantity > 0 that DID NOT clear today
askDepth = total unsold supply quantity sitting at or below bestAsk
bidDepth = total unmet demand quantity sitting at or above bestBid
midPrice = clearing price when one cleared; otherwise the geometric
            mean of bestBid and bestAsk when both exist, or whichever
            single side is quoted
spread   = bestAsk - bestBid, both >0 (else "—" for the one-sided book)
```

The book is **derived per-tick from the residual schedules** — it
does NOT persist orders across days. Each tick re-builds it from the
current actor stockpiles, treasuries, and recipe demand. This matches
the design pillar: the ladder is the visible state of who happens to
be standing in the forum today with goods or coin, not a synthetic
limit-order book pretending to be a modern exchange.

The spread emerges from the documented **bid-ask asymmetry across
actor types**: subsistence households bid as high as their cash will
allow on staples but cap fast on luxuries; comfort buyers walk away
past their budget; status buyers will pay multiples of fair price
for the right luxury; producers bid only up to their break-even on
inputs; patient patrician sellers post asks above marginal cost while
desperate hamlet sellers cut their ask close to salvage; bandit fences
quote both sides at deep discounts.

Expected spread shape, in a healthy market:

- **Staple food (grain, bread, legumes)**: tight spread. Subsistence
  demand crowds against marginal-cost-anchored seller asks. A market
  this thin around the clearing price means buyers and sellers agree
  on what bread should cost; if the spread widens, something is
  breaking (rich-only buyers, granary hoarding, shortage).
- **Comfort goods (wine, oil, cheese, cloth, pottery)**: moderate
  spread. Comfort demand is elastic, so buyers walk well before
  reservation prices, and sellers can afford to wait days for the
  right counterparty.
- **Status goods (luxury textiles, silver, exotics)**: wide spread.
  Few patrician buyers with deep pockets; sellers willing to hold for
  months. Each individual cleared trade can move the recorded clearing
  price visibly.
- **Capital goods (carts, tools, herd capital, construction materials)**:
  spread is set by amortization windows. Producer inputs to durable
  recipes get bid up to a discounted future revenue; a smith's tool
  workshop will bid for iron up to the per-unit margin of a tool sale
  multiplied by the expected tool turnover.
- **Strategic inputs (iron ore, charcoal, salt, equines)**: spread is
  often wide and asymmetric — a sudden shortage drives bestBid hard
  upward while bestAsk lags as patient sellers wait.

Caravans and "internal needs" (a workshop running short of a critical
input, a tax convoy preparing to leave) cross the spread by bidding
above bestAsk or asking below bestBid. When that happens the next
clearing matches the crossing party against the residual book and the
spread re-equilibrates the next day. This is the explicit price-
discovery story: most days, only the people who genuinely need to
trade cross the spread; the rest of the book is quoted but quiet,
which is exactly how a real local forum looked.

**Dormant markets are an alarm.** If a settlement records `bestAsk` /
`bestBid` quotes for several days but no clearing, something is
suppressing crossings — usually an empty buyer treasury or a one-sided
book where supply exists but no actor with cash wants the good. We
treat these as diagnostic signals, not as bugs in the clearing math:
the CDA correctly refuses to invent trade where willingness to pay
doesn't meet willingness to sell, and the burn-in instrumentation
must surface those frozen books for triage.

### Per-settlement markets, regional smoothing

**Each settlement clears its own market.** A pagus and its three
dependent hamlets sharing a hex are _four separate markets_, each
with its own aggregate demand + aggregate supply schedules. There
is no shared "regional clearing price"; if the village runs short
of grain its price will spike before the neighbor hamlets feel it.

What pulls those four markets back into rough alignment is the
**local-trade pass** specified in
[06 — Caravans](06-caravans.md) §"Local trade between nearby
settlements": after every settlement clears, petty merchants move
small household loads between settlements within 3 hexes of each
other, including fresh local foods such as milk, fish, and game.
Livestock capital walks in small herd-unit fractions over the same
local radius. Workshop/industrial cartage can move tools, ore,
charcoal, metals, and construction materials out to 6 hexes when the
spread pays the heavier transport cost. Both arbitrage price spreads
down to roughly the transport-cost band.

So:

- Same-hex spreads close to ~0 (transport cost is 0).
- Adjacent-hex spreads close to ~0.005 coin/kg.
- 3-hex spreads close to ~0.02 coin/kg.
- 4–6 hex spreads close only for workshop/industrial cartage, with
  higher costs up to ~0.08 coin/kg; household food and comfort goods
  still need long-haul trade beyond 3 hexes.
- Beyond the local-cartage range, only long-haul caravans connect
  markets, and spreads can stay wide for days or weeks — exactly when
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
  to sell at local prices. Their margin covers their costs. Cargo
  and target selection are price-responsive: a tool shortage in one
  city can make that city a better destination and tools a better
  cargo than silk, and a severe iron shortage can pull in iron bars
  despite their weight. Launch cadence is margin-responsive too, bounded
  by daily and active-fleet caps so scarcity increases flow without
  creating a perimeter burst. Cheap local tools or iron push the house
  back toward exotics, salt, or other profitable cargo.
- **Exports**: NPC long-haul merchant houses based in our cities
  periodically assemble caravans of high-value low-weight goods
  to ship out. Their margin (local price → global price) covers
  their costs. Because these houses are stockpile owners in their
  home markets, their transport capital demand for equines and carts
  is funded by their own treasury and clears through the normal CDA
  schedules rather than through a hidden spawn rule.

### Why imports and exports are dominated by luxuries (emergent)

- The fixed cost of a long-haul caravan (crew food, carried
  grain/legume fodder after grazing, animal wear, guards over weeks of
  travel) is **per-unit-weight**, not per-unit-value.
- For grain and other low-value bulk staples, the spread between
  local and global prices doesn't cover the per-kg transport cost.
  These stay local.
- For spices, silk, silver, fine cloth, and amphora-packed oil/wine
  when quality or scarcity makes the spread high enough, the spread
  per kg can cover transport. These flow naturally.
- Strategic heavy inputs such as iron bars sit in the middle: they
  are too heavy for routine luxury-style trade, but a city whose iron
  price has spiked can still attract real import caravans.

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
  an unfunded garrison. Tax assessments are queued and dispatched as
  district convoys under daily and active-convoy capacity caps; harvest
  day cannot spawn every owed owner/settlement assessment as its own
  caravan, and a congested road network back-pressures later dispatches.
  Delivered in-kind tax shipments deposit into the governor's stockpile;
  delivered `goods.coin` tax cargo credits the governor's spendable
  treasury. The coin resource exists while money is being minted or
  physically shipped, but local markets spend actor treasury.
- Caravans can attempt to evade tolls by going off-road; trade-off
  is speed and risk.

## Cash circulation discipline (locked)

A continuous double auction with cash-constrained buyers can deadlock
itself in three different ways:

1. **Producer cash drain.** A patrician estate pays wages to common
   households for every recipe run, but if no buyer with cash bids on
   the estate's output, the estate's treasury bleeds to zero. After
   that, the estate cannot afford its wage bill and falls back on
   in-kind grain wages, which keeps physical food moving but stops the
   coin flowing. Once the estate is cashless its derived input demand
   for tools, iron, oil, etc. also collapses.
2. **Wage-spent-immediately collapse.** Common households receive
   wages and immediately spend them on subsistence at the same
   settlement; their treasury equilibrates near zero. Subsistence
   demand at zero treasury is mathematically zero at any positive
   price (the wealth-per-need term goes to zero), so the next day's
   bread market has no buyer at the patrician's reservation. The
   household DOES self-provision from its own grain stockpile when it
   holds one — this is the actual food path in steady state — but
   that breaks down for any good the household does NOT already hold,
   like wine, cheese, or pottery.
3. **One-rich-actor crowding.** When one city corporation or off-map
   house absorbs most coin in a region, the rest of the actor
   ledger settles to near-zero. The bid-ask book then looks like a
   wall of unfillable asks (everyone wants to sell) against a wall of
   non-binding bids (everyone wants to buy but nobody has coin),
   and clearing volume collapses despite huge physical stockpiles
   sitting on shelves.

The model handles cases 1 and 2 via in-kind wages, self-provision,
and the inventory-pressure discount on patient sellers' asks — those
mechanisms keep food and the subsistence chain alive even with no
coin circulating. They do NOT however make comfort, status, capital,
or strategic-input markets functional, because those don't have an
in-kind-wage fallback. So a chronic cash drain in a province shows up
as a **healthy food market plus dormant everything-else markets**
sitting on top of huge unsold stockpiles. That is exactly the
diagnostic pattern the bid-ask book is meant to surface, and it is
the leading reason a city can have "no trade in wine for 90 days"
despite having amphorae and cellars.

The v1.5 lever to keep cash circulating is the **distribution of
liquid wealth across owner kinds**: every actor type that bids on
goods needs a sustainable income channel. City corporations get tax
inflows and own civic production. Patrician families need rents,
tribute, and merchant-house dividends to refill what they pay out
as wages — a patrician estate that pays wages but never collects
rent or sells output for coin is structurally doomed in this model.
Common households need wages-in-coin to participate in comfort and
service markets — wages-in-grain only feeds them, it does not let
them buy a new clay pot. The procgen + bootstrap pass therefore has
to seed plausible initial treasuries AND continuous income mechanics
on every owner kind that the schedule builder draws from.

### Per-class household actors (locked, v1.5 C21)

Free urban populations are NOT modeled as a single aggregate
`common_household` ledger anymore. A town or city's free residents
break into three class-level actors:

```
plebeian_household   — wage-earning urban poor + smallholder commoners
freedman_household   — former slaves, free legally, often clientela
foreigner_household  — itinerant traders, mercenaries, resident
                       non-citizens
```

Each carries its own treasury and stockpile. Wages from recipes
that run on city land split across the three IN PROPORTION to the
recipe's actual class mix (computed from the LaborClassContext the
production engine already uses). Subsistence and comfort demand
from each class bid against THAT class's actor treasury — so a
plebeian's empty pocket no longer suppresses a freedman's wine
purchase, and the residual bid-ask book naturally has three
distinct demand sources per resource instead of one merged curve.

Hamlets and free villages keep their existing
`hamlet_household` / `free_village` actor because those are
political/ownership entities, not class aggregates. They route
wages to the single household actor as before.

Slaves do NOT have a `slave_household` actor. Per docs/11
§"Slaves", they are owned property and consume on their owner's
ledger. Slave subsistence demand bids through `patrician_family` /
`city_corporation` / `governor_office` / `temple` / `hamlet_household`
/ `free_village` as appropriate to who owns them.

This is the C21 disaggregation. See docs/15 §C21 for the
implementation details and the diagnosis that motivated it.

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
Service trades are the physical-transfer exception: coin still moves
from buyer to seller, but no `service.*` stockpile is written because
service capacity is consumed locally. Public works follows the same
rule: patrons with pending construction buy local `service.public_works`
capacity from forum/project offices, while lumber, stone, tools, and
wages clear through their own material and labor paths.

### Bid-ask asymmetry between actor types

Different actors have systematically different reservation prices
on the same goods, and that's what drives most local commerce:

| Actor                                        | Strategy                                                                                          | Effective bid/ask                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Subsistence buyer (plebeian household)       | Inelastic on bread/grain; will pay whatever it takes up to bare minimum                           | High bid for staples, low ceiling for luxuries                             |
| Comfort buyer (free villager, freedman)      | Elastic on wine/oil/cloth; walks away if too dear                                                 | Moderate bids that respond to budget                                       |
| Status buyer (patrician)                     | Inelastic on luxury goods; status is the point of the bid                                         | Very high bids on silks/jewels/fine wine                                   |
| Producer of inputs (a forester selling wood) | Wants to recover production cost + margin                                                         | Sells above cost; holds back if price < reserve                            |
| Producer of outputs (a baker buying flour)   | Derived demand; bids only as much as bread will return                                            | Bids = (bread price × output ratio) − labor − fuel                         |
| Bandit fence                                 | Buys stolen goods at deep discount, resells anonymously                                           | Bids ~60% of going price; never asks below 95%                             |
| Off-map merchant                             | Imports = sells slightly above their long-haul cost; exports = buys slightly above local clearing | Tight margins, large volume                                                |
| Governor / city watch                        | Buys grain + tools + weapons/armor/shields for garrisons; sells confiscated bandit loot           | Public-procurement bids, sometimes pays above market for political loyalty |
| Temple / civic office                        | Sells local service capacity; buys offerings, stipends, tools, and cloth to sustain it            | Service trades move coin only; institutional goods are consumed as upkeep  |
| Garrison / forum owner                       | Sells standing security or administrative capacity backed by buildings and staff                  | Local service supply clears without creating cargo                         |
| Investor / merchant house                    | Holds construction materials, equines, and carts as buffer-stock capital                          | Stockpile bids funded by actual treasury; purchases become actor inventory |

The CDA implementation (per `src/sim/market/clear.ts`) sums these
schedules into one local clearing price per resource per day. The
spread between buy/sell schedules is what every actor lives off.

### Profit-seeking rivalry (locked)

**Everyone wants to make money from everyone else.** Concretely:

1. **Patrician families** prefer to sell their estate's wheat to
   the city corp at the highest price they can get; the city corp
   prefers to buy from a _cheaper_ family (or import). Family
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

- **Materials upfront**: per the building catalog `constructionCost`,
  e.g., `{material.lumber: 4, material.brick_tile: 4, goods.tools: 2}`.
  Investors bid in the normal market for a small buffer stock of these
  materials before they build. When a project starts, the resources come
  out of the investing actor's stockpile immediately; the recorded coin
  cost is an opportunity-cost valuation at local prices, not a magical
  treasury debit. The actor lost real working capital because the
  construction materials can no longer be sold, consumed, or used
  elsewhere.
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

Because construction is heavy, the investment decision is made by a
specific stockpile-owning actor, not by an aggregate settlement pool.
The actor that funds the build owns the new building (per docs/11
hex-level ownership) and collects the production. A patrician family
that builds a smithy in their hometown gets the smithy's iron output;
the city corp doesn't get a cut unless explicitly via tax. This creates
real political tension: who gets to build _what_ in the city's hexes,
and who profits.

The current v1.5 implementation (see `src/sim/tick.ts`
`investmentPhase` and `constructionPhase`) deducts construction
resources immediately, creates a `pendingBuilding`, then spends
construction worker-days before materializing the building. Mine
investment is constrained to matching finite deposit hexes; ore
refineries require local ore stock or a deposit-backed mine already
present/under construction. Free construction worker-days are paid at
the same local reservation wage as recipe labor, so construction demand
moves coin from patrons to worker households instead of consuming
abstract labor for free.
Enslaved construction labor advances projects without a cash wage only
when the owner can command that labor; it still has owner-funded upkeep
demand. Construction worker-days are role-specific in v1.5 (mason and
carpenter pools drain independently). Demolition remains the follow-up
(docs/15 §C8).
