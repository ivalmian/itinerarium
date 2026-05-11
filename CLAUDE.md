# CLAUDE.md

Project: **Ecogame** — a Roman-era trading & caravan game with a
fully simulated economy. Browser-first TypeScript, hexagonal grid
(1 km hexes), turn-based with daily ticks and a Vagrus-style
player turn UX.

## Read this before starting work

**The full design plan lives in [`docs/`](docs/).** Start at
[`docs/README.md`](docs/README.md) for the index. Don't propose
architecture or features before reading the relevant doc — the
design has specific opinions that must not be silently broken.

The non-negotiable design pillars are in
[`docs/00-pillars.md`](docs/00-pillars.md). The most load-bearing
one: **no hidden hands.** Every transaction has a real
counter-party; every good was produced by named labor in a
specific place; every reputation update was carried by a specific
person walking a specific route. If you find yourself adding a
global price ticker, instant tax-revenue teleportation, an
all-knowing reputation broadcast, or a UI feature that shows the
player something no merchant in the world could know — stop,
you're breaking the design.

## Status

The repo currently contains only the design docs. **No code yet.**
All initial design questions have been resolved (see
[10 — Scope & Decisions](docs/10-scope-and-questions.md), 24
locked decisions). The plan continues to evolve in conversation —
check git log for recent design changes before assuming a doc
reflects current intent.

## Tech stack (intended)

- TypeScript, browser-first (Vite assumed unless decided
  otherwise), Electron later.
- Hexagonal grid (pointy-top, axial coordinates), **1 km hexes**.
- **~500 km × 500 km** map, ~250,000 hexes total — most of which
  is wilderness between 3–5 settled clusters.
- ~1,000–1,500 settlement entities; ~6,000 named characters;
  ~700k–1.2M modeled people in stratified pools.
- WebGL/PixiJS rendering for the burn-in viewer (see docs/16);
  the eventual player UI may revisit this. Viewport-culled.
- Deterministic sim with seeded RNG.
- Data-oriented (Structure-of-Arrays) layout.
- Sim loop separable from rendering — Web Worker candidate.
- Headless "run N years, dump state" mode is required for tuning
  (and doubles as the procgen burn-in harness for stabilization).

## Doc map (quick links)

- [Pillars](docs/00-pillars.md) — must-stay-true rules
- [Simulation frame](docs/01-simulation-frame.md) — time, space,
  scale
- [Resources](docs/02-resources.md) — enumerated set, ~50 items
- [Production](docs/03-production.md) — recipes (building +
  specialist both required)
- [Population](docs/04-population.md) — full demographic pyramid,
  classes, jobs, consumption, disease, banditry pathway
- [Settlements](docs/05-settlements.md) — multi-hex extent,
  hex-level ownership, market state
- [Caravans](docs/06-caravans.md) — real movement numbers,
  edge-hub imports / exports
- [Geography](docs/07-geography.md) — natural feature extents,
  wilderness, hidden features, procgen + stabilization
- [Money & trade](docs/08-money-and-trade.md) — continuous double
  auction; subsistence + comfort + status + derived input
  demand; off-map global market
- [Politics & ownership](docs/11-politics-and-ownership.md) —
  governor, patrician families, village patrons / elders, slaves,
  named characters per faction, hex-level ownership
- [Bandits & conflict](docs/12-bandits-and-conflict.md) — bandit
  emergence, patrols, battle system, player-as-bandit
- [Reputation & relationships](docs/13-reputation-and-relationships.md)
  — per-named-character reputation, news-carrier propagation,
  battle-survivor witnesses, aliases
- [Player](docs/09-player.md) — what the player does, Vagrus-style
  daily MP / camp-to-end-turn, honest + bandit paths
- [Scope & decisions](docs/10-scope-and-questions.md) — v1 cut
  and the locked decisions
- [Debug strategies](docs/14-debug-strategies.md) — how to triage a
  failing burn-in (instruments + failure patterns + checklist)
- [v1.5 cleanups](docs/15-v1-5-cleanups.md) — outstanding hacks +
  acceptance criteria for the v1.5 sweep
- [Burn-in viewer](docs/16-viewer.md) — browser viewer that runs
  the sim live (PixiJS, pannable hex map, time controls)

## Working norms in this repo

- **No backwards compatibility — ever.** This is a single-author,
  pre-release, design-phase project. There are no external
  consumers, no saved games to migrate, no API surface that anyone
  depends on. When you remove a feature, an enum value, or a
  function, **delete it everywhere**: no deprecated enum members,
  no inert switch arms left "for type-system exhaustiveness," no
  re-exports, no shim functions, no `// removed` or `// kept for
  compat` comments. Refactor every call site instead. The git log
  is the audit trail; the codebase is for active code only.
- **Docs-first, always.** Before implementing or modifying code,
  update the relevant design doc(s) FIRST. Code follows docs;
  docs are the source of truth. If the user makes a design call
  in conversation, the FIRST action is doc updates (then code,
  then tests). Never implement a behavior that isn't documented.
- **Docs hold all the conceptual data.** Recipe lists, resource
  enumerations, building catalogs, job role tables, vital rates,
  economic curves, combat formulas — all live in docs as the
  authoritative reference. Code implements from docs, not the
  other way around. If you need a new constant or a new
  enumeration value, document it first.
- Edit existing docs rather than create parallel ones; the doc
  map above is the source of truth.
- When the user makes a new design call in conversation, update
  the relevant doc(s) and the locked-decisions table in
  [10 — Scope](docs/10-scope-and-questions.md). Cross-reference
  related docs.
- The user wants realism by default. Where you abstract, justify
  it explicitly in the doc. Numbers should be physically
  sanity-checkable against the historical record.
- Performance matters but isn't yet load-bearing. Implement
  naively first, profile with realistic settlement / hex /
  named-character counts, optimize the hot path.
- This is still a design phase. Expect more iteration; don't
  assume a doc is locked just because it has been written —
  scan the latest git history first.
