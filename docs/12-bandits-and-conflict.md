# 12 — Bandits, Patrols, and Conflict

The Roman world had endemic banditry. Hilly and forested regions
harbored sizeable bands; main roads were patrolled by military
detachments; cities had watchmen. Bandits weren't an event — they
were a feature of the geography, emerging from the same population
and economy that produced everything else. The same battle mechanic
covers caravan ambushes, patrol sweeps, and (rarely) sieges.

## Banditry as a fate (where bandits come from)

People become bandits via several pathways:

- **Failed harvests / famine**: rural smallholders who lost their
  land or their crop turn to brigandage rather than starve.
- **Demobilized soldiers**: a war ends, units disband, some men
  don't go home. They have weapons and training — the most
  dangerous flavor of bandit.
- **Escaped slaves**: maroons take to wilderness; some band
  together.
- **Dispossessed peasants**: land seizures, debt foreclosure, a
  patron family's eviction of unprofitable tenants.
- **Urban idle poor**: city-born thieves, sometimes graduating to
  full wilderness banditry.
- **Baseline tendency**: a small constant fraction of people choose
  banditry by inclination — sets a floor below which bandit
  numbers don't fall, even in good times.

Mechanically, the population `idle` class (see
[04 — Population](04-population.md)) is the main recruitment pool;
local conditions (food shortage, plague, unemployment, a recent
demobilization) push some idle adults into the bandit class. They
leave the settlement, walk to a wilderness hex (a real migration
caravan, with ration cost), and join an existing camp or found a new
one.

## Bandit camps

A bandit camp is a special kind of settlement entity:

- **Located in wilderness hexes** — typically forest, hills, or
  mountain edges within a few days' march of a road. Procgen seeds
  initial camps near road chokepoints in low-garrison terrain
  (see [07 — Geography](07-geography.md)).
- **No formal stockpile or buildings** beyond crude shelter.
  Stockpile is loot.
