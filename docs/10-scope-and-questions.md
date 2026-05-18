# 10 — Current Scope, Decisions, Risks, Next Steps

All design questions raised so far have been resolved. This doc
describes the current v1.5 scope, the main risks, and
what to build first.

## Current Scope (v1.5)

**Goal of the current scope:** the smallest world that meaningfully demonstrates
the no-hidden-hands economy, with realistic Roman-style social
structure, physically correct distances and feature sizes, a
political-and-conflict layer rich enough that the player has
choices beyond "buy low, sell high," and a Vagrus-style daily
play loop.

### In

- **1 day per turn, fully turn-based.** Year = 365 turns. Player
  turn = one in-game day, structured Vagrus-style: daily MP pool,
  spend during the turn on movement / trade / combat / exploration,
  end the turn by camping. **No real-time fast-forward** — passing
  time is just clicking End Turn (with or without actions). UI
  surfaces auto-pause flags + hold-to-end-turn so long waits aren't
  painful, but nothing in the sim "skips" days.
- **1 km hexes.** A typical mule caravan's day ≈ 25 hexes (= 25
  km). All distances physically realistic.
- **Map size: ~500 km × 500 km, ~250,000 hexes.** Most of the
  map is wilderness; settlements concentrate in 3–5 regional
  clusters with arterial routes between them.
- **4–5 cities** (5k–30k people each, dense, 2–10 urban hexes
  each) + **10–25 towns** + economically realistic hinterland.
  No settlement aggregation: ~1,200–2,500 real village entities
  and ~1,500–4,500 real hamlet entities, totaling **~3,000–8,000
  settlement entities**. Modeled population: ~700k–1.2M. Numbers
  derived from realistic Roman demographics and refined by procgen
  - stabilization.
- **Settlements physically occupy multiple hexes** for towns and
  cities. Entering any of their hexes opens the settlement
  screen.
- **Natural features have proper extent**: a forest is 20–200
  contiguous hexes, a mining region is 1–10 deposit hexes, a
  village's fields are ~6–10 hexes, etc.
- **Hex-level ownership**: every field, mine, pasture,
  workshop, granary belongs to a named actor. Recipe output
  goes to the owner's stockpile.
- **Wilderness and exploration**: ~80% of the map is
  wilderness between settled clusters. Procgen places ~10–30
  hidden features (abandoned mines, ruins, hermit shrines,
  abandoned settleable villages, lost routes, bandit hideouts)
  for discovery.
- **Full demographic pyramid**: 5-year age cohorts × male/
  female × class. Real Roman vital rates.
- **Disease**: endemic background mortality + stochastic
  epidemic events that propagate along caravan routes. Cities
  can quarantine.
- **All Tier 0–2 resources** except sea-only ones, plus Tier 2b
  exotic imports, plus Tier 2c people-as-cargo, plus Tier 3
  institutional capacities.
- **Slavery** as a population class + transportable resource.
- **Exotic imports** arrive only via real off-map caravans.
- **Exports to off-map global market** symmetrically: NPC
  long-haul caravans take high-value low-weight goods out,
  including surplus amphora-packed oil/wine when quality or scarcity
  makes the spread justify it. Low-value bulk staples don't export
  because the math doesn't justify it (emergent). Player cannot run
  off-map caravans.
- **Detailed demand & supply model**: subsistence inelastic +
  comfort elastic + status inelastic-rich + producer derived
  input demand; market clearing per (settlement, resource,
  day).
- **Both buildings AND specialist labor required** for any
  recipe.
- **Land caravans only.** No ships.
- **Procgen + stabilization burn-in** before play begins (5–20
  game years headless).
- **Roman political layer** — single province with a governor in
  the capital, patrician families running cities and owning
  estates, villages either patron-client or free with elders,
  hamlets one-family or smallholder. Per
  [11 — Politics & Ownership](11-politics-and-ownership.md).
- **Named characters per faction** — every faction has named
  individuals who decide, remember, act, age, die, and are
  replaced. Roughly ~12k–32k named characters across the province.
- **Bandits and patrols**: bandits emerge from the population
  (failed harvests, demobilized soldiers, escaped slaves,
  dispossessed peasants); patrol by governor's troops, city
  watch, family guards, and caravan escorts pushes back.
  Friendly settlements fence stolen goods. Per
  [12 — Bandits & Conflict](12-bandits-and-conflict.md).
