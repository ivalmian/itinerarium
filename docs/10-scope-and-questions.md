# 10 — V1 Scope, Decisions, Risks, Next Steps

All design questions raised so far have been resolved. This doc
describes the v1 scope as actually planned, the main risks, and
what to build first.

## V1 Scope

**Goal of v1:** the smallest world that meaningfully demonstrates
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
  Aggregate entity counts: ~600–900 villages and ~300–500
  hamlets, totaling **~1,000–1,500 settlement entities**.
  Modeled population: ~700k–1.2M. Numbers derived from realistic
  Roman demographics and refined by procgen + stabilization.
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
  long-haul caravans take high-value low-weight goods out. Bulk
  goods don't export because the math doesn't justify it
  (emergent). Player cannot run off-map caravans.
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
  replaced. ~6,000 named characters across the province.
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
- Simple SVG rendering, viewport-culled, no animation beyond
  minimal feedback. Multi-hex settlements drawn as clustered
  urban hexes.
- Save/load.
- Headless "run N years" mode — required for tuning, not
  optional.
- Per-settlement, per-resource, per-recipe, per-population,
  per-market, per-named-character, per-reputation,
  per-news-carrier diagnostics so the player can ask the world
  *why*.

### Out (v1.5+)

- Sea trade.
- Multi-province / Mediterranean scale.
- Empires beyond a single province (the governor is the top of
  the political pyramid in v1).
- Player owning workshops/farms/estates with directed labor.
- Player becoming a patrician family member or holding office.
- Player running off-map export/import caravans.
- Religion as full economic actor (priesthood is a service
  capacity, but no festival economy or sacred-resource flows
  yet).
- Marriage / family-membership mechanics for the player.
- Full guild system for craftsmen.

This keeps v1 small enough to tune while exercising every core
loop: production → consumption → trade → demographics & disease
→ politics → conflict → reputation → consequence.

## Decisions locked

| # | Question | Decision |
|---|---|---|
| 1 | Turn length | **1 day**, fully turn-based; End Turn = advance one day, with or without actions |
| 2 | Map size | **~500 × 500 km, ~250,000 hexes** with mostly wilderness between settled clusters |
| 3 | Slavery as a modeled system | **Yes** — population class + transportable resource |
| 4 | Exotic imports | **Real off-map caravans** (no magic spawning) |
| 5 | Buildings vs. specialists | **Both required** for a recipe to run |
| 6 | Player labor control over settlements | **None in v1.** Player operates caravans only |
| 7 | Sea trade in v1 | **No.** Land only |
| 8 | Procgen geography style | **Procgen + stabilization sim** |
| 9 | Politics scope | **Roman political layer** — governor + patrician families + village patrons / elders |
| 10 | Hex size | **1 km across.** All distances physically correct |
| 11 | Demographic model | **Full pyramid** (5-yr cohorts × M/F × class) |
| 12 | Disease in v1 | **Yes**, with epidemic propagation along caravan routes |
| 13 | Demand/supply model | **Subsistence inelastic + comfort elastic + status inelastic-rich + derived input demand**; market clearing per (settlement, resource, day) |
| 14 | Off-map exports | **Yes**, via NPC long-haul caravans; player cannot run them |
| 15 | Settlements: physical extent | **Multi-hex** for towns/cities; entering any hex opens the settlement screen |
| 16 | Natural features: extent and ownership | **Real multi-hex extents**; every feature hex has an owner; recipe outputs go to hex owner's stockpile |
| 17 | Wilderness & exploration | **Mostly wilderness between clusters**; procgen places hidden features for discovery |
| 18 | Bandits & patrols | **Bandits emerge from population**; patrols counter; player can act as a bandit |
| 19 | Battle system | **Simple probabilistic combat** with training/weapons/armor/health/posture/terrain |
| 20 | Reputation system | **Per-actor reputation tables**; affects trade, access, info, help |
| 21 | Named characters per faction | **Yes** — every faction has named characters who decide, remember, act, die, and are replaced |
| 22 | News-carrier rumor propagation | **Locked** — reputation updates travel at the speed of caravans / refugees / escaped survivors, never instantly |
| 23 | Battle survivor witness mechanic | **Locked** — escaped survivors become real news carriers; "leave no witnesses" is hard but possible; missing caravans seed indirect rumor |
| 24 | Player turn UX | **Vagrus-style** — daily MP pool spent during the turn; end the turn by camping; clicking End Turn without actions advances one day; auto-pause flags surface notable events |
| 25 | Terrain difficulty model | **Per-(terrain, road) difficulty factors** (road=1, dirt=1.25, off-road varies 2.5–8); modified by load + equipment + animals. See [06 — Caravans](06-caravans.md) |
| 26 | Goal-bearing units | **Caravans, migrations, military units, patrols carry persistent goals** (move_to / trade_at / escort / patrol / return_home / flee_to) on a stack, subject to money/food/health/season constraints |
| 27 | Communicated price discovery | **Merchant guilds** mediate price gossip — caravans deposit observations to home guild, members read on arrival, guilds exchange across cities. Each NPC plans crowding-aware (no stampedes). See [08 — Money & Trade](08-money-and-trade.md) |
| 28 | Escalating banditry response | Local watch → family guard → governor patrol → cohort sweep → cross-province reinforcement. Patterns of incidents (not single events) drive escalation. See [12 — Bandits & Conflict](12-bandits-and-conflict.md) |
| 29 | Docs-first discipline | **Locked rule** in CLAUDE.md: design changes update docs FIRST, then code. Docs hold the conceptual data (recipes, vital rates, formulas). Code implements from docs |

## Open design risks

- **Performance.** ~1,000–1,500 settlement entities × ~40
  resources × per-day market clearing, plus ~250k mostly-static
  hexes, plus hundreds of caravans planning daily, plus full
  demographic pyramid updates, plus disease propagation, plus
  bandit and patrol AI, plus ~6,000 named characters with
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
  fail to understand *why* something happened. We commit to
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
- **Reputation mass.** ~6,000 named characters × sparse
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
   + 3 villages + 1 patrician family + 1 governor + 1 bandit
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
6. SVG rendering of the hex map (with multi-hex settlements,
   viewport-culled) and a single settlement panel.
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
