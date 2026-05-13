/** Tests for the movement phase (src/sim/phases/movement.ts). */

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
  buildOneSettlementWorld,
  eventsOfType,
  makeTile,
} from '../testing/tickFixtures.js';

  describe('movement phase', () => {
    it('advances a caravan with a destination toward the destination', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 0 } });
      // Add several plains hexes east of the anchor for the caravan to walk.
      for (let q = 3; q <= 10; q++) {
        w.grid.set(hex(q, 0), makeTile('plains'));
      }
      const cId = caravanId('cara-1');
      const owner = actorId('city-corp-1');
      const c = createCaravan({
        id: cId,
        ownerActor: owner,
        position: { q: 0, r: 0 },
        destination: { q: 10, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 6 },
        vehicles: {},
      });
      // Give it some rations so it doesn't starve immediately.
      c.cargo.set(resourceId('food.bread'), 50);
      w.caravans.set(cId, c);
      const r = tick({ world: w, rng: createRng('cara-move') });
      const moves = eventsOfType(r.events, 'caravan_moved');
      // The caravan should have moved at least one hex toward the destination.
      expect(c.position.q).toBeGreaterThan(0);
      expect(moves.length).toBeGreaterThan(0);
      for (let i = 1; i < moves.length; i++) {
        expect(moves[i]?.from).toEqual(moves[i - 1]?.to);
      }
    });

    it('emits caravan_arrived when a caravan reaches its destination', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 0 } });
      const cId = caravanId('cara-arr');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('city-corp-1'),
        position: { q: 0, r: 0 },
        destination: { q: 0, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 4 },
        vehicles: {},
      });
      c.cargo.set(resourceId('food.bread'), 10);
      w.caravans.set(cId, c);
      const r = tick({ world: w, rng: createRng('cara-arr') });
      const arrivals = eventsOfType(r.events, 'caravan_arrived');
      expect(arrivals.some((e) => e.caravan === cId)).toBe(true);
    });

    it('disbands caravans whose crew has already been wiped out', () => {
      const w = buildOneSettlementWorld({ populationByClass: { plebeian: 0 } });
      const cId = caravanId('cara-zero-crew');
      const c = createCaravan({
        id: cId,
        ownerActor: actorId('city-corp-1'),
        position: { q: 0, r: 0 },
        destination: { q: 0, r: 0 },
        crew: [{ kind: 'merchant', count: 1, weapons: 0, armor: 0 }],
        animals: { mule: 1 },
        vehicles: {},
      });
      c.crew = [];
      w.caravans.set(cId, c);

      const r = tick({ world: w, rng: createRng('zero-crew-disband') });
      const disbanded = eventsOfType(r.events, 'caravan_disbanded').find((e) => e.caravan === cId);

      expect(w.caravans.has(cId)).toBe(false);
      expect(disbanded?.reason).toBe('zero_crew');
    });
  });