- **Battle system**: simple probabilistic combat with training,
  weapons, armor, health, posture, terrain. Used for caravan
  ambushes, patrol sweeps, settlement defense.
- **Reputation system**: per-named-character reputation, sparse
  storage, severe magnitudes, **propagated only by news
  carriers** (caravans, refugees, escaped survivors) at real
  travel speed. Per [13 — Reputation & Relationships](13-reputation-and-relationships.md).
- **Battle survivor witness mechanic**: surviving fleeers
  become real news carriers; "leave no witnesses" is hard but
  possible; missing caravans generate indirect rumor.
- **Player as caravan operator** — honest trader, fixer,
  military contractor, **or bandit** (or any mix). Multiple
  caravans, hire/equip crew, store goods, donate, bribe,
  eventually fund founding a settlement. Aliases allow
  operating under different names in different clusters until
  news catches up.
- WebGL/PixiJS rendering, viewport-culled. Initial terrain and glyph
  assets may be SVG-backed. Multi-hex settlements drawn as clustered
  urban hexes; burn-in viewer animates caravans and moving camps.
- Save/load.
- Headless "run N years" mode — required for tuning, not
  optional.
- Per-settlement, per-resource, per-recipe, per-population,
  per-market, per-named-character, per-reputation,
  per-news-carrier diagnostics so the player can ask the world
  _why_.

### Out (future layers)

- Sea trade.
- Multi-province / Mediterranean scale.
- Empires beyond a single province (the governor is the top of
  the political pyramid in the current scope).
- Player owning workshops/farms/estates with directed labor.
- Player becoming a patrician family member or holding office.
- Player running off-map export/import caravans.
- Religion as full economic actor (priesthood is a service
  capacity, but no festival economy or sacred-resource flows
  yet).
- Marriage / family-membership mechanics for the player.
- Full guild system for craftsmen.

This keeps the current scope small enough to tune while exercising every core
loop: production → consumption → trade → demographics & disease
→ politics → conflict → reputation → consequence.

## Decisions locked