- **Population**: bandits (combat-capable adults), plus
  hangers-on (children, captives, women — historically the camps
  weren't just men).
- **Decisions per turn**: raid (attack a target), lay low, move
  camp, recruit, bribe a friendly settlement, fence loot.
- **Subject to the same consumption rules**: bandits eat. A camp
  that can't feed itself raids more aggressively or starves /
  scatters.

### Camp size determines what they can do

| Size              | Capability                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Small (<20)       | Opportunistic ambushes on lone caravans.                                                       |
| Medium (20–100)   | Coordinated road attacks; small village raids.                                                 |
| Large (100–500)   | Regional menace; town raids; can shadow-rule a wilderness area.                                |
| Insurgency (500+) | Effectively a rival polity. The governor must respond with serious force or lose the province. |

A camp may grow until a patrol breaks it, internal disputes
fragment it, or a particularly rich score lets the leaders retire
into respectability (laundering coin into land — historically
real).

### Bandit demographics

Per the pillar-1 rule "everyone in all units has gender and age",
every `BanditCamp` carries two optional **demographics** maps:

- `banditDemographics` — sums to `banditCount`. The fighters.
- `hangersOnDemographics` — sums to `hangersOnCount`. Children,
  captives, dependents.

Both use the same sparse `Map<string, number>` keyed by
`${sex}|${ageBand}` shape as `CrewMember.demographics` (docs/06)
and `Settlement.population`.

Sourcing rule (procgen + recruitment):

- The initial-camp seeder pulls from the **nearest city's
  working-age population pool** via
  `drawDemographicsFromPool(pool, count, bias, rng)`, matching the
  "banditry as a fate" doctrine: bandits are recruited from real
  villages and city poor, not generated from thin air.
- Per-role bias profiles (`ROLE_BIASES` in
  `src/sim/population/demographics.ts`):
  - `bandit` — heavily male (10% female weight), fighting-age
    15-44.
  - `bandit_hanger_on` — wider, female-favored (50/100 sex
    weight), with strong weight on children (5-14) and a sliver
    of the elderly. Reflects the historical mix of camp
    dependents.
- Recruitment drives (the `recruit_drive` action) add fighters;
  the demographics extension to that path is a follow-up — the
  current `recruit()` helper doesn't draw new demographics.

Casualty rule (battle):

- `applyBanditCasualties(camp, deaths, rng)` in
  `src/sim/bandit/camp.ts` returns a new camp with `banditCount`
  AND `banditDemographics` reduced together (largest-remainder
  rounding, RNG tie-breaking for determinism).
- The drained per-bucket map is returned for downstream
  feed-back-to-source-village accounting (currently a follow-up).

The fields are **optional** so existing fixtures keep working.

## Patrols (Roman-era)

Authorities push back. Roman-era options, all modeled in the current scope:

- **Provincial garrison patrols**: the governor's troops. Stationary
  detachments (`stationarii`) at road chokepoints; mobile patrols
  on arterials. Funded from `service.garrison` in the capital +
  tax revenue.
- **City watch** (analog of `vigiles`): urban patrols. Effective
  inside the city, marginal outside the walls.
- **Private family guards**: patrician families maintain small
  forces patrolling family estates and roads to family villages.
  See [11 — Politics & Ownership](11-politics-and-ownership.md).
- **Caravan escorts**: not patrols per se but a real deterrent —
  armed guards reduce ambush probability.

Patrol effectiveness depends on:

- Distance from the patrol base.
- Terrain (open plains > dense forest > mountains, for the
  patrol).
- Season (winter favors bandits; passes close, patrols
  sparser).
- Whether the patrol is bribed (corruption is real; some bandits
  effectively have safe-conduct).

Patrol demographics: every `Patrol` carries an optional
`demographics` map summing to `unit.count`, populated at procgen
from the `basedAt` settlement's working-age pool with the
`patrol_soldier` bias (heavily male, fighting-age 15-44). The
`applyPatrolCasualties(patrol, deaths, rng)` helper in
`src/sim/conflict/patrol.ts` drains both `count` and demographics
together. See docs/06 §"Crew demographics" for the parallel
caravan-side wiring.

## Escalating banditry response (locked)

A single ambush isn't immediately a governor-level problem. But
patterns of incidents escalate up the political chain:

1. **Local response**: when a caravan is robbed, news carriers
   carry the report (per
   [13 — Reputation](13-reputation-and-relationships.md)) to the
   nearest settlement. The local headman / family agent /
   merchant guild logs it. The local response is to send a
   private guard or city watch patrol if available.
2. **Pattern detection**: each settlement keeps a rolling count
   of robbery / ambush reports per region (last 30 days). If the
   count crosses a regional threshold, the settlement's leadership
   formally asks the local family head (or city council) to fund
   a stronger patrol. This is a real coin transfer + a new
   patrol's spawn.
3. **Family escalation**: family heads track banditry losses
   across their estates. If their losses exceed a tolerance, they
   raise the matter with the governor's office (a tax shipment
   carries the petition; petitions take days to arrive).
4. **Governor response**: the governor receives petitions + their
   own intelligence (provincial garrison reports). If multiple
   families petition AND the bandit problem is regional, the
   governor diverts garrison to the affected region — the
   "cohort sweep." This is a multi-day military movement.
5. **Insurgency response**: if a bandit camp grows past
   ~500 (insurgency-level per the size table above), the governor
   treats it as proto-rebellion and assembles a serious force,
   potentially calling in additional cohorts from neighboring
   provinces (modeled as off-map reinforcement caravans).

Each escalation step has a cost (coin, time, political capital).
Local leadership prefers cheap responses; only persistent or large
problems reach the governor. This means:

- A clever bandit who picks isolated victims and stays small
  can operate for years.
- A successful bandit who grows too fast attracts a governor
  response that wipes them out.
- Player-as-bandit gameplay is shaped by knowing the escalation
  thresholds and pacing accordingly.

The player can reverse-engineer this: bribe the governor to slow
escalation, take out specific informant caravans before reports
arrive, or even buy into a friendly family that buffers their
losses to delay petition.

## Friendly settlements and fences

Not every settlement is hostile to bandits:

