# 13 — Reputation & Relationships

The world is full of **named** actors who remember what you did.
Reputation is per-actor, persistent, severe, and travels at the
speed of news — which means at the speed of caravans and refugees,
not instantly.

This is a load-bearing system: it's how the game enforces
consequences without breaking pillar 1 ("no hidden hands"). An
action you take is witnessed by specific people; those specific
people carry the news; news arrives at specific places at specific
times; reputation updates follow.

## Factions and named characters (locked)

The world is organized into factions. Each faction has named
characters who actually act, decide, and remember.

### What's a faction

| Faction type | Examples | Has named characters |
|---|---|---|
| Patrician family | Family Vibian in City X | Patriarch + adult members |
| Free village council | Elder council of Village Y | Elders by name |
| Hamlet household | Headman family of Hamlet Z | Headman by name |
| Bandit camp | The Caelian Band | Leader + lieutenants |
| Patrol detachment | III Cohort at Mile-X | Commanding officer |
| City watch | Watch of City X | Watch captain |
| Caravan | Vibian grain shipment of Quintilis | Merchant in charge |
| Player caravan | Player's caravan | The player (and their alias if any) |
| Governor's office | Provincial governor | Governor + senior officials |
| Temple | Temple of Mars in City X | High priest |

Settlements have **1 or more factions**:

- A hamlet has 1 faction (the headman household).
- A village has 1 faction (council or patron-appointed headman).
- A town has 1–3 factions (a few notable households + the town council).
- A city has 3–7 patrician families + the city watch + the temple +
  the magistrates → effectively 5–10 factions, sometimes in active
  conflict.

### Why named characters matter

Without named characters, "the city" or "the family" is an
abstraction that can't form opinions about specific things. With
them:

- The patriarch of Family Vibian can have a personal grudge
  against the player.
- Caravan merchant Lucius can survive an ambush, walk to the next
  city, and tell everyone who's listening that it was the player.
- Bandit captain Caelius can have a personal vendetta against a
  specific patrol officer.
- The governor can be friends with one family and at odds with
  another.

Named characters age, die, and are replaced (heirs, elections,
appointments). Their reputations are partially inherited by their
successors — diluted, since the heir didn't personally experience
the wrong.

### Modeling cost

For ~3,000–8,000 settlements × ~2 factions average × ~2 named
characters per faction = roughly ~12k–32k named individuals total.
Still tractable with sparse reputation storage. Each has: name, age,
sex, role, faction, current location, status
(alive/dead/captured/missing), reputation slate, traits.

## What reputation is

For each pair of named actors that can deal with each other:

```
reputation[holder][subject] ∈ [-1, +1]
```

- `+1` = trusted ally; `-1` = mortal enemy; `0` = neutral / unknown.
- Initial values from procgen (some pre-existing relationships:
  family rivalries, established trade partnerships, longstanding
  grudges); the player starts at 0 with everyone.
- Sparse storage — most pairs are 0 (no relationship yet).

## How reputation gets updated — the news-carrier model (locked)

Reputation does NOT update instantly across the world. It updates
only when **specific people carry specific news to specific
places**. This is the load-bearing rule — without it, "no hidden
hands" doesn't survive contact with reputation.

### Lifecycle of a reputation event

1. **Action**: Player (or any actor) does something — robs a
   caravan, donates to a temple, defends an ambushed merchant,
   kills a tax collector.

2. **Direct witnesses**: Identify everyone who saw or experienced
   it firsthand. These are the seeds of news.

3. **Witness fate** — for each witness, determined by what
   happened during/after the action:
   - **Killed during the action** → no propagation (silent).
   - **Captured by perpetrator** → held; future fate determines
     propagation (ransom = slow propagation; sold into slavery
     = silent unless they later escape; killed later = silent).
   - **Survived but stayed put** (the action was at their home) →
     immediate update of that settlement's reputation slates;
     news begins to spread from this settlement outward via
     departing caravans.
   - **Survived and fled** → become **news carriers** walking to
     the nearest friendly settlement.

4. **News carriers in transit**: Each carrier is a real entity
   with a position on the map. They walk (~20 km/day) toward
   their destination, eating rations. They can be intercepted
   (and silenced — but see below). They may meet other caravans
   and share what they know.

5. **Arrival at settlement**: The carrier reports to authorities
   and to friends/family. Each named faction in the settlement
   updates its reputation slate for the perpetrator. The action
   becomes part of the settlement's local "event log."

6. **Secondary spread**: Caravans leaving the settlement carry
   the news further. Repeat (3)–(5) with diluted detail
   (testimony becomes hearsay) and slower spread.

### Severity of the reputation hit

Reputation hits can be **very severe** (the user emphasised this
explicitly). The hit a hearer takes depends on:

- **Magnitude of the action**: Stealing 1 sack of grain ≠ killing
  30 people.
- **Hearer's alignment**: A bandit-aligned settlement isn't
  shocked by banditry; an honest one is.
