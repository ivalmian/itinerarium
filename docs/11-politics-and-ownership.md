# 11 — Politics & Ownership

The Roman world wasn't atomized individuals trading freely — it was
structured by hierarchies of power and ownership. Provinces had
governors. Cities had ruling families. Villages had patrons or
elders. Land, slaves, workshops, herds, and stockpiles were owned
by **specific people**, not "the settlement."

This doc covers the political and ownership layer for the current scope.

## Every faction has named characters (locked)

Every faction in the world — patrician families, free village
councils, common households, hamlet households, bandit camps,
patrol detachments, city watches, caravans, the governor's office, temples — has
**named individual characters** who actually decide, remember,
and act. The patriarch of Family Vibian. The captain of the III
Cohort. The headman of Free Village Carnia. The leader of the
Caelian bandit band.

These named characters age, die, and are replaced (heirs,
elections, appointments). Their reputations are partially
inherited by their successors, diluted (the heir didn't
personally suffer the wrong). See
[13 — Reputation & Relationships](13-reputation-and-relationships.md)
for the full mechanics.

A settlement may have **one or many factions**: a hamlet has one
(the headman household); a village typically has one; a town has
one to three; a city has 5–10 (multiple patrician families, the
city watch, the temple, the magistrates) often in active
competition with each other.

The economic ledger also has **per-class household actors** in towns,
cities, and patron-client villages — one each for `plebeian_household`,
`freedman_household`, and `foreigner_household` (whichever classes have
positive population). They are not landowners; they stand for the
class's household cash and wage receipts so food, fuel, and comfort
purchases are paid by workers rather than by the city corporation.
Each class bids and accumulates wages independently — so when an
empty plebeian pocket suppresses bread bids, a freedman with savings
can still buy a clay pot. See docs/15 §C21 for the disaggregation
rationale (prior `common_household` consolidation merged all three
classes into one ledger, dampening per-class demand). Free villages
and hamlets use their village/hamlet household actor directly,
because those are political entities (with land, elders, patron
relations), not class aggregates. None of these household actors
command enslaved labor; if a household-owned workshop runs, it hires
free/freed/foreigner labor and pays the local reservation wage.

## Province governor

- **One per province**, and the current scope is a single province, so one
  governor total.
- Resides in the **provincial capital** — the largest of the 4–5
  cities. (Designated during procgen — see
  [07 — Geography](07-geography.md).)
- Term-limited: rotates every few in-game years. Successor is
  appointed (currently from a deterministic queue; later, by
  player / empire-level mechanics).

### Governor's powers

- Sets provincial tax rates (% of harvest, fixed per-cart toll on
  roads, tribute on certain goods).