| #   | Question                                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Turn length                                  | **1 day**, fully turn-based; End Turn = advance one day, with or without actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | Map size                                     | **~500 × 500 km, ~250,000 hexes** with mostly wilderness between settled clusters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3   | Slavery as a modeled system                  | **Yes** — population class + transportable resource                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Exotic imports                               | **Real off-map caravans** (no magic spawning)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | Buildings vs. specialists                    | **Both required** for a recipe to run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | Player labor control over settlements        | **None in the current scope.** Player operates caravans only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | Sea trade in current scope                   | **No.** Land only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | Procgen geography style                      | **Procgen + stabilization sim**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 9   | Politics scope                               | **Roman political layer** — governor + patrician families + village patrons / elders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | Hex size                                     | **1 km across.** All distances physically correct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11  | Demographic model                            | **Full pyramid** (5-yr cohorts × M/F × class)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Disease in current scope                     | **Yes**, with epidemic propagation along caravan routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 13  | Demand/supply model                          | **Subsistence inelastic + comfort elastic + status inelastic-rich + derived input demand**; market clearing per (settlement, resource, day)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 14  | Off-map exports                              | **Yes**, via NPC long-haul caravans; player cannot run them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 15  | Settlements: physical extent                 | **Multi-hex** for towns/cities; entering any hex opens the settlement screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 16  | Natural features: extent and ownership       | **Real multi-hex extents**; every feature hex has an owner; recipe outputs go to hex owner's stockpile                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 17  | Wilderness & exploration                     | **Mostly wilderness between clusters**; procgen places hidden features for discovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 18  | Bandits & patrols                            | **Bandits emerge from population**; patrols counter; player can act as a bandit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 19  | Battle system                                | **Simple probabilistic combat** with training/weapons/armor/health/posture/terrain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 20  | Reputation system                            | **Per-actor reputation tables**; affects trade, access, info, help                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 21  | Named characters per faction                 | **Yes** — every faction has named characters who decide, remember, act, die, and are replaced                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | News-carrier rumor propagation               | **Locked** — reputation updates travel at the speed of caravans / refugees / escaped survivors, never instantly                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 23  | Battle survivor witness mechanic             | **Locked** — escaped survivors become real news carriers; "leave no witnesses" is hard but possible; missing caravans seed indirect rumor                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 24  | Player turn UX                               | **Vagrus-style** — daily MP pool spent during the turn; end the turn by camping; clicking End Turn without actions advances one day; auto-pause flags surface notable events                                                                                                                                                                                                                                                                                                                                                                                              |
| 25  | Terrain difficulty model                     | **Per-(terrain, road) difficulty factors** (road=1, dirt=1.25, off-road varies 5–16); modified by load + equipment + animals. See [06 — Caravans](06-caravans.md)                                                                                                                                                                                                                                                                                                                                                                                                         |
| 26  | Goal-bearing units                           | **Caravans, migrations, military units, patrols carry persistent goals** (move_to / trade_at / escort / patrol / return_home / flee_to) on a stack, subject to money/food/health/season constraints                                                                                                                                                                                                                                                                                                                                                                       |
| 27  | Communicated price discovery                 | **Merchant guilds** mediate price gossip — caravans deposit observations to home guild, members read on arrival, guilds exchange across cities. Each NPC plans crowding-aware (no stampedes). See [08 — Money & Trade](08-money-and-trade.md)                                                                                                                                                                                                                                                                                                                             |
| 28  | Escalating banditry response                 | Local watch → family guard → governor patrol → cohort sweep → cross-province reinforcement. Patterns of incidents (not single events) drive escalation. See [12 — Bandits & Conflict](12-bandits-and-conflict.md)                                                                                                                                                                                                                                                                                                                                                         |
| 29  | Docs-first discipline                        | **Locked rule** in CLAUDE.md: design changes update docs FIRST, then code. Docs hold the conceptual data (recipes, vital rates, formulas). Code implements from docs                                                                                                                                                                                                                                                                                                                                                                                                      |
| 30  | River vs. lake terrain semantics             | **Rivers are sub-1 km wide** — a river hex still has riverbank land, so settlements + buildings CAN sit on river hexes; fording without a bridge is slow but possible. **Lakes fully occupy their hex** — impassable + unbuildable. **No `coast` terrain** — sub-sea-level hexes are `lake` directly; sea-trade content is deferred. See [07 — Geography](07-geography.md)                                                                                                                                                                                                |
| 31  | River/lake adjacency caps                    | A river hex may touch ≤3 water neighbors total (rivers + lakes) of which ≤1 may be a lake; a lake hex may touch ≤1 river. Violators collapse to lake. Prevents "river-lakes" and multi-outlet lakes. See [07 — Geography](07-geography.md) "River adjacency caps"                                                                                                                                                                                                                                                                                                         |
| 32  | Bid-ask book per market                      | **Locked** — every per-(settlement, resource) clearing records `bestBid`, `bestAsk`, `bidDepth`, `askDepth`, `midPrice`, and `spread` derived from the residual demand/supply schedules. Surfaced in viewer panels and consumed by caravan/cross-spread logic. See [08 — Money & Trade](08-money-and-trade.md) §"Bid-ask book"                                                                                                                                                                                                                                            |
| 33  | Cash circulation discipline                  | **Locked** — every actor kind that the schedule builder draws bids from must have a sustainable cash income channel (rents, tax, wages-in-coin, merchant-house dividends, sales). Without it, comfort/status/capital markets go dormant on top of full stockpiles. See [08 — Money & Trade](08-money-and-trade.md) §"Cash circulation discipline"                                                                                                                                                                                                                         |
| 34  | Physical inventory by settlement             | **Locked** — `Actor.stockpile` is keyed by `SettlementId` (`Map<SettlementId, Map<ResourceId, Quantity>>`). The same actor can hold inventory at multiple settlements but the pools are distinct: a recipe firing at building `b` only drains/credits `actor.stockpile.get(b.settlement)`. No hidden hand can satisfy markets in 18 settlements from one warehouse. See [11 — Politics & Ownership](11-politics-and-ownership.md), [15 — v1.5 cleanups](15-v1-5-cleanups.md) §C30                                                                                         |
| 35  | Patron-client tribute (not pooled inventory) | **Locked** — client villages have their own `free_village` actor that owns the village's harvest. Patrons collect quarterly **coin tribute** (a fraction of village treasury) — they do not co-own the village's stockpile. The viewer reports physical stock at each settlement, not "ownership pool" abstractions. See [11 — Politics & Ownership](11-politics-and-ownership.md) §"Patron-client villages", [15 — v1.5 cleanups](15-v1-5-cleanups.md) §C29                                                                                                              |
| 36  | Village ↔ city flow via villager caravans    | **Locked** — every village's `free_village` steward dispatches a small handcart caravan (2-4 mules, 1 drover + 1 guard) to the nearest city every ~2 weeks if it has any exportable inventory, accumulated treasury, or a hard-times resupply need. Surplus run / import trip / hard-times resupply are the three motivations; the planner picks cargo + direction each leg. Distinct from patron-funded long-haul merchant trains; renders with its own SVG glyph. See [06 — Caravans](06-caravans.md) §"NPC caravan AI", [15 — v1.5 cleanups](15-v1-5-cleanups.md) §C31 |
| 37  | Caravans transact via local markets, never stockpile (v1.6) | **Locked** — every caravan (international, long-haul, villager, replacement, player) buys and sells on the destination's CDA market via bid/ask. No direct stockpile transfer path exists. Petty merchants in the local-trade pass post the same kind of bid/ask in both settlements' markets. See [06 — Caravans](06-caravans.md) §"Caravan lifecycle", [08 — Money & Trade](08-money-and-trade.md) §"Caravans transact via local markets, never stockpile" |
| 38  | Per-actor information asymmetry on prices (v1.6) | **Locked** — every Actor carries `knownPrices: Map<SettlementId, MarketObservation>` where `MarketObservation` is a whole-ladder snapshot stamped with one `observedDay`. **One observation per (actor, settlement)**, not per-resource. Updated only by physical syncs: resident-presence (daily for actors at home), arrival, meeting (same-hex or same-settlement on same day, friendly/neutral only), guild-ledger, edge-hex. **Newer observedDay always wins atomically** on merge — older snapshot is discarded whole. **No deception channel**: hostile actors withhold sync, never feed false data. No source / provenance tracking. Observations older than 180 days are stale. No global oracle. See [06](06-caravans.md) §"Caravan information model" + [13](13-reputation-and-relationships.md) §"News-carrier price piggyback" |
| 39  | International ventures dispatched by patricians + guilds (v1.6) | **Locked** — international caravans are not spawned by a global schedule. Patrician families and merchant guilds at large/small cities evaluate route profit using their `knownPrices` maps and dispatch a venture when `expected_profit ≥ 3 × expected_transport_cost`. Transport cost = full operating cost (feed + wages + cart wear + bandit-loss exp + tolls), including the 20-tick off-map sojourn. Other actor kinds do not dispatch international trade. See [06](06-caravans.md) §"International ventures" |
| 40  | 20-tick off-map sojourn at edge hex (v1.6)   | **Locked** — a caravan at an edge hex sells outbound cargo to the global market at the global reference price, optionally buys return cargo, and enters `off_map` state for **20 ticks**. During those ticks: invisible on map, no movement, no ambush risk, but **wages + fodder still accrue**. On day E + 20 the caravan re-emerges at the same edge hex with return cargo and walks home. Provisioning at dispatch must include home→edge + 20 + edge→home rations. Single 20-tick value applies to every edge gate. See [06](06-caravans.md) §"The 20-tick off-map sojourn" |
| 41  | Global market = infinite-demand sink at edge hexes (v1.6) | **Locked** — the off-map global market has **infinite buying and selling capacity** at the global reference price. The edge hex is the market venue. Old `EDGE_HUB_MAX_ACTIVE_*`, `EDGE_HUB_DISPATCH_INTERVAL_DAYS`, exogenous import-house spawn schedule, and `maxImportSpawnsPerDay` style caps are **deleted**. What restrains volume is bounded actor information + finite treasuries + the 3× transport-cost dispatch threshold. Per Pillar 8, every catalog resource has a global reference price. See [08](08-money-and-trade.md) §"The off-map global market" |
| 42  | Per-capita consumption calibrated to Roman reference (v1.6) | **Locked** — every comfort-demand per-capita rate (wine, oil, cheese, salted meat/fish, cloth, clothing, pottery, furniture) lies within the historical Roman per-capita range (Garnsey, Erdkamp, Jongman) documented in [04 — Population](04-population.md) §"Per-capita consumption sanity ranges". Mismatches between recipe outputs and demand cause stockpile bloat — the calibration table is the source of truth and both demand schedules and `grantStarterMarketInventory` must match it |
| 43  | All inter-settlement trade goes through real caravan units (v1.6) | **Locked** — the abstract `localTradePhase` daily-pass that teleported goods between settlement pairs is **deleted**. Every cross-settlement trade is a real Caravan unit with a position, food consumption, ambush exposure, weather risk, and disease vector. Three tiers (handcart ≤ 50 kg / villager cart 2–4 mules / standing merchant 10–50 animals) all share the SAME machinery — they differ only in size, dispatcher, and route length. Only same-hex coexistence (pagus + dependent hamlets sharing one literal hex) clears at 0-tick via intra-hex market step. A villager handcart on a road is as ambush-exposed as a senatorial merchant train on the same road. See [06 — Caravans](06-caravans.md) §"Local trade between nearby settlements" |

