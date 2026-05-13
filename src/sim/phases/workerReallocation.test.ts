/** Tests for the worker-reallocation phase (src/sim/phases/workerReallocation.ts). */

import { describe, expect, it } from 'vitest';
import {
  jobId,
  settlementId,
} from '../types.js';
import { createRng } from '../rng.js';
import type { WorldState } from '../../procgen/seed.js';
import { tick, type TickEvent } from '../tick.js';
import {
  buildOneSettlementWorld,
  eventsOfType,
} from '../testing/tickFixtures.js';

  describe('worker reallocation by demand (docs/04 §"Worker reallocation")', () => {
    it('moves workers from over-supplied roles to roles whose recipes are blocked by labor', async () => {
      // Setup: a town with a mill (needs millers) but every adult is
      // procgen-allocated as a 'farmer'. The mill_grain recipe will block on
      // labor every day (no millers). After ~30 days the monthly hook should
      // shift some workers off farmer onto miller.
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        addMill: true,
        flourSacks: 0,
        // Give the city actor some grain so the mill has inputs and only
        // labor is the bottleneck.
        grainModii: 200,
      });
      const sId = settlementId('settle-1');
      const settle = w.settlements.get(sId);
      if (settle === undefined) throw new Error('expected fixture settlement');
      // Simulate procgen having put everyone on the farmer role (no millers).
      const { jobId } = await import('../types.js');
      settle.jobAllocations.set(jobId('farmer'), 200);

      // Drive 30 days; the politicsPhase reallocation hook fires when
      // (today + 1) % 30 === 0 — i.e. after day=29 ticks (today=29 → +1 = 30).
      let world: WorldState = w;
      let collected: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`worker-${d}`) });
        collected = collected.concat(r.events);
        world = r.world;
      }

      const moves = eventsOfType(collected, 'workers_reallocated');
      expect(moves.length).toBeGreaterThanOrEqual(1);
      const lastMove = moves[moves.length - 1];
      expect(lastMove?.toJob).toBe(jobId('miller'));
      expect(lastMove?.fromJob).toBe(jobId('farmer'));
      expect(lastMove?.count).toBeGreaterThan(0);
      // Allocation should have shifted: some millers now exist.
      const refreshed = world.settlements.get(sId);
      expect(refreshed?.jobAllocations.get(jobId('miller'))).toBeGreaterThan(0);
      expect(refreshed?.jobAllocations.get(jobId('farmer'))).toBeLessThan(200);
    });

    it('splits monthly worker moves across multiple labor bottlenecks', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 200 },
        addMill: true,
        addBakery: true,
        grainModii: 2000,
        flourSacks: 2000,
        woodCords: 2000,
      });
      const sId = settlementId('settle-1');
      const settle = w.settlements.get(sId);
      if (settle === undefined) throw new Error('expected fixture settlement');
      settle.jobAllocations.clear();
      settle.jobAllocations.set(jobId('farmer'), 200);

      let world: WorldState = w;
      let collected: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`worker-split-${d}`) });
        collected = collected.concat(r.events);
        world = r.world;
      }

      const moves = eventsOfType(collected, 'workers_reallocated');
      expect(moves.some((m) => m.toJob === jobId('miller'))).toBe(true);
      expect(moves.some((m) => m.toJob === jobId('baker'))).toBe(true);
      const refreshed = world.settlements.get(sId);
      expect(refreshed?.jobAllocations.get(jobId('miller'))).toBeGreaterThan(0);
      expect(refreshed?.jobAllocations.get(jobId('baker'))).toBeGreaterThan(0);
      expect(refreshed?.jobAllocations.get(jobId('farmer'))).toBeLessThan(200);
    });

    it('emits no workers_reallocated event when no recipes are blocked by labor', async () => {
      // Settlement with no buildings → no recipes can run → no labor blocks.
      // The reallocation phase has nothing to do.
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 100 } });
      const sId = settlementId('settle-1');
      const settle = w.settlements.get(sId);
      if (settle === undefined) throw new Error('expected fixture settlement');
      const { jobId } = await import('../types.js');
      // Allocate everyone to idle so production can't fire.
      settle.jobAllocations.set(jobId('idle'), 100);

      let world: WorldState = w;
      let collected: TickEvent[] = [];
      for (let d = 0; d < 30; d++) {
        const r = tick({ world, rng: createRng(`worker-noop-${d}`) });
        collected = collected.concat(r.events);
        world = r.world;
      }

      const moves = eventsOfType(collected, 'workers_reallocated');
      expect(moves.length).toBe(0);
    });
  });
