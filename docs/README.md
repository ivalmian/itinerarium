# Ecogame Design Docs

A Roman-era trading & caravan game with a fully simulated economy.
No hidden hands: every loaf of bread was baked by someone, from
flour milled by someone else, from grain grown on a specific hex.
The player is one trader (or one outlaw) inside this world, not a
god looking down on it.

These docs are the working design plan. They are opinionated, with
explicit decisions called out. Open questions have been resolved
in conversation; see [10 — Scope & Decisions](10-scope-and-questions.md)
for the full locked list.

## Read order

1. [00 — Design pillars](00-pillars.md) — the things that must
   stay true.
2. [01 — Simulation frame](01-simulation-frame.md) — time, space,
   scale, hex size, "no hidden hands" operationalized.
3. [02 — Resources](02-resources.md) — the full enumerated set
   (Tier 0 raw, Tier 1 refined, Tier 2 manufactured, Tier 2b
   exotic imports, Tier 2c people-as-cargo, Tier 3 institutional).
4. [03 — Production recipes](03-production.md) — what turns into
   what, what labor it takes, building + specialist requirements.
5. [04 — Population & labor](04-population.md) — full demographic
   pyramid, classes, jobs, consumption, mortality, disease,
   pathways into banditry.
6. [05 — Settlements](05-settlements.md) — multi-hex extent,
   catchments, hex-level ownership, market state, settlement
   entry UX.
7. [06 — Caravans](06-caravans.md) — composition, real movement
   numbers, risk, edge-hub imports/exports.
8. [07 — Geography & climate](07-geography.md) — natural feature
   extents, climate bands, seasons, settled clusters vs.
   wilderness, hidden features for exploration, procgen +
   stabilization.
9. [08 — Money & trade](08-money-and-trade.md) — coin, the
   continuous-double-auction market clearing model (subsistence
   inelastic + comfort elastic + status inelastic-rich +
   producer derived input demand), off-map global market.
10. [11 — Politics & ownership](11-politics-and-ownership.md) —
    governor, patrician families, village patrons / elders, slave
    ownership, hex-level ownership, named characters per faction.
11. [12 — Bandits & conflict](12-bandits-and-conflict.md) —
    bandit emergence from population, camps, patrols, friendly
    fences, the simple battle system, player-as-bandit option,
    witness propagation.
12. [13 — Reputation & relationships](13-reputation-and-relationships.md)
    — per-named-character reputation, severe magnitudes,
    news-carrier propagation (never instant), battle survivor
    witness mechanic, aliases, public vs. private actions.
13. [09 — Player role](09-player.md) — what the player actually
    does, Vagrus-style daily MP / camp-to-end-turn UX, honest and
    bandit growth paths, fast-forward auto-pause events.
14. [10 — V1 scope, decisions, risks, next steps](10-scope-and-questions.md)
    — the locked v1 cut + the full table of design decisions +
    risks + ordered build plan.

## Tech stack assumptions

- TypeScript, browser-first (Vite or similar), Electron later.
- Hexagonal grid (1 km hexes, pointy-top, axial coordinates),
  turn-based with daily ticks and Vagrus-style player turns.
- SVG placeholder rendering, viewport-culled.
- Deterministic sim with seeded RNG.
- Data-oriented (Structure-of-Arrays) layout — we want to scale
  to ~250k hexes and ~1,500 settlement entities + ~6k named
  characters.
- Sim loop separable from rendering so it can move to a Web
  Worker.
- Headless "run N years, dump state" mode is required for
  tuning, not optional. Doubles as the burn-in harness for
  stabilization.

## A note on the doc set

These docs grew organically through iteration. They cover a lot
of system surface (~13 docs) for a game that hasn't started
implementation. That's intentional: the design has many
interlocking parts (economy, demographics, politics, reputation,
combat) that have to be coherent before any code is written.
Each doc is a thematic slice; cross-references link them.

When in doubt, [00 — Pillars](00-pillars.md) is the tiebreaker.