## Open design risks

- **Performance.** ~3,000–8,000 settlement entities × ~40
  resources × per-day market clearing, plus ~250k mostly-static
  hexes, plus hundreds of caravans planning daily, plus full
  demographic pyramid updates, plus disease propagation, plus
  bandit and patrol AI, plus ~12k–32k named characters with
  sparse reputation tables, plus news carriers in transit, plus
  daily ticks for years during burn-in. Tractable in TS but
  needs care: data-oriented layout, throttle heavy logic to
  multi-day ticks where realistic (demographics aggregate
  weekly is fine), Web Worker offload, sparse reputation
  storage. Burn-in performance is the biggest single cost
  driver; profile early.
- **Tuning hell.** Deeply interlinked economies are notoriously
  hard to balance. The stabilization burn-in doubles as our
  main tuning harness: if the world doesn't stabilize, the
  model is broken.
- **Player legibility.** With no hidden hand, the player can
  fail to understand _why_ something happened. We commit to
  per-resource history panels, per-recipe shortfall reasons,
  per-population want diagnostics, per-disease state,
  per-named-character reputation attribution, per-news-carrier
  in-transit visibility, per-market schedule view.
- **End-turn UX.** A 1-day turn means a 5-year campaign is
  1,800+ turns. The Vagrus-style camp/rest with auto-pause
  events is the answer; it has to work well from day one.
