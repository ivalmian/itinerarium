# 16 — Burn-in viewer

A browser viewer that runs the simulation in real time and displays
the world's evolving state visually. Lets you watch caravans move,
settlements grow / shrink, banditry erupt, and reputation propagate
without reading event logs.

This is the canonical UX for v1 development inspection. The eventual
player UI (Vagrus-style turn UX, see docs/09) is a different surface
and not what this viewer is.

## Goals

- **Run the sim live in the browser.** Tick the world automatically
  at a chosen speed (1×, 4×, 16×, 64×). Pause / play / step.
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
- **PixiJS** for WebGL rendering. The hex map is a single
  PIXI.Container; hex tiles are batched as `PIXI.Sprite`s using a
  generated atlas of terrain colors. Settlements + caravans are
  separate Container layers.
- **TypeScript** throughout, sharing types with the sim.
- **No framework** for the panels — vanilla DOM + small helpers.
  Adding React would couple us to a heavier toolchain for what is
  fundamentally an inspection UI.
- **Same simulation.** The viewer imports `tick`, `seedWorld`, etc.
  from the existing `src/` modules. The simulation runs in the
  main thread for v1; if framerate suffers, move it to a Web
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

## Caravan rendering

Each caravan is one PIXI.Sprite (a 6-px circle, color = owner
faction). On each sim tick, the caravan's `position` may change.
The viewer interpolates the sprite's position between old and
new over the tick interval (so at 16× speed the dots smoothly
slide between hexes rather than teleporting).

Caravans carrying bandit-stolen cargo have a red outline.

## Bandit camp rendering

A small black X glyph (5 px) on the camp's hex. Tooltip on hover:
"Caelius's band — 18 bandits, 32 loot units". Camps moving via
`move_camp` action animate the same way as caravans.

## Time controls

- ▶ Play (current speed)
- ⏸ Pause
- ▶▶ Speed up (toggle through 1×, 4×, 16×, 64×)
- ⏹ Reset (re-seed and re-run from day 0 with same seed)

Internally, `setInterval` ticks the sim at `1000 / speed` ms per
tick at 1×; faster speeds reduce the interval. We don't tick more
than once per requestAnimationFrame to avoid blocking the renderer.

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

## Resources panel

When expanded, shows a table:

| Resource | Global stock | Production rate (units/day, 30d avg) | Last price |
|---|---|---|---|
| food.grain | 1.2M modii | 12,400/day | 1.05 coin |
| metal.iron | 2,400 kg | 8/day | 12.40 coin |
| ... | ... | ... | ... |

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

## File layout (new)

```
viewer/
  index.html          # entrypoint
  main.ts             # app bootstrap
  app.ts              # main loop (drives sim ticks + rendering)
  map/
    hexMap.ts         # PIXI hex grid renderer
    settlements.ts    # settlement glyph layer
    caravans.ts       # caravan sprite layer
    banditCamps.ts    # camp glyph layer
    overlays.ts       # heat-map overlays
    coords.ts         # axial → screen pixel conversion
  ui/
    sidebar.ts        # the right panel
    timeControls.ts   # play/pause/speed buttons
    settlementPanel.ts
    caravanPanel.ts
    resourcePanel.ts
    eventLog.ts
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

## Out of scope (v1 viewer)

- Editing the world (placing buildings, moving caravans). Read-only.
- Sound.
- Mobile support.
- Persistence — refresh re-seeds.
- The actual player UI (Vagrus-style daily MP, camp-to-end-turn).
  That's docs/09 and a separate surface.
