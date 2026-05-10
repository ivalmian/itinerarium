import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { actorId, resourceId, settlementId, type Quantity, type ResourceId } from '../types.js';
import { hex } from '../world/hex.js';
import {
  DEFAULT_IMPORT_PALETTE,
  DEFAULT_GLOBAL_PRICES,
  estimateExportMargin,
  tickEdgeHubs,
  TRANSPORT_COST_COIN_PER_KG_PER_HEX,
  type EdgeHubConfig,
  type EdgeHubTickInputs,
} from './edgeHub.js';

const grain = resourceId('food.grain');
const oliveOil = resourceId('food.olive_oil');
const wine = resourceId('food.wine');
const cloth = resourceId('goods.cloth');
const luxuryTextiles = resourceId('goods.luxury_textiles');
const silver = resourceId('metal.silver');
const spices = resourceId('exotic.spices');
const slave = resourceId('people.slave');

const baseConfig = (overrides: Partial<EdgeHubConfig> = {}): EdgeHubConfig => ({
  edgeHexes: [hex(-50, 0), hex(50, 0)],
  globalPrices: DEFAULT_GLOBAL_PRICES,
  baseImportSpawnProbPerDay: 0.02,
  baseExportSpawnProbPerDay: 0.02,
  importPalette: DEFAULT_IMPORT_PALETTE,
  ...overrides,
});

const aquileia = settlementId('aquileia');
const ravenna = settlementId('ravenna');

const cityImportTargets = [
  { settlementId: aquileia, hex: hex(0, 0) },
  { settlementId: ravenna, hex: hex(40, 0) },
];

const exportSource = (
  id: typeof aquileia,
  h: ReturnType<typeof hex>,
  localPrices: ReadonlyMap<ResourceId, number>,
  available: ReadonlyMap<ResourceId, Quantity>,
): EdgeHubTickInputs['cityExportSources'][number] => ({
  settlementId: id,
  hex: h,
  ownerActor: actorId(`${String(id)}-merchant`),
  localPrices,
  availableForExport: available,
});

describe('TRANSPORT_COST_COIN_PER_KG_PER_HEX', () => {
  it('is positive (transport is not free)', () => {
    expect(TRANSPORT_COST_COIN_PER_KG_PER_HEX).toBeGreaterThan(0);
  });
});

describe('DEFAULT_GLOBAL_PRICES', () => {
  it('has prices for the major exotic imports and exportables', () => {
    for (const r of [grain, oliveOil, wine, cloth, luxuryTextiles, silver, spices]) {
      expect(DEFAULT_GLOBAL_PRICES.get(r)).toBeGreaterThan(0);
    }
  });

  it('high-value-per-kg goods (silver) trade at much higher coin/unit than bulk grain', () => {
    const silverP = DEFAULT_GLOBAL_PRICES.get(silver) ?? 0;
    const grainP = DEFAULT_GLOBAL_PRICES.get(grain) ?? 0;
    expect(silverP / grainP).toBeGreaterThan(50);
  });
});

describe('estimateExportMargin (per-unit)', () => {
  it('bulk grain has strongly negative margin even with a 100% local-price spread', () => {
    const localPrices = new Map<ResourceId, number>([[grain, 1]]);
    const m = estimateExportMargin(grain, 100, localPrices);
    expect(m).toBeLessThan(0);
  });

  it('silver has positive margin over a typical export distance', () => {
    const localPrices = new Map<ResourceId, number>([[silver, 500]]);
    const m = estimateExportMargin(silver, 100, localPrices);
    expect(m).toBeGreaterThan(0);
  });

  it('luxury textiles have positive margin', () => {
    const localPrices = new Map<ResourceId, number>([[luxuryTextiles, 30]]);
    const m = estimateExportMargin(luxuryTextiles, 100, localPrices);
    expect(m).toBeGreaterThan(0);
  });

  it('plain cloth — bulky for its value — is not profitable', () => {
    const localPrices = new Map<ResourceId, number>([[cloth, 10]]);
    const m = estimateExportMargin(cloth, 100, localPrices);
    expect(m).toBeLessThan(0);
  });

  it('returns negative margin if local price exceeds global price', () => {
    const localPrices = new Map<ResourceId, number>([[silver, 99999]]);
    const m = estimateExportMargin(silver, 100, localPrices);
    expect(m).toBeLessThan(0);
  });
});