- Commands the **provincial garrison** (built from city
  `service.garrison` capacities + the capital's own larger force).
- **Sends patrols against bandits** (see
  [12 — Bandits & Conflict](12-bandits-and-conflict.md)):
  stationary detachments (`stationarii`) at road chokepoints,
  mobile patrols on arterials. Patrol frequency depends on the
  governor's disposition and tax revenue.
- Funds large public works (inter-city roads, walls, aqueducts).
- Issues edicts: grain price caps, conscription, expulsion of a
  family, tariff exemption for a favored merchant, curfew, etc.

### Tax revenue is real

Tax flows are real grain in real carts moving from villages →
cities → capital. Some flows further up to "the empire" off-map are
future scope; currently the governor keeps provincial tax revenue. A tax-shipment
caravan that gets ambushed (see
[12 — Bandits & Conflict](12-bandits-and-conflict.md)) is an
unfunded garrison the next month.

Assessment is not dispatch. A harvest assessment may create many owed
shipments, but the tax office queues them and releases only a limited
number of district convoys per day. It also has an active-convoy cap:
if earlier tax convoys are still on the road, later assessments remain
queued instead of spawning a second wave. Several same-resource
owner/settlement assessments can ride in one convoy; the local
feeder-cart collection into that staging convoy is abstracted. This
avoids impossible province-wide instant mobilization and keeps caravan
counts continuous. Once a tax shipment reaches the capital, in-kind
cargo enters the governor's stockpile, while `goods.coin` cargo credits
the governor's spendable treasury; the shipment unit leaves the caravan
simulation and does not become a permanent merchant caravan.

A per-governor disposition modifier (corrupt / generous / militant
/ neglectful) shapes their decisions while in office. The governor
holds reputations with each family, headman, and notable merchant
— see [13 — Reputation & Relationships](13-reputation-and-relationships.md).

## City patrician families

- Each city has **3–7 patrician families**, generated by procgen.
- Each family owns a portfolio:
  - **Estates in the countryside**: one or more villages whose
    land they own and whose labor — tenants and/or slaves — they
    direct.
  - **Workshops in the city**: smithy, pottery, mill, weaver
    shop, etc.
  - **Standing herds**: sheep, cattle.
  - **Mines** where they have access.
  - **A town house** in the city.
- Families sit on the **city council (curia)** and elect annual
  magistrates from among themselves.
- Families compete: rivalries, alliances, marriages. One family
  often dominates a city; civil disputes between families are
  real events with economic consequences (boycotts, hired thugs,
  sabotaged caravans). Family-vs-family reputation is tracked
  per-pair (see [13 — Reputation](13-reputation-and-relationships.md)).
- A family head can:
  - **Fund public works** (donations buy popularity; reduces tax
    pressure).
  - **Sponsor festivals** (boosts city happiness; consumes wine,
    grain, livestock).
  - **Maintain a small private guard** (private soldiers paid
    from family treasury; patrols family estates and roads).
  - **Hire caravans** — including the player — to move family
    goods.
  - **Take loans, default on loans** (consequences propagate
    through the network of lenders and rivals).
- Profits flow into family wealth: rents from tenants, products
  from slave-worked estates and family workshops, dividends from
  minor enterprises, money-lending.

## Village & hamlet leadership

Two main forms.

### Patron-client villages (most common)

- Village land is owned by one (occasionally two competing)
  patrician family in a nearby city (`tile.ownerActor = patron`).
- Village headman (`vilicus`) is the family's appointed agent,
  often a freedman or a trusted slave with limited authority.
- The village itself has its own `free_village` actor — the
  village commons / steward fund. This actor owns the village's
  buildings, runs production, holds the village's grain reserves,
  and pays its plebeian workers' wages. Per docs/15 §C29 the
  patron is **not** a stockpile owner of the village; per docs/15
  §C30 inventory is physical-by-settlement.
- Workers are coloni-style tenants whose surplus is gathered by
  the village steward and converted to coin at the local market.
- The family directs production goals (more grain this year,
  switch pasture to vines, slaughter more livestock for the family
  festival) but day-to-day work is the headman's call.
- Surplus flows to the family town house **as quarterly coin
  tribute** (`Settlement.clientPatron` points to the patron;
  `tributePhase` runs every 90 days and transfers
  `TRIBUTE_FRACTION × village.treasury` coin to the patron).
  Grain physically stays at the village granary unless a caravan
  hauls it to the city in response to a price gap or a villager
  caravan (see "Village ↔ city trade" below) takes it.

### Free villages (less common)

- Smallholder peasants own their own plots.
- A village elder or a small council of elders coordinates shared
  resources (oven, well, common pasture, mill).
- Still owe taxes / military service to the regional governor.
- More resilient politically but typically poorer than
  patron-client villages.

### Village / hamlet trade — the villager caravan (docs/15 §C31)

Village and hamlet stewards can dispatch low-capacity villager pack
caravans when local conditions justify a market run. This is not the
prestige long-haul mule-train pattern that patrician families run,
but the modest 2-4 mule local-trade path that lets rural economies
sell surplus and buy missing goods through real movement.

The same caravan handles three motivations depending on the
season's pressure:

1. **Surplus run.** The settlement has more grain / legumes / wool /
   flax / lumber / cheese / livestock / cloth than it needs.
   Carry it to a market, sell, come back with coin and bought goods.
2. **Import trip.** The settlement has accumulated coin from prior
   trips. The steward funds a trip to buy pottery / oil / wine /
   salt / iron tools and brings them back.
3. **Hard-times resupply.** The settlement's own subsistence is
   running short (bad harvest, plague). The steward drains some
   treasury and sends the caravan to buy staples back.

The caravan's id carries the `villager-` prefix and the viewer
renders it with a dedicated peasant-with-handcart glyph. It uses
the same planner as merchant caravans, so direction + cargo emerge
from known prices, bid depth, route cost, and fallback scouting; the
dispatch trigger is demand-backed: sellable surplus, a home-learned
import shortage, or a hard-times staple need. Accumulated treasury alone
does not launch a trip. Per-owner cap = 3 active villager caravans.
There is no global rural slot pool; dispatch is constrained by the
steward's animals, rations, operating cash, current demand, known prices,
and route economics.

### Hamlets

- Usually one extended family or a cluster of related
  households, often sharing an oven and a well.
- Either independent smallholders or tenants of an absentee
  landlord (effectively a tiny patron-client setup).

## Hex-level ownership (locked)

Every catchment hex (every field, pasture, mine deposit, managed
forest hex, quarry, river weir) is owned by a specific actor:

- A free village's catchment is owned by the village (collective)
  or its individual smallholders.
- A patron-client village's catchment is owned by the patron
  family (which is one of the city families).
- A mining region's deposit hexes are owned by whoever holds
  mining rights — a patrician family, the city corporation, or
  the governor. **Off-map merchants do not hold concessions**
  (docs/10 §45); foreign trade flows through transient inbound
  visits only.
- A managed forest near a settlement may be communal (city-owned),
  private (family-owned), or imperial / governor-owned.
- **Wilderness hexes are typically unowned.** First-come
  extraction works; if a settlement extends its catchment to
  include a wilderness hex and works it consistently, it
  effectively claims it (formal recognition by the governor may
  follow, or may not).

When a recipe runs at a catchment hex, output goes to the
**building's `ownerActor` stockpile at this settlement**, not to a
generic settlement pool. Per docs/15 §C30 inventory is keyed by
settlement, so the same actor's stockpile in city A and village B
are separate physical pools. For patron-client villages this
distinction matters: the building owner is the village steward
(the village's `free_village` actor), not the patron. The patron
owns the LAND (`tile.ownerActor`) but the steward owns the
HARVEST. Surplus reaches the patron via the quarterly tribute
(`tributePhase`), not by direct accumulation in a shared pool.

The owner then chooses whether to sell into the local market
(see [08 — Money & Trade](08-money-and-trade.md) for the per-owner
reservation-price logic).

This is what makes "blockade the city" or "seize a family's mine"
have real economic teeth: ownership is traceable end-to-end and
inventory is physically located.

## Slaves

- Slaves are **owned property** — owned by a specific actor (a
  family, the city, the governor, a temple).
- Can be inherited, sold, freed.
- They are not a settlement-wide labor subsidy. Only actors with slave
  ownership or command rights can use enslaved worker-days without a
  cash wage; other actors must hire free labor or rent/purchase labor
  through an explicit future contract.
- Sources: war captives, debt bondage, raids and trade from beyond
  the map (carried by real caravans — see
  [06 — Caravans](06-caravans.md)).
- Population segment: lower consumption, no comfort/status wants,
  higher mortality (especially mines and large estates). Modeled
  in detail in [04 — Population](04-population.md).
- A slave economy is brittle: it depends on continuous supply and
  produces a population that has no loyalty to the system that
  owns them. Slave revolts are possible when conditions degrade —
  some revolting slaves become bandits in nearby wilderness (see
  [12 — Bandits & Conflict](12-bandits-and-conflict.md)).

## How this connects to the rest of the sim

- When a recipe runs at a workshop, the output goes to the
  **workshop owner's stockpile**, not "the settlement's pool."
- When a settlement is short on food, its different owners react
  differently — some sell at any price, some hoard waiting for
  higher prices, some donate for political credit. The market
  clearing in [08 — Money & Trade](08-money-and-trade.md)
  produces consequences (riots, edicts, mob looting) emergently.
- Politics shapes taxes, garrison strength, big infrastructure
  projects, and which routes are safe.
- Reputation between families, between families and the
  governor, and between any of those and the player is tracked
  in [13 — Reputation & Relationships](13-reputation-and-relationships.md).
- The player can't directly command any of these actors but can
  influence them via trade, bribes, donations, future marriage
  mechanics, or military pressure.

## What the player can and can't do here

- **Can:** trade with anyone, donate to public works, bribe
  officials, hire mercenary guards, intercept rival caravans on
  the road, fund the founding of a new settlement, build a
  reputation with specific families and the governor.
- **Cannot (in the current scope):** become a patrician family member with
  estate-level labor control. Cannot replace a governor. Cannot
  dictate tax policy. Cannot directly run a workshop or farm.

These limits keep the player as _one actor among many_ in the
simulated economy. The path to becoming a patrician (and beyond)
is future scope.
