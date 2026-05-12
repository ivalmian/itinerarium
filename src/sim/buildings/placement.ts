/**
 * Terrain-aware placement for buildings.
 *
 * Per docs/05 §"Stage-1 seeding rules" + docs/07 §"Buildability +
 * passability", every building has a natural fit for certain terrains:
 * farms want plains / fertile_valley, vineyards and olive groves want
 * hills, forester camps want forest, fisheries want river/lake-adjacent
 * land, mines want hills/mountains with deposits, urban workshops want
 * the urban hex. Previously the procgen + dynamic-investment placement
 * code just picked the first passable hex in iteration order — a
 * vineyard might land on a marsh, a forester camp on plains.
 *
 * This module owns the affinity matrix and the per-hex scoring function
 * that callers use to rank candidate hexes. Returns 0 when a hex is
 * unsuitable (blocking placement entirely); higher scores are
 * preferable.
 *
 * Used by:
 *   - `src/procgen/seed.ts` (initial settlement seeding)
 *   - `src/sim/tick.ts` (quarterly investment placement)
 *
 * Adding a new building? Update both the catalog (src/sim/buildings/
 * catalog.ts) and the switch below — buildings without an explicit
 * entry get a uniform mid-score on every passable hex, which keeps
 * the system extensible without forcing every caller to know about
 * the new building.
 */

import type { BuildingId } from '../types.js';
import type { Climate, HexTile, Terrain } from '../world/terrain.js';

/**
 * Whether a terrain can physically host any building at all. Per
 * docs/07-geography §"Buildability + passability":
 *   - lake: always 0 (water occupies the whole hex)
 *   - mountains: 0 (too steep; quarries / mines bypass this)
 *   - dense_forest: 0 (cleared land needed for almost anything)
 * Mines and quarries override this when a matching deposit is present.
 */
export const isTerrainBuildable = (terrain: Terrain): boolean => {
  switch (terrain) {
    case 'lake':
    case 'mountains':
    case 'dense_forest':
      return false;
    default:
      return true;
  }
};

/**
 * Score how well a building fits a given hex. 0 = unsuitable (do not
 * place); >0 = suitable, higher is better. Callers pick the highest-
 * scoring free hex among candidates.
 *
 * `waterAdjacent` lets the caller signal that the hex sits next to a
 * river or lake hex (or is one itself) — used by fisheries and water-
 * powered mills. Computed by the caller because adjacency depends on
 * the full grid which we don't import here.
 *
 * `isUrban` signals that the hex is part of a settlement's urban
 * footprint, regardless of its underlying terrain. Procgen does not
 * (yet) flip the urban hex's terrain to `urban` — those hexes keep
 * the plains / fertile_valley / etc. terrain they were born with —
 * so we can't read "is this the city core?" from the terrain alone.
 */
