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

| Size | Capability |
|---|---|
| Small (<20) | Opportunistic ambushes on lone caravans. |
| Medium (20–100) | Coordinated road attacks; small village raids. |
| Large (100–500) | Regional menace; town raids; can shadow-rule a wilderness area. |
| Insurgency (500+) | Effectively a rival polity. The governor must respond with serious force or lose the province. |

A camp may grow until a patrol breaks it, internal disputes
fragment it, or a particularly rich score lets the leaders retire
into respectability (laundering coin into land — historically
real).

## Patrols (Roman-era)

Authorities push back. Roman-era options, all modeled in v1:

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

## Bandit emergence in the tick loop (locked)

Per-day, in the politics phase, after consumption:

1. **Recruitment from idle**: for each settlement, count adults with
   `idle` job role + adults whose subsistence is unmet for 14+
   consecutive days (prospective recruits — rural poor, jobless urban
   plebs). A small fraction (default ~0.0005/day = ~18%/year) of this
   pool defects to wilderness banditry. They are removed from the
   settlement's pool and added to the nearest existing bandit camp
   within ~50 hexes, OR a new camp is founded in a nearby wilderness
   forest/hills hex if no camp is nearby.
2. **Camp population dynamics**: each camp ages, has its own
   subsistence consumption (rations from loot or raiding), and may
   die out from starvation if it can't raid successfully.
3. **Camp decisions**: for each camp, call `decideCampAction(camp,
   inputs)` (T16). Translate decision:
   - `raid_caravan` → emit pendingBattle; resolve via T45 ambush
   - `raid_settlement` → emit pendingBattle; resolve via T38 raid
   - `recruit_drive` → next-day recruit rate doubles
   - `move_camp` → update camp.hex
   - `lay_low` → no-op
   - `bribe_settlement` → coin transfer + reputation +0.1
   - `fence_loot` → liquidate loot at corrupt settlement at 60% price
4. **Initial seeding**: procgen places 1 small bandit camp per cluster
   in wilderness near a road chokepoint. They're already there at
   day 0; not a cold-start problem.

## Patrol dispatch in the tick loop (locked)

Per-day, in the politics phase, after consumption:

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