- **Corrupt or coerced villages** near a camp: pay tribute and
  aren't raided in return; may also fence stolen goods.
- **Indifferent city quarters**: in a large enough city, certain
  markets don't ask hard questions about provenance. Stolen goods
  sell at a discount but they sell.
- **Governor disinterest**: in remote regions the governor's reach
  is weak; local patrons may tolerate bandits as long as they
  don't threaten patron interests.

This means bandits can move and trade as long as they stay in their
friendly network. Cross into a strict city or a vigorously patrolled
region and they get arrested or attacked on sight. The player-as-
bandit (below) lives or dies by knowing this map.

## Attacks on settlements

Large enough bandit bands attack settlements directly:

- **Hamlets / small villages**: smash-and-grab raids; loot
  stockpile, abduct people for ransom or slavery.
- **Towns**: rare; needs a large band or a bribed gate guard.
- **Cities**: very rare; needs a very large band or insider help;
  triggers a major governor response.

A settlement under attack defends with: garrison soldiers, local
militia (idle adults grabbing whatever they have), walls (a major
factor — see [03 — Production](03-production.md) for `build_walls`).

## Bandit raid parties (docs/15 §C32)

Per pillar §1 (no hidden hands), every camp-originated action that
touches another hex is a **physical, movable unit** — not an instant
camp-internal action. The unit is a `BanditParty`: a subset of the
camp's bandits that walks to the target, executes the mission on
arrival, and walks back.

**One party per camp at a time.** The camp's combat strength
temporarily drops by the party's share while it's away (per
mission: ~half for a raid, ~25% for a fence escort, ~20% for a
recruit or bribe trip, the entire roster for a one-way `migrate`).

**Mission resolution on arrival:**

| Mission            | At target                                                                                                                           | Return cargo |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `raid_settlement`  | Combat + loot drain (same maths as before)                                                                                          | Loot, coin   |
| `raid_caravan`     | Ambush at the target hex if any caravan there                                                                                       | Cargo, coin  |
| `fence_loot`       | Hand camp's loot to a friendly settlement actor for coin                                                                            | Coin         |
| `recruit_drive`    | Camp's `recruit_drive` pressure-multiplier already engaged at dispatch — the party is the physical marker of the recruitment effort | —            |
| `bribe_settlement` | Hand pre-loaded coin to a city_corp / governor; apply reputation deltas                                                             | —            |
| `migrate`          | Found a new camp at this hex; old camp deleted                                                                                      | —            |

**Round-trip target ~1 week**, so most missions fire against
targets ≤3-4 hexes from the home camp.

**If the home camp is destroyed while the party is away**, the
returning party founds a new camp at its arrival hex. This is the
only way a wiped camp's faction survives.

**Patrol intercepts** (planned per `docs/15` §C32 follow-up tasks):
patrols within 2 hexes detect the party, deviate from their cyclic
route to pursue, fight on hex-overlap. The party flees when the
patrol's expected combat advantage is positive. No bribery —
every engagement is fought.

## Bandit emergence in the tick loop (locked)

Bandits aren't just an ambient hazard — they're a **social
phenomenon emerging from the population's pressure points**, and
they have real political character. Each camp has a leader, a
reputation, and friends in low places.

### Per-day mechanics

1. **Recruitment from pressure points**: for each settlement, count
   the recruitment pool ≈ adults × pressure-fraction. Default
   pressure-fraction = 0.03 (3% of adults are "idle-ish"); 0.15 for
   settlements with a current food shortfall.
   A baseline fraction (default ~0.0005/day, i.e. `BASE_RECRUIT_FRAC_PER_DAY`)
   of that pool defects to wilderness banditry. **Successful nearby
   bands recruit faster** — if a camp within ~30 hexes has a
   successful raid in the past 30 days, that camp's recruitment
   fraction triples (word gets out: "Caelius is rich now"). **Poor
   villages contribute disproportionately**: a settlement with
   subsistence shortfall recruits at 3× rate relative to a
   prosperous one (`POOR_VILLAGE_RECRUIT_BOOST = 3`).

   These are deliberately low baseline rates. A prosperous 200-adult
   village contributes far less than one bandit per year on average;
   a famine-stricken village can contribute a visible trickle over a
   season. The goal is endemic danger, not a deterministic province-
   wide insurgency from normal peacetime.