- **Burn-in convergence.** If the stabilization sim oscillates
  or collapses, we have no game. Burn-in stability is an
  explicit acceptance criterion.
- **Demand/supply numerical stability.** A subsistence-inelastic
  demand curve can produce extreme prices in narrow conditions
  (a famine with one rich actor still buying). We need price
  caps, sane fallbacks (riots, edicts, mob looting), and good
  diagnostics before exploiting goes infinite.
- **Pathfinding scale.** Long cross-cluster routes through
  250k hexes need efficient pathfinding (jump-point search,
  hierarchical, or precomputed road graphs). Not free, not
  hard.
- **Battle balance.** Probabilistic combat with many modifiers
  is easy to get wrong. The headless harness should include
  combat scenarios with expected outcome distributions.
- **Reputation mass.** ~12k–32k named characters × sparse
  reputation slates is small in storage but unbounded in
  cascading update cost if a single big event has many
  hearers. Keep updates event-driven and bounded.

## Next steps

1. Concrete TypeScript data schema (`Resource`, `Recipe`,
   `Building`, `Settlement`, `Hex`, `Caravan`,
   `PopulationCohort`, `OwnerActor`, `Family`,
   `NamedCharacter`, `Governor`, `Market`, `Disease`,
   `BanditCamp`, `CombatUnit`, `ReputationTable`,
   `NewsCarrier`).
2. Deterministic tick loop, headless: a tiny scenario (1 city
   - 3 villages + 1 patrician family + 1 governor + 1 bandit
     camp + a working demographic pyramid) that runs N days and
     dumps state.
3. Stabilization-sim loop on that scenario: run for years,
   verify it stabilizes; check expected demographic, economic,
   political, and reputation invariants.
4. Procgen v0 for hex maps at 1 km hex / 500 km map (terrain +
   climate + resource placement + natural feature extents).
5. Settlement and ownership seeding pass; place wilderness
   features and bandit camps; instantiate named characters per
   faction; full burn-in on a procgen map.
6. WebGL/PixiJS rendering of the hex map (with multi-hex settlements,
   viewport-culled and SVG-backed initial glyph assets) and a single
   settlement panel.
7. Player caravan with daily-MP movement, rations, hex-by-hex
   travel at correct distances; camp-to-end-turn UX.
8. Trade UI: market view of the current settlement with
   diagnostics (who's selling, who owns the stockpile, what
   the demand schedule looks like).
9. Reputation UI: per-named-character reputation panel with
   attribution; news-carrier in-transit view.
10. Combat UI: simple resolution screens for ambushes, patrol
    encounters, settlement defense; explicit witness/survivor
    accounting.
11. End-turn UI with auto-pause events (no real-time fast-forward).
12. Iterate against the headless tuning harness.
