# 15 -- Viewer

The viewer is the browser surface for seeing the simulation. It has two jobs:

- an inspection harness for burn-in, debugging, tuning, and QA;
- the player-facing map renderer for the final game.

Those jobs share one rendering direction. There is one final map renderer: a
fixed-isometric generated raster world. Existing viewer code or art survives
only if it directly supports that renderer. Everything else should be deleted
as the replacement lands.

## Replacement Mandate

The transition is a wholesale replacement, not a layered migration.

Locked decisions:

- Delete viewer art and renderer code that does not serve the fixed-isometric
  map.
- Use generated raster assets for map-facing art.
- Do not keep alternate visual paths.
- Keep existing code only when it remains useful in the new state: simulation
  stepping, entity inspection, map culling, path animation, selection, panels,
  diagnostics, and shared data types.
- When the replacement is complete, the repo should not contain unused viewer
  assets, fallback visual modes, or docs describing non-target art paths.

## Product Shape

The viewer should feel like a living Roman provincial atlas: a painted,
fixed-isometric strategic landscape where the player can read the simulator
through terrain, roads, settlements, movement, seasons, and visible land use.

It should not look like:

- close-up board-game terrain;
- decorative fantasy tiles;
- top-down satellite imagery;
- arbitrary collections of flowers, rocks, tufts, or props;
- mixed perspective sprites pasted onto a flat map.

The map must remain legible at game scale. One hex is roughly 1 km of land.
Visible detail should represent kilometer-scale geography, land use, and
simulated entities.

## Viewer Modes

The same viewer supports two presentation modes.

### Inspection Mode

Inspection mode is the development and burn-in harness. It runs the simulation
live in the browser and exposes state for debugging.

Required capabilities:

- run, pause, step, reset, and speed control;
- simulation day/year, population, caravans, patrols, bandits, and recent
  event counters;
- clickable settlements, caravans, patrols, news carriers, bandit camps, and
  bandit parties;
- detail panels for selected entities;
- resource stockpile, market, price, production, and flow overlays;
- heat maps for resources, prices, disease, road wear, bandit risk, ownership,
  and other diagnostics;
- visual lockstep between simulation ticks and unit animation;
- deterministic seeds and repeatable camera scenarios for QA.

Inspection mode can expose dense overlays and numbers. It must still use the
same map projection, asset catalog, road/river topology, unit directions, and
seasonal state as the player map.

### Player Mode

Player mode is the final Vagrus-style turn surface described in
[09 -- Player role](09-player.md). The player is one caravan operator inside
the simulation, not an omniscient map editor.

Required implications:

- known information is visually distinct from guessed, stale, or unknown
  information;
- reputation, prices, hazards, and news are revealed through physical
  information flow;
- clicking a settlement opens the settlement experience, not a debug dump;
- map visuals should teach the player to read land, routes, risk, and
  economic opportunity without needing symbolic clutter everywhere.

## Camera Contract

All player-facing map assets must share one camera contract:

- fixed orthographic isometric projection;
- no perspective convergence;
- one global azimuth and pitch;
- one global light direction and shadow softness;
- one hex footprint and anchor convention;
- transparent background for sprites and overlays;
- no labels, borders, UI, prompt text, or debug marks in generated assets;
- no arbitrary rotation unless an asset is explicitly certified as
  rotationally safe.

This is a renderer contract, not just a prompt instruction. Catalog validation
should reject assets that violate it.

## Scale Contract

Every visible object on the map should answer: what simulated thing does this
represent at 1 km scale?

Valid independent map objects:

- settlement footprints, hamlets, villages, towns, cities, and ruins;
- roads, tracks, bridges, ferries, fords, gates, and mountain passes;
- rivers, lakes, wetlands, irrigation works, and harbor edges;
- mines, quarries, logging camps, salt works, forts, shrines, estates, and
  camps;
- caravans, patrols, messengers, armies, bandit parties, migrants, and other
  moving entities;
- named hidden features once discovered.

Invalid independent scatter:

- individual flowers;
- single decorative rocks;
- isolated grass tufts;
- repeated bushes used only to fill empty space;
- generic props with no simulation meaning.

Micro-detail belongs inside terrain materials: canopy mottling, field strips,
dry grass, stone speckle, hill shadow, marsh reed bands, dust, snow crust, and
soil variation.

