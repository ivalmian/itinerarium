/** Tests for the trail-wear tick phase (src/sim/phases/trailWearTick.ts). */

import { describe, expect, it } from 'vitest';
import { hex } from '../world/hex.js';
import {
  createCaravan,
} from '../caravan/caravan.js';
import {
  actorId,
  caravanId,
  resourceId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildEmptyWorld,
  eventsOfType,
  makeTile,
} from '../testing/tickFixtures.js';

  describe('trail wear phase', () => {
    it('caps road wear from heavy repeated caravan traffic', () => {
      const w = buildEmptyWorld();
      w.grid.set(hex(0, 0), makeTile('plains'));
      w.grid.set(hex(1, 0), makeTile('plains'));
      w.grid.set(hex(2, 0), makeTile('plains'));
      for (const [, t] of w.grid.tiles()) {
        t.road = 'none';
        t.roadWear = 0;
      }

      const cId = caravanId('heavy-traffic');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('city-corp-1'),
        position: hex(0, 0),
        destination: hex(2, 0),
        crew: [{ kind: 'merchant', count: 2000, weapons: 0, armor: 0 }],
        animals: { mule: 5000 },
        vehicles: {},
      });
      c.cargo.set(resourceId('food.bread'), 100000);
      w.caravans.set(cId, c);

      tick({ world: w, rng: createRng('road-wear-cap') });

      expect(w.grid.get(hex(1, 0))?.roadWear).toBeLessThanOrEqual(10);
    });

    it('demotes unused dirt roads near the downgrade threshold and clears their wear', () => {
      const w = buildEmptyWorld();
      // Isolated dirt hex (0 road neighbors): decay = 0.75 × 2^-2 = 0.1875/day.
      // Seed it at 20.1 so a single tick brings it below DIRT_DOWNGRADE_THRESHOLD (20).
      w.grid.set(hex(0, 0), {
        ...makeTile('plains'),
        road: 'dirt',
        roadWear: 20.1,
      });

      const r = tick({ world: w, rng: createRng('road-decay') });
      const downgraded = eventsOfType(r.events, 'road_downgraded');

      expect(w.grid.get(hex(0, 0))?.road).toBe('none');
      expect(w.grid.get(hex(0, 0))?.roadWear).toBe(0);
      expect(downgraded).toHaveLength(1);
    });

    it('scales dirt-road decay exponentially with road-neighbor count', () => {
      // An isolated dirt hex (0 road neighbors) should decay at 0.25× the
      // baseline rate. A 3-road-neighbor dirt hex should decay at 2× the
      // baseline. See docs/06 §"Dirt roads can downgrade."
      const isolated = buildEmptyWorld();
      isolated.grid.set(hex(10, 10), makeTile('plains'));
      isolated.grid.set(hex(10, 10), {
        ...isolated.grid.get(hex(10, 10))!,
        road: 'dirt',
        roadWear: 100,
      });
      tick({ world: isolated, rng: createRng('iso') });
      // Baseline DIRT_ROAD_DECAY_PER_DAY = 0.75; with n=0, decay = 0.75 × 2^-2 = 0.1875.
      // 100 - 0.1875 = 99.8125.
      expect(isolated.grid.get(hex(10, 10))?.roadWear).toBeCloseTo(99.8125, 2);

      const dense = buildEmptyWorld();
      const center = hex(10, 10);
      dense.grid.set(center, makeTile('plains'));
      dense.grid.set(center, {
        ...dense.grid.get(center)!,
        road: 'dirt',
        roadWear: 100,
      });
      // Give it 3 road neighbors.
      for (const d of [hex(11, 10), hex(11, 9), hex(10, 9)]) {
        dense.grid.set(d, makeTile('plains'));
        dense.grid.set(d, { ...dense.grid.get(d)!, road: 'dirt', roadWear: 100 });
      }
      tick({ world: dense, rng: createRng('dense') });
      // With n=3, decay = 0.75 × 2^1 = 1.5. 100 - 1.5 = 98.5.
      expect(dense.grid.get(center)?.roadWear).toBeCloseTo(98.5, 2);
    });
  });