2. **Joining vs. founding**: defectors walk to the nearest existing
   camp within ~50 hexes if it has space; otherwise a new camp is
   founded in a wilderness forest/hills hex within 5–15 hexes of
   the settlement.
   Ordinary recruitment stops at a soft cap of ~120 fighters per camp:
   beyond that, logistics, conspicuousness, and internal disputes make
   further peacetime growth unlikely. Camps above that size require
   future special causes such as war, demobilization, or sustained
   famine.
3. **Camp population dynamics**: each camp consumes daily rations
   from its loot stockpile (~0.4 kg grain-equivalent per bandit per
   day). When loot food runs out, the camp must raid or starve.
   Starving bandits desert (~5%/day at zero food); a camp with
   <3 bandits left dissolves and any remaining members rejoin
   nearby plebeians.
4. **Camp decisions**: for each camp, call `decideCampAction(camp,
inputs)` (T16). Translate the action:
   - `raid_caravan(targetHex)` → emit pendingBattle; resolve via
     T45 ambush at the caravan's hex. Caravan ambushes are
     probabilistic, not automatic: camp size, target value, guard
     pressure, and nearby patrol pressure set the chance. After a
     successful ambush, the camp has a short lay-low/fence-loot
     cooldown before it attacks again; otherwise a single camp becomes
     an unrealistic daily caravan-kill zone instead of a punctuated
     road hazard.
   - `raid_settlement(targetSettlement)` → emit pendingBattle;
     resolve via T38 raid. **Camp-size-scaled probability**:
     insurgency-scale (500+) raids at 40% chance per check, large
     (100-499) at 22%, medium (20-99) at 10%. Small (<20) camps
     don't raid settlements — they need to grow first. All require
     `pressure < 1.5`. This scaling means a med-sized camp will
     actively raid the hamlets/villages within its 30-hex horizon
     instead of waiting forever to reach insurgency — the early
     bandit phase is no longer "dormant camp sits doing nothing"
     until it hits 500 bandits.
   - `recruit_drive` → next-week recruit rate from nearby
     settlements doubles
   - `move_camp(toHex)` → walk one hex/day toward toHex
   - `lay_low` → no-op (used when patrols active nearby)
   - `bribe_settlement(s, amount)` → coin from camp to settlement's
     city_corp/headman; reputation Camp→Settlement +0.1, the
     settlement now actively misinforms patrols looking for the
     camp
   - `fence_loot(through)` → camp-to-settlement loot transfer at
     60% local clearing price; settlement's actor pays coin, gets
     stolen goods. Bandit-aligned cities retain the goods quietly;
     others may actually be undercover patrol fronts.
5. **Initial seeding**: procgen places 1 small bandit camp per
   settled cluster in a forest/hills hex within 6–12 hexes of a
   city. They're already there at day 0; the world doesn't have to
   wait years for the first camp to bootstrap.

### Battles aren't total annihilation

Per docs/13 §"Battle survivor system": every combat resolution
emits structured survivor records. `fled_escaped` survivors become
real news carriers walking to their nearest friendly settlement at
~20 hexes/day, carrying first-hand knowledge of the engagement.
**Killing every witness is hard.** Even an "attacker_won" outcome
typically leaves 1-3 fled_escaped survivors who reach a settlement
4-10 days later and update reputations.

This means:

- A successful raid on a Vibian caravan with 3 escapees is known
  to Family Vibian by day +5, Family Vibian's allies by day +12,
  the governor by day +20 (depending on geography).
- A patrol that wins a skirmish but lets some bandits escape gives
  the surviving bandits intel on patrol strength + tactics.
- A massacre with NO survivors still generates **indirect rumor**
  (a missing caravan eventually triggers an investigation), just
  slower and less specific.

### Bandit-aligned sub-factions in cities

Bandits aren't isolated wilderness folk — they have FRIENDS in
the cities. Specifically:

- **Fences**: in every city of size ≥small, there's a small
  bandit-aligned faction (a "merchant" who buys stolen goods at
  60% price, no questions). Faction is procgen-named (often
  associated with the docks or a specific minor patrician
  family). Fences pay in coin from their own treasury; coin is
  laundered back into the legitimate market.
- **Patron of bandits**: occasionally a real patrician family
  has a covert relationship with a bandit camp — paying for
  raids on their rivals, or buying back their own goods at a
  discount when raided "by mistake". This creates rivalries
  visible in the family-vs-family reputation table.
- **Bribed officials**: governor / city watch officers can have
  high reputation with specific camps (per the bribery action
  above) — when they hear about that camp's raid, they "see
  nothing" and don't dispatch patrols. The cost is reputation
  damage to themselves with the victims.

### Successful bandit careers (flavor + emergent)

Specific bandits become characters with histories:

- A camp leader who has 5+ successful raids and >100 bandits
  becomes a **regional warlord**. Patrician families may
  negotiate with them; the governor may treat them as a
  rebellion.
- A long-running camp (>2 years) that's been raided by the
  governor and reformed gets a `notable_bandit` tag — they're
  famous, news of them spreads further, recruits from further
  away, but also makes them a higher-priority patrol target.
- A camp leader killed in battle is replaced by their lieutenant
  (per docs/11 character succession); the new leader inherits
  reduced reputation (the heir didn't personally make the
  reputation), so the camp may temporarily go quiet.

These are emergent properties: the named-character + reputation
machinery already supports them; the politics phase just needs to
emit the right events and check the thresholds.

## Patrol dispatch in the tick loop (locked)

Per-day, in the politics phase after the movement, trade, and
demographics phases (per [01 — Simulation Frame](01-simulation-frame.md)):

1. **Garrison patrols**: governor's office maintains 1 patrol unit
   per ~3 cities, walking arterial roads. Patrols spawn from the
   governor's coin treasury (each unit costs ~10 coin/day in pay +
   rations).
2. **City watch**: each city + town spawns its own small patrol from
   city budget, walking the urban perimeter + nearby roads.
3. **Family guards**: each patrician family with a recent banditry
   loss spawns a private patrol around their estates.
4. **Engagement**: when a patrol's `tickPatrol` (T31) emits a
   pendingBattle, resolve via `resolveBattle` (battle system). On
   patrol victory, camp count drops; on bandit victory, patrol
   disbanded.

**Funding feedback**: tax shipments (T39) replenish the governor's
treasury → more patrols → fewer raids → more tax shipments. Cut the
shipments and patrols dwindle within months.

## Battle system (locked, simple, probabilistic)

Combat — caravan vs. bandits, patrol vs. camp, two caravans,
settlement defense, or any other engagement — uses one shared
mechanic.

### Unit stats

A combat unit is a group of people characterized by:

- `count`: number of effective combatants.
- `training`: 0–1 scalar derived from class/role:
  - soldier ~0.9, caravan_guard ~0.6, bandit ~0.4,
    idle_militia ~0.2, civilian ~0.1.
- `weapons`: 0–1 from issued `goods.weapons` per combatant
  (none = 0, basic = 0.5, full kit = 1.0).
- `armor`: 0–1 from issued `goods.armor` per combatant.
- `health`: 0–1 (fatigue, disease, prior wounds reduce it).
- `posture`: `attacking` / `defending` / `fleeing`.
- `terrain_bonus`: defender bonus when in walls, on a hilltop, in
  forest cover, behind a river, etc.

### Derived chances

```
attack_chance  = training * (0.4 + 0.6 * weapons) * health
defense_chance = training * (0.3 + 0.7 * armor)   * health
                 + terrain_bonus
first_strike   = (posture == attacking) AND ambushed
                 → free initial round before the other side responds
pursuit_speed  = training * health * (1 - load_fraction)
```

(Numbers first-pass, tunable.)

### Resolution loop

A "round" is a unit of combat time — minutes for skirmishes, days
for sieges:

1. Determine engagement type: ambush, skirmish, set-piece, siege.
2. If ambush: the surprising side gets a free first round.
3. Each side rolls damage:
   ```
   damage_dealt(side) = count * attack_chance * RNG_factor
   casualties(opp)    = damage_dealt(side) * (1 - opp.defense_chance)
   ```
4. Apply casualties: split between deaths and wounded based on
   armor (more armor → more wounds, fewer deaths).
5. Reduce `count`; reduce average `health` for the survivors.
6. Morale check: a side that takes > X% casualties in one round
   may rout (posture → `fleeing`).
7. If one side flees, the other may pursue. Pursuit at higher
   `pursuit_speed` catches more fleeers and inflicts further
   casualties.

Output: winner, casualties on both sides, captured cargo /
prisoners, fled survivors. The full record is kept for diagnostics
so the player (or any reader) can reconstruct what happened.

### Witness propagation (locked)

Surviving witnesses — escaped flee-ers, released captives,
settlement defenders if the defenders won — become **news
carriers**. See [13 — Reputation & Relationships](13-reputation-and-relationships.md)
for the full mechanic. They walk to the nearest friendly
settlement, taking real days, and report what happened. Each
arrival updates the reputation slates of the perpetrator at every
named character in the settlement who hears.

The "leave no witnesses" path is real but **hard**:

- Some flee-ers escape pursuit (high training, bad pursuit
  terrain, night, exhausted pursuers).
- Captives held for ransom or sold into slavery may eventually
  escape and talk.
- Even with all direct witnesses dead, a missing caravan
  eventually generates **indirect rumor** ("Caravan X
  disappeared on the road between Y and Z") that drives general
  banditry concern in the region.

Pure stealth slows reputation propagation but doesn't eliminate
it. The world doesn't forget that caravans are disappearing.

### Examples

- **Ambush**: a band of 30 bandits surprises a caravan of 4
  drovers + 2 guards. Bandits get a free first strike, kill or
  scatter the guards; drovers flee. Bandits take cargo.
- **Patrol vs. camp**: 80-strong cavalry detachment attacks a
  60-strong bandit camp in wooded hills. Bandits have terrain
  bonus; cavalry has training and weapons. Likely a hard fight —
  outcome depends on rolls and morale.
- **Siege**: large bandit insurgency vs. a town. Daily rounds.
  Town walls give big terrain bonus; defender militia is poorly
  trained. Eventual outcome depends on supplies (food stockpile
  vs. besieger food supply) — the besieger usually starves first
  unless they can keep their supply lines open.

## Player as bandit (locked option)

The player is one caravan operator among many — and one of the
choices available is to operate **as a bandit** instead of (or in
addition to) trading honestly.

Mechanically:

- The player can attack other caravans (NPC traders, tax-shipment
  carts, edge-hub long-haul caravans, even patrols).
- Successful attacks transfer cargo and may yield prisoners (who
  become slaves, ransom-bait, or recruits).
- The player picks up a **bandit reputation**, which:
  - Closes honest cities (gates shut, watch alerted on entry).
  - Makes them a target for patrols.
  - Opens corrupt fences and tolerant settlements where stolen
    goods can be moved.
- The player can establish or join a bandit camp in the wilderness
  as a base of operations.
- Reputation is recoverable but slow — bribing officials, hiding
  for a long time, moving to a different cluster, changing
  identity (an alias mechanic).

This is **not** a separate game mode. It is a path through the same
economy, taken by the player like any NPC actor. A particularly
successful bandit player may grow into a regional warlord — at
which point the governor will treat them as proto-rebellion, not a
nuisance.

## Diagnostics

The player should be able to ask (and pay informants for the
answer):

- How big is each known bandit camp? Who leads it? Who do they
  prey on?
- What are the patrol patterns in this region? When did a patrol
  last pass this road segment?
- Which settlements are friendly to bandits / fence stolen goods?
- What's the recent banditry rate on this route — how many
  caravans were lost in the last 30 days?

Information is discoverable (rumor, paid informants, observation
during travel) — not free, but obtainable.