## Terrain

Base terrain art is generated as large-scale land surface, not as object
collections.

Required terrain families:

- plains;
- fertile valley;
- steppe;
- desert;
- hills;
- mountains;
- forest;
- dense forest;
- marsh;
- lake;
- urban;
- ruin.

Each terrain family can vary by climate, elevation, season, and seeded variant.
The catalog should eventually support 8-16 variants per important
terrain/climate/season combination, but generation should start with a proof
board before scaling up.

Terrain examples at 1 km scale:

- plains: field mosaics, grazing areas, faint tracks, soil bands;
- fertile valley: irrigation geometry, crop pattern, floodplain influence;
- steppe: broad dry grass masses, sparse scrub, exposed soil;
- desert: dune sheets, stony flats, wadis, salt crust, heat haze;
- hills: ridgelines, terracing, slope shadow, erosion gullies;
- mountains: ridges, cliffs, snowline, scree fields;
- forest: canopy mass, clearings, logging scars;
- marsh: wetland texture, channels, reed bands;
- lake: full-hex water with shorelines generated from neighbor masks;
- urban: roof masses, walls, roads, courtyards, markets, industrial edges;
- ruin: collapsed urban footprint, overgrowth, former roads.

## Transitions

Transitions are deterministic composition, not generated topology.

The renderer needs masks for:

- one edge transition;
- adjacent two-edge transition;
- opposite two-edge transition;
- three-edge transition;
- corner blends;
- lake shoreline against any neighboring land;
- marsh and wetland blends along river or lake margins;
- hill and mountain elevation blends.

Generated art supplies materials and edge texture. Code decides which edges,
corners, and multi-edge cases apply.

## Roads

Roads are topology first, art second.

Each roaded hex renders from a six-bit connection mask, one bit per hex
direction. A road endpoint must land exactly on the midpoint of the matching
hex edge. A two-connection road is a segment connecting both selected edge
midpoints. Three or more connections are junctions. Dead ends are valid only
when the simulation has a reason for them.

Road grade controls material:

- track: faint dirt, seasonal mud, created by traffic;
- dirt road: compacted path, visible ruts, stronger in dry seasons;
- Roman road: engineered surface, drainage, straighter where plausible;
- damaged road: broken surface, overgrowth, maintenance failure.

Generated art supplies road material strips, shoulders, junction textures,
bridges, and fords. It must not bake arbitrary road networks into terrain
tiles.

## Rivers And Lakes

Lakes fully occupy their hexes. River hexes are land hexes with sub-1 km river
corridors running through them. This distinction is locked in
[07 -- Geography & climate](07-geography.md).

Rendering implications:

- lake shorelines are neighbor-mask driven;
- rivers use geometry through edge midpoints or sub-edge anchors;
- river width comes from metadata and can vary downstream;
- road-river crossings render as bridge, ford, ferry, or blocked crossing;
- settlements can sit on river hexes;
- marsh and fertile valley visuals can derive from river adjacency.

Water animation should be subtle: directional shimmer, slow current bands,
seasonal color, floodplain wetness, and plausible winter ice.

## Settlements And Land Use

Settlements are footprints and catchments, not isolated icons.

Physical extent from [05 -- Settlements](05-settlements.md):

- hamlets can be sub-hex and multiple can share a hex;
- villages usually occupy one hex;
- towns occupy one to two hexes;
- small cities occupy two to three urban hexes;
- large cities occupy three to ten urban hexes.

Rendering implications:

- hamlets are small integrated settlement marks inside terrain;
- villages alter the whole hex through fields, paths, smoke, and buildings;
- towns and cities use multi-hex footprints with connected roads, walls,
  markets, fields, docks, and industrial edges;
- abandoned urban hexes become ruins;
- catchments show land use: fields, vineyards, pasture, managed forest,
  quarry scars, mine works, salt pans.

The best map richness should come from simulated land use, not random props.

## Resource Sites

Resources should appear as physical signatures:

- grain: field systems and harvest state;
- wood: forest mass, managed cuts, logging camps;
- fish: docks, boats, nets, lake or river productivity where relevant;
- minerals: mine scars, spoil heaps, tracks, work camps;
- stone: quarry faces and pale cuts into hills;
- salt: salt pans, lake margins, or caravan destinations.

