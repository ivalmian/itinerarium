import { describe, expect, it } from 'vitest';

import { buildingId } from '../types.js';
import type { HexTile } from '../world/terrain.js';

import { pickBestHex, terrainAffinity, isTerrainBuildable, isTerrainAllowedFor } from './placement.js';

const tile = (overrides: Partial<HexTile>): HexTile => ({
  terrain: 'plains',
  climate: 'temperate',
  elevation: 100,
  hasRiver: false,
  road: 'none',
  ownerActor: null,
  ...overrides,
});

const urbanCandidate = (
  q: number,
  r: number,
  overrides: Partial<HexTile> = {},
): { hex: { q: number; r: number }; tile: HexTile; waterAdjacent: boolean; isUrban: boolean } => ({
  hex: { q, r },
  tile: tile(overrides),
  waterAdjacent: false,
  isUrban: true,
});

const ruralCandidate = (
  q: number,
  r: number,
  overrides: Partial<HexTile> = {},
): { hex: { q: number; r: number }; tile: HexTile; waterAdjacent: boolean; isUrban: boolean } => ({
  hex: { q, r },
  tile: tile(overrides),
  waterAdjacent: false,
  isUrban: false,
});

describe('isTerrainBuildable', () => {
  it.each([
    ['lake', false],
    ['mountains', false],
    ['dense_forest', false],
    ['plains', true],
    ['fertile_valley', true],
    ['hills', true],
    ['forest', true],
    ['marsh', true],
    ['desert', true],
    ['steppe', true],
    ['river', true],
    ['urban', true],
    ['ruin', true],
  ] as const)('terrain %s buildable=%s', (terrain, expected) => {
    expect(isTerrainBuildable(terrain)).toBe(expected);
  });
});

