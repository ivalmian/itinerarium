/**
 * Tests for seedWorld(): turn a procgen output (terrain grid + settlement
 * sites) into an initial WorldState ready for burn-in.
 */

import { describe, expect, it } from 'vitest';
import { buildingId, jobId, resourceId, type ActorId } from '../sim/types.js';
import { createGrid } from '../sim/world/grid.js';
import { hex, hexesWithinRange, hexKey, type Hex } from '../sim/world/hex.js';
import type { HexTile } from '../sim/world/terrain.js';
import { generateTerrain } from './terrain.js';
import { siteSettlements, type SettlementSite } from './settlements.js';
import { seedWorld, type WorldState } from './seed.js';

const SMALL_GRID_OPTS = {
  seed: 'seed-test',
  widthHexes: 32,
  heightHexes: 32,
  oceanCoveragePct: 5,
  mountainsCoveragePct: 10,
} as const;

const SMALL_SITE_OPTS = {
  seed: 'sites-test',
  cityCount: 2,
  townCount: 3,
  villageCount: 6,
  hamletCount: 8,
  clusterRadiusHexes: 8,
} as const;

const tile = (overrides: Partial<HexTile> = {}): HexTile => ({
  terrain: 'plains',
  climate: 'mediterranean',
  elevation: 20,
  hasRiver: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

const buildFixtureWorld = (
  overrides: { seed?: string; familiesPerCity?: number } = {},
): WorldState => {
  const grid = generateTerrain(SMALL_GRID_OPTS);
  const sites = siteSettlements({ ...SMALL_SITE_OPTS, grid });
  const opts = {
    seed: overrides.seed ?? 'world-test',
    grid,
    settlementSites: sites,
    ...(overrides.familiesPerCity !== undefined
      ? { patricianFamiliesPerCity: overrides.familiesPerCity }
      : {}),
  };
  return seedWorld(opts);
};

const buildSameHexHamletWorld = (): WorldState => {
  const grid = createGrid();
  const center = hex(0, 0);
  for (const h of hexesWithinRange(center, 5)) {
    grid.set(h, tile());
  }
  const sites: SettlementSite[] = [
    {
      kind: 'capital',
      anchor: center,
      urbanHexes: [center],
      estimatedPopulation: 12_000,
    },
    {
      kind: 'hamlet',
      anchor: center,
      urbanHexes: [center],
      estimatedPopulation: 80,
    },
  ];
  return seedWorld({
    seed: 'same-hex-hamlet',
    grid,
    settlementSites: sites,
    patricianFamiliesPerCity: 1,
  });
};

describe('seedWorld', () => {
  describe('shape', () => {
    it('returns a WorldState with all the top-level maps', () => {
      const w = buildFixtureWorld();
      expect(w.day).toBe(0);
      expect(w.grid).toBeDefined();
      expect(w.settlements).toBeInstanceOf(Map);
      expect(w.actors).toBeInstanceOf(Map);
      expect(w.factions).toBeInstanceOf(Map);
      expect(w.characters).toBeInstanceOf(Map);
      expect(w.caravans).toBeInstanceOf(Map);
      expect(w.reputation).toBeDefined();
    });

    it('starts with empty caravans (burn-in spawns them)', () => {
      const w = buildFixtureWorld();
      expect(w.caravans.size).toBe(0);
    });

    it('starts with no reputation entries by default', () => {
      const w = buildFixtureWorld();
      expect(w.reputation.size()).toBe(0);
    });
  });

  describe('determinism', () => {
    it('same seed and procgen input → identical settlement / actor / character counts', () => {
      const a = buildFixtureWorld({ seed: 'det-1' });
      const b = buildFixtureWorld({ seed: 'det-1' });
      expect(b.settlements.size).toBe(a.settlements.size);
      expect(b.actors.size).toBe(a.actors.size);
      expect(b.characters.size).toBe(a.characters.size);
      expect(b.factions.size).toBe(a.factions.size);
    });

    it('different seeds produce different actor IDs (in general)', () => {
      const a = buildFixtureWorld({ seed: 'det-A' });
      const b = buildFixtureWorld({ seed: 'det-B' });
      const idsA = [...a.actors.keys()].sort();
      const idsB = [...b.actors.keys()].sort();
      // The procgen input shape is identical, so counts are identical, but
      // names/ids should disagree somewhere because the family-name picker
      // flowed through a different rng stream.
      expect(idsA).not.toEqual(idsB);
    });

    it('a specific named character — the governor — is the same across runs with the same seed', () => {
      const a = buildFixtureWorld({ seed: 'det-gov' });
      const b = buildFixtureWorld({ seed: 'det-gov' });
      const govA = [...a.characters.values()].find((c) => c.role === 'governor');
      const govB = [...b.characters.values()].find((c) => c.role === 'governor');
      expect(govA).toBeDefined();
      expect(govB).toBeDefined();
      expect(govA?.name).toBe(govB?.name);
      expect(govA?.location).toEqual(govB?.location);
    });
  });

  describe('governor', () => {
    it('creates exactly one governor named character', () => {
      const w = buildFixtureWorld();
      const govs = [...w.characters.values()].filter((c) => c.role === 'governor');
      expect(govs).toHaveLength(1);
    });

    it('creates exactly one governor_office Actor + Faction', () => {
      const w = buildFixtureWorld();
      const govActors = [...w.actors.values()].filter((a) => a.kind === 'governor_office');
      expect(govActors).toHaveLength(1);
      const govFactions = [...w.factions.values()].filter((f) => f.actor === govActors[0]?.id);
      expect(govFactions).toHaveLength(1);
    });

    it('places the governor in the provincial capital', () => {
      const w = buildFixtureWorld();
      const sites = w.bySite;
      const capital = sites.find((s) => s.kind === 'capital');
      expect(capital).toBeDefined();
      const gov = [...w.characters.values()].find((c) => c.role === 'governor');
      expect(gov).toBeDefined();
      // Governor lives at the capital anchor (or one of its urban hexes).
      const urbanKeys = new Set((capital?.urbanHexes ?? []).map(hexKey));
      expect(urbanKeys.has(hexKey(gov?.location as Hex))).toBe(true);
    });

    it('the governor_office actor is anchored to the capital settlement', () => {
      const w = buildFixtureWorld();
      const govActor = [...w.actors.values()].find((a) => a.kind === 'governor_office');
      const capitalSite = w.bySite.find((s) => s.kind === 'capital');
      expect(govActor?.homeSettlement).toBeDefined();
      const capitalSettlement = [...w.settlements.values()].find(
        (s) => s.anchor.q === capitalSite?.anchor.q && s.anchor.r === capitalSite?.anchor.r,
      );
      expect(govActor?.homeSettlement).toBe(capitalSettlement?.id);
    });
  });

  describe('patrician families', () => {
    it('creates the requested families per city + capital', () => {
      const w = buildFixtureWorld({ familiesPerCity: 4 });
      const cityCount = w.bySite.filter((s) => s.kind === 'city' || s.kind === 'capital').length;
      const families = [...w.actors.values()].filter((a) => a.kind === 'patrician_family');
      expect(families).toHaveLength(cityCount * 4);
    });

    it('each family has a named patriarch character', () => {
      const w = buildFixtureWorld({ familiesPerCity: 3 });
      const families = [...w.actors.values()].filter((a) => a.kind === 'patrician_family');
      const patriarchs = [...w.characters.values()].filter((c) => c.role === 'patriarch');
      expect(patriarchs.length).toBe(families.length);
      // Every patriarch's faction maps back to a family actor.
      const familyActorIds = new Set<ActorId>(families.map((f) => f.id));
      for (const p of patriarchs) {
        const fac = w.factions.get(p.faction);
        expect(fac).toBeDefined();
        expect(familyActorIds.has(fac?.actor as ActorId)).toBe(true);
      }
    });

    it('family treasuries are non-zero (a few thousand sesterces)', () => {
      const w = buildFixtureWorld();
      const families = [...w.actors.values()].filter((a) => a.kind === 'patrician_family');
      expect(families.length).toBeGreaterThan(0);
      for (const f of families) {
        expect(f.treasury).toBeGreaterThanOrEqual(1000);
      }
    });

    it('default patricianFamiliesPerCity is in the 3–7 docs/11 range', () => {
      const w = buildFixtureWorld();
      const cityCount = w.bySite.filter((s) => s.kind === 'city' || s.kind === 'capital').length;
      const families = [...w.actors.values()].filter((a) => a.kind === 'patrician_family');
      const perCity = cityCount === 0 ? 0 : families.length / cityCount;
      expect(perCity).toBeGreaterThanOrEqual(3);
      expect(perCity).toBeLessThanOrEqual(7);
    });
  });

  describe('per-class households (docs/15 §C21)', () => {
    it('creates per-class household actors for towns, cities, and patron-client villages', () => {
      const w = buildFixtureWorld();
      for (const settlement of w.settlements.values()) {
        const owners = settlement.stockpileOwners
          .map((id) => w.actors.get(id))
          .filter((a): a is NonNullable<typeof a> => a !== undefined);
        // The legacy common_household actor is replaced by class-specific
        // households. We expect at least one of them in towns/cities/
        // patron-client villages (per docs/15 §C21).
        const hasClassHousehold = owners.some(
          (a) =>
            a.kind === 'plebeian_household' ||
            a.kind === 'freedman_household' ||
            a.kind === 'foreigner_household',
        );
        const isUrban =
          settlement.tier === 'town' ||
          settlement.tier === 'small_city' ||
          settlement.tier === 'large_city';
        const isPatronClientVillage =
          settlement.tier === 'village' && owners.some((a) => a.kind === 'patrician_family');
        if (isUrban || isPatronClientVillage) {
          expect(hasClassHousehold).toBe(true);
        }
      }
    });
  });

  describe('village leadership', () => {
    it('every village has a headman or elder character', () => {
      const w = buildFixtureWorld();
      const villageSettlements = [...w.settlements.values()].filter((s) => s.tier === 'village');
      expect(villageSettlements.length).toBeGreaterThan(0);
      for (const v of villageSettlements) {
        const hasLeader = [...w.characters.values()].some(
          (c) =>
            (c.role === 'headman' || c.role === 'elder') &&
            v.urbanHexes.some((u) => u.q === c.location.q && u.r === c.location.r),
        );
        expect(hasLeader).toBe(true);
      }
    });

    it('every village has either a patron-family actor or a free_village actor owning its catchment', () => {
      const w = buildFixtureWorld();
      const villageSettlements = [...w.settlements.values()].filter((s) => s.tier === 'village');
      for (const v of villageSettlements) {
        // Pick a catchment hex and check ownerActor is set in the grid.
        const sample = v.catchmentHexes[0];
        if (sample === undefined) continue;
        const tile = w.grid.get(sample);
        expect(tile?.ownerActor).not.toBeNull();
        const owner = w.actors.get(tile?.ownerActor as ActorId);
        expect(owner).toBeDefined();
        expect(['patrician_family', 'free_village']).toContain(owner?.kind);
      }
    });

    it('roughly the requested fraction of villages are free (no clientPatron)', () => {
      // Per docs/15 §C29: both free and client villages now have a
      // `free_village` actor (the village steward). The difference is
      // whether `Settlement.clientPatron` is set — client villages point
      // to a patrician_family, free villages don't.
      const w = buildFixtureWorld();
      const villages = [...w.settlements.values()].filter((s) => s.tier === 'village');
      const free = villages.filter((v) => v.clientPatron === undefined);
      // Default is 20% free; allow wide tolerance for small-N stochastic seeds.
      const ratio = villages.length === 0 ? 0 : free.length / villages.length;
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(0.5);
    });
  });

  describe('hamlets', () => {
    it('every hamlet has a hamlet_household actor and a headman character', () => {
      const w = buildFixtureWorld();
      const hamletSettlements = [...w.settlements.values()].filter((s) => s.tier === 'hamlet');
      for (const h of hamletSettlements) {
        // The hamlet's stockpileOwners should include a hamlet_household actor.
        const owners = h.stockpileOwners.map((a) => w.actors.get(a));
        const hasHousehold = owners.some((a) => a?.kind === 'hamlet_household');
        expect(hasHousehold).toBe(true);
        // And there's a headman living there.
        const hasHeadman = [...w.characters.values()].some(
          (c) =>
            c.role === 'headman' &&
            h.urbanHexes.some((u) => u.q === c.location.q && u.r === c.location.r),
        );
        expect(hasHeadman).toBe(true);
      }
    });
  });

  describe('settlement → tier mapping', () => {
    it('capital sites become large_city settlements', () => {
      const w = buildFixtureWorld();
      const capSite = w.bySite.find((s) => s.kind === 'capital');
      const cap = [...w.settlements.values()].find(
        (s) => s.anchor.q === capSite?.anchor.q && s.anchor.r === capSite?.anchor.r,
      );
      expect(cap?.tier).toBe('large_city');
    });

    it('city sites become small_city or large_city per population', () => {
      const w = buildFixtureWorld();
      for (const site of w.bySite.filter((s) => s.kind === 'city')) {
        const settlement = [...w.settlements.values()].find(
          (s) => s.anchor.q === site.anchor.q && s.anchor.r === site.anchor.r,
        );
        expect(['small_city', 'large_city']).toContain(settlement?.tier as string);
      }
    });

    it('town/village/hamlet sites become town/village/hamlet settlements respectively', () => {
      const w = buildFixtureWorld();
      const expectMap: Record<string, string> = {
        town: 'town',
        village: 'village',
        hamlet: 'hamlet',
      };
      for (const site of w.bySite) {
        const tier = expectMap[site.kind];
        if (tier === undefined) continue;
        // Per docs/05 §"Same-hex coexistence" multiple settlements may share
        // an anchor (a village + up to 5 hamlets). Match by anchor *and*
        // expected tier so the lookup is unambiguous.
        const settlement = [...w.settlements.values()].find(
          (s) => s.anchor.q === site.anchor.q && s.anchor.r === site.anchor.r && s.tier === tier,
        );
        expect(settlement?.tier).toBe(tier);
      }
    });
  });

  describe('population pyramid', () => {
    it('total population per settlement matches the procgen estimate within ±10%', () => {
      const w = buildFixtureWorld();
      // Per docs/05 §"Same-hex coexistence" multiple settlements may share
      // an anchor (a village + up to 5 hamlets). Resolve to the right
      // settlement by matching anchor + tier.
      const tierForSite = (kind: string, pop: number): string => {
        switch (kind) {
          case 'capital':
            return 'large_city';
          case 'city':
            return pop >= 15000 ? 'large_city' : 'small_city';
          case 'town':
            return 'town';
          case 'village':
            return 'village';
          case 'hamlet':
            return 'hamlet';
          default:
            return '';
        }
      };
      for (const site of w.bySite) {
        const tier = tierForSite(site.kind, site.estimatedPopulation);
        const settlement = [...w.settlements.values()].find(
          (s) => s.anchor.q === site.anchor.q && s.anchor.r === site.anchor.r && s.tier === tier,
        );
        const total = settlement?.population.total() ?? 0;
        const expected = site.estimatedPopulation;
        // Rounding from class+age decomposition keeps us within ~10%.
        expect(total).toBeGreaterThanOrEqual(Math.floor(expected * 0.9));
        expect(total).toBeLessThanOrEqual(Math.ceil(expected * 1.1));
      }
    });

    it('class breakdown roughly matches docs/04 (1–3% patrician, ~80% plebeian, ~10–15% slave)', () => {
      const w = buildFixtureWorld();
      const cities = [...w.settlements.values()].filter(
        (s) => s.tier === 'large_city' || s.tier === 'small_city',
      );
      // The ranges below are loose to allow for stochastic rounding in
      // small populations, but must hold on city-scale settlements.
      for (const c of cities) {
        const pop = c.population;
        const total = pop.total();
        if (total < 1000) continue;
        const patFrac = pop.totalByClass('patrician') / total;
        const plebFrac = pop.totalByClass('plebeian') / total;
        const slaveFrac = pop.totalByClass('slave') / total;
        expect(patFrac).toBeGreaterThanOrEqual(0.005);
        expect(patFrac).toBeLessThanOrEqual(0.05);
        expect(plebFrac).toBeGreaterThanOrEqual(0.6);
        expect(plebFrac).toBeLessThanOrEqual(0.9);
        expect(slaveFrac).toBeGreaterThanOrEqual(0.05);
        expect(slaveFrac).toBeLessThanOrEqual(0.25);
      }
    });

    it('slaves are absent from hamlets but plebeians dominate', () => {
      const w = buildFixtureWorld();
      const hamlets = [...w.settlements.values()].filter((s) => s.tier === 'hamlet');
      for (const h of hamlets) {
        const total = h.population.total();
        if (total === 0) continue;
        expect(h.population.totalByClass('plebeian') / total).toBeGreaterThan(0.5);
      }
    });

    it('age pyramid is bottom-heavy (children outnumber elders)', () => {
      const w = buildFixtureWorld();
      const big = [...w.settlements.values()].filter((s) => s.population.total() > 1000).at(0);
      expect(big).toBeDefined();
      const children =
        big!.population.totalByAgeBand('0-4') + big!.population.totalByAgeBand('5-9');
      const elders =
        big!.population.totalByAgeBand('70-74') +
        big!.population.totalByAgeBand('75-79') +
        big!.population.totalByAgeBand('80+');
      expect(children).toBeGreaterThan(elders);
    });
  });

  describe('initial stockpiles', () => {
    it('cities have a city_corporation actor with a granary stockpile of grain', () => {
      const w = buildFixtureWorld();
      const cities = [...w.settlements.values()].filter(
        (s) => s.tier === 'large_city' || s.tier === 'small_city' || s.tier === 'town',
      );
      for (const c of cities) {
        const cityActor = [...w.actors.values()].find(
          (a) => a.kind === 'city_corporation' && a.homeSettlement === c.id,
        );
        expect(cityActor).toBeDefined();
        const grainStock = cityActor?.stockpile.get(resourceId('food.grain')) ?? 0;
        // ~30 days of grain at 0.4 kg/day = 12 kg / person; in modii (6.7 kg) ~ 1.8 modii / person.
        const expectedMin = Math.floor(c.population.total() * 0.5);
        expect(grainStock).toBeGreaterThanOrEqual(expectedMin);
      }
    });

    it('villages have small grain + tools stockpiles on their patron or free_village actor', () => {
      const w = buildFixtureWorld();
      const villages = [...w.settlements.values()].filter((s) => s.tier === 'village');
      for (const v of villages) {
        // The village's stockpile owner is one of its stockpileOwners.
        const owners = v.stockpileOwners
          .map((id) => w.actors.get(id))
          .filter((a): a is NonNullable<typeof a> => a !== undefined);
        const someoneHasGrain = owners.some(
          (a) => (a.stockpile.get(resourceId('food.grain')) ?? 0) > 0,
        );
        expect(someoneHasGrain).toBe(true);
      }
    });
  });

  describe('starter buildings', () => {
    it('records installed capacity for seeded buildings', () => {
      const w = buildFixtureWorld();
      for (const settlement of w.settlements.values()) {
        for (const building of settlement.buildings) {
          expect(building.maxCapacity).toBe(building.capacity);
          expect(building.maxCapacity).toBeGreaterThan(0);
        }
      }
    });

    it('gives same-hex hamlets subsistence buildings even when their catchment is fully claimed', () => {
      const w = buildSameHexHamletWorld();
      const hamlet = [...w.settlements.values()].find((s) => s.tier === 'hamlet');
      expect(hamlet).toBeDefined();
      expect(hamlet?.catchmentHexes).toHaveLength(0);

      const buildingIds = new Set(hamlet?.buildings.map((b) => String(b.buildingId)) ?? []);
      expect(buildingIds.has('pasture')).toBe(true);
      expect(buildingIds.has('farm')).toBe(true);
      expect(buildingIds.has('forester_camp')).toBe(true);
      expect(buildingIds.has('sawmill')).toBe(true);

      expect(hamlet?.jobAllocations.get(jobId('farmer')) ?? 0).toBeGreaterThan(0);
      expect(hamlet?.jobAllocations.get(jobId('idle')) ?? 0).toBeLessThan(
        hamlet?.population.totalAdults() ?? 0,
      );
    });

    it('seeds town light industry needed by comfort demand', () => {
      const w = buildFixtureWorld();
      const towns = [...w.settlements.values()].filter(
        (s) => s.tier === 'town' || s.tier === 'small_city' || s.tier === 'large_city',
      );
      expect(towns.length).toBeGreaterThan(0);
      for (const town of towns) {
        const buildingIds = new Set(town.buildings.map((b) => String(b.buildingId)));
        expect(buildingIds.has('weaver_workshop')).toBe(true);
        expect(buildingIds.has('tannery')).toBe(true);
        expect(buildingIds.has('kiln')).toBe(true);
        expect(buildingIds.has('pottery')).toBe(true);
        expect(buildingIds.has('tailor_shop')).toBe(true);
        expect(buildingIds.has('cart_wright')).toBe(true);
      }
    });

    it('seeds fisheries for settlements with river or lake access', () => {
      const grid = createGrid();
      const center = hex(0, 0);
      for (const h of hexesWithinRange(center, 2)) {
        grid.set(h, tile({ hasRiver: hexKey(h) === hexKey(center) }));
      }
      const sites: SettlementSite[] = [
        {
          kind: 'village',
          anchor: center,
          urbanHexes: [center],
          estimatedPopulation: 500,
        },
      ];
      const w = seedWorld({
        seed: 'river-fishery',
        grid,
        settlementSites: sites,
        patricianFamiliesPerCity: 1,
      });
      const village = [...w.settlements.values()][0];
      const buildingIds = new Set(village?.buildings.map((b) => String(b.buildingId)) ?? []);
      expect(buildingIds.has('fishery')).toBe(true);
    });

    it('seeds mines only on actual mineral deposits', () => {
      const grid = createGrid();
      const center = hex(0, 0);
      const depositHex = hex(1, 0);
      for (const h of hexesWithinRange(center, 2)) {
        grid.set(
          h,
          tile(
            hexKey(h) === hexKey(depositHex)
              ? {
                  terrain: 'hills',
                  deposit: { resource: resourceId('mineral.iron_ore'), remaining: 500 },
                }
              : {},
          ),
        );
      }
      const w = seedWorld({
        seed: 'deposit-backed-mines',
        grid,
        settlementSites: [
          {
            kind: 'village',
            anchor: center,
            urbanHexes: [center],
            estimatedPopulation: 500,
          },
        ],
        patricianFamiliesPerCity: 1,
      });
      const village = [...w.settlements.values()][0];
      const mines = village?.buildings.filter((b) => b.buildingId === buildingId('mine')) ?? [];

      expect(mines).toHaveLength(1);
      expect(hexKey(mines[0]!.hex)).toBe(hexKey(depositHex));
    });

    it('does not seed fake mines when a village has no mineral deposit', () => {
      const grid = createGrid();
      const center = hex(0, 0);
      for (const h of hexesWithinRange(center, 2)) {
        grid.set(h, tile());
      }
      const w = seedWorld({
        seed: 'no-fake-mines',
        grid,
        settlementSites: [
          {
            kind: 'village',
            anchor: center,
            urbanHexes: [center],
            estimatedPopulation: 500,
          },
        ],
        patricianFamiliesPerCity: 1,
      });
      const village = [...w.settlements.values()][0];
      const mines = village?.buildings.filter((b) => b.buildingId === buildingId('mine')) ?? [];

      expect(mines).toHaveLength(0);
    });
  });

  describe('hex-level ownership', () => {
    it('every village/town/city catchment hex has its ownerActor set', () => {
      const w = buildFixtureWorld();
      for (const s of w.settlements.values()) {
        for (const c of s.catchmentHexes) {
          const tile = w.grid.get(c);
          if (tile === undefined) continue; // procgen may have skipped this hex
          expect(tile.ownerActor).not.toBeNull();
        }
      }
    });

    it('urban hexes are owned by their city/town corporation or a family', () => {
      const w = buildFixtureWorld();
      for (const s of w.settlements.values()) {
        for (const u of s.urbanHexes) {
          const tile = w.grid.get(u);
          if (tile === undefined) continue;
          expect(tile.ownerActor).not.toBeNull();
        }
      }
    });

    it('wilderness hexes (not in any catchment or urban set) remain unowned', () => {
      const w = buildFixtureWorld();
      const owned = new Set<string>();
      for (const s of w.settlements.values()) {
        for (const u of s.urbanHexes) owned.add(hexKey(u));
        for (const c of s.catchmentHexes) owned.add(hexKey(c));
      }
      // Find a few hexes in the grid that are NOT in any settlement.
      let foundWilderness = false;
      for (const h of w.grid.hexes()) {
        if (owned.has(hexKey(h))) continue;
        const tile = w.grid.get(h);
        expect(tile?.ownerActor).toBeNull();
        foundWilderness = true;
      }
      expect(foundWilderness).toBe(true);
    });
  });

  describe('factions', () => {
    it('each Actor has at most one faction (most have exactly one)', () => {
      const w = buildFixtureWorld();
      // Build actor → faction count.
      const counts = new Map<ActorId, number>();
      for (const f of w.factions.values()) {
        counts.set(f.actor, (counts.get(f.actor) ?? 0) + 1);
      }
      for (const n of counts.values()) {
        expect(n).toBeLessThanOrEqual(1);
      }
    });

    it('every named character belongs to a faction that exists', () => {
      const w = buildFixtureWorld();
      for (const c of w.characters.values()) {
        expect(w.factions.has(c.faction)).toBe(true);
      }
    });
  });
});