describe('tickEdgeHubs — imports', () => {
  it('with high spawn prob, creates import caravans at edge hexes', () => {
    const config = baseConfig({ baseImportSpawnProbPerDay: 1.0, baseExportSpawnProbPerDay: 0 });
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets,
      cityExportSources: [],
      rng: createRng('imports-1'),
    });
    expect(result.newCaravans.length).toBeGreaterThan(0);
    for (const c of result.newCaravans) {
      // Origin: one of the edge hexes
      const isEdge = config.edgeHexes.some((h) => h.q === c.position.q && h.r === c.position.r);
      expect(isEdge).toBe(true);
      // Destination: one of the city target hexes (nearest preferred)
      expect(c.destination).not.toBeNull();
      const isCity = cityImportTargets.some(
        (t) => c.destination !== null && t.hex.q === c.destination.q && t.hex.r === c.destination.r,
      );
      expect(isCity).toBe(true);
      expect(c.cargo.size).toBeGreaterThan(0);
      // Cargo entry should be one of the configured import-palette resources.
      for (const cargoRes of c.cargo.keys()) {
        expect(config.importPalette.some((p) => p.resource === cargoRes)).toBe(true);
      }
    }
  });

  it('with zero spawn prob, no caravans are created', () => {
    const config = baseConfig({ baseImportSpawnProbPerDay: 0, baseExportSpawnProbPerDay: 0 });
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets,
      cityExportSources: [],
      rng: createRng('zero'),
    });
    expect(result.newCaravans).toEqual([]);
  });

  it('imports prefer the nearest city target', () => {
    const config = baseConfig({ baseImportSpawnProbPerDay: 1.0, baseExportSpawnProbPerDay: 0 });
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      // edge at (50,0); aquileia at (0,0) dist 50; ravenna at (40,0) dist 10. ravenna should win for the 50,0 edge.
      cityImportTargets,
      cityExportSources: [],
      rng: createRng('nearest'),
    });
    // For the (50,0) edge, the chosen destination should be ravenna.
    const fromEastEdge = result.newCaravans.filter((c) => c.position.q === 50);
    expect(fromEastEdge.length).toBeGreaterThan(0);
    for (const c of fromEastEdge) {
      expect(c.destination?.q).toBe(40);
    }
  });

  it('cargo amounts respect importPalette range', () => {
    const tightPalette: EdgeHubConfig['importPalette'] = [
      { resource: spices, weight: 1, cargoKg: [100, 200] },
    ];
    const config = baseConfig({
      baseImportSpawnProbPerDay: 1.0,
      baseExportSpawnProbPerDay: 0,
      importPalette: tightPalette,
    });
    for (let trial = 0; trial < 20; trial++) {
      const result = tickEdgeHubs({
        config,
        today: 100,
        season: 'summer',
        cityImportTargets,
        cityExportSources: [],
        rng: createRng(`cargo-${trial}`),
      });
      for (const c of result.newCaravans) {
        for (const [, qty] of c.cargo) {
          // spices is 1 kg/unit so kg ≈ unit count
          expect(qty).toBeGreaterThanOrEqual(100);
          expect(qty).toBeLessThanOrEqual(200);
        }
      }
    }
  });
});

describe('tickEdgeHubs — exports', () => {
  const farEdge = hex(-50, 0);

  it('does NOT export low-value bulk staples (grain, ordinary cloth) at any distance', () => {
    const config = baseConfig({
      baseImportSpawnProbPerDay: 0,
      baseExportSpawnProbPerDay: 1.0,
      edgeHexes: [farEdge],
    });
    const localPrices = new Map<ResourceId, number>([
      [grain, 1],
      [cloth, 8],
    ]);
    const available = new Map<ResourceId, Quantity>([
      [grain, 100000],
      [cloth, 5000],
    ]);
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets: [],
      cityExportSources: [exportSource(aquileia, hex(0, 0), localPrices, available)],
      rng: createRng('bulk-no-export'),
    });
    // None of the resulting caravans should carry these bulk goods.
    for (const c of result.newCaravans) {
      expect(c.cargo.has(grain)).toBe(false);
      expect(c.cargo.has(cloth)).toBe(false);
    }
  });

  it('exports amphora-packed olive oil + wine when local surplus depresses prices over a reasonable distance', () => {
    // Per docs/06 §"Exports" + docs/08: amphora oil/wine CAN export
    // "in good years when quality or scarcity makes the spread high
    // enough". Same margin filter as everything else.
    const nearEdge = hex(-30, 0);
    const config = baseConfig({
      baseImportSpawnProbPerDay: 0,
      baseExportSpawnProbPerDay: 1.0,
      edgeHexes: [nearEdge],
    });
    // Surplus year: local prices well below the amphora-export global.
    const localPrices = new Map<ResourceId, number>([
      [oliveOil, 2],
      [wine, 3],
    ]);
    const available = new Map<ResourceId, Quantity>([
      [oliveOil, 200],
      [wine, 200],
    ]);
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets: [],
      cityExportSources: [exportSource(aquileia, hex(0, 0), localPrices, available)],
      rng: createRng('amphora-export'),
    });
    expect(result.newCaravans.length).toBeGreaterThan(0);
    for (const c of result.newCaravans) {
      const cargoResources = Array.from(c.cargo.keys());
      expect(cargoResources.length).toBeGreaterThan(0);
      // Cargo should be one of the amphora staples (the higher-margin
      // pick wins per bestExportFor).
      for (const r of cargoResources) {
        expect([oliveOil, wine]).toContain(r);
      }
    }
  });

  it('does NOT export amphora oil/wine when local price is already at or near the global price', () => {
    // No spread → no profit → no export. The same filter that lets
    // bulk grain stay home keeps amphora goods home when there's no
    // surplus to liquidate.
    const nearEdge = hex(-30, 0);
    const config = baseConfig({
      baseImportSpawnProbPerDay: 0,
      baseExportSpawnProbPerDay: 1.0,
      edgeHexes: [nearEdge],
    });
    const localPrices = new Map<ResourceId, number>([
      [oliveOil, 145],
      [wine, 195],
    ]);
    const available = new Map<ResourceId, Quantity>([
      [oliveOil, 200],
      [wine, 200],
    ]);
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets: [],
      cityExportSources: [exportSource(aquileia, hex(0, 0), localPrices, available)],
      rng: createRng('amphora-no-spread'),
    });
    for (const c of result.newCaravans) {
      expect(c.cargo.has(oliveOil)).toBe(false);
      expect(c.cargo.has(wine)).toBe(false);
    }
  });

  it('exports silver / luxury_textiles when their local price leaves a positive margin', () => {
    const config = baseConfig({
      baseImportSpawnProbPerDay: 0,
      baseExportSpawnProbPerDay: 1.0,
      edgeHexes: [farEdge],
    });
    const localPrices = new Map<ResourceId, number>([
      [silver, 500],
      [luxuryTextiles, 30],
    ]);
    const available = new Map<ResourceId, Quantity>([
      [silver, 50],
      [luxuryTextiles, 200],
    ]);
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets: [],
      cityExportSources: [exportSource(aquileia, hex(0, 0), localPrices, available)],
      rng: createRng('lux-export'),
    });
    expect(result.newCaravans.length).toBeGreaterThan(0);
    for (const c of result.newCaravans) {
      // Caravan starts at the city, heads to the edge.
      expect(c.position.q).toBe(0);
      expect(c.destination).toEqual(farEdge);
      // Cargo is one of the profitable goods.
      const cargoResources = Array.from(c.cargo.keys());
      expect(cargoResources.length).toBeGreaterThan(0);
      for (const r of cargoResources) {
        expect([silver, luxuryTextiles]).toContain(r);
      }
    }
  });

  it('does not export resources the city has none of', () => {
    const config = baseConfig({
      baseImportSpawnProbPerDay: 0,
      baseExportSpawnProbPerDay: 1.0,
      edgeHexes: [farEdge],
    });
    const localPrices = new Map<ResourceId, number>([[silver, 500]]);
    const available = new Map<ResourceId, Quantity>([[silver, 0]]);
    const result = tickEdgeHubs({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets: [],
      cityExportSources: [exportSource(aquileia, hex(0, 0), localPrices, available)],
      rng: createRng('no-stock'),
    });
    expect(result.newCaravans).toEqual([]);
  });
});

