# 16 — Burn-in viewer

A browser viewer that runs the simulation in real time and displays
the world's evolving state visually. Lets you watch caravans move,
settlements grow / shrink, banditry erupt, and reputation propagate
without reading event logs.

This is the canonical UX for current development inspection. The eventual
player UI (Vagrus-style turn UX, see docs/09) is a different surface
and not what this viewer is.

## Goals

- **Run the sim live in the browser.** Tick the world automatically
  at a chosen speed (1×, 4×, 16×, 64×, 256×). Pause / play / step.
- **Pannable + zoomable hex map.** WebGL/PixiJS for performance —
  ~250k hexes total, ~hundreds visible per viewport.
- **Settlements scale with population.** Glyph radius proportional
  to log(population). When a city grows from 5k → 50k, the player
  sees it grow visually.
- **Caravans animate.** Each caravan is a moving dot; it interpolates
  between hexes on each tick. Color by owner faction (or solid grey
  for off-map houses).
- **Bandit camps appear** as a wilderness skull/X glyph. They move
  when the camp moves; they vanish when the camp dies; new ones
  appear when emerges. Witnessing emergent banditry is half the
  point of the viewer.
- **Stats sidebar.** Global day/year, population, caravan count,
  bandit count, recent activity counts.
- **Drilldown panels.** Click a settlement → its full state
  (population by age band, stockpiles, buildings, recent prices).
  Click a caravan → cargo + route. Click a bandit camp → leader,
  banditCount, loot.
- **Resource breakdowns.** Global stockpile per resource, global
  production rate per resource (recipes/day moving avg), price
  chart. Toggleable heat-map overlay (e.g., color hexes by grain
  price).

## Tech stack

- **Vite** dev server (already in `package.json`). `npm run dev`
  serves the viewer at http://localhost:5173/.
- **PixiJS** for WebGL rendering. Initial terrain, settlement, and
  marker assets may be authored as SVGs and baked/loaded into the
  WebGL renderer. The hex map is a single
  PIXI.Container; hex tiles are batched as `PIXI.Sprite`s using a
  generated atlas of terrain colors. Settlements + caravans are
  separate Container layers.
- **TypeScript** throughout, sharing types with the sim.
- **No framework** for the panels — vanilla DOM + small helpers.
  Adding React would couple us to a heavier toolchain for what is
  fundamentally an inspection UI.
- **Same simulation.** The viewer imports `tick`, `seedWorld`, etc.
  from the existing `src/` modules. The simulation runs in the
  main thread for the current viewer; if framerate suffers, move it to a Web
  Worker (already a CLAUDE.md tech stack note).

## Layout

```
┌─────────────────────────────────────────────────────────┬──────────────────┐
│                                                         │   Day 1234 / Y4  │
│                                                         │   ───────────    │
│                                                         │   Population     │
│                                                         │     732,415      │
│                                                         │   Caravans  53   │
│              [pannable hex map area]                    │   Bandits  157   │
│                                                         │   Patrols    4   │
│              terrain colors + settlement glyphs         │   ───────────    │
│              + caravan dots                             │   Recent (year)  │
│              + bandit camp X markers                    │     robberies 318│
│                                                         │     raids       0│
│                                                         │     news      330│
│                                                         │     reputat'n  14│
│                                                         │   ───────────    │
│                                                         │   Speed: 16x     │
│                                                         │   [▶][⏸][▶▶][⏹]│
│                                                         │   ───────────    │
│                                                         │   Resources >    │
│                                                         │   ───────────    │
│                                                         │   [selected]     │
│                                                         │   Settlement X   │
│                                                         │   pop: 4,200     │
│                                                         │   stocks:        │
│                                                         │     grain  120k  │
│                                                         │     iron     43  │
│                                                         │   buildings: 8   │
│                                                         │   ───────────    │
│                                                         │   [event log]    │
│                                                         │   Y4 d12 Caravan │
│                                                         │   X robbed near  │
│                                                         │   Y                │
└─────────────────────────────────────────────────────────┴──────────────────┘
```

## Settlement glyph sizing