export const terrainAffinity = (
  buildingId: BuildingId,
  tile: HexTile,
  options: { readonly waterAdjacent: boolean; readonly isUrban?: boolean } = {
    waterAdjacent: false,
  },
): number => {
  const t = tile.terrain;
  const c = tile.climate;
  const wet = options.waterAdjacent || tile.hasRiver;
  const urban = options.isUrban === true || t === 'urban';

  // Mines and quarries can sit on terrain that's otherwise unbuildable
  // (mountains, dense forest) — they're geology-led, not land-use-led.
  // Caller still gates on a matching deposit.
  if (String(buildingId) === 'mine') {
    return mineScore(t);
  }
  if (String(buildingId) === 'quarry') {
    return quarryScore(t);
  }

  if (!isTerrainBuildable(t)) return 0;

  // Land-use buildings (farm, pasture, vineyard, olive_grove, orchard,
  // forester_camp) make no sense inside the city core: the urban hex
  // is the place that *consumes* food, not the place that grows it.
  // Score urban as a minimal fallback so it's only used when the
  // catchment is unavailable (same-hex hamlets, fully-claimed
  // catchments). Any positive catchment score beats this floor.
  const URBAN_FALLBACK_FOR_LAND_USE = 1;

  switch (String(buildingId)) {
    case 'farm':
      // Subsistence cereals. Fertile valleys are perfect, plains good,
      // hills marginal (terraced), steppe poor (only short-grain
      // varieties), marsh / desert almost unviable. Never on city core.
      if (urban) return URBAN_FALLBACK_FOR_LAND_USE;
      if (t === 'fertile_valley') return 10;
      if (t === 'plains') return 8;
      if (t === 'hills') return 4;
      if (t === 'steppe') return 2;
      if (t === 'marsh' || t === 'desert') return 1;
      return 3;

    case 'pasture':
      // Steppe is iconic grazing land; plains and hills are nearly as
      // good. Forests can be silvopastured but it's marginal.
      if (urban) return URBAN_FALLBACK_FOR_LAND_USE;
      if (t === 'steppe') return 10;
      if (t === 'plains') return 9;
      if (t === 'hills') return 8;
      if (t === 'fertile_valley') return 5;
      if (t === 'forest') return 3;
      if (t === 'desert' || t === 'marsh') return 1;
      return 3;

    case 'vineyard':
      // Vines love hill slopes in mediterranean climates. Plains work
      // in temperate / continental. Steppe / desert / alpine: no.
      if (urban) return URBAN_FALLBACK_FOR_LAND_USE;
      if (t === 'hills' && c === 'mediterranean') return 10;
      if (t === 'hills') return 8;
      if (t === 'fertile_valley' && c === 'mediterranean') return 7;
      if (t === 'plains' && c === 'mediterranean') return 6;
      if (t === 'plains') return 4;
      return 1;

    case 'olive_grove':
      // Mediterranean-specific. Hills strongly preferred.
      if (urban) return URBAN_FALLBACK_FOR_LAND_USE;
      if (t === 'hills' && c === 'mediterranean') return 10;
      if (t === 'fertile_valley' && c === 'mediterranean') return 7;
      if (t === 'plains' && c === 'mediterranean') return 5;
      if (c !== 'mediterranean') return 1;
      return 3;

    case 'orchard':
      // Mixed fruit — most adaptable.
      if (urban) return URBAN_FALLBACK_FOR_LAND_USE;
      if (t === 'fertile_valley') return 10;
      if (t === 'plains') return 8;
      if (t === 'hills') return 7;
      return 3;

    case 'forester_camp':
      // Wants standing timber. Forest is the only sensible base; the
      // catchment scan already requires forest somewhere nearby.
      if (urban) return URBAN_FALLBACK_FOR_LAND_USE;
      if (t === 'forest') return 10;
      if (t === 'dense_forest') return 9;
      if (t === 'hills') return 3;
      return 1;

    case 'fishery':
      // Needs water access. Hex itself must touch water (river / lake
      // adjacent or be a river hex). On a buildable hex with water
      // access, prefer plains / fertile_valley shore over forest /
      // marsh.
      if (!wet) return 0;
      if (t === 'river') return 10;
      if (t === 'fertile_valley' || t === 'plains') return 8;
      if (t === 'marsh') return 6;
      return 5;

    // Workshops and storage / civic / military: they all want to sit
    // inside the settlement's urban core. Score urban high; allow a
    // mid-score fallback on plains / fertile_valley so a settlement
    // with no urban hex (rare) can still seed its workshops.
    case 'mill':
      // Watermills love a river-adjacent hex. Animal-powered mills
      // fall back to the urban core.
      if (wet && urban) return 10;
      if (wet) return 8;
      if (urban) return 7;
      return 4;

    case 'sawmill':
      // Water-powered preferred but plenty of historical sawmills
      // were ox- or hand-powered.
      if (wet) return 10;
      if (urban) return 7;
      if (t === 'forest') return 6;
      return 4;

    case 'charcoal_kiln':
      // Kilns sit at the wood / town boundary — high heat, smoke,
      // needs to be near both fuel and a road.
      if (t === 'forest') return 9;
      if (urban) return 7;
      if (t === 'plains' || t === 'hills') return 6;
      return 3;

    case 'tannery':
      // Smelly + water-hungry. Conventionally placed downwind of the
      // city, near running water.
      if (wet) return 10;
      if (urban) return 6;
      return 4;

    case 'kiln':
    case 'pottery':
    case 'bloomery':
    case 'smithy':
    case 'weaver_workshop':
    case 'tailor_shop':
    case 'cart_wright':
    case 'mint':
    case 'bakery':
    case 'oil_press':
    case 'winery':
    case 'dairy':
      if (urban) return 10;
      if (t === 'fertile_valley' || t === 'plains') return 5;
      return 3;

    case 'granary':
    case 'warehouse':
    case 'cistern':
    case 'temple':
    case 'forum_market':
    case 'walls':
    case 'barracks':
      // Civic + storage + military: urban core only.
      if (urban) return 10;
      return 2;

    case 'aqueduct_segment':
    case 'road_segment':
      // Infrastructure: routed by other code, but if asked here, any
      // buildable terrain works.
      return 5;

    default:
      // Unknown / new building id: uniform mid-score on every
      // buildable hex so it doesn't get stuck.
      return 5;
  }
};

const mineScore = (t: Terrain): number => {
  // Caller separately requires a matching mineable deposit on the hex.
  if (t === 'hills') return 10;
  if (t === 'mountains') return 8;
  if (t === 'forest' || t === 'plains') return 5;
  if (t === 'dense_forest') return 4;
  return 3;
};

const quarryScore = (t: Terrain): number => {
  if (t === 'hills') return 10;
  if (t === 'mountains') return 8;
  return 3;
};

/**
 * Pick the highest-scoring hex from candidates for the given building.
 * Returns `null` if no candidate is suitable (every candidate scored 0
 * — e.g. a fishery with no water-adjacent hex available).
 *
 * Ties are broken deterministically by the candidate's q-then-r
 * coordinates so two runs of the same seed always pick the same hex.
 *
 * `getTile` is the caller's grid lookup so we don't pull in
 * `HexGrid` here.
 */
export interface PlacementCandidate {
  readonly hex: { readonly q: number; readonly r: number };
  readonly tile: HexTile;
  readonly waterAdjacent: boolean;
  /** `true` when the hex is part of a settlement's urban footprint
   *  (regardless of underlying terrain). Workshops / storage / civic
   *  buildings score this dramatically higher than non-urban candidates. */
  readonly isUrban: boolean;
}

export const pickBestHex = (
  buildingId: BuildingId,
  candidates: readonly PlacementCandidate[],
): PlacementCandidate | null => {
  let bestScore = 0;
  let best: PlacementCandidate | null = null;
  for (const c of candidates) {
    const score = terrainAffinity(buildingId, c.tile, {
      waterAdjacent: c.waterAdjacent,
      isUrban: c.isUrban,
    });
    if (score <= 0) continue;
    if (
      best === null ||
      score > bestScore ||
      (score === bestScore &&
        (c.hex.q < best.hex.q || (c.hex.q === best.hex.q && c.hex.r < best.hex.r)))
    ) {
      bestScore = score;
      best = c;
    }
  }
  return best;
};

/** Re-export for tests / other consumers that want the raw climate axis. */
export type { Climate, Terrain };