describe('tickEdgeHubs — seasonality', () => {
  it('summer produces more import caravans than winter (over many trials)', () => {
    const config = baseConfig({ baseImportSpawnProbPerDay: 0.3, baseExportSpawnProbPerDay: 0 });
    let summerCount = 0;
    let winterCount = 0;
    for (let trial = 0; trial < 50; trial++) {
      const sRng = createRng(`s-${trial}`);
      const wRng = createRng(`w-${trial}`);
      summerCount += tickEdgeHubs({
        config,
        today: 150,
        season: 'summer',
        cityImportTargets,
        cityExportSources: [],
        rng: sRng,
      }).newCaravans.length;
      winterCount += tickEdgeHubs({
        config,
        today: 350,
        season: 'winter',
        cityImportTargets,
        cityExportSources: [],
        rng: wRng,
      }).newCaravans.length;
    }
    expect(summerCount).toBeGreaterThan(winterCount);
  });
});

describe('tickEdgeHubs — determinism', () => {
  it('same inputs + same rng seed → same caravans', () => {
    const config = baseConfig({ baseImportSpawnProbPerDay: 0.3, baseExportSpawnProbPerDay: 0.3 });
    const localPrices = new Map<ResourceId, number>([[silver, 500]]);
    const available = new Map<ResourceId, Quantity>([[silver, 50]]);
    const inputs = (rng: ReturnType<typeof createRng>): EdgeHubTickInputs => ({
      config,
      today: 100,
      season: 'summer',
      cityImportTargets,
      cityExportSources: [exportSource(aquileia, hex(0, 0), localPrices, available)],
      rng,
    });
    const a = tickEdgeHubs(inputs(createRng('det')));
    const b = tickEdgeHubs(inputs(createRng('det')));
    expect(a.newCaravans.length).toBe(b.newCaravans.length);
    for (let i = 0; i < a.newCaravans.length; i++) {
      const ca = a.newCaravans[i];
      const cb = b.newCaravans[i];
      expect(ca?.position).toEqual(cb?.position);
      expect(ca?.destination).toEqual(cb?.destination);
      expect(Array.from(ca?.cargo.entries() ?? [])).toEqual(Array.from(cb?.cargo.entries() ?? []));
    }
  });
});

describe('tickEdgeHubs — slaves are exportable cargo', () => {
  it('slaves at their global price land profitable enough to export', () => {
    const localPrices = new Map<ResourceId, number>([[slave, 200]]);
    const m = estimateExportMargin(slave, 100, localPrices);
    expect(m).toBeGreaterThan(0);
  });
});