describe('terrainAffinity', () => {
  it('farms prefer fertile valley over plains over hills over steppe', () => {
    const farm = buildingId('farm');
    const fv = terrainAffinity(farm, tile({ terrain: 'fertile_valley' }));
    const plains = terrainAffinity(farm, tile({ terrain: 'plains' }));
    const hills = terrainAffinity(farm, tile({ terrain: 'hills' }));
    const steppe = terrainAffinity(farm, tile({ terrain: 'steppe' }));
    expect(fv).toBeGreaterThan(plains);
    expect(plains).toBeGreaterThan(hills);
    expect(hills).toBeGreaterThan(steppe);
  });

  it('pastures prefer steppe over plains over hills', () => {
    const pasture = buildingId('pasture');
    const steppe = terrainAffinity(pasture, tile({ terrain: 'steppe' }));
    const plains = terrainAffinity(pasture, tile({ terrain: 'plains' }));
    const hills = terrainAffinity(pasture, tile({ terrain: 'hills' }));
    expect(steppe).toBeGreaterThan(plains);
    expect(plains).toBeGreaterThan(hills);
  });

  it('vineyards score higher in mediterranean hills than temperate plains', () => {
    const v = buildingId('vineyard');
    const medHills = terrainAffinity(v, tile({ terrain: 'hills', climate: 'mediterranean' }));
    const tempPlains = terrainAffinity(v, tile({ terrain: 'plains', climate: 'temperate' }));
    expect(medHills).toBeGreaterThan(tempPlains);
  });

  it('olive groves score 0 outside mediterranean except for a low floor', () => {
    const og = buildingId('olive_grove');
    const med = terrainAffinity(og, tile({ terrain: 'hills', climate: 'mediterranean' }));
    const alpine = terrainAffinity(og, tile({ terrain: 'hills', climate: 'alpine' }));
    expect(med).toBeGreaterThan(alpine);
    expect(alpine).toBeLessThanOrEqual(3);
  });

  it('uniform hard gate (isTerrainAllowedFor) rejects water for urban / rural / forest', () => {
    // Every non-mining building must refuse lake outright.
    for (const id of ['farm', 'pasture', 'forester_camp', 'smithy', 'temple', 'mill', 'fishery']) {
      expect(isTerrainAllowedFor(buildingId(id), 'lake')).toBe(false);
    }
    // Mountains / dense_forest are unbuildable for everything except mining.
    for (const id of ['farm', 'forester_camp', 'smithy', 'fishery']) {
      expect(isTerrainAllowedFor(buildingId(id), 'mountains')).toBe(false);
      expect(isTerrainAllowedFor(buildingId(id), 'dense_forest')).toBe(false);
    }
    // Mining family DOES accept mountains + dense_forest but NOT water / urban / ruin.
    for (const id of ['mine', 'quarry']) {
      expect(isTerrainAllowedFor(buildingId(id), 'mountains')).toBe(true);
      expect(isTerrainAllowedFor(buildingId(id), 'dense_forest')).toBe(true);
      expect(isTerrainAllowedFor(buildingId(id), 'lake')).toBe(false);
      expect(isTerrainAllowedFor(buildingId(id), 'river')).toBe(false);
      expect(isTerrainAllowedFor(buildingId(id), 'urban')).toBe(false);
      expect(isTerrainAllowedFor(buildingId(id), 'ruin')).toBe(false);
    }
  });

  it('unknown / unmapped buildings fall back to the urban family (strict)', () => {
    // An unmapped building should refuse the water + wildland terrains
    // rather than silently scoring on lakes (defensive against future
    // additions to the catalog).
    const novel = buildingId('totally_new_workshop');
    expect(isTerrainAllowedFor(novel, 'lake')).toBe(false);
    expect(isTerrainAllowedFor(novel, 'mountains')).toBe(false);
    expect(isTerrainAllowedFor(novel, 'dense_forest')).toBe(false);
    expect(isTerrainAllowedFor(novel, 'plains')).toBe(true);
  });

  it('quarries refuse to sit on water or urban / ruin terrain', () => {
    const q = buildingId('quarry');
    expect(terrainAffinity(q, tile({ terrain: 'lake' }))).toBe(0);
    expect(terrainAffinity(q, tile({ terrain: 'river' }))).toBe(0);
    expect(terrainAffinity(q, tile({ terrain: 'urban' }))).toBe(0);
    expect(terrainAffinity(q, tile({ terrain: 'ruin' }))).toBe(0);
    expect(terrainAffinity(q, tile({ terrain: 'hills' }))).toBeGreaterThan(0);
    expect(terrainAffinity(q, tile({ terrain: 'mountains' }))).toBeGreaterThan(0);
  });

  it('mines refuse to sit on water or urban / ruin terrain', () => {
    const m = buildingId('mine');
    expect(terrainAffinity(m, tile({ terrain: 'lake' }))).toBe(0);
    expect(terrainAffinity(m, tile({ terrain: 'river' }))).toBe(0);
    expect(terrainAffinity(m, tile({ terrain: 'urban' }))).toBe(0);
    expect(terrainAffinity(m, tile({ terrain: 'ruin' }))).toBe(0);
    expect(terrainAffinity(m, tile({ terrain: 'hills' }))).toBeGreaterThan(0);
    expect(terrainAffinity(m, tile({ terrain: 'mountains' }))).toBeGreaterThan(0);
  });

  it('forester camp wants forest', () => {
    const fc = buildingId('forester_camp');
    const forest = terrainAffinity(fc, tile({ terrain: 'forest' }));
    const plains = terrainAffinity(fc, tile({ terrain: 'plains' }));
    expect(forest).toBeGreaterThan(plains);
  });

  it('fishery returns 0 without water access', () => {
    const f = buildingId('fishery');
    expect(terrainAffinity(f, tile({ terrain: 'plains' }), { waterAdjacent: false })).toBe(0);
    expect(terrainAffinity(f, tile({ terrain: 'plains' }), { waterAdjacent: true })).toBeGreaterThan(0);
  });

  it('urban workshops score highest on urban hex (terrain=urban)', () => {
    for (const b of ['bakery', 'smithy', 'weaver_workshop', 'pottery', 'kiln'] as const) {
      const id = buildingId(b);
      const urban = terrainAffinity(id, tile({ terrain: 'urban' }), { waterAdjacent: false });
      const plains = terrainAffinity(id, tile({ terrain: 'plains' }), { waterAdjacent: false });
      expect(urban).toBeGreaterThan(plains);
    }
  });

  it('urban workshops score highest on isUrban hex even with plains terrain', () => {
    // Procgen keeps the urban hex's underlying terrain (plains /
    // fertile_valley / etc.). The `isUrban` option lets us still rank
    // these as the city core.
    for (const b of ['bakery', 'smithy', 'weaver_workshop', 'pottery', 'kiln'] as const) {
      const id = buildingId(b);
      const cityCore = terrainAffinity(id, tile({ terrain: 'plains' }), {
        waterAdjacent: false,
        isUrban: true,
      });
      const wilderness = terrainAffinity(id, tile({ terrain: 'plains' }), {
        waterAdjacent: false,
        isUrban: false,
      });
      expect(cityCore).toBeGreaterThan(wilderness);
    }
  });

  it('water-powered buildings prefer river-adjacent hexes', () => {
    const mill = buildingId('mill');
    const wet = terrainAffinity(mill, tile({ terrain: 'urban', hasRiver: true }));
    const dry = terrainAffinity(mill, tile({ terrain: 'urban', hasRiver: false }));
    expect(wet).toBeGreaterThan(dry);
  });

  it('mine scoring works on terrains that are otherwise unbuildable', () => {
    const mine = buildingId('mine');
    expect(terrainAffinity(mine, tile({ terrain: 'mountains' }))).toBeGreaterThan(0);
    expect(terrainAffinity(mine, tile({ terrain: 'hills' }))).toBeGreaterThan(
      terrainAffinity(mine, tile({ terrain: 'plains' })),
    );
  });

  it('unbuildable terrain returns 0 for normal buildings', () => {
    expect(terrainAffinity(buildingId('farm'), tile({ terrain: 'lake' }))).toBe(0);
    expect(terrainAffinity(buildingId('bakery'), tile({ terrain: 'lake' }))).toBe(0);
    expect(terrainAffinity(buildingId('bakery'), tile({ terrain: 'mountains' }))).toBe(0);
  });
});