Debug overlays can remain symbolic. Player-facing art should make the land
readable.

## Units And Movement

Moving units need six directional animation sets. Rotating one sprite is not
acceptable because perspective, load angle, shadows, silhouettes, and gait all
change by direction.

Required directions:

- east;
- northeast;
- northwest;
- west;
- southwest;
- southeast.

For each moving unit class:

- idle loop per direction;
- moving loop per direction;
- loaded/unloaded variants where useful;
- matching shadow and dust layers;
- stable anchor point;
- optional posture variants for patrols, armies, bandits, refugees, and
  couriers.

The renderer chooses direction from the current hex segment delta and changes
animation at segment boundaries. Multi-hex daily movement is animated as a
sequence of route segments.

## Sim / Visual Lockstep

The viewer may run the sim at 1x, 4x, 16x, 64x, 256x, or other configured
speeds, but the speed is a cap. The next simulation tick should only fire
when:

- the requested tick interval has elapsed;
- visible unit animations for the previous tick have completed or been
  explicitly skipped by the user.

This keeps the rendered map from trailing the simulation state. Fast speeds
can shorten or coalesce animation, but they should not leave a hidden backlog
of movement after pause.

## Seasons

Seasons are simulator state made visible, not a global color filter.

The date model uses one day per turn, a 365-day year, and roughly 91-day
seasons. Visible season should derive from date, climate, terrain, and
elevation.

Seasonal cues:

- spring: green-up, planting, swollen rivers, wet roads, pasture recovery;
- summer: dry tracks, dust, open mountain passes, active campaigning;
- autumn: harvest fields, vineyards, orchard color, market traffic;
- winter: fuel demand, snow by elevation and climate, closed passes, mud or
  frost depending on region.

Climate bands matter. Mediterranean winter is not alpine winter. Arid spring
can briefly bloom. Continental winter can freeze rivers. High passes can keep
snow while valleys are green.

Implementation options:

- seasonal terrain variants for visible terrain/climate pairs;
- generated overlays for snow, mud, dryness, and harvest;
- shader-assisted wetness and palette changes;
- seasonal road materials;
- elevation and climate rules to prevent uniform map-wide swaps.

## Animation

Animation should make the simulation legible and alive.

Good animation sources:

- caravans, patrols, couriers, migrants, armies, and bandit parties moving
  along real paths;
- road dust, wagon sway, pack animal gait, camp torchlight;
- river shimmer, lake wind bands, marsh wetness, floodplain pulses;
- settlement smoke, kilns, smithies, camps, and burned ruins;
- market-day crowd flicker in towns and cities;
- construction scaffolds, road maintenance, quarry movement;
- seasonal transitions: green-up, harvest, snowline, thaw, mud, dust;
- weather overlays: cloud shadow, rain bands, valley fog, heat haze;
- danger cues: fire, abandoned smoke, patrol banners, bandit camp embers.

Bad animation sources:

- pointer-driven parallax on loading or main menu screens;
- random props moving because they exist;
- motion that implies detail smaller than the simulation represents;
- animation used to hide topology errors.

Menu and loading screens should use generated image sets, not mouse parallax.
Each mode should have at least five strong background paintings and timed
crossfades with subtle authored pan, weather, or atmospheric overlays.

## Generated Asset Pipeline

Generated with GenAI:

- base terrain variants;
- seasonal terrain variants;
- road and river material strips;
- shoreline and transition materials;
- settlement footprint kits;
- landmark and resource-site sprites;
- six-direction unit animation sheets;
- menu and loading background paintings;
- UI icons that need to share the game art language.

Owned by code:

- hex projection;
- adjacency and bitmasks;
- road topology;
- river topology;
- lake shoreline masks;
- terrain transition masks;
- settlement footprint placement;
- unit path direction;
- known/guessed/unknown information state;
- animation timing tied to simulation state.

Generation starts with a style bible and proof board. The proof board should
contain representative terrain, roads, rivers, lake edges, settlement
footprints, unit movement, and all four seasons in one controlled scene. Do
not scale the catalog until that board reads as one coherent world.

Prompt requirements:

- fixed orthographic isometric camera;
- one kilometer strategic terrain scale;
- no close-up decorative props;
- no labels, borders, UI, text, arrows, or grid;
- transparent background for sprites and overlays;
- same light direction and shadow softness;
- same hex footprint and anchor;
- Roman provincial frontier and trade landscape mood;
- readable from game zoom distances.