```
glyph_radius_px = baseR + log10(max(1, population)) * scaleR
```

- `baseR` = 4 px (so even an empty settlement is visible at zoom)
- `scaleR` = 6 px

Population of 100 → r=4+12=16; pop 1k → r=4+18=22; pop 10k → r=28;
pop 100k → r=34. The log keeps mega-cities from dominating the map.

Color by tier:

- hamlet: light brown
- village: brown
- town: dark brown
- small_city: gold
- large_city: bright gold + outline

## Unit rendering

All moving sim entities — **caravans** (merchant, villager, tax,
edge-hub), **patrols**, **news carriers**, and **bandit raid
parties** — render through a single shared layer
(`viewer/map/unitLayer.ts`). Each entity is a PIXI sprite with a
small owner-colored badge underneath and an optional white halo for
the selected unit. Per-unit-type wrappers
(`caravans.ts`, `patrols.ts`, `newsCarriers.ts`, `banditParties.ts`)
just thread a `UnitKind` glyph + a `getEntities` callback through;
the animation engine, faction colour hashing, sprite + badge + halo
drawing, and tick-scaled visual duration are all in the shared
module so every unit type moves and looks the same way.

On each sim tick the unit's `position` may change by a full day of
travel (~25 hex/day). The viewer interpolates the sprite over the
**full tick interval** (`unitVisualDurationMs(state)` in
`viewer/app.ts`), so the sprite glides continuously rather than
sliding fast then sitting still. The visual duration tracks the
tick interval directly with no floor — at 256× a tick is ~15 ms
and animations are tight; at 1× a tick is ~4 s and caravans glide
visibly.

**Sim/visual lockstep.** Speed multipliers (1×, 4×, …, 256×) are a
*cap* on tick rate, not a target. The next sim tick fires only
when (a) at least `tickIntervalMs` of wall-clock has elapsed AND
(b) every unit layer reports `isIdle()` — meaning every animated
sprite has finished interpolating to its sim hex. If animations
can't complete inside the requested cap (long routes, slow paint
budget), ticks lag: the effective tick rate drops to whatever the
visuals can sustain. The sim never races ahead of the rendered
state, and pause stops everything — no animation backlog drains
after pausing (the longest residual motion is one in-flight tick,
≤ `tickIntervalMs`).

Two animation modes (chosen by whether the caller passes
`pathPerEntity`):

- **Path-driven** (caravans): the sim emits the explicit hex path
  the unit walked during the day; the sprite follows it segment by
  segment so multi-hex moves trace the planned route.
- **Straight-line fallback** (patrols, news carriers, bandit
  parties): when no explicit path is provided, the layer
  interpolates straight from the previous display position to the
  new world position. Visually indistinguishable from path mode for
  one-hex-per-day movers; for fast movers it's a straight slide
  rather than a curved trace, which is fine since these units don't
  have planned route data.

Per-type glyphs:

| Unit                              | Glyph                                   |
| --------------------------------- | --------------------------------------- |
| Merchant / tax / edge-hub caravan | `caravan` (mules + amphora)             |
| Villager caravan                  | `villager_caravan` (peasant + handcart) |
| Patrol                            | `patrol`                                |
| News carrier                      | `news_carrier`                          |
| Bandit raid party                 | `bandit_raid`                           |

Caravans carrying bandit-stolen cargo have a red outline.

## Bandit camp rendering

A small black X glyph (5 px) on the camp's hex. Tooltip on hover:
"Caelius's band — 18 bandits, 32 loot units". Camps that have
dispatched a raid party out: the party (rendered separately as a
`bandit_raid` sprite per docs/15 §C32) walks toward the target and
back.

## Building rendering

Sub-hex building markers are small (~7 px) SVG glyphs from the
`viewer/art/buildings/` registry. A hex with several different
buildings arrays them in a deterministic ring around the centre;
multiples of the same building collapse into one icon plus a
`×N` count label. The container has `sortableChildren = true` and
each sprite picks up a stable `zIndex` from a hash of its
`buildingId` so multi-building hexes never flip front/back across
rebuilds — without this, pooled sprites would re-attach in LIFO
order and the visual stacking would shuffle every time a tick
triggers a buildings-layer rebuild.

