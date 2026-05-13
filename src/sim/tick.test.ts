/**
 * Tests for the per-day tick loop itself — shape, determinism, integration
 * smoke, and reputation decay.
 *
 * Per-phase behavioral tests live alongside their phase modules under
 * src/sim/phases/<name>.test.ts and reuse the shared fixture builders in
 * src/sim/testing/tickFixtures.ts.
 */

import { describe, expect, it } from 'vitest';
import { actorId } from './types.js';
import { createRng } from './rng.js';
import { tick, type TickEvent } from './tick.js';
import { buildEmptyWorld, buildOneSettlementWorld } from './testing/tickFixtures.js';

describe('tick (per-day loop)', () => {
  describe('shape', () => {
    it('returns the same world reference advanced by one day with no events on an empty world', () => {
      const w = buildEmptyWorld();
      const r = tick({ world: w, rng: createRng('t1') });
      expect(r.world.day).toBe(1);
      expect(r.events).toEqual([]);
    });

    it('preserves all top-level maps (no replacement)', () => {
      const w = buildEmptyWorld();
      const r = tick({ world: w, rng: createRng('t1') });
      expect(r.world.settlements).toBe(w.settlements);
      expect(r.world.actors).toBe(w.actors);
      expect(r.world.factions).toBe(w.factions);
      expect(r.world.characters).toBe(w.characters);
      expect(r.world.caravans).toBe(w.caravans);
      expect(r.world.reputation).toBe(w.reputation);
    });
  });

  describe('determinism', () => {
    it('two ticks with the same world + RNG produce the same events', () => {
      const a = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const b = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        grainModii: 500,
        addMill: true,
      });
      const ra = tick({ world: a, rng: createRng('det-1') });
      const rb = tick({ world: b, rng: createRng('det-1') });
      // Compare event sequences by stringifying (events contain only plain
      // structurally-comparable data).
      expect(JSON.stringify(rb.events)).toBe(JSON.stringify(ra.events));
    });
  });

  describe('integration smoke', () => {
    it('a procgen-seeded small world ticks 30 days without throwing', async () => {
      const { generateTerrain } = await import('../procgen/terrain.js');
      const { siteSettlements } = await import('../procgen/settlements.js');
      const { seedWorld } = await import('../procgen/seed.js');
      const grid = generateTerrain({
        seed: 'tick-smoke',
        widthHexes: 24,
        heightHexes: 24,
        oceanCoveragePct: 5,
        mountainsCoveragePct: 10,
      });
      const sites = siteSettlements({
        seed: 'tick-smoke-sites',
        grid,
        cityCount: 1,
        townCount: 2,
        villageCount: 4,
        hamletCount: 4,
      });
      let world = seedWorld({ seed: 'tick-smoke-world', grid, settlementSites: sites });
      const allEvents: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`smoke-${d}`) });
        allEvents.push(...r.events);
        world = r.world;
      }
      expect(world.day).toBe(30);
      // Sanity: at least some events should have fired across 30 days in a
      // populated world (markets clearing, demographics ticking).
      expect(allEvents.length).toBeGreaterThan(0);
    });
  });

  describe('reputation phase', () => {
    it('decays existing reputation entries every tick', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const a = actorId('actor-A');
      const b = actorId('actor-B');
      w.reputation.set(a, b, 0.5);
      const before = w.reputation.get(a, b);
      // Tick many days so the half-life decay is observable.
      let world = w;
      for (let d = 0; d < 60; d++) {
        const r = tick({ world, rng: createRng(`rep-${d}`) });
        world = r.world;
      }
      const after = world.reputation.get(a, b);
      expect(Math.abs(after)).toBeLessThan(Math.abs(before));
    });
  });
});