describe('pickBestHex', () => {
  it('returns null on empty candidates', () => {
    expect(pickBestHex(buildingId('farm'), [])).toBeNull();
  });

  it('picks the highest-scoring candidate', () => {
    const candidates = [
      ruralCandidate(0, 0, { terrain: 'steppe' }),
      ruralCandidate(1, 0, { terrain: 'fertile_valley' }),
      ruralCandidate(2, 0, { terrain: 'hills' }),
    ];
    const best = pickBestHex(buildingId('farm'), candidates);
    expect(best?.hex).toEqual({ q: 1, r: 0 });
  });

  it('breaks ties by (q, r) order so seeded worlds stay deterministic', () => {
    const candidates = [
      ruralCandidate(3, 0, { terrain: 'plains' }),
      ruralCandidate(1, 5, { terrain: 'plains' }),
      ruralCandidate(2, 0, { terrain: 'plains' }),
    ];
    const best = pickBestHex(buildingId('farm'), candidates);
    expect(best?.hex).toEqual({ q: 1, r: 5 });
  });

  it('returns null when every candidate scores 0', () => {
    const candidates = [ruralCandidate(0, 0, { terrain: 'plains' })];
    // Fishery requires water access — no candidate qualifies.
    expect(pickBestHex(buildingId('fishery'), candidates)).toBeNull();
  });

  it('a workshop placed on an urban (plains-terrain) hex beats a fertile_valley rural hex', () => {
    const candidates = [
      urbanCandidate(0, 0, { terrain: 'plains' }),
      ruralCandidate(1, 0, { terrain: 'fertile_valley' }),
    ];
    const best = pickBestHex(buildingId('bakery'), candidates);
    expect(best?.hex).toEqual({ q: 0, r: 0 });
  });
});