## Time controls

- ▶ Play (current speed)
- ⏸ Pause
- ▶▶ Speed up (toggle through 1×, 4×, 16×, 64×, 256×)
- ⏹ Reset (re-seed and re-run from day 0 with same seed)

The speed multiplier is a *cap* on tick rate. The actual rate is
the slower of (cap, what the visuals can sustain). See "Sim/visual
lockstep" under Unit rendering — sim ticks are gated on animation
completion so the rendered state never trails the sim.

## Stats sidebar

Always-visible counters, updated each tick:

- Day / year
- Total population (sum across settlements)
- Caravan count
- Total bandits (sum across camps)
- Patrol count
- Last-365-day rolling counts of: caravan_robbed, settlement_raided,
  patrol_engaged, news_carrier_arrived, reputation_updated, epidemic_started

Below: Resources expandable section. Below that: Selected entity
panel (whatever the user last clicked). Below: scrolling event log
(last 50 high-magnitude events).

## Detail popup

Clicking a settlement, caravan, bandit camp, patrol, news carrier,
or bandit raid party opens a modal popup above the map with the
rich inspector view — much larger than the sidebar's compact
panel. The popup is dismissed by Escape, by
clicking the dark backdrop, or by the close button; any of those
also clears the selection so the sidebar reverts to "nothing
selected". The sidebar's compact selected-entity panel keeps
showing the same data; the popup is additive.

The popup layers on top of the faction screen ordering: clicking a
faction chip inside a settlement / caravan / camp popup opens the
faction screen on top. Closing the faction screen reverts the
selection to none (closes the popup beneath as well).

Content per kind:

- **Settlement.** Header (name, tier, anchor, factions). Population:
  class totals (patrician / plebeian / freedman / slave / foreigner)
  plus an age × sex pyramid (17 bands × 2 sexes, oldest at top).
  Treasury per owning actor. Buildings grouped by kind with hex list.
  Stockpile / market table: per-resource quantity, last clearing
  price, bid-ask spread placeholder (— until the market layer
  surfaces max-bid / min-ask), recent in/outflow units, and a
  60-day price sparkline from the per-entity history buffer. Recent
  per-entity events.
- **Caravan.** Owner actor + faction. Position / destination /
  hex-distance / estimated days (range from baseMp × loadMult).
  "Why?" line: top of the goal stack rendered as a human sentence,
  or inferred from cargo + destination when the stack is empty.
  Cargo manifest with last buy / sell prices at home / destination
  and implied margin. Crew table + animals + vehicles. P/L surrogate:
  treasury Δ over the last 60 days plus a treasury / cargo / crew /
  health sparkline trio (per-trip ledger TODO). Condensed route
  trace from the per-entity history.
- **Bandit camp.** Header. Combat profile (bandits, hangers-on,
  weapons %, armor %, health). Loot stockpile table. Bandit
  demographics pyramid (when seeded). 60-day sparkline trio
  (bandits / hangers-on / treasury / health). Recent action events.
- **Patrol.** Header (kind, base settlement, owning faction).
  Strength + kit + health, days on patrol, current pursuit target.
  Route summary with the next stop linked.
- **News carrier.** Position, speed, destination (as a settlement
  link), and the news being carried (perpetrator, victim,
  magnitude). Per docs/13 — the player can see who's about to learn
  what, and from whose mouth.
- **Bandit raid party.** Mission type (raid / fence / recruit /
  migrate / bribe), phase, current strength, days on trip, target
  (as a settlement link where applicable), home camp link, cargo
  manifest if any.

**Named-entity links throughout.** Per docs/00 pillar 1 ("no
hidden hands") the UI never displays a raw branded id. Every
reference to a settlement / caravan / bandit camp / faction is a
clickable named link that selects the underlying entity. Caravan
destinations show the destination settlement's name (or the
bandit-camp name on the target hex) rather than `(q, r)`
coordinates. The trade history / event log goes through the
shared `viewer/ui/entityLinks.ts` placeholder substitution so the
same event summary renders with links inside any popup.