Negative requirements:

- no top-down satellite view;
- no side-view buildings;
- no fantasy miniatures;
- no single flowers or decorative rocks;
- no black background;
- no green-screen background;
- no roads or rivers unless generating road or river material;
- no arbitrary hex outlines unless generating a reference image.

## Asset Catalog

Every generated asset needs metadata:

- asset id;
- role;
- terrain, climate, season, and variant tags;
- camera contract version;
- hex footprint size;
- anchor point;
- edge connection data if relevant;
- animation direction if relevant;
- frame count and timing if animated;
- source prompt id;
- review status;
- allowed zoom range;
- code owner or render layer.

Uncataloged generated art should not ship.

## Visual QA

Catalog validation:

- image dimensions match metadata;
- alpha channel exists when required;
- anchor point is present;
- no prompt text, labels, UI, or background leaks;
- edge connection pixels cover required endpoints;
- shadows use the approved direction;
- frame counts and direction tags match unit metadata.

Topology validation:

- every road connection reaches the exact edge midpoint it claims;
- absent road bits produce no visible road arm;
- river-road crossings use bridge, ford, ferry, or blocked state;
- lake shoreline masks cover every land-adjacent edge;
- multi-edge shoreline cases render without duplicate fragments;
- terrain transitions preserve camera angle.

Screenshot validation:

- representative maps in all four seasons;
- dense city and rural wilderness;
- lake clusters with one, two, three, and many land edges;
- river valleys with bridges and settlements;
- road networks with dead ends, segments, T-junctions, and hubs;
- zoomed-out regional view and zoomed-in settlement view;
- moving units in all six directions;
- menu and loading backgrounds cycling through generated image sets.

## Implementation Plan

Phase 0: delete and inventory.

Remove unused viewer art, generated fragments, and renderer branches that will
not be part of the fixed-isometric target. Inventory the code that survives:
simulation stepping, culling, panels, selection, overlays, unit path data, and
diagnostics.

Phase 1: freeze camera and style contract.

Define projection, hex pixel footprint, light direction, anchor conventions,
asset metadata, and acceptance checks.

Phase 2: build the proof board.

Generate a small coherent set of terrain, road, river, settlement, unit, and
seasonal assets. Render them in one controlled map scenario before scaling
catalog generation.

Phase 3: implement topology-owned composition.

Build road bitmask rendering, river geometry, lake shoreline masks, and terrain
transition masks. Generated assets provide material and texture only.

Phase 4: replace terrain and land-use rendering.

Use generated terrain variants and land-use signatures at 1 km scale. Remove
decorative scatter from map-facing rendering.

Phase 5: add seasons.

Introduce season-aware terrain selection, road materials, hydrology cues,
weather overlays, climate rules, and elevation rules.

Phase 6: add six-direction unit animation.

Generate and wire directional animation sheets for caravans first, then
patrols, couriers, migrants, armies, and bandits.

Phase 7: replace menu and loading backgrounds.

Use generated image sets with timed transitions and subtle authored motion.
Remove pointer-tied parallax.

Phase 8: add ambient life.

Layer in smoke, water, dust, weather, city activity, construction, ruin fires,
and seasonal transitions. Motion should remain sparse, readable, and tied to
world state where possible.

Phase 9: performance and LOD.

Use viewport culling, atlases, seasonal atlases, and zoom-dependent detail. At
regional zooms, show terrain, roads, rivers, cities, and moving entities. At
close zooms, reveal settlement texture, road surface, land use, and ambient
motion.

## Acceptance Criteria

The viewer replacement is complete when:

- `15-viewer.md` is the only viewer design doc;
- player-facing map art uses the fixed-isometric generated asset pipeline;
- road and river networks connect correctly in all six directions;
- lake and terrain transitions handle multi-edge cases without artifacts;
- terrain reads at 1 km scale without decorative close-up scatter;
- settlements occupy believable physical footprints;
- seasons are recognizable and climate-aware;
- units move with six-direction animation;
- menu and loading screens cycle generated images with timed motion;
- unused viewer art and renderer branches have been deleted;
- no docs describe alternate viewer art paths as available.
