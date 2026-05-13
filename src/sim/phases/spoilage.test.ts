/** Tests for the storage spoilage phase (src/sim/phases/spoilage.ts). */

import { describe, expect, it } from 'vitest';
import {
  actorId,
  resourceId,
} from '../types.js';
import { createRng } from '../rng.js';
import { tick, } from '../tick.js';
import {
  buildOneSettlementWorld,
  eventsOfType,
  getStock,
  setStock,
} from '../testing/tickFixtures.js';

  describe('storage spoilage', () => {
    it('short-lived perishables spoil even during the bootstrap storage grace period', () => {
      const w = buildOneSettlementWorld({
        populationByClass: { plebeian: 0, slave: 100 },
        grainModii: 1_000,
      });
      const owner = w.actors.get(actorId('city-corp-1'));
      if (owner === undefined) throw new Error('missing owner');
      const grapes = resourceId('food.grapes');
      const cheese = resourceId('food.cheese');
      setStock(owner, grapes, 100);
      setStock(owner, cheese, 100);

      const r = tick({ world: w, rng: createRng('natural-short-spoilage') });

      expect(getStock(owner, grapes) ?? 0).toBeLessThan(100);
      expect(getStock(owner, cheese) ?? 0).toBe(100);
      expect(eventsOfType(r.events, 'storage_spoilage').some((e) => e.resource === grapes)).toBe(
        true,
      );
      expect(eventsOfType(r.events, 'storage_spoilage').some((e) => e.resource === cheese)).toBe(
        false,
      );
    });
  });