- **Hearer's relationship to the victim**: The victim's family
  takes a HUGE hit; the victim's rivals take a small hit (or
  even mild positive — they're glad their rival lost money).
- **Hearer's prior reputation of perpetrator**: A good prior
  softens the blow; a bad prior amplifies it.

**Worked example.** Player robs Family Vibian's grain caravan,
leaving 3 survivors who flee. After news propagates:

| Hearer | Δ reputation | Reasoning |
|---|---|---|
| Family Vibian patriarch | -0.5 | Their caravan, their loss |
| Vibian-allied families in same city | -0.3 | Hurt their ally |
| Vibian-rival families in same city | -0.1 | Mild displeasure (don't like robbery in general) but quiet schadenfreude |
| Governor | -0.2 to -0.4 | Upholding law is part of the role; magnitude depends on disposition |
| Other honest merchants who hear | -0.15 | "This could happen to me" |
| Bandit camps that hear | +0.2 | "A fellow operator!" |
| Bandit-friendly settlements | +0.05 | A potential new fence client |

The honest world's response is collective and severe; the bandit
world's response is friendly. The player's action ripples
asymmetrically based on who's listening.

### Public vs. private spread

- **Public actions** (visible to many witnesses, in busy places)
  spread broadly and fast.
- **Private actions** (kept secret by a few) spread narrowly and
  slowly — sometimes never beyond the original counter-party.
- The player can choose to operate publicly (faster gains, faster
  reputation) or privately (slower but stealthier). Private
  doesn't mean cheap — keeping it private may require silencing
  witnesses, which is its own action.

## Battle survivor system (locked)

After every combat resolution (see
[12 — Bandits & Conflict](12-bandits-and-conflict.md)),
survivors are categorized:

- **Killed in action** → no propagation.
- **Captured by victor** → held; future fate determines
  propagation.
- **Fled and pursued — caught and killed** → no propagation.
- **Fled and pursued — captured** → held.
- **Fled successfully — escaped** → become **news carriers**.

Even in a "kill everyone" attack, some survivors may slip away
if pursuit conditions are bad (terrain, weather, night), their
training is high, or their numbers exceed pursuer count. **Leaving
no witnesses is hard.** Cold-blooded calculation requires
intentional thoroughness, and even then, a non-zero chance of
missing one.

A successfully escaped survivor walks (slowly, hungry, often
wounded) to the nearest friendly settlement. They take real time
to arrive — 10–20 days for a long flight. On the way they may
meet other caravans, sharing the story and amplifying spread.

The player can attempt to **chase down survivors** to silence
them — but pursuit creates additional risks (further survivors
of THAT pursuit). A truly clean kill leaves no survivors to
track, which is rare.

### News carrier demographics

Per the pillar-1 rule "everyone in all units has gender and age",
each `NewsCarrier` carries an optional `demographics` map keyed by
`${sex}|${ageBand}` with the same shape as `CrewMember.demographics`
(docs/06) and `BanditCamp.banditDemographics` (docs/12). A carrier
is logically one person — but the field is a map so a future change
can model "a refugee family" or "a rescued caravan crew traveling
together" without a breaking type change.

When a battle produces escaped survivors and one is promoted to a
news carrier, the carrier's demographics should be sliced from the
losing unit's demographics (e.g., a single male drover, age 25-29).
The drain helper for that lives in
`src/sim/population/demographics.ts` (`drainDemographics`); the
specific battle-survivor → carrier wiring is staged for a follow-up.

### Indirect propagation: missing caravans

Even with no direct witnesses, the world notices when:

- A regular caravan doesn't arrive on schedule.
- A scheduled tax shipment doesn't reach the capital.
- A regular trader stops appearing in markets.

These trigger investigations — slow, less specific:
"Caravan X disappeared somewhere on the road between Y and Z;
possibly bandits." This raises general "banditry concern" in the
affected region without naming a specific perpetrator. Repeated
unexplained disappearances eventually trigger patrol responses,
governor edicts, or family-funded private vendetta hunts.

So **pure stealth slows reputation propagation but doesn't
eliminate it**. The world doesn't forget that caravans are
disappearing.

## News-carrier price piggyback (locked, v1.6)

The same news-carrier channel that propagates reputation events
**also propagates market prices**. Per docs/06 §"Caravan
information model", every actor carries a `knownPrices` map
keyed by settlement, holding one `MarketObservation` per
settlement. Per-settlement, the merge rule is **newer
observedDay wins, whole snapshot replaces** — there is no
per-resource merge.

Update channels are physical-sync events:

1. **Meeting sync between two moving units (any pair, friendly
   or neutral):** when two caravans / news-carriers / patrols
   share a hex on a tick, each owner's `knownPrices` is merged
   with the other owner's, per-settlement newer wins. Hostile
   pairs refuse to share. The reputation/relationship layer
   decides; the sync layer just executes.
2. **Co-presence at a settlement:** two units at the same
   settlement on the same day merge their owners' maps the same
   way. This is the channel that gets most prices around —
   caravans stay in cities for a day or two to trade, and during
   that day every visiting party's map syncs against every other.
3. **Guild ledger:** guilds are themselves resident actors with
   their own `knownPrices`. A member visiting the guild merges
   against the guild's map; the guild's resident-presence sync
   keeps its map fresh as long as any member is on-site. See
   docs/08 §"Communicated price discovery via guilds".
4. **City crier:** each city can maintain one patrician-funded
   crier whose job is price news rather than reputation testimony.
   He walks a deterministic greedy route from the city through tied
   villages and hamlets, records the market at each stop, mutually
   merges his own `knownPrices` with actors present there, and
   returns to the city to restock. Client villages tie to their
   patron's city; other rural stops use nearest-city fallback. If he
   fails to check back into the city for over 30 days, the city funds
   a replacement.

All shared observations are **authoritative** — there is no
"hostile actors deliberately misinform" path. Hostile actors
withhold; they don't lie. Real Roman merchants who got caught
lying about prices lost their trade network, so the model treats
withholding as the only available defection.

The same locality rule that makes reputation slow also makes
price propagation slow. A patrician dispatcher in City A learns
the grain price in City Q only when a real chain of units has
walked the news there. This binds the "no hidden hands" pillar
(docs/00 Pillar 1) on prices, not just on actions.

A `MarketObservation` older than 180 days is dropped on read; see
docs/06 §"Information decay".

## Decay and aging

- All reputation decays toward 0 slowly. Half-life: ~1 in-game
  year for an isolated incident.
- A pattern of repeated behavior keeps the reputation alive
  (refreshes the memory).
- Major incidents (massacres, dynastic murders) decay much slower
  or not at all in the affected actor's slate.
- When a named character dies, their reputation slate is
  partially inherited by their successor — typically diluted
  (the heir didn't personally suffer the wrong).

## What reputation affects

### Trade

- **Friendly (>0.3)**: small price discount buying / premium
  accepted selling; counter-party may extend credit.
- **Neutral**: market prices.
- **Hostile (<-0.3)**: refusal to deal, or aggressive markup.
  May report you to authorities, refuse access entirely.

### Access

- **Friendly settlement / faction**: gates open, watch ignores
  you, possibly a free billet, contract priority.
- **Neutral**: standard fees, standard search.
- **Hostile / outlaw**: gates closed, watch alerted on entry,
  warrant possible.

### Information

- **Friendly**: shares everything — sync runs fully, including
  bandit-density observations, route hints, and `knownPrices`.
- **Neutral**: standard merchant courtesy — sync runs by default.
- **Hostile**: **refuses to share** (no piggyback exchange, no
  guild-ledger access). Hostile actors never feed false data —
  per v1.6 there is no deceptive-information channel — they
  simply withhold. The model relies on real merchants having
  burned anyone who got caught lying.

### Help in extremis

- **Friendly**: posts bail, sends rescue, hides from patrols,
  feeds in famine, lends crew.
- **Neutral**: nothing.
- **Hostile**: actively betrays.

## Player reputation specifics

- Tracked just like any other actor's, per-faction and
  per-named-character.
- The UI shows the slate explicitly with attribution: "Family
  Vibian patriarch: -0.5 (your robbery of their grain caravan,
  news arrived 23 days ago); decaying slowly."
- **Aliases work, partially.** A player wanted in one cluster
  can travel to another and use a different name; their
  reputation doesn't follow until news catches up. Aliases blow
  when:
  - A merchant who's met you recognizes your face.
  - A former crew member talks.
  - A distinctive public action gives the alias away.
- **Reputation recovery is slow but possible**: bribes, public
  good works, time, fleeing the region, swearing oaths, marriage
  (future scope).

## NPC actor reputation (same machine)

Reputation is symmetric: NPC actors hold it of each other and
act on it. Family rivalries, governor-merchant disputes,
headman-bandit collusion all run on the same reputation slate
updated by the same news-carrier propagation.

This means the political layer is **alive during burn-in**.
Procgen sets up some initial relationships; burn-in lets them
play out for years; the player walks into a province with rich
ongoing politics and pre-existing reputations they can map and
exploit.

## Diagnostics

The player should be able to ask (and pay informants for
the answer):

- What is my reputation with each named character, and why?
  Latest action that moved it? Who carried the news?
- Which named characters have heard about which of my actions?
- Where are the news carriers currently in transit who carry
  information about my recent actions? (This is critical
  intel — the player can decide whether to intercept them.)
- What is each actor's reputation with each *other* actor
  (where I have informants)?

The last item matters: the political map (who likes whom) is
itself information the player can buy. A merchant who knows the
patron-rival map of a city can play factions against each other
— a real Roman art.

## Implementation hints

- Sparse reputation tables — most actor pairs are 0; don't
  allocate.
- News-carrier entities are first-class — a kind of caravan
  with cargo type "news" instead of goods.
- "Witness fate" is computed at battle resolution time and emits
  one or more news-carrier entities into the world.
- Settlement entry triggers reputation updates from any news
  carriers arriving with the visitor.
- Reputation updates are event-driven, not per-tick scans.
