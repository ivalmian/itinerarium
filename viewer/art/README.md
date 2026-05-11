# viewer/art — painterly-vector SVG assets

54 standalone SVG files, browseable in `gallery.html`. Painterly style:
linear-gradient base fills, `feTurbulence` noise overlay for surface
texture, soft drop shadow on raised features, NW light convention.

## Layout

- `terrain/` — 13 hex-shaped tiles (plains, fertile_valley, hills,
  mountains, forest, dense_forest, marsh, desert, steppe, river, lake,
  urban, ruin)
- `buildings/` — 34 building glyphs (full list per
  `viewer/map/buildings.ts` switch)
- `settlements/` — 5 tier glyphs (hamlet, village, town, small_city,
  large_city)
- `units/` — 2 mover glyphs (caravan, bandit_camp)

## Author conventions

- **viewBox**:
  - Terrain tiles: `0 0 128 148` (pointy-top hex inscribed, corners at
    (64,0)·(128,37)·(128,111)·(64,148)·(0,111)·(0,37))
  - Buildings: `0 0 64 64`, ground line at y≈44
  - Settlements: `0 0 64 64`, anchored center
  - Units: `0 0 32 32`, anchored center
- **Light**: NW. Upper-left faces lighter; lower-right darker. Drop
  shadow offsets `dx=.5 dy=1`.
- **Defs** (inline per file): `id="lg-..."` linear-gradient(s),
  `id="ds"` drop-shadow filter, `id="nz"` noise filter.
- **Palette**: per-asset 3-tone (light / base / dark) derived ±15%
  lightness. Cohesive earth + sky palette across the set.
- **Stroke**: 0.5–1.0 px darkened-base color, alpha ~0.7. Avoid pure
  black outlines.

## Browsing

Open `gallery.html` in a browser (e.g. `python3 -m http.server 8080`
from repo root, then visit `localhost:8080/viewer/art/gallery.html`).
The page enumerates every SVG by name in a labeled grid.

## Not yet wired

These assets are not yet loaded by the viewer. Wiring happens after the
user reviews the gallery and decides which to use vs replace.