The popup refreshes on every sim tick while open AND the selection
still matches — the renderer is gated so non-popup-eligible
selections (hex, faction, none) do not cost a rebuild per tick.

## Resources panel

When expanded, shows a table:

| Resource   | Global stock | Production rate (units/day, 30d avg) | Last price |
| ---------- | ------------ | ------------------------------------ | ---------- |
| food.grain | 1.2M modii   | 12,400/day                           | 1.05 coin  |
| metal.iron | 2,400 kg     | 8/day                                | 12.40 coin |
| ...        | ...          | ...                                  | ...        |

Sorted by total value (stock × price), top 20.

## Heat-map overlay

A dropdown above the map: "Color hexes by:"

- (none — terrain only)
- Population density (catchment hexes around populous settlements)
- Grain price (last clearing price)
- Bandit threat (proximity to active camps)
- Patrol coverage (proximity to patrol routes)

Implemented as a per-hex tint applied to the terrain sprite when
the overlay is active.

## Performance budget

- 80×80 grid = 6,400 hexes; viewport-culled to ~2,000 visible.
- 50–100 caravans + 2–10 bandit camps + 4–10 patrols = ~120 sprites
  in the dynamic layer.
- 100–250 settlements = 250 glyphs.
- ~3,000 PIXI display objects total = trivial for WebGL.

The bottleneck will be the simulation, not the renderer. At
64× speed, that's 64 ticks/second; current `tick()` runs in
~3 ms on a 80×80 grid → 190 ms/sec of CPU = fine for the main
thread. If we go to the full 500×500 grid, the sim will need to
move to a Web Worker.

## File layout

```
viewer/
  index.html          # entrypoint
  main.ts             # app bootstrap
  app.ts              # main loop (drives sim ticks + rendering)
  map/
    hexMap.ts         # PIXI hex grid renderer (neighbor-aware tiles)
    settlements.ts    # settlement glyph layer (tier-aware + same-hex stacking)
    caravans.ts       # caravan sprite layer
    banditCamps.ts    # camp glyph layer
    buildings.ts      # sub-hex building marker layer
    catchment.ts      # catchment shading layer
    rivers.ts         # river overlay
    roads.ts          # roads overlay (sub-hex segments)
    overlays.ts       # heat-map overlays
    coords.ts         # axial → screen pixel conversion
  ui/
    sidebar.ts        # the right panel
    timeControls.ts   # play/pause/speed buttons
    settlementPanel.ts
    caravanPanel.ts
    banditCampPanel.ts
    resourcePanel.ts
    eventLog.ts
    popup.ts          # reusable modal-popup chrome (backdrop, Esc, X)
    settlementPopup.ts  # rich inspector content for a selected settlement
    caravanPopup.ts     # rich inspector content for a selected caravan
    banditCampPopup.ts  # rich inspector content for a selected bandit camp
    factionScreen.ts  # modal faction inspector (separate stack)
    factionLink.ts    # clickable faction chips used by all panels
  state/
    viewerState.ts    # selected entity, current speed, etc.
```

`vite.config.ts` (new): roots the dev server at `./viewer/`. Build
output goes to `dist/`.

## Accessibility / debug affordances

- Press `Esc` to deselect.
- Press `Space` to toggle play/pause.
- Press `+` / `-` to change speed.
- `?` shows a help overlay listing keys.
- A "Copy state JSON" button on the selected-entity panel for
  pasting into bug reports.

## Running

```bash
npm run dev        # opens http://localhost:5173/
npm run build      # static build into dist/
```

The `dev` script in `package.json` already points at vite; we just
need a `vite.config.ts` and the `viewer/` directory.

## Out of scope (current viewer)

- Editing the world (placing buildings, moving caravans). Read-only.
- Sound.
- Mobile support.
- Persistence — refresh re-seeds.
- The actual player UI (Vagrus-style daily MP, camp-to-end-turn).
  That's docs/09 and a separate surface.
