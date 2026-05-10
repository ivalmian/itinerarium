# 09 — The Player

The player is one trader (or one outlaw) among many inside the
simulation.

In v1, the player operates **caravans only** — they cannot direct
labor inside any settlement. This keeps them as one actor in the
world, not its hidden hand (pillar 1).

## Starting state

- A small pack train (a few mules, a couple of crew).
- A small purse of coin.
- Some starting knowledge of nearby town prices.
- An origin town they call home.
- A reputation slate (initially neutral) with each notable named
  character — patrician family heads, the governor, a few
  village headmen, and any merchants they've already met. See
  [13 — Reputation & Relationships](13-reputation-and-relationships.md).

## What the player does, mechanically

Identical to NPC caravan operators (and NPC bandits): travel,
buy, sell, hire crew, upgrade equipment, fight, flee. The only
difference is the player makes decisions manually instead of via
heuristic AI.

This is important: we cannot give the player powers that NPCs
don't have (like seeing global prices), without breaking pillar 1.

## Turn structure — Vagrus-style camp/rest (locked)

Each in-game day is **one player turn**. The player wakes with a
pool of **movement points (MP)** — equal to how far their caravan
can travel in one day given their crew, animals, road grade,
weather, and load (typical: ~25 MP for a laden mule caravan on
Roman road; see [06 — Caravans](06-caravans.md) for the full
table).

During the turn, the player spends MP on actions:

| Action | MP cost |
|---|---|
| Move to an adjacent hex on Roman road | 1 MP (modified by terrain/weather/load) |
| Move to an adjacent hex on dirt road | ~1.25 MP |
| Move to an adjacent hex off-road (rough) | ~2.5 MP |
| Enter a market and post trade intents | small fixed MP |
| Engage in combat | variable; may consume the rest of the day |
| Investigate a hidden feature | variable per feature |
| Talk with NPC, browse settlement panel | free |

The player ends the turn by **camping** (or by sheltering in a
friendly settlement). Camping:

- Advances the world to the next day.
- Consumes overnight rations from cargo.
- May trigger an encounter — bandit attack on the camp, a
  merchant arriving on the same hex, weather event, disease
  exposure.
- Restores MP for the next day.

While the player's turn is in progress, the rest of the world is
conceptually "in motion" — NPC caravans moving on their planned
routes, recipes running, populations eating, markets clearing.
When the player camps, all of these resolve for the day, and any
consequences (caravan arrivals, news, price changes, reputation
updates from arriving news carriers) update the world the player
wakes into.

This style (modeled on Vagrus) lets the player feel each day's
rhythm of choices without forcing them through a single
"decision moment." It also lets time-skip work cleanly: a
fast-forwarded day is just an auto-camp at the end.

### Fast-forward mode

For long travel or idle periods, the player can fast-forward:
auto-camp each day, traveling along a preset route at full speed.
The system **auto-pauses on configurable events**:

- Caravan arrival at a settlement.
- Market price change > X%.
- Contract expiration.
- News of war / plague / banditry surge.
- Granary or warehouse threshold crossed.
- Bandit attack on the player's caravan.
- A reputation change above threshold.
- Discovery of a hidden feature.

Without fast-forward, a 5-year campaign of ~1,800 turns is
unplayable. With it, the player only sees turns that matter.

## Honest growth paths in v1

All caravan-centric. The player can grow into:

- **A multi-caravan trading house.** Hire merchants to run
  additional caravans on routes you set up; they take a cut
  of profit.
- **An equipment specialist.** Bigger wagons, better breeding
  stock, more guards, faster mules.
- **A warehouse holder.** Rent (or eventually own) warehouses
  in cities to store goods between caravans, smoothing seasonal
  arbitrage.
- **A fixer.** Bribe officials, donate to public works, sponsor
  patrician families' festivals — earn reputation, lower
  tariffs, unlock routes.
- **A military contractor.** Run caravans of soldiers and
  equipment for hire — escort other merchants' goods, supply
  garrisons, reinforce besieged towns.
- **A founder.** Late-game: fund the establishment of a new
  settlement. The player provides capital and the migration
  caravan; the new settlement runs itself per normal rules.

## The bandit path (locked)

The player can also operate **as a bandit** — attack other
caravans, raid hamlets, fence stolen goods through corrupt
markets. See [12 — Bandits & Conflict](12-bandits-and-conflict.md)
for the mechanics, and
[13 — Reputation & Relationships](13-reputation-and-relationships.md)
for how news of your actions propagates.

This is not a separate mode; it's the same caravan, the same
combat system, the same map — just a different reputation
trajectory and a different network of friendly settlements. A
successful bandit can grow into a regional warlord. An
unsuccessful one ends in a noose.

The player can mix paths: run honest trade in one cluster while
quietly hiring out for "questionable" jobs in another. Reputation
is per-actor, so a careful player can keep separate identities
across clusters — until news catches up.

## What the player cannot do in v1

- Direct labor inside any settlement, even one they helped
  found.
- Own a workshop, farm, or estate with chosen production
  targets.
- Become a patrician family member or hold political office.
- Replace a governor or set tax rates.
- Run off-map (long-haul export/import) caravans. That's the
  business of merchant houses with the network and capital
  for multi-month round-trips. See
  [06 — Caravans](06-caravans.md).

These are intentionally out of scope; deferred to v1.5+.

## Losing

The player can lose. Bandits clean them out, plague kills their
crew, a war closes their best route, a patrol hangs them. They
restart with whatever's left — possibly just the clothes on
their back. There is no autosave-magic that prevents this.
(Manual save/load, yes; world-state-rewind, no.)

## Information UX

Because the player has the same information-channel limits as
everyone else, the UI must:

- Make it crisp what the player *knows* vs. what they're
  *guessing*.
- Show price books with confidence (date last seen, freshness).
- Surface news the player has heard (who told them, when, at
  what hex).
- Show reputations explicitly per named character with
  attribution (this family head likes me because of X, that
  governor doesn't because of Y, this region considers me an
  outlaw — see
  [13 — Reputation & Relationships](13-reputation-and-relationships.md)).
- Show news carriers in transit (whose actions they're carrying
  and where to) — the player may decide to intercept.
- Never accidentally leak global state into a tooltip or
  summary screen.

A player should be able to make a costly mistake because their
information was stale. That has to be a feature, not a bug.

## Settlement entry UX

Entering any hex of a multi-hex settlement (urban hex, or a
settlement-flagged catchment hex like a watchtower) opens the
settlement screen. The player doesn't need to find the "right"
hex — the settlement is one entity even though it occupies many
hexes. See [05 — Settlements](05-settlements.md).
